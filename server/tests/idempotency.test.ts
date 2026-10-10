import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Server} from 'node:http';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {openDatabase} from '../db.ts';
import type {Database,Executor} from '../db.ts';
import {createApp} from '../app.ts';
import {addPayment,mutate,putRecord} from '../business.ts';
import type {Identity,Snapshot} from '../business.ts';
import {cleanupExpiredResponses,createIdempotencyMaintenance,DEFAULT_IDEMPOTENCY_CACHE,idempotencyPolicy} from '../idempotency.ts';
import type {IdempotencyCachePolicy} from '../idempotency.ts';
import {emptyData,today} from '../validation.ts';

const external=process.env.IDEMPOTENCY_TEST_DATABASE_URL??process.env.RECOVERY_TEST_DATABASE_URL;
let db:Database,mainScope:Awaited<ReturnType<typeof postgresScope>>|undefined;
const httpServers:Array<{app:ReturnType<typeof createApp>;server:Server}>=[];
async function postgresScope(){
  assert.ok(external,'A dedicated test PostgreSQL URL is required');
  const url=new URL(external);assert.ok(['postgres:','postgresql:'].includes(url.protocol));
  const schema='yunji_idempotency_test_'+randomUUID().replace(/-/g,'');
  assert.match(schema,/^yunji_idempotency_test_[a-f0-9]{32}$/);
  const admin=new pg.Client({connectionString:external});await admin.connect();let created=false;
  try{await admin.query(`CREATE SCHEMA "${schema}" AUTHORIZATION CURRENT_USER`);created=true;}catch(error){await admin.end();throw error;}
  url.searchParams.set('options',`-c search_path=${schema}`);
  return {url:url.toString(),schema,async close(){try{if(created){assert.match(schema,/^yunji_idempotency_test_[a-f0-9]{32}$/);await admin.query(`DROP SCHEMA "${schema}" CASCADE`);created=false;}}finally{await admin.end();}}};
}
before(async()=>{
  if(external){mainScope=await postgresScope();db=await openDatabase({url:mainScope.url});assert.equal((await db.query('SELECT current_schema() AS name')).rows[0].name,mainScope.schema);}
  else db=await openDatabase({dataDir:':memory:'});
});
after(async()=>{
  try{for(const {app,server} of httpServers){await app.locals.closeIdempotencyCleanup();await app.locals.closeMail();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}if(db)await db.close();}
  finally{if(mainScope)await mainScope.close();}
});
async function actor(database=db):Promise<Identity>{
  const userId=randomUUID(),workspaceId=randomUUID(),email=`cache-${randomUUID()}@example.test`;
  await database.transaction(async tx=>{await tx.query('INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)',[userId,email,'隔离验收','test-only-hash']);await tx.query('INSERT INTO workspaces(id,name,owner_id) VALUES($1,$2,$3)',[workspaceId,'幂等隔离空间',userId]);});
  return {userId,workspaceId,email,name:'隔离验收',workspaceName:'幂等隔离空间',sessionHash:'test-only',csrfToken:'test-only',emailVerified:false};
}
const customer=(id:string=randomUUID(),name='测试客户',notes='')=>({id,name,contact:'',phone:'',email:'',industry:'服务',level:'普通客户' as const,date:today(),notes});
const putRequest=(value:ReturnType<typeof customer>,revision:number,key:string=randomUUID())=>({key,revision,method:'PUT',path:`/api/records/customers/${value.id}`,body:{value}});
async function put(who:Identity,value:ReturnType<typeof customer>,revision:number,key:string=randomUUID(),policy:IdempotencyCachePolicy=idempotencyPolicy(),database=db){
  return mutate(database,who,putRequest(value,revision,key),(tx,data)=>putRecord(tx,who.workspaceId,data,'customers',value.id,value),policy);
}
async function counts(who:Identity,database=db){
  const row=(await database.query(`SELECT (SELECT revision FROM workspaces WHERE id=$1) AS revision,
    (SELECT count(*)::int FROM records WHERE workspace_id=$1) AS records,
    (SELECT count(*)::int FROM receipts WHERE workspace_id=$1) AS receipts,
    (SELECT count(*)::int FROM audit_events WHERE workspace_id=$1) AS audits,
    (SELECT count(*)::int FROM idempotency_keys WHERE workspace_id=$1) AS keys,
    (SELECT count(*)::int FROM idempotency_keys WHERE workspace_id=$1 AND response IS NOT NULL) AS cached,
    (SELECT coalesce(sum(response_bytes),0)::bigint FROM idempotency_keys WHERE workspace_id=$1) AS bytes`,[who.workspaceId])).rows[0];
  return {...row,bytes:Number(row.bytes)};
}
async function expire(who:Identity,key?:string){await db.query("UPDATE idempotency_keys SET response_expires_at='2000-01-01' WHERE workspace_id=$1"+(key?' AND key=$2':''),key?[who.workspaceId,key]:[who.workspaceId]);}

test('缓存配置有固定硬上限，只允许注入更小测试值',()=>{
  assert.deepEqual(DEFAULT_IDEMPOTENCY_CACHE,{ttlMs:86400000,maxEntries:32,maxBytes:33554432});
  assert.deepEqual(idempotencyPolicy({ttlMs:0,maxEntries:0,maxBytes:0}),{ttlMs:0,maxEntries:0,maxBytes:0});
  for(const field of ['ttlMs','maxEntries','maxBytes'] as const){for(const value of [-1,0.5,Number.NaN,DEFAULT_IDEMPOTENCY_CACHE[field]+1])assert.throws(()=>idempotencyPolicy({[field]:value}));}
});

test('有效缓存返回原快照并优先于过期If-Match',async()=>{
  const who=await actor(),value=customer(),key=randomUUID(),first=await put(who,value,0,key);
  await put(who,{...value,name:'后续版本'},1);
  const replay=await mutate(db,who,putRequest(value,999,key),async()=>assert.fail('Repeated action must not execute'));
  assert.deepEqual(replay,first);assert.equal((await counts(who)).revision,2);assert.equal((await counts(who)).audits,2);
  const linked=(await db.query('SELECT audit_event_id FROM idempotency_keys WHERE workspace_id=$1 AND key=$2',[who.workspaceId,key])).rows[0];assert.ok(linked.audit_event_id);
});

test('到期但尚未清理的相同请求返回200当前快照和原提交版本',async()=>{
  const app=createApp({db,config:{appOrigin:'http://127.0.0.1:5174',production:false,authRateLimit:1000}}),server=app.listen(0,'127.0.0.1');await once(server,'listening');httpServers.push({app,server});
  const base=`http://127.0.0.1:${(server.address() as any).port}`,origin='http://127.0.0.1:5174';
  const registered=await fetch(base+'/api/auth/register',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email:`http-cache-${randomUUID()}@example.test`,password:'Cache-Tests-2026!',name:'缓存验收',workspaceName:'缓存验收'})});
  assert.equal(registered.status,201);const identity=await registered.json() as any;
  const value=customer(),key=randomUUID(),headers={Origin:origin,'Content-Type':'application/json',Cookie:registered.headers.getSetCookie()[0].split(';')[0],'X-CSRF-Token':identity.csrfToken,'If-Match':'"0"','Idempotency-Key':key};
  const address=base+`/api/records/customers/${value.id}`;
  assert.equal((await fetch(address,{method:'PUT',headers,body:JSON.stringify({value})})).status,200);
  assert.equal((await fetch(address,{method:'PUT',headers:{...headers,'If-Match':'"1"','Idempotency-Key':randomUUID()},body:JSON.stringify({value:{...value,name:'更新之后'}})})).status,200);
  await db.query("UPDATE idempotency_keys SET response_expires_at='2000-01-01' WHERE workspace_id=$1 AND key=$2",[identity.workspace.id,key]);
  const retry=await fetch(address,{method:'PUT',headers,body:JSON.stringify({value})});assert.equal(retry.status,200);const body=await retry.json() as Snapshot;
  assert.equal(body.data.customers[0].name,'更新之后');assert.equal(body.revision,2);assert.deepEqual(body.idempotency,{replayed:true,responseExpired:true,committedRevision:1});
  const state=await counts({workspaceId:identity.workspace.id} as Identity);assert.equal(state.keys,2);assert.equal(state.audits,2);assert.equal(state.records,1);
});

test('压缩后同key不同请求仍冲突，不能借旧revision重新执行',async()=>{
  const who=await actor(),value=customer(),key=randomUUID();await put(who,value,0,key,idempotencyPolicy({maxBytes:0}));
  await assert.rejects(()=>put(who,{...value,name:'伪造新操作'},0,key),(error:any)=>error.code==='IDEMPOTENCY_CONFLICT');
  const row=(await db.query('SELECT response,committed_revision,request_hash FROM idempotency_keys WHERE workspace_id=$1 AND key=$2',[who.workspaceId,key])).rows[0];
  assert.equal(row.response,null);assert.equal(row.committed_revision,1);assert.match(row.request_hash,/^[a-f0-9]{64}$/);assert.equal((await counts(who)).revision,1);
});

test('永久去重凭据按空间隔离，相同key可属于不同空间',async()=>{
  const a=await actor(),b=await actor(),key=randomUUID(),value=customer();await put(a,value,0,key,idempotencyPolicy({ttlMs:0}));await put(b,{...value,name:'另一空间'},0,key);
  const replay=await mutate(db,a,putRequest(value,0,key),async()=>assert.fail('Repeated action must not execute'));
  assert.equal(replay.data.customers[0].name,value.name);assert.ok(replay.idempotency);assert.equal((await counts(b)).cached,1);
});

test('收款响应压缩和并发清理后重复请求始终只记一次',async()=>{
  const who=await actor(),value=customer();await put(who,value,0);
  const order={id:randomUUID(),customerId:value.id,title:'待收款',category:'服务',amount:1000,paidAmount:0,status:'进行中' as const,date:today(),dueDate:today(),notes:''};
  await mutate(db,who,{key:randomUUID(),revision:1,method:'PUT',path:'/api/records/orders/'+order.id,body:{value:order}},(tx,data)=>putRecord(tx,who.workspaceId,data,'orders',order.id,order));
  const payment={id:randomUUID(),orderId:order.id,type:'收款' as const,amount:400,date:today(),notes:''},request={key:randomUUID(),revision:2,method:'POST',path:`/api/orders/${order.id}/payments`,body:payment};
  await mutate(db,who,request,(tx,data)=>addPayment(tx,who.workspaceId,data,order.id,payment));await expire(who,request.key);
  const actions=await Promise.all([cleanupExpiredResponses(db),mutate(db,who,request,async()=>assert.fail('Payment replayed')),cleanupExpiredResponses(db),mutate(db,who,request,async()=>assert.fail('Payment replayed'))]);
  for(const index of [1,3]){const snapshot=actions[index] as Snapshot;assert.equal(snapshot.data.receipts.length,1);assert.equal(snapshot.data.orders[0].paidAmount,400);assert.equal(snapshot.idempotency?.committedRevision,3);}
  const state=await counts(who);assert.equal(state.receipts,1);assert.equal(state.revision,3);assert.equal(state.audits,3);assert.equal(state.keys,3);
});

test('条数预算只保留最后N个快照但保留所有key和审计',async()=>{
  const who=await actor(),value=customer(),policy=idempotencyPolicy({maxEntries:2});let firstKey='';
  for(let index=0;index<6;index++){const key=randomUUID();if(!index)firstKey=key;await put(who,{...value,name:'版本'+index},index,key,policy);}
  const state=await counts(who);assert.equal(state.cached,2);assert.equal(state.keys,6);assert.equal(state.audits,6);
  assert.deepEqual((await db.query('SELECT committed_revision FROM idempotency_keys WHERE workspace_id=$1 AND response IS NOT NULL ORDER BY committed_revision',[who.workspaceId])).rows.map(row=>row.committed_revision),[5,6]);
  const replay=await mutate(db,who,putRequest({...value,name:'版本0'},0,firstKey),async()=>assert.fail('Evicted request re-executed'),policy);
  assert.equal(replay.idempotency?.committedRevision,1);assert.equal(replay.data.customers[0].name,'版本5');
});

test('默认32条上限不随重复编辑无限增长',async()=>{
  const who=await actor(),value=customer();for(let index=0;index<35;index++)await put(who,{...value,name:'版本'+index},index);
  const state=await counts(who);assert.equal(state.cached,32);assert.equal(state.keys,35);assert.equal(state.audits,35);assert.ok(state.bytes<=33554432);
});

test('字节预算使用数据库UTF8 JSON文本并淘汰较旧响应',async()=>{
  const who=await actor(),value=customer(randomUUID(),'中文客户','经营'.repeat(120)),policy=idempotencyPolicy({maxBytes:1400});
  for(let index=0;index<4;index++)await put(who,{...value,name:'客户'+index},index,randomUUID(),policy);
  const state=await counts(who);assert.equal(state.cached,1);assert.ok(state.bytes>700&&state.bytes<=1400);assert.equal(state.keys,4);assert.equal(state.audits,4);
  const rows=(await db.query('SELECT response_bytes,octet_length(response::text) AS actual FROM idempotency_keys WHERE workspace_id=$1 AND response IS NOT NULL',[who.workspaceId])).rows;assert.ok(rows.every(row=>row.response_bytes===row.actual));
});

test('单个响应大于预算或零TTL时业务成功且仅保存永久去重凭据',async()=>{
  for(const policy of [idempotencyPolicy({maxBytes:1}),idempotencyPolicy({ttlMs:0}),idempotencyPolicy({maxEntries:0})]){
    const who=await actor(),value=customer(),key=randomUUID(),first=await put(who,value,0,key,policy);assert.equal(first.data.customers[0].id,value.id);
    const state=await counts(who);assert.equal(state.cached,0);assert.equal(state.bytes,0);assert.equal(state.keys,1);assert.equal(state.audits,1);
    const replay=await mutate(db,who,putRequest(value,999,key),async()=>assert.fail('Receipt must survive without a cached body'),policy);assert.equal(replay.idempotency?.committedRevision,1);
  }
});

test('过期清理按批次和空间上限执行，不删除业务、审计和key',async()=>{
  while((await cleanupExpiredResponses(db,{maxEntries:1000,maxWorkspaces:100})).compacted>0){/* Drain earlier expired caches inside this isolated test schema. */}
  const actors=[];for(let index=0;index<3;index++){const who=await actor();actors.push(who);const value=customer();for(let revision=0;revision<3;revision++)await put(who,{...value,name:'批次'+revision},revision);await expire(who);}
  const result=await cleanupExpiredResponses(db,{maxEntries:2,maxWorkspaces:1});assert.equal(result.scanned,2);assert.equal(result.workspaces,1);assert.equal(result.compacted,2);
  let remaining=0;for(const who of actors){const state=await counts(who);remaining+=state.cached;assert.equal(state.keys,3);assert.equal(state.audits,3);assert.equal(state.records,1);}
  assert.equal(remaining,7);
  while((await cleanupExpiredResponses(db,{maxEntries:2,maxWorkspaces:1})).compacted>0){/* Each call stays independently bounded. */}
  for(const who of actors)assert.equal((await counts(who)).cached,0);
});

test('清理与工作空间写锁兼容，真实PG跳过正忙空间',async()=>{
  const who=await actor(),value=customer();await put(who,value,0);await expire(who);
  let release!:()=>void,locked!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{locked=resolve;});
  const holding=db.transaction(async tx=>{await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[who.workspaceId]);locked();await gate;});await ready;
  try{if(db.engine==='postgres'){assert.equal((await cleanupExpiredResponses(db)).compacted,0);release();await holding;assert.equal((await cleanupExpiredResponses(db)).compacted,1);}else{const cleaning=cleanupExpiredResponses(db);release();await holding;assert.equal((await cleaning).compacted,1);}}
  finally{release();await holding;}
});

test('幂等记录落库失败时业务、审计和revision全部回滚',async()=>{
  const who=await actor(),value=customer(),key=randomUUID();
  const failing:Database={...db,transaction:async<T>(fn:(tx:Executor)=>Promise<T>)=>db.transaction(tx=>fn({query:async(sql,params)=>{if(sql.includes('INSERT INTO idempotency_keys'))throw new Error('Injected receipt write failure');return tx.query(sql,params);}}))};
  await assert.rejects(()=>put(who,value,0,key,idempotencyPolicy(),failing),/Injected receipt write failure/);
  const state=await counts(who);assert.equal(state.revision,0);assert.equal(state.records,0);assert.equal(state.audits,0);assert.equal(state.keys,0);
  assert.equal((await put(who,value,0,key)).revision,1);
});

test('维护器启动有界且不重叠，close等待当前清理并阻止新任务',async()=>{
  let entered!:()=>void,release!:()=>void,calls=0;const reached=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const delayed:Database={...db,query:async(sql,params)=>{if(sql.startsWith('SELECT workspace_id FROM idempotency_keys')){calls++;entered();await gate;}return db.query(sql,params);}};
  const maintenance=createIdempotencyMaintenance(delayed,{intervalMs:10,maxEntries:2,maxWorkspaces:1});maintenance.start();await reached;
  const pending=maintenance.runOnce();assert.equal(pending,maintenance.runOnce());await new Promise(resolve=>setTimeout(resolve,30));assert.equal(calls,1);
  let closed=false;const closing=maintenance.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);release();await closing;await pending;
  const beforeCalls=calls;await new Promise(resolve=>setTimeout(resolve,25));assert.equal(calls,beforeCalls);assert.deepEqual(await maintenance.runOnce(),{scanned:0,workspaces:0,compacted:0});
});

test('004保留旧数据与去重凭据，回填版本、压缩缓存且二次启动不复活',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'yunji-cache-migration-')),dataDir=join(directory,'database');
  let scope:Awaited<ReturnType<typeof postgresScope>>|undefined,old:PGlite|pg.Client|undefined,current:Database|undefined;
  try{
    if(external){scope=await postgresScope();old=new pg.Client({connectionString:scope.url});await old.connect();}
    else{old=new PGlite(dataDir);await old.waitReady;}
    for(const name of ['001_initial.sql','002_history_order_audit.sql','003_account_recovery.sql']){const sql=await readFile(new URL('../migrations/'+name,import.meta.url),'utf8');if(old instanceof PGlite)await old.exec(sql);else await old.query(sql);}
    const userId='legacy-user',workspaceId='legacy-space',value=customer('legacy-customer','保留旧数据'),data={...emptyData(),customers:[value]};
    const seed:Executor={query:async(sql,params)=>{if(old instanceof PGlite)return old.query(sql,params);return old!.query(sql,params);}};
    await seed.query('INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)',[userId,'legacy-cache@example.test','旧账号','unchanged-hash']);
    await seed.query('INSERT INTO workspaces(id,name,owner_id,revision) VALUES($1,$2,$3,35)',[workspaceId,'旧空间',userId]);
    await seed.query("INSERT INTO records(workspace_id,kind,id,payload) VALUES($1,'customers',$2,$3::jsonb)",[workspaceId,value.id,JSON.stringify(value)]);
    await seed.query("INSERT INTO audit_events(id,workspace_id,user_id,action,entity_kind,entity_id) VALUES('legacy-audit',$1,$2,'create','customers',$3)",[workspaceId,userId,value.id]);
    const hash=createHash('sha256').update('{"body":null,"method":"DELETE","path":"/legacy-operation"}').digest('hex');
    for(let revision=1;revision<=35;revision++)await seed.query('INSERT INTO idempotency_keys(workspace_id,key,request_hash,response,created_at) VALUES($1,$2,$3,$4::jsonb,$5)',[workspaceId,'legacy-key-'+revision,hash,JSON.stringify({data,revision}),new Date(Date.now()-(revision===1?3*86400000:3600000)).toISOString()]);
    if(old instanceof PGlite)await old.close();else await old.end();old=undefined;
    const options=scope?{url:scope.url}:{dataDir};current=await openDatabase(options);
    const who:Identity={userId,workspaceId,email:'legacy-cache@example.test',name:'旧账号',workspaceName:'旧空间',csrfToken:'test-only',sessionHash:'test-only',emailVerified:false};
    assert.equal((await current.query('SELECT password_hash FROM users WHERE id=$1',[userId])).rows[0].password_hash,'unchanged-hash');
    const initial=await counts(who,current);assert.equal(initial.keys,35);assert.equal(initial.cached,32);assert.equal(initial.audits,1);assert.equal(initial.records,1);
    assert.equal((await current.query('SELECT count(*)::int AS total FROM idempotency_keys WHERE audit_event_id IS NOT NULL')).rows[0].total,0);
    const metadata=(await current.query("SELECT response,request_hash,committed_revision,response_expires_at FROM idempotency_keys WHERE workspace_id=$1 AND key='legacy-key-1'",[workspaceId])).rows[0];
    assert.equal(metadata.response,null);assert.equal(metadata.request_hash,hash);assert.equal(metadata.committed_revision,1);
    const replay=await mutate(current,who,{key:'legacy-key-1',revision:999,method:'DELETE',path:'/legacy-operation',body:undefined},async()=>assert.fail('Migrated operation must not execute'));assert.equal(replay.idempotency?.committedRevision,1);assert.equal(replay.data.customers[0].name,'保留旧数据');
    await current.close();current=await openDatabase(options);
    const reopened=(await current.query("SELECT response,request_hash,committed_revision,response_expires_at FROM idempotency_keys WHERE workspace_id=$1 AND key='legacy-key-1'",[workspaceId])).rows[0];
    assert.deepEqual(reopened,metadata);assert.equal((await counts(who,current)).keys,35);assert.equal((await counts(who,current)).audits,1);
    assert.deepEqual((await current.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(row=>row.version),[1,2,3,4]);
  }finally{if(old){if(old instanceof PGlite)await old.close();else await old.end();}if(current)await current.close();if(scope)await scope.close();await rm(directory,{recursive:true,force:true});}
});
