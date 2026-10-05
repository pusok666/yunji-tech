import { randomBytes, randomUUID } from 'node:crypto';
import type { Database, Executor } from './db.ts';
import { fail } from './validation.ts';
import { hashPassword, hashToken } from './security.ts';
import { deliver, MailQueue } from './mail.ts';
import type { Mailer } from './mail.ts';

type Purpose='verify_email'|'reset_password';
export interface RecoveryConfig { appOrigin: string; verificationTtlMs?: number; resetTtlMs?: number; mailCooldownMs?: number; mailRateLimit?: number; mailQueueMax?: number; mailTimeoutMs?: number }
function invalid():never { return fail('链接无效或已过期，请重新申请',400,'AUTH_TOKEN_INVALID'); }
const safeToken=(value:unknown):string=>{if(typeof value!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value))invalid();return value as string;};
export function createRecovery({db,config,mailer}:{db:Database;config:RecoveryConfig;mailer?:Mailer}) {
  const queue=new MailQueue({max:config.mailQueueMax});
  const stats={sent:0,failed:0};
  const enabled=!!mailer;
  const ensureEnabled=()=>{if(!enabled)fail('邮件服务尚未配置，请联系管理员',503,'EMAIL_NOT_CONFIGURED');};
  async function allow(scope:string,identity:string,options:{cooldown?:number;max?:number}={}):Promise<boolean> {
    const now=new Date(),windowStart=new Date(now.getTime()-15*60*1000),next=new Date(now.getTime()+(options.cooldown??config.mailCooldownMs??60000));
    const key=hashToken(`${scope}:${identity}`);
    // The UPDATE condition is evaluated under the unique-key row lock. Missing
    // accounts receive the same limiter operations as existing accounts.
    const result=await db.query(`INSERT INTO auth_request_limits(key,window_started_at,attempts,next_allowed_at) VALUES($1,$2,1,$3)
      ON CONFLICT(key) DO UPDATE SET window_started_at=CASE WHEN auth_request_limits.window_started_at<=$4 THEN $2 ELSE auth_request_limits.window_started_at END,
      attempts=CASE WHEN auth_request_limits.window_started_at<=$4 THEN 1 ELSE auth_request_limits.attempts+1 END,next_allowed_at=$3
      WHERE auth_request_limits.next_allowed_at<=$2 AND (auth_request_limits.window_started_at<=$4 OR auth_request_limits.attempts<$5) RETURNING key`,[key,now.toISOString(),next.toISOString(),windowStart.toISOString(),options.max??config.mailRateLimit??5]);
    return result.rows.length>0;
  }
  async function audit(tx:Executor,userId:string,action:string) {
    const workspace=(await tx.query('SELECT id FROM workspaces WHERE owner_id=$1',[userId])).rows[0];
    if(workspace) await tx.query('INSERT INTO audit_events(id,workspace_id,user_id,action,entity_kind,entity_id) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),workspace.id,userId,action,'account',userId]);
  }
  async function issueAndSend(email:string,purpose:Purpose,expectedVersion:number,sessionHash?:string) {
    if(!mailer)return;
    const raw=randomBytes(32).toString('base64url'),id=randomUUID();
    const record=await db.transaction(async tx=>{
      const user=(await tx.query('SELECT id,email,credential_version,email_verified_at FROM users WHERE email=$1 FOR UPDATE',[email])).rows[0];
      if(!user || user.credential_version!==expectedVersion || (purpose==='verify_email'&&user.email_verified_at))return null;
      if(sessionHash && !(await tx.query('SELECT token_hash FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>now()',[sessionHash,user.id])).rows.length)return null;
      // A process may stop between token insertion and SMTP completion. Reclaim
      // only abandoned pending attempts after the send deadline plus a grace
      // period, without invalidating delivered links or another live sender.
      const abandonedBefore=new Date(Date.now()-Math.max((config.mailTimeoutMs??15000)+60000,75000));
      await tx.query("UPDATE auth_tokens SET invalidated_at=now(),delivery_status='failed' WHERE user_id=$1 AND purpose=$2 AND delivery_status='pending' AND consumed_at IS NULL AND invalidated_at IS NULL AND created_at<$3",[user.id,purpose,abandonedBefore.toISOString()]);
      const expires=new Date(Date.now()+(purpose==='verify_email'?(config.verificationTtlMs??24*60*60*1000):(config.resetTtlMs??30*60*1000)));
      // Keep at most three live links; a failed resend leaves earlier links valid.
      const active=(await tx.query('SELECT id FROM auth_tokens WHERE user_id=$1 AND purpose=$2 AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at>now() ORDER BY created_at DESC,id DESC',[user.id,purpose])).rows;
      if(active.length>=3) return null;
      await tx.query('INSERT INTO auth_tokens(id,user_id,purpose,token_hash,email_snapshot,credential_version,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,user.id,purpose,hashToken(raw),user.email,user.credential_version,expires.toISOString()]);
      return {userId:user.id,email:user.email};
    });
    if(!record)return;
    const route=purpose==='verify_email'?'verify-email':'reset-password';
    const url=`${config.appOrigin}/#/${route}?token=${encodeURIComponent(raw)}`;
    const message={to:record.email,subject:purpose==='verify_email'?'云迹科技：验证邮箱':'云迹科技：重置密码',text:purpose==='verify_email'?`请打开以下链接并点击确认，验证你的云迹科技账号邮箱。\n\n${url}\n\n链接仅供本人使用，将在24小时内失效。若非本人操作，请忽略本邮件。`:`请打开以下链接设置新的云迹科技账号密码。\n\n${url}\n\n链接仅供本人使用，将在30分钟内失效。若非本人操作，请忽略本邮件，当前密码不会因此改变。`};
    try {
      await deliver(mailer,message,config.mailTimeoutMs??15000);
      await db.query("UPDATE auth_tokens SET sent_at=now(),delivery_status='sent' WHERE id=$1",[id]);stats.sent++;
    } catch {
      await db.query("UPDATE auth_tokens SET invalidated_at=CASE WHEN consumed_at IS NULL THEN now() ELSE invalidated_at END,delivery_status='failed' WHERE id=$1",[id]);stats.failed++;
    }
  }
  async function enqueue(email:string,purpose:Purpose,sessionHash?:string) {
    const user=(await db.query('SELECT credential_version FROM users WHERE email=$1',[email])).rows[0];
    const version=user?.credential_version??-1;
    return queue.enqueue(async()=>{try{await issueAndSend(email,purpose,version,sessionHash);}catch{stats.failed++;}});
  }
  async function consume(raw:unknown,purpose:Purpose,newPassword?:string) {
    const tokenHash=hashToken(safeToken(raw));
    const candidate=(await db.query('SELECT user_id FROM auth_tokens WHERE token_hash=$1 AND purpose=$2',[tokenHash,purpose])).rows[0];
    if(!candidate)invalid();
    const passwordHash=purpose==='reset_password'?await hashPassword(newPassword!):undefined;
    return db.transaction(async tx=>{
      // Every issuing/consuming/password operation locks users before tokens.
      const user=(await tx.query('SELECT id,email,credential_version FROM users WHERE id=$1 FOR UPDATE',[candidate.user_id])).rows[0];
      const token=(await tx.query('SELECT id,email_snapshot,credential_version FROM auth_tokens WHERE token_hash=$1 AND user_id=$2 AND purpose=$3 AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at>now() FOR UPDATE',[tokenHash,candidate.user_id,purpose])).rows[0];
      if(!user||!token||token.email_snapshot!==user.email||token.credential_version!==user.credential_version)invalid();
      await tx.query('UPDATE auth_tokens SET consumed_at=now() WHERE id=$1',[token.id]);
      if(purpose==='reset_password') {
        await tx.query('UPDATE users SET password_hash=$1,credential_version=credential_version+1,email_verified_at=COALESCE(email_verified_at,now()) WHERE id=$2',[passwordHash,user.id]);
        await tx.query('DELETE FROM sessions WHERE user_id=$1',[user.id]);
        await tx.query('UPDATE auth_tokens SET invalidated_at=now() WHERE user_id=$1 AND consumed_at IS NULL AND invalidated_at IS NULL',[user.id]);
      } else {
        await tx.query('UPDATE users SET email_verified_at=COALESCE(email_verified_at,now()) WHERE id=$1',[user.id]);
        await tx.query("UPDATE auth_tokens SET invalidated_at=now() WHERE user_id=$1 AND purpose='verify_email' AND consumed_at IS NULL AND invalidated_at IS NULL",[user.id]);
      }
      await audit(tx,user.id,purpose==='reset_password'?'password-reset':'email-verified');
      return {email:user.email};
    });
  }
  function notifyReset(email:string) {
    if(mailer)queue.enqueue(async()=>{try{await deliver(mailer,{to:email,subject:'云迹科技：密码已重置',text:'你的云迹科技账号密码已重置，已有登录会话已退出。如果这不是你的操作，请尽快联系管理员并重新申请密码恢复。本邮件不包含密码。'},config.mailTimeoutMs??15000);stats.sent++;}catch{stats.failed++;}});
  }
  return {enabled,ensureEnabled,allow,enqueue,consume,notifyReset,queue,stats};
}
