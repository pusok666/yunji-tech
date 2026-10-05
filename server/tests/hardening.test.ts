import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../app.ts';
import { openDatabase } from '../db.ts';
import type { Database } from '../db.ts';
import { parse, receiptSchema, today } from '../validation.ts';

const origin = 'http://127.0.0.1:5174';
let db: Database, server: Server, base: string;
before(async () => { db = await openDatabase({ dataDir: ':memory:' }); server = createApp({ db, config: { appOrigin: origin, production: false, inviteCode: 'test-invitation-only', authRateLimit: 1000 } }).listen(0,'127.0.0.1'); await once(server,'listening'); base=`http://127.0.0.1:${(server.address() as any).port}`; });
after(async () => { server?.closeAllConnections(); if(server) await new Promise<void>(resolve => server.close(() => resolve())); if(db) await db.close(); });
async function request(route: string, method='GET', body?: any, headers: Record<string,string>={}) { const response = await fetch(base+route,{method,headers:{Origin:origin,...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)}); return { response, body:await response.json() as any }; }
async function register() {
  const password = 'Independent-Test-2026!', email=`test-${randomUUID()}@example.test`;
  const result = await request('/api/auth/register','POST',{email,password,name:'验证账户',workspaceName:'验证空间',inviteCode:'test-invitation-only'});
  assert.equal(result.response.status,201);
  return { ...result, password, email, headers:{Cookie:result.response.headers.getSetCookie()[0].split(';')[0],'X-CSRF-Token':result.body.csrfToken} };
}
test('生产错误配置失败关闭且禁止嵌入式数据库生产启动', () => {
  assert.throws(() => createApp({db,config:{appOrigin:origin,production:true}}));
  assert.throws(() => createApp({db,config:{appOrigin:'https://app.example.test',production:true,inviteCode:'long-invitation-code'}}));
  assert.throws(() => createApp({db,config:{appOrigin:origin+'/path',production:false}}));
});
test('注册来源与邀请码保护',async () => {
  const payload={email:'origin@example.test',password:'Independent-Test-2026!',name:'测试',workspaceName:'测试'};
  assert.equal((await request('/api/auth/register','POST',payload,{Origin:'https://evil.test'})).response.status,403);
  assert.equal((await request('/api/auth/register','POST',payload)).response.status,403);
});
test('数据库只保存密码散列及会话令牌散列，过期会话拒绝',async () => {
  const actor = await register();
  const row=(await db.query('SELECT password_hash FROM users WHERE email=$1',[actor.email])).rows[0];
  assert.match(row.password_hash,/^scrypt:/); assert.ok(!row.password_hash.includes(actor.password));
  const session=(await db.query('SELECT token_hash FROM sessions WHERE user_id=$1',[actor.body.user.id])).rows[0];
  assert.notEqual(session.token_hash,actor.headers.Cookie.split('=')[1]);
  assert.match(actor.response.headers.get('set-cookie') ?? '',/HttpOnly/);
  await db.query('UPDATE sessions SET expires_at=$1 WHERE user_id=$2',['2000-01-01',actor.body.user.id]);
  assert.equal((await request('/api/data','GET',undefined,actor.headers)).response.status,401);
});
test('金额以分校验，拒绝tiny正数及三位小数', () => {
  const receipt={id:'test',orderId:'order',type:'收款',amount:0.01,date:today(),notes:''};
  assert.equal(parse(receiptSchema,receipt).amount,0.01);
  assert.equal(parse(receiptSchema,{...receipt,amount:1.15}).amount,1.15);
  for(const amount of [1e-12,0.001,1.005,Number.POSITIVE_INFINITY,-0.01]) assert.throws(()=>parse(receiptSchema,{...receipt,amount}));
});
test('审计保存修改前后摘要，并不接受前端workspace注入',async () => {
  const actor=await register(); const id=randomUUID();
  const customer={id,name:'原名',contact:'联系人',phone:'13800000000',email:'a@example.test',industry:'服务',level:'普通客户',date:today(),notes:''};
  const headers={...actor.headers,'If-Match':'"0"','Idempotency-Key':randomUUID()};
  assert.equal((await request(`/api/records/customers/${id}`,'PUT',{value:{...customer,workspace_id:'other'}},headers)).response.status,400);
  assert.equal((await request(`/api/records/customers/${id}`,'PUT',{value:customer},headers)).response.status,200);
  assert.equal((await request(`/api/records/customers/${id}`,'PUT',{value:{...customer,name:'新名'}},{...actor.headers,'If-Match':'"1"','Idempotency-Key':randomUUID()})).response.status,200);
  const audit=await request('/api/audit','GET',undefined,actor.headers);
  const update=audit.body.events.find((e:any)=>e.action==='update');
  assert.equal(update.before.name,'原名'); assert.equal(update.after.name,'新名');
  assert.ok(!JSON.stringify(audit.body).includes('13800000000'));
});
test('坏JSON与超大请求返回安全错误',async () => {
  const broken=await fetch(base+'/api/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{"email":'});
  assert.equal(broken.status,400); assert.deepEqual(Object.keys(await broken.json()).sort(),['code','error']);
  const oversized=await request('/api/auth/login','POST',{payload:'x'.repeat(5*1024*1024)});
  assert.equal(oversized.response.status,413); assert.equal(oversized.body.code,'BODY_TOO_LARGE');
});
test('登录失败频率限制返回429与Retry-After',async () => {
  const limited=createApp({db,config:{appOrigin:origin,production:false,authRateLimit:2}}).listen(0,'127.0.0.1');
  await once(limited,'listening'); const address=`http://127.0.0.1:${(limited.address() as any).port}/api/auth/login`;
  try {
    for(let i=0;i<3;i++) { const response=await fetch(address,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email:'nobody@example.test',password:'wrong'})}); assert.equal(response.status,i<2?401:429); if(i===2) assert.ok(Number(response.headers.get('retry-after'))>0); await response.arrayBuffer(); }
  } finally { limited.closeAllConnections(); await new Promise<void>(resolve=>limited.close(()=>resolve())); }
});
test('嵌入式数据库关闭并重开后保留记录及迁移版本',async () => {
  const directory=await mkdtemp(join(tmpdir(),'yunji-db-reopen-')); let disk: Database | undefined;
  try {
    disk=await openDatabase({dataDir:join(directory,'database')});
    await disk.query('INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)',['persist-user','persist@example.test','持久化','test-only-hash']);
    await disk.close(); disk=undefined;
    disk=await openDatabase({dataDir:join(directory,'database')});
    assert.equal((await disk.query('SELECT name FROM users WHERE id=$1',['persist-user'])).rows[0].name,'持久化');
    assert.deepEqual((await disk.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(r=>r.version),[1,2,3]);
  } finally { if(disk) await disk.close(); await rm(directory,{recursive:true,force:true}); }
});
