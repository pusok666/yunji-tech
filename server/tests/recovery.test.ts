import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { openDatabase } from '../db.ts';
import type { Database, Executor } from '../db.ts';
import { createApp } from '../app.ts';
import type { AppConfig } from '../app.ts';
import type { Mailer, MailMessage } from '../mail.ts';
import { hashToken } from '../security.ts';

const origin='http://127.0.0.1:5174',password='Recovery-Test-2026!',newPassword='Recovered-Test-2026!';
let db:Database;
let schemaAdmin:pg.Client|undefined,testSchema:string|undefined,schemaCreated=false;
const running:Array<{server:Server;app:ReturnType<typeof createApp>}>=[];
before(async()=>{
  const external=process.env.RECOVERY_TEST_DATABASE_URL;
  if(!external){db=await openDatabase({dataDir:':memory:'});return;}
  const scoped=new URL(external);assert.ok(['postgres:','postgresql:'].includes(scoped.protocol),'Expected a dedicated PostgreSQL test database URL');
  testSchema='yunji_recovery_test_'+randomUUID().replace(/-/g,'');
  assert.match(testSchema,/^yunji_recovery_test_[a-f0-9]{32}$/);
  schemaAdmin=new pg.Client({connectionString:external});await schemaAdmin.connect();
  await schemaAdmin.query(`CREATE SCHEMA "${testSchema}" AUTHORIZATION CURRENT_USER`);schemaCreated=true;
  scoped.searchParams.set('options',`-c search_path=${testSchema}`);
  db=await openDatabase({url:scoped.toString()});
  assert.equal((await db.query('SELECT current_schema() AS name')).rows[0].name,testSchema);
});
after(async()=>{
  try {
    for(const h of running){await h.app.locals.closeMail();h.server.closeAllConnections();await new Promise<void>(resolve=>h.server.close(()=>resolve()));}
    if(db)await db.close();
    if(schemaCreated&&schemaAdmin&&testSchema){assert.match(testSchema,/^yunji_recovery_test_[a-f0-9]{32}$/);await schemaAdmin.query(`DROP SCHEMA "${testSchema}" CASCADE`);schemaCreated=false;}
  } finally {if(schemaAdmin)await schemaAdmin.end();}
});
class FakeMailer implements Mailer {
  messages:MailMessage[]=[];fail=false;hold:Promise<void>|undefined;
  async send(message:MailMessage){this.messages.push({...message});if(this.hold)await this.hold;if(this.fail)throw new Error('Test SMTP rejected private message');}
}
async function harness(options:Partial<AppConfig>={},mailer:FakeMailer|undefined=new FakeMailer(),database=db) {
  const config:AppConfig={appOrigin:origin,production:false,requireVerifiedEmail:!!mailer,authRateLimit:1000,mailCooldownMs:0,mailRateLimit:1000,...options};
  const app=createApp({db:database,config,mailer});const server=app.listen(0,'127.0.0.1');await once(server,'listening');running.push({app,server});
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  const request=async(method:string,path:string,body?:unknown,headers:Record<string,string>={})=>{
    const response=await fetch(base+path,{method,headers:{Origin:config.appOrigin,...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,body:await response.json() as any,response};
  };
  const register=async()=>{
    const email=`recovery-${randomUUID()}@example.test`;
    const r=await request('POST','/api/auth/register',{email,password,name:'邮件验收',workspaceName:'隔离测试',...(config.inviteCode?{inviteCode:config.inviteCode}:{})});
    assert.equal(r.status,201);
    return {email,id:r.body.user.id,workspaceId:r.body.workspace.id,body:r.body,headers:{Cookie:r.response.headers.getSetCookie()[0].split(';')[0],'X-CSRF-Token':r.body.csrfToken}};
  };
  return {app,request,register,mailer,drain:()=>app.locals.drainMail() as Promise<void>};
}
function tokenOf(mailer:FakeMailer,email:string,route:'verify-email'|'reset-password') {
  const message=[...mailer.messages].reverse().find(m=>m.to===email&&m.text.includes(`/#/${route}?token=`));
  assert.ok(message,'Expected an in-memory test mail');
  const match=message.text.match(/token=([A-Za-z0-9_-]{43})/);assert.ok(match,'Expected a recovery token inside in-memory mail');return match[1];
}

test('无SMTP时能力明确关闭且本地注册/经营数据保持兼容',async()=>{
  const h=await harness({requireVerifiedEmail:false},undefined); // Explicitly replace the default below.
  const app=createApp({db,config:{appOrigin:origin,production:false}});const server=app.listen(0,'127.0.0.1');await once(server,'listening');running.push({app,server});
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  const capabilities=await fetch(base+'/api/auth/capabilities');assert.deepEqual(await capabilities.json(),{emailEnabled:false,verificationRequired:false});
  const response=await fetch(base+'/api/auth/register',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email:`local-${randomUUID()}@example.test`,password,name:'本地',workspaceName:'本地空间'})});
  assert.equal(response.status,201);const session=await response.json() as any;assert.equal(session.emailDelivery,'disabled');assert.equal(session.user.emailVerified,false);
  const cookie=response.headers.getSetCookie()[0].split(';')[0];assert.equal((await fetch(base+'/api/data',{headers:{Cookie:cookie}})).status,200);
  const forgot=await fetch(base+'/api/auth/password/forgot',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email:'local@example.test'})});
  assert.equal(forgot.status,503);assert.equal((await forgot.json() as any).code,'EMAIL_NOT_CONFIGURED');await h.drain();
});
test('生产强制验证、要求完整SMTP配置，注入fake不会真实发信',async()=>{
  const postgresShape={...db,engine:'postgres' as const};
  const config={appOrigin:'https://yunji.example.test',production:true,inviteCode:'test-only-invitation-2026',requireVerifiedEmail:false};
  assert.throws(()=>createApp({db:postgresShape,config,mailer:new FakeMailer()}));
  assert.throws(()=>createApp({db:postgresShape,config:{...config,smtp:{host:'smtp.example.test',port:587,user:'',password:'',from:'bad'}},mailer:new FakeMailer()}));
  const h=await harness({...config,smtp:{host:'smtp.example.test',port:587,user:'test',password:'not-real',from:'no-reply@example.test'}},new FakeMailer(),postgresShape);
  const result=await h.request('GET','/api/auth/capabilities');assert.deepEqual(result.body,{emailEnabled:true,verificationRequired:true});
  const actor=await h.register();assert.equal((await h.request('GET','/api/data',undefined,actor.headers)).body.code,'EMAIL_NOT_VERIFIED');await h.drain();
});
test('未验证业务闸门由服务端执行，确认邮箱后原会话可读取数据',async()=>{
  const h=await harness(),actor=await h.register();await h.drain();
  assert.equal(actor.body.emailDelivery,'queued');assert.equal(actor.body.user.emailVerified,false);
  for(const route of ['/api/data','/api/backup','/api/audit'])assert.equal((await h.request('GET',route,undefined,actor.headers)).body.code,'EMAIL_NOT_VERIFIED');
  const token=tokenOf(h.mailer!,actor.email,'verify-email');
  assert.equal((await h.request('POST','/api/auth/verification/confirm',{token})).status,200);
  assert.equal((await h.request('GET','/api/auth/session',undefined,actor.headers)).body.user.emailVerified,true);
  assert.equal((await h.request('GET','/api/data',undefined,actor.headers)).status,200);
  assert.equal((await h.request('POST','/api/auth/verification/confirm',{token})).body.code,'AUTH_TOKEN_INVALID');
});
test('Origin/CSRF保护及验证申请不能伪造收件账号',async()=>{
  const h=await harness(),actor=await h.register();await h.drain();
  assert.equal((await h.request('POST','/api/auth/verification/request',{}, {...actor.headers,'X-CSRF-Token':'wrong'})).status,403);
  assert.equal((await h.request('POST','/api/auth/verification/request',{email:'other@example.test'},actor.headers)).status,400);
  assert.equal((await h.request('POST','/api/auth/password/forgot',{email:actor.email},{Origin:'https://evil.example'})).status,403);
  const token=tokenOf(h.mailer!,actor.email,'verify-email');
  assert.equal((await h.request('POST','/api/auth/verification/confirm',{token},{Origin:'https://evil.example'})).status,403);
  assert.ok(h.mailer!.messages.every(m=>m.to===actor.email));
});
test('令牌只存散列；用途、邮箱快照和过期校验失败不会修改账号',async()=>{
  const h=await harness(),actor=await h.register();await h.drain();const token=tokenOf(h.mailer!,actor.email,'verify-email');
  const stored=(await db.query('SELECT token_hash FROM auth_tokens WHERE user_id=$1',[actor.id])).rows;assert.ok(stored.every(row=>row.token_hash!==token));assert.ok(stored.some(row=>row.token_hash===hashToken(token)));
  assert.equal((await h.request('POST','/api/auth/password/reset',{token,newPassword})).body.code,'AUTH_TOKEN_INVALID');
  await db.query("UPDATE auth_tokens SET email_snapshot='different@example.test' WHERE token_hash=$1",[hashToken(token)]);
  assert.equal((await h.request('POST','/api/auth/verification/confirm',{token})).body.code,'AUTH_TOKEN_INVALID');
  await db.query("UPDATE auth_tokens SET email_snapshot=$1,expires_at='2000-01-01' WHERE token_hash=$2",[actor.email,hashToken(token)]);
  assert.equal((await h.request('POST','/api/auth/verification/confirm',{token})).body.code,'AUTH_TOKEN_INVALID');
  assert.equal((await h.request('GET','/api/auth/session',undefined,actor.headers)).body.user.emailVerified,false);
});
test('找回对存在/未知邮箱与账号冷却返回同一202',async()=>{
  const h=await harness({mailCooldownMs:60000}),actor=await h.register();await h.drain();
  const first=await h.request('POST','/api/auth/password/forgot',{email:actor.email});
  const cooldown=await h.request('POST','/api/auth/password/forgot',{email:actor.email});
  const missing=await h.request('POST','/api/auth/password/forgot',{email:`missing-${randomUUID()}@example.test`});
  assert.equal(first.status,202);assert.deepEqual({status:cooldown.status,body:cooldown.body},{status:first.status,body:first.body});assert.deepEqual({status:missing.status,body:missing.body},{status:first.status,body:first.body});await h.drain();
  assert.equal(h.mailer!.messages.filter(m=>m.text.includes('/#/reset-password')).length,1);
});
test('密码恢复证明邮箱归属，撤销所有旧会话并使旧密码和链接失效',async()=>{
  const h=await harness(),actor=await h.register();await h.drain();
  const second=await h.request('POST','/api/auth/login',{email:actor.email,password});const secondCookie=second.response.headers.getSetCookie()[0].split(';')[0];
  await h.request('POST','/api/auth/password/forgot',{email:actor.email});await h.drain();const token=tokenOf(h.mailer!,actor.email,'reset-password');
  assert.equal((await h.request('POST','/api/auth/password/reset',{token,newPassword})).status,200);await h.drain();
  assert.equal((await h.request('GET','/api/auth/session',undefined,actor.headers)).status,401);assert.equal((await h.request('GET','/api/auth/session',undefined,{Cookie:secondCookie})).status,401);
  assert.equal((await h.request('POST','/api/auth/login',{email:actor.email,password})).status,401);
  const login=await h.request('POST','/api/auth/login',{email:actor.email,password:newPassword});assert.equal(login.status,200);assert.equal(login.body.user.emailVerified,true);
  assert.equal((await h.request('POST','/api/auth/password/reset',{token,newPassword:password})).body.code,'AUTH_TOKEN_INVALID');
  assert.ok(h.mailer!.messages.some(m=>m.subject==='云迹科技：密码已重置'&&!m.text.includes(newPassword)));
});
test('同一令牌并发恢复只有一个成功',async()=>{
  const h=await harness(),actor=await h.register();await h.drain();await h.request('POST','/api/auth/password/forgot',{email:actor.email});await h.drain();const token=tokenOf(h.mailer!,actor.email,'reset-password');
  const results=await Promise.all([h.request('POST','/api/auth/password/reset',{token,newPassword}),h.request('POST','/api/auth/password/reset',{token,newPassword:password})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,400]);await h.drain();
});
test('恢复只修改令牌所属账号且不清除其他账号浏览器Cookie',async()=>{
  const h=await harness(),actorA=await h.register(),actorB=await h.register();await h.drain();
  const otherA=await h.request('POST','/api/auth/login',{email:actorA.email,password});const otherCookie=otherA.response.headers.getSetCookie()[0].split(';')[0];
  await h.request('POST','/api/auth/password/forgot',{email:actorB.email});await h.drain();const token=tokenOf(h.mailer!,actorB.email,'reset-password');
  assert.equal((await h.request('POST','/api/auth/password/reset',{token,newPassword,userId:actorA.id},actorA.headers)).status,400);
  const reset=await h.request('POST','/api/auth/password/reset',{token,newPassword},actorA.headers);assert.equal(reset.status,200);assert.equal(reset.response.headers.getSetCookie().length,0);
  assert.equal((await h.request('GET','/api/auth/session',undefined,actorA.headers)).status,200);
  assert.equal((await h.request('GET','/api/auth/session',undefined,{Cookie:otherCookie})).status,200);
  assert.equal((await h.request('GET','/api/auth/session',undefined,actorB.headers)).status,401);
  assert.equal((await h.request('POST','/api/auth/login',{email:actorA.email,password})).status,200);await h.drain();
});
test('晚到恢复响应没有Set-Cookie，事务完成后新登录的会话保持有效',async()=>{
  let gateEmail:string|undefined,release!:()=>void,committed!:()=>void;
  const responseGate=new Promise<void>(resolve=>{release=resolve;}),commitReached=new Promise<void>(resolve=>{committed=resolve;});
  const delayed:Database={...db,transaction:async<T>(fn:(tx:Executor)=>Promise<T>):Promise<T>=>{const result=await db.transaction(fn);if(gateEmail&&result&&typeof result==='object'&&(result as any).email===gateEmail){committed();await responseGate;}return result;}};
  const h=await harness({},new FakeMailer(),delayed),actor=await h.register();await h.drain();
  await h.request('POST','/api/auth/password/forgot',{email:actor.email});await h.drain();const token=tokenOf(h.mailer!,actor.email,'reset-password');gateEmail=actor.email;
  const pending=h.request('POST','/api/auth/password/reset',{token,newPassword});
  await commitReached;
  try {
    const login=await h.request('POST','/api/auth/login',{email:actor.email,password:newPassword});assert.equal(login.status,200);
    const cookie=login.response.headers.getSetCookie()[0].split(';')[0];release();const reset=await pending;
    assert.equal(reset.status,200);assert.equal(reset.response.headers.getSetCookie().length,0);
    assert.equal((await h.request('GET','/api/auth/session',undefined,{Cookie:cookie})).status,200);await h.drain();
  } finally {release();}
});
test('同账号不同令牌并发恢复只有一个成功，其他链接撤销',async()=>{
  const h=await harness(),actor=await h.register();await h.drain();await h.request('POST','/api/auth/password/forgot',{email:actor.email});await h.drain();const first=tokenOf(h.mailer!,actor.email,'reset-password');
  await h.request('POST','/api/auth/password/forgot',{email:actor.email});await h.drain();const second=tokenOf(h.mailer!,actor.email,'reset-password');assert.ok(first!==second);
  const results=await Promise.all([h.request('POST','/api/auth/password/reset',{token:first,newPassword}),h.request('POST','/api/auth/password/reset',{token:second,newPassword:password})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,400]);await h.drain();
});
test('普通改密使恢复链接失效但保留当前会话',async()=>{
  const h=await harness(),actor=await h.register();await h.drain();await h.request('POST','/api/auth/password/forgot',{email:actor.email});await h.drain();const token=tokenOf(h.mailer!,actor.email,'reset-password');
  assert.equal((await h.request('POST','/api/auth/password',{currentPassword:password,newPassword},actor.headers)).status,200);
  assert.equal((await h.request('POST','/api/auth/password/reset',{token,newPassword:password})).body.code,'AUTH_TOKEN_INVALID');
  assert.equal((await h.request('GET','/api/auth/session',undefined,actor.headers)).status,200);
});
test('新邮件失败不破坏已有效链接，错误正文不进入日志',async()=>{
  const h=await harness(),actor=await h.register();await h.drain();const original=tokenOf(h.mailer!,actor.email,'verify-email');
  const logged:unknown[]=[];const previous=console.error;console.error=(...args)=>{logged.push(args);};
  try {
    h.mailer!.fail=true;assert.equal((await h.request('POST','/api/auth/verification/request',{},actor.headers)).status,202);await h.drain();
    const failed=tokenOf(h.mailer!,actor.email,'verify-email');assert.ok(failed!==original);
    assert.equal((await h.request('POST','/api/auth/verification/confirm',{token:failed})).body.code,'AUTH_TOKEN_INVALID');
    assert.equal((await h.request('POST','/api/auth/verification/confirm',{token:original})).status,200);
    assert.ok(!JSON.stringify(logged).includes(failed));assert.ok(!JSON.stringify(logged).includes('Test SMTP rejected'));
  } finally {console.error=previous;}
});
test('邮件总超时失效新链接，晚到成功不会重新激活',async()=>{
  const fake=new FakeMailer();let release!:()=>void;fake.hold=new Promise<void>(resolve=>{release=resolve;});
  const h=await harness({mailTimeoutMs:20},fake),actor=await h.register();await h.drain();const token=tokenOf(fake,actor.email,'verify-email');
  assert.equal(h.app.locals.mailStats.failed,1);release();await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal((await h.request('POST','/api/auth/verification/confirm',{token})).body.code,'AUTH_TOKEN_INVALID');
  assert.equal((await h.request('GET','/api/auth/session',undefined,actor.headers)).status,200);
});
test('队列满时注册仍成功并明确unavailable，找回仍通用202',async()=>{
  const h=await harness({mailQueueMax:0}),actor=await h.register();assert.equal(actor.body.emailDelivery,'unavailable');
  assert.equal((await h.request('POST','/api/auth/verification/request',{},actor.headers)).body.code,'MAIL_QUEUE_BUSY');
  assert.equal((await h.request('POST','/api/auth/password/forgot',{email:actor.email})).status,202);
  assert.equal((await h.request('POST','/api/auth/login',{email:actor.email,password})).status,200);assert.equal(h.mailer!.messages.length,0);
});
test('邮箱重发冷却不能通过并发绕过',async()=>{
  const h=await harness({mailCooldownMs:60000}),actor=await h.register();await h.drain();
  const results=await Promise.all([h.request('POST','/api/auth/verification/request',{},actor.headers),h.request('POST','/api/auth/verification/request',{},actor.headers)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[202,429]);await h.drain();
});
test('进程中断遗留pending可回收，保留已发送链接和仍在发送的令牌',async()=>{
  const h=await harness(),actor=await h.register();await h.drain();const original=tokenOf(h.mailer!,actor.email,'verify-email');
  const abandoned=[randomUUID(),randomUUID()],active=randomUUID();
  for(const id of [...abandoned,active])await db.query("INSERT INTO auth_tokens(id,user_id,purpose,token_hash,email_snapshot,credential_version,created_at,expires_at) VALUES($1,$2,'verify_email',$3,$4,0,$5,$6)",[id,actor.id,hashToken(randomUUID()),actor.email,new Date(Date.now()-(id===active?0:120000)).toISOString(),new Date(Date.now()+86400000).toISOString()]);
  const before=h.mailer!.messages.length;
  assert.equal((await h.request('POST','/api/auth/verification/request',{},actor.headers)).status,202);await h.drain();
  assert.equal(h.mailer!.messages.length,before+1);
  for(const id of abandoned){const row=(await db.query('SELECT invalidated_at,delivery_status FROM auth_tokens WHERE id=$1',[id])).rows[0];assert.ok(row.invalidated_at);assert.equal(row.delivery_status,'failed');}
  const current=(await db.query('SELECT invalidated_at,delivery_status FROM auth_tokens WHERE id=$1',[active])).rows[0];assert.equal(current.invalidated_at,null);assert.equal(current.delivery_status,'pending');
  assert.equal((await h.request('POST','/api/auth/verification/confirm',{token:original})).status,200);
});

test('已注销账号排队中的验证任务不创建令牌或发送邮件',async()=>{
  const fake=new FakeMailer();let release!:()=>void;fake.hold=new Promise<void>(resolve=>{release=resolve;});
  const h=await harness({mailTimeoutMs:10000},fake);await h.register();await h.register();const waiting=await h.register();
  assert.equal((await h.request('POST','/api/auth/logout',{},waiting.headers)).status,200);
  release();await h.drain();assert.ok(!fake.messages.some(message=>message.to===waiting.email));
  assert.equal((await db.query('SELECT count(*)::int AS total FROM auth_tokens WHERE user_id=$1',[waiting.id])).rows[0].total,0);
});
test('003升级保留旧账号密码与业务记录，不自动标记邮箱已验证',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'yunji-auth-migrate-')),dataDir=join(directory,'database');let old:PGlite|undefined,next:Database|undefined;
  try {
    old=new PGlite(dataDir);await old.waitReady;
    for(const name of ['001_initial.sql','002_history_order_audit.sql'])await old.exec(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
    await old.query('INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)',['old-user','old@example.test','旧账号','existing-hash']);
    await old.query('INSERT INTO workspaces(id,name,owner_id) VALUES($1,$2,$3)',['old-space','原空间','old-user']);
    await old.query('INSERT INTO records(workspace_id,kind,id,payload) VALUES($1,$2,$3,$4::jsonb)',['old-space','customers','old-customer',JSON.stringify({id:'old-customer',name:'原客户'})]);
    await old.close();old=undefined;next=await openDatabase({dataDir});
    const user=(await next.query('SELECT password_hash,email_verified_at,credential_version FROM users WHERE id=$1',['old-user'])).rows[0];
    assert.equal(user.password_hash,'existing-hash');assert.equal(user.email_verified_at,null);assert.equal(user.credential_version,0);
    assert.equal((await next.query('SELECT payload FROM records WHERE workspace_id=$1',['old-space'])).rows[0].payload.name,'原客户');
  } finally {if(old)await old.close();if(next)await next.close();await rm(directory,{recursive:true,force:true});}
});
