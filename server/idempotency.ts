import type { Database, Executor } from './db.ts';

export type IdempotencyCachePolicy = { ttlMs: number; maxEntries: number; maxBytes: number };
export const DEFAULT_IDEMPOTENCY_CACHE: Readonly<IdempotencyCachePolicy> = Object.freeze({ttlMs:24*60*60*1000,maxEntries:32,maxBytes:32*1024*1024});
export function idempotencyPolicy(input:Partial<IdempotencyCachePolicy>={}):IdempotencyCachePolicy {
  const policy={...DEFAULT_IDEMPOTENCY_CACHE,...input};
  for(const field of ['ttlMs','maxEntries','maxBytes'] as const) {
    if(!Number.isSafeInteger(policy[field])||policy[field]<0||policy[field]>DEFAULT_IDEMPOTENCY_CACHE[field])throw new Error(`Invalid idempotency cache ${field}`);
  }
  return policy;
}

// Caller holds this workspace's FOR UPDATE lock. Cache bytes are the database's
// UTF-8 JSON text size, not a claim about compressed files, indexes or WAL size.
export async function compactWorkspaceResponses(tx:Executor,workspaceId:string,policy:IdempotencyCachePolicy):Promise<number> {
  const result=await tx.query(`WITH ranked AS (
      SELECT key,row_number() OVER (ORDER BY committed_revision DESC,key DESC) AS position,
        sum(response_bytes) OVER (ORDER BY committed_revision DESC,key DESC) AS bytes
      FROM idempotency_keys WHERE workspace_id=$1 AND response IS NOT NULL AND response_expires_at>now()
    ), compact AS (
      SELECT key FROM ranked WHERE position>$2 OR bytes>$3
      UNION ALL SELECT key FROM idempotency_keys WHERE workspace_id=$1 AND response IS NOT NULL AND response_expires_at<=now()
    ) UPDATE idempotency_keys SET response=NULL,response_bytes=0
      WHERE workspace_id=$1 AND key IN (SELECT key FROM compact) RETURNING key`,[workspaceId,policy.maxEntries,policy.maxBytes]);
  return result.rows.length;
}

export type CleanupResult={scanned:number;workspaces:number;compacted:number};
// Bound each pass independently. Skip busy workspaces rather than holding up
// foreground writes. No timer or cleanup path deletes request/audit records.
export async function cleanupExpiredResponses(db:Database,options:{maxEntries?:number;maxWorkspaces?:number}={}):Promise<CleanupResult> {
  const maxEntries=options.maxEntries??128,maxWorkspaces=options.maxWorkspaces??16;
  if(!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>1000||!Number.isSafeInteger(maxWorkspaces)||maxWorkspaces<1||maxWorkspaces>100)throw new Error('Invalid idempotency cleanup batch');
  const candidates=(await db.query('SELECT workspace_id FROM idempotency_keys WHERE response IS NOT NULL AND response_expires_at<=now() ORDER BY response_expires_at,workspace_id LIMIT $1',[maxEntries])).rows;
  const workspaces=[...new Set(candidates.map(row=>row.workspace_id as string))].slice(0,maxWorkspaces);
  let compacted=0,processed=0;
  for(const workspaceId of workspaces) {
    if(compacted>=maxEntries)break;
    const count=await db.transaction(async tx=>{
      const locked=await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE SKIP LOCKED',[workspaceId]);
      if(!locked.rows.length)return 0;
      const result=await tx.query(`UPDATE idempotency_keys SET response=NULL,response_bytes=0 WHERE workspace_id=$1 AND key IN (
        SELECT key FROM idempotency_keys WHERE workspace_id=$1 AND response IS NOT NULL AND response_expires_at<=now()
        ORDER BY response_expires_at,key LIMIT $2
      ) RETURNING key`,[workspaceId,maxEntries-compacted]);
      return result.rows.length;
    });
    processed++;compacted+=count;
  }
  return {scanned:candidates.length,workspaces:processed,compacted};
}

export function createIdempotencyMaintenance(db:Database,options:{intervalMs?:number;maxEntries?:number;maxWorkspaces?:number;onFailure?:()=>void}={}) {
  const intervalMs=options.intervalMs??60000;
  if(!Number.isSafeInteger(intervalMs)||intervalMs<10||intervalMs>86400000)throw new Error('Invalid idempotency cleanup interval');
  let timer:ReturnType<typeof setInterval>|undefined,pending:Promise<CleanupResult>|undefined,closed=false;
  const stats={passes:0,compacted:0,failed:0};
  function runOnce():Promise<CleanupResult> {
    if(closed)return Promise.resolve({scanned:0,workspaces:0,compacted:0});
    if(pending)return pending;
    pending=cleanupExpiredResponses(db,options).then(result=>{stats.passes++;stats.compacted+=result.compacted;return result;}).finally(()=>{pending=undefined;});
    return pending;
  }
  const trigger=()=>{if(pending||closed)return;void runOnce().catch(()=>{stats.failed++;options.onFailure?.();});};
  function start(){if(closed||timer)return;trigger();timer=setInterval(trigger,intervalMs);timer.unref();}
  async function close(){closed=true;if(timer){clearInterval(timer);timer=undefined;}try{await pending;}catch{/* A scheduled failure is reported without exposing SQL or request data. */}}
  return {start,runOnce,close,stats};
}
