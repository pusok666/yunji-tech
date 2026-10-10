import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Database } from './db.ts';
import { addMovement, addPayment, deleteRecord, mutate, parseId, parseKind, putRecord, readSnapshot, restoreBackup } from './business.ts';
import type { Identity } from './business.ts';
import { fail, HttpError, parse } from './validation.ts';
import { rulesReply } from './assistant.ts';
import { checkPassword, hashPassword, hashToken as sha, constantEqual as equal } from './security.ts';
import { createSmtpMailer, validateSmtp } from './mail.ts';
import type { Mailer, SmtpConfig } from './mail.ts';
import { createRecovery } from './recovery.ts';
import type { RecoveryConfig } from './recovery.ts';
import { createIdempotencyMaintenance, idempotencyPolicy } from './idempotency.ts';
import type { IdempotencyCachePolicy } from './idempotency.ts';

export interface AppConfig extends RecoveryConfig { production: boolean; inviteCode?: string; sessionTtlMs?: number; authRateLimit?: number; trustProxy?: boolean; staticDir?: string; smtp?: SmtpConfig; requireVerifiedEmail?: boolean; idempotencyCache?:Partial<IdempotencyCachePolicy> }
const cookieName = 'yunji_commercial_session';
const emailSchema = z.string().trim().email().max(254).transform(v => v.toLowerCase());
const passwordSchema = z.string().min(12, '密码至少 12 位').max(128);
function tokenFrom(req: Request): string | undefined { return req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(`${cookieName}=`))?.slice(cookieName.length+1); }
const who = (res: Response) => res.locals.identity as Identity;
const sessionBody = (identity: Identity,auth:{emailEnabled:boolean;verificationRequired:boolean}) => ({ user: { id: identity.userId, email: identity.email, name: identity.name,emailVerified:identity.emailVerified }, workspace: { id: identity.workspaceId, name: identity.workspaceName, role: 'owner' }, csrfToken: identity.csrfToken,auth });
const businessHeaders = (req: Request) => {
  const match = req.get('If-Match'); const key = req.get('Idempotency-Key');
  if (!match || !/^"\d+"$/.test(match) || !Number.isSafeInteger(Number(match.slice(1,-1)))) fail('需要 If-Match 快照版本', 428, 'REVISION_REQUIRED');
  if (!key || !/^[A-Za-z0-9_-]{8,120}$/.test(key)) fail('需要有效的 Idempotency-Key 请求编号');
  return { revision: Number(match.slice(1,-1)), key, method: req.method, path: req.path, body: req.body };
};

export function createApp({ db, config,mailer }: { db: Database; config: AppConfig; mailer?:Mailer }) {
  let origin: URL;
  try { origin = new URL(config.appOrigin); } catch { throw new Error('APP_ORIGIN 必须为有效地址'); }
  if (origin.origin !== config.appOrigin || !['http:','https:'].includes(origin.protocol)) throw new Error('APP_ORIGIN 只能包含协议、域名和端口');
  if (config.production && (origin.protocol !== 'https:' || !config.inviteCode || config.inviteCode.length < 16 || db.engine !== 'postgres')) throw new Error('生产环境必须配置 HTTPS APP_ORIGIN、至少 16 位邀请码以及 PostgreSQL DATABASE_URL');
  if(config.production&&!config.smtp)throw new Error('生产环境必须配置 SMTP 并强制验证邮箱');
  if(config.smtp)validateSmtp(config.smtp);
  const actualMailer=mailer??(config.smtp?createSmtpMailer(config.smtp):undefined);
  const auth={emailEnabled:!!actualMailer,verificationRequired:config.production||!!config.requireVerifiedEmail};
  if(auth.verificationRequired&&!auth.emailEnabled)throw new Error('要求邮箱验证时必须配置邮件服务');
  const recovery=createRecovery({db,config,mailer:actualMailer});
  const cache=idempotencyPolicy(config.idempotencyCache);
  const maintenance=createIdempotencyMaintenance(db,{onFailure:()=>console.error('[idempotency] cleanup failed')});
  const app = express(); app.disable('x-powered-by');
  app.locals.drainMail=()=>recovery.queue.drain();app.locals.closeMail=()=>recovery.queue.close();app.locals.mailStats=recovery.stats;
  app.locals.startIdempotencyCleanup=maintenance.start;app.locals.runIdempotencyCleanup=maintenance.runOnce;app.locals.closeIdempotencyCleanup=maintenance.close;app.locals.idempotencyCleanupStats=maintenance.stats;
  if (config.trustProxy) app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' });
    if (config.production) res.set('Strict-Transport-Security', 'max-age=31536000');
    if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'yunji-commercial', database: db.engine }));
  app.get('/api/auth/capabilities',(_req,res)=>res.json(auth));
  app.use('/api', express.json({ limit: '5mb', strict: true }));
  app.use('/api', (req, _res, next) => {
    if (!['GET','HEAD','OPTIONS'].includes(req.method) && req.get('Origin') !== config.appOrigin) return next(new HttpError(403, '请求来源不受信任', 'ORIGIN_REJECTED'));
    next();
  });
  const attempts = new Map<string, { count: number; reset: number }>();
  const rateLimit = (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    if (attempts.size > 5000) for (const [key, value] of attempts) if (value.reset <= now) attempts.delete(key);
    const key = req.ip ?? 'unknown'; let bucket = attempts.get(key);
    if (!bucket || bucket.reset <= now) { bucket = { count: 0, reset: now+15*60*1000 }; attempts.set(key, bucket); }
    bucket.count++;
    if (bucket.count > (config.authRateLimit ?? (config.production ? 20 : 100))) { res.set('Retry-After', String(Math.ceil((bucket.reset-now)/1000))); return next(new HttpError(429, '尝试过于频繁，请稍后再试', 'RATE_LIMITED')); }
    next();
  };
  const ttl = config.sessionTtlMs ?? 7*24*60*60*1000;
  const setCookie = (res: Response, token: string) => res.cookie(cookieName, token, { httpOnly: true, secure: config.production, sameSite: 'lax', path: '/', maxAge: ttl });
  const newSession = async (tx: any, userId: string, workspaceId: string) => {
    const token = randomBytes(32).toString('hex'), csrfToken = randomBytes(32).toString('hex');
    await tx.query('DELETE FROM sessions WHERE expires_at <= now()');
    await tx.query('INSERT INTO sessions(token_hash,user_id,workspace_id,csrf_token,expires_at) VALUES($1,$2,$3,$4,$5)', [sha(token), userId, workspaceId, csrfToken, new Date(Date.now()+ttl).toISOString()]);
    return { token, csrfToken };
  };
  app.post('/api/auth/register', rateLimit, async (req, res) => {
    const input = parse(z.object({ email: emailSchema, password: passwordSchema, name: z.string().trim().min(1).max(120), workspaceName: z.string().trim().min(1).max(120), inviteCode: z.string().max(256).optional() }).strict(), req.body);
    if (config.inviteCode && !equal(input.inviteCode ?? '', config.inviteCode)) fail('邀请码不正确', 403, 'INVITE_REQUIRED');
    const passwordHash = await hashPassword(input.password); const userId = randomUUID(), workspaceId = randomUUID();
    try {
      const session = await db.transaction(async tx => {
        await tx.query('INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)', [userId, input.email, input.name, passwordHash]);
        await tx.query('INSERT INTO workspaces(id,name,owner_id) VALUES($1,$2,$3)', [workspaceId, input.workspaceName, userId]);
        return newSession(tx, userId, workspaceId);
      });
      setCookie(res, session.token);
      let emailDelivery:'queued'|'disabled'|'unavailable'='disabled';
      if(auth.emailEnabled) { try { emailDelivery=await recovery.enqueue(input.email,'verify_email',sha(session.token))?'queued':'unavailable'; } catch { emailDelivery='unavailable'; } }
      res.status(201).json({...sessionBody({ userId, workspaceId, email: input.email, name: input.name, workspaceName: input.workspaceName, csrfToken: session.csrfToken, sessionHash: sha(session.token),emailVerified:false },auth),emailDelivery});
    } catch (error: any) { if (error.code === '23505') fail('该邮箱已注册，请登录', 409, 'EMAIL_EXISTS'); throw error; }
  });
  app.post('/api/auth/login', rateLimit, async (req, res) => {
    const input = parse(z.object({ email: emailSchema, password: z.string().min(1).max(128) }).strict(), req.body);
    const user = (await db.query('SELECT u.id,u.email,u.name,u.password_hash,u.email_verified_at,w.id AS workspace_id,w.name AS workspace_name FROM users u JOIN workspaces w ON w.owner_id=u.id WHERE u.email=$1', [input.email])).rows[0];
    const valid = await checkPassword(input.password, user?.password_hash ?? 'scrypt:00000000000000000000000000000000:' + '0'.repeat(128));
    if (!user || !valid) fail('邮箱或密码不正确', 401, 'INVALID_CREDENTIALS');
    const session = await db.transaction(async tx => {
      // Serialize with password changes. A slow login that verified the old hash
      // cannot recreate a valid session after the password-change transaction.
      const current = (await tx.query('SELECT password_hash FROM users WHERE id=$1 FOR UPDATE', [user.id])).rows[0];
      if (!current || current.password_hash !== user.password_hash) fail('登录状态已变化，请重新输入密码', 401, 'INVALID_CREDENTIALS');
      return newSession(tx, user.id, user.workspace_id);
    });
    setCookie(res, session.token);
    res.json(sessionBody({ userId: user.id, workspaceId: user.workspace_id, email: user.email, name: user.name, workspaceName: user.workspace_name, csrfToken: session.csrfToken, sessionHash: sha(session.token),emailVerified:!!user.email_verified_at },auth));
  });
  const mailIpLimit=async(req:Request)=>{if(!await recovery.allow('mail-ip',req.ip??'unknown',{cooldown:0,max:config.authRateLimit??30}))fail('尝试过于频繁，请稍后再试',429,'RATE_LIMITED');};
  app.post('/api/auth/password/forgot',async(req,res)=>{
    recovery.ensureEnabled();const input=parse(z.object({email:emailSchema}).strict(),req.body);await mailIpLimit(req);
    if(await recovery.allow('forgot-email',input.email))await recovery.enqueue(input.email,'reset_password');
    res.status(202).json({ok:true,message:'如果该邮箱已注册，我们会发送密码重置邮件。'});
  });
  app.post('/api/auth/verification/confirm',async(req,res)=>{
    recovery.ensureEnabled();await mailIpLimit(req);
    const input=parse(z.object({token:z.unknown()}).strict(),req.body);
    await recovery.consume(input.token,'verify_email');res.json({ok:true});
  });
  app.post('/api/auth/password/reset',async(req,res)=>{
    recovery.ensureEnabled();await mailIpLimit(req);
    const input=parse(z.object({token:z.unknown(),newPassword:passwordSchema}).strict(),req.body);
    const result=await recovery.consume(input.token,'reset_password',input.newPassword);recovery.notifyReset(result.email);
    // A late reset response must not overwrite a newer login's cookie. The
    // target account's old sessions were revoked in the recovery transaction.
    res.json({ok:true,relogin:true});
  });
  app.use('/api', async (req, res, next) => {
    const token = tokenFrom(req);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) fail('请先登录', 401, 'UNAUTHENTICATED');
    const row = (await db.query('SELECT s.token_hash,s.user_id,s.workspace_id,s.csrf_token,u.email,u.name,u.email_verified_at,w.name AS workspace_name FROM sessions s JOIN users u ON u.id=s.user_id JOIN workspaces w ON w.id=s.workspace_id AND w.owner_id=u.id WHERE s.token_hash=$1 AND s.expires_at>now()', [sha(token)])).rows[0];
    if (!row) fail('登录已失效，请重新登录', 401, 'UNAUTHENTICATED');
    const identity: Identity = { userId: row.user_id, workspaceId: row.workspace_id, sessionHash: row.token_hash, csrfToken: row.csrf_token, email: row.email, name: row.name, workspaceName: row.workspace_name,emailVerified:!!row.email_verified_at };
    res.locals.identity = identity;
    if (!['GET','HEAD','OPTIONS'].includes(req.method) && !equal(req.get('X-CSRF-Token') ?? '', identity.csrfToken)) fail('安全校验失败，请刷新页面后重试', 403, 'CSRF_REJECTED');
    next();
  });
  app.get('/api/auth/session', (_req, res) => res.json(sessionBody(who(res),auth)));
  app.post('/api/auth/logout', async (_req, res) => { await db.query('DELETE FROM sessions WHERE token_hash=$1', [who(res).sessionHash]); res.clearCookie(cookieName, { path: '/', httpOnly: true, secure: config.production, sameSite: 'lax' }); res.json({ ok: true }); });
  app.post('/api/auth/password', rateLimit, async (req, res) => {
    const input = parse(z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema }).strict(), req.body); const identity = who(res);
    const user = (await db.query('SELECT password_hash FROM users WHERE id=$1', [identity.userId])).rows[0];
    if (!user || !await checkPassword(input.currentPassword, user.password_hash)) fail('当前密码不正确', 400);
    const hash = await hashPassword(input.newPassword);
    await db.transaction(async tx => {
      const current=(await tx.query('SELECT password_hash FROM users WHERE id=$1 FOR UPDATE',[identity.userId])).rows[0];
      if(!current||current.password_hash!==user.password_hash)fail('密码已变更，请重新登录后重试',409);
      if(!(await tx.query('SELECT token_hash FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>now()',[identity.sessionHash,identity.userId])).rows.length)fail('登录已失效，请重新登录',401,'UNAUTHENTICATED');
      const result = await tx.query('UPDATE users SET password_hash=$1,credential_version=credential_version+1 WHERE id=$2 AND password_hash=$3 RETURNING id', [hash, identity.userId, user.password_hash]);
      if (!result.rows.length) fail('密码已变更，请重新登录后重试', 409);
      await tx.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2', [identity.userId, identity.sessionHash]);
      await tx.query('UPDATE auth_tokens SET invalidated_at=now() WHERE user_id=$1 AND consumed_at IS NULL AND invalidated_at IS NULL',[identity.userId]);
      await tx.query('INSERT INTO audit_events(id,workspace_id,user_id,action,entity_kind,entity_id) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), identity.workspaceId, identity.userId, 'password-change', 'account', identity.userId]);
    });
    res.json({ ok: true });
  });
  app.post('/api/auth/verification/request',async(req,res)=>{
    recovery.ensureEnabled();await mailIpLimit(req);const identity=who(res);
    parse(z.object({}).strict(),req.body??{});
    if(!await recovery.allow('verify-user',identity.userId))fail('请稍后再申请验证邮件',429,'RATE_LIMITED');
    if(!await recovery.enqueue(identity.email,'verify_email',identity.sessionHash))fail('邮件队列繁忙，请稍后重试',503,'MAIL_QUEUE_BUSY');
    res.status(202).json({ok:true,emailDelivery:'queued'});
  });
  app.use('/api',(_req,res,next)=>{if(auth.verificationRequired&&!who(res).emailVerified)fail('请先验证邮箱后使用经营管理功能',403,'EMAIL_NOT_VERIFIED');next();});
  // Use a transaction for coherent snapshots across all tables during concurrent writes.
  const snapshot = (identity: Identity) => db.transaction(async tx => { await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [identity.workspaceId]); return readSnapshot(tx, identity.workspaceId); });
  app.get('/api/data', async (_req, res) => res.json(await snapshot(who(res))));
  app.put('/api/records/:kind/:id', async (req, res) => {
    const identity = who(res), kind = parseKind(req.params.kind), id = parseId(req.params.id);
    const body = parse(z.object({ value: z.unknown() }).strict(), req.body);
    res.json(await mutate(db, identity, businessHeaders(req), (tx, data) => putRecord(tx, identity.workspaceId, data, kind, id, body.value),cache));
  });
  app.delete('/api/records/:kind/:id', async (req, res) => {
    const identity = who(res), kind = parseKind(req.params.kind), id = parseId(req.params.id);
    res.json(await mutate(db, identity, businessHeaders(req), (tx, data) => deleteRecord(tx, identity.workspaceId, data, kind, id),cache));
  });
  app.post('/api/orders/:id/payments', async (req, res) => {
    const identity = who(res), id = parseId(req.params.id);
    res.json(await mutate(db, identity, businessHeaders(req), (tx, data) => addPayment(tx, identity.workspaceId, data, id, req.body),cache));
  });
  app.post('/api/products/:id/stock-movements', async (req, res) => {
    const identity = who(res), id = parseId(req.params.id);
    res.json(await mutate(db, identity, businessHeaders(req), (tx, data) => addMovement(tx, identity.workspaceId, data, id, req.body),cache));
  });
  app.get('/api/audit', async (_req, res) => {
    const events = (await db.query('SELECT id,action,entity_kind AS "entityKind",entity_id AS "entityId",created_at AS "createdAt",before_state AS before,after_state AS after FROM audit_events WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 200', [who(res).workspaceId])).rows;
    res.json({ events });
  });
  app.get('/api/backup', async (_req, res) => { const result = await snapshot(who(res)); res.json({ format: 'yunji-commercial-backup', version: 1, exportedAt: new Date().toISOString(), ...result }); });
  app.post('/api/restore', async (req, res) => { const identity = who(res); res.json(await mutate(db, identity, businessHeaders(req), (tx, data) => restoreBackup(tx, identity.workspaceId, data, req.body),cache)); });
  app.post('/api/assistant', async (req, res) => {
    const body = parse(z.object({ question: z.string().trim().min(1).max(2000), history: z.array(z.object({ role: z.enum(['user','assistant']), content: z.string().max(10000) }).strict()).max(20).optional() }).strip(), req.body);
    const { data } = await snapshot(who(res)); res.json({ answer: rulesReply(body.question, data), mode: 'rules' });
  });
  app.use('/api', (_req, _res, next) => next(new HttpError(404, '接口不存在', 'NOT_FOUND')));
  if (config.production || config.staticDir) {
    app.use((_req, res, next) => { res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"); next(); });
    app.use(express.static(resolve(config.staticDir ?? 'dist'), { index: 'index.html', maxAge: 0 }));
  }
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
    if (error.type === 'entity.too.large') { res.status(413).json({ error: '请求内容过大，最大为 5 MB', code: 'BODY_TOO_LARGE' }); return; }
    if (error instanceof SyntaxError && 'body' in error) { res.status(400).json({ error: 'JSON 格式不正确', code: 'INVALID_JSON' }); return; }
    console.error('[api] request failed', { type: error?.name ?? 'Error', code: error?.code ?? 'UNEXPECTED' });
    res.status(500).json({ error: '服务暂时无法处理请求，请稍后重试', code: 'INTERNAL_ERROR' });
  });
  return app;
}
