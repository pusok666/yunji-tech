import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { openDatabase } from '../server/db.ts';
import { createApp } from '../server/app.ts';

const origin = 'http://127.0.0.1:5174';
const password = 'Test-only-Yunji-2026!';
const now = new Date();
const stockDate = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
let db, server, base, temp;
before(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), 'yunji-commercial-api-'));
  db = await openDatabase({ dataDir: path.join(temp, 'database'), ...(process.env.TEST_DATABASE_URL ? {url:process.env.TEST_DATABASE_URL} : {}) });
  const app = await createApp({ db, config: { appOrigin:origin, production:false, inviteCode:'test-invitation-only', authRateLimit:1000 } });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (db) await db.close();
  if (temp) await rm(temp, {recursive:true,force:true});
});

function actor() {
  return {
    cookie:'', csrf:'', revision:0,
    async request(method, route, body, overrides={}) {
      const headers = {Origin:origin, ...(this.cookie?{Cookie:this.cookie}:{}), ...(body!==undefined?{'Content-Type':'application/json'}:{}), ...(this.csrf?{'X-CSRF-Token':this.csrf}:{}), ...overrides};
      const response = await fetch(base+route, {method,headers,body:body===undefined?undefined:JSON.stringify(body)});
      const cookies = response.headers.getSetCookie();
      if(cookies.length) this.cookie=cookies.map(c=>c.split(';')[0]).join('; ');
      const value = await response.json();
      if(value.csrfToken) this.csrf=value.csrfToken;
      if(response.ok && typeof value.revision==='number') this.revision=value.revision;
      return {status:response.status,body:value,headers:response.headers};
    },
    async register(label) {
      this.email=`test-${randomUUID()}@example.test`;
      const r=await this.request('POST','/api/auth/register',{email:this.email,password,name:label,workspaceName:`${label}工作室`,inviteCode:'test-invitation-only'});
      assert.ok([200,201].includes(r.status),JSON.stringify(r.body));
      assert.ok(r.body.user.id && r.body.workspace.id && r.body.csrfToken);
      assert.match(this.cookie,/yunji_commercial_session=/);
      assert.match(r.headers.get('set-cookie'),/HttpOnly/i);
      return r.body;
    },
    mutate(method,route,body,headers={}) {
      return this.request(method,route,body,{'If-Match':`"${this.revision}"`,'Idempotency-Key':randomUUID(),...headers});
    },
    put(kind,value,headers={}) {return this.mutate('PUT',`/api/records/${kind}/${value.id}`,{value},headers);},
    snapshot(){return this.request('GET','/api/data');},
  };
}
const customer=id=>({id,name:'验收客户',contact:'陈先生',phone:'13800000000',email:'client@example.test',industry:'专业服务',level:'普通客户',date:'2026-01-01',notes:''});
const order=(id,customerId)=>({id,customerId,title:'服务与商品基础订单',category:'技术服务',amount:1000,paidAmount:0,status:'进行中',date:'2026-01-10',dueDate:'2026-12-31',notes:''});
const product=id=>({id,name:'验收商品',sku:`SKU-${id}`,category:'文创周边',stock:10,threshold:2,price:30,cost:10,unit:'件',notes:''});
function ok(r){assert.equal(r.status,200,JSON.stringify(r.body));return r.body;}
function rejected(r){assert.ok(r.status>=400&&r.status<500,JSON.stringify(r));}

test('真实业务与租户安全验收', async t => {
  const a=actor(),b=actor();
  let customerA,orderA,paymentA,paymentB,productA,backup;
  await t.test('未登录无法读取数据或导出',async()=>{
    assert.equal((await a.snapshot()).status,401);
    assert.equal((await a.request('GET','/api/backup')).status,401);
  });
  await t.test('邀请开通、密码要求及独立工作空间',async()=>{
    rejected(await a.request('POST','/api/auth/register',{email:'bad@example.test',password:'123',name:'bad',workspaceName:'bad',inviteCode:'wrong'}));
    const sa=await a.register('甲'),sb=await b.register('乙');
    assert.notEqual(sa.workspace.id,sb.workspace.id);
    assert.equal(ok(await a.snapshot()).data.customers.length,0);
    assert.equal(ok(await b.snapshot()).data.customers.length,0);
    assert.equal((await actor().request('POST','/api/auth/login',{email:a.email,password:'wrong'})).status,401);
  });
  await t.test('CSRF、跨域与缺失并发版本保护',async()=>{
    const c=customer(randomUUID());
    assert.equal((await a.put('customers',c,{'X-CSRF-Token':'wrong'})).status,403);
    assert.equal((await a.put('customers',c,{Origin:'https://evil.example'})).status,403);
    rejected(await a.put('customers',c,{'If-Match':''}));
    assert.equal(ok(await a.snapshot()).data.customers.length,0);
  });
  await t.test('客户保存、第二浏览器登录及同账号数据共享',async()=>{
    customerA=customer(randomUUID());
    ok(await a.put('customers',customerA));
    const another=actor();
    ok(await another.request('POST','/api/auth/login',{email:a.email,password}));
    assert.equal(ok(await another.snapshot()).data.customers[0].id,customerA.id);
    assert.equal(ok(await b.snapshot()).data.customers.length,0);
  });
  await t.test('幂等重试不会重复创建，key 换内容被拒绝',async()=>{
    const value=customer(randomUUID()),key=randomUUID(),rev=a.revision;
    const headers={'Idempotency-Key':key,'If-Match':`"${rev}"`};
    const first=ok(await a.put('customers',value,headers));
    const repeat=ok(await a.put('customers',value,headers));
    assert.deepEqual(repeat,first);
    assert.equal((await a.put('customers',{...value,name:'试图复用key'},headers)).status,409);
    assert.equal(ok(await a.snapshot()).data.customers.filter(c=>c.id===value.id).length,1);
  });
  await t.test('过期版本不会覆盖他人修改',async()=>{
    assert.equal((await a.put('customers',{...customerA,name:'旧版本覆盖'},{'If-Match':'"0"'})).status,409);
    assert.equal(ok(await a.snapshot()).data.customers.find(c=>c.id===customerA.id).name,customerA.name);
  });
  await t.test('并发写入只有一个成功，另一请求明确冲突',async()=>{
    const rev=a.revision;
    const result=await Promise.all([a.put('customers',customer(randomUUID()),{'If-Match':`"${rev}"`}),a.put('customers',customer(randomUUID()),{'If-Match':`"${rev}"`})]);
    assert.deepEqual(result.map(r=>r.status).sort(),[200,409]);
    ok(await a.snapshot());
  });
  await t.test('新订单不能伪造已收款金额或引用别人的客户',async()=>{
    orderA=order(randomUUID(),customerA.id);
    rejected(await a.put('orders',{...orderA,paidAmount:500}));
    rejected(await b.put('orders',order(randomUUID(),customerA.id)));
    ok(await a.put('orders',orderA));
  });
  await t.test('独立收款 400 + 600，按收款日期保留流水',async()=>{
    paymentA={id:randomUUID(),orderId:orderA.id,type:'收款',amount:400,date:'2026-02-01',notes:'首款'};
    paymentB={id:randomUUID(),orderId:orderA.id,type:'收款',amount:600,date:'2026-03-01',notes:'尾款'};
    ok(await a.mutate('POST',`/api/orders/${orderA.id}/payments`,paymentA));
    const state=ok(await a.mutate('POST',`/api/orders/${orderA.id}/payments`,paymentB));
    assert.equal(state.data.orders.find(o=>o.id===orderA.id).paidAmount,1000);
    assert.equal(state.data.receipts.find(r=>r.id===paymentA.id).date,'2026-02-01');
  });
  await t.test('拒绝超额收款、非法精度、早于订单的收款',async()=>{
    for(const changes of [{amount:0.01},{amount:-1},{amount:0.001},{amount:1,date:'2025-12-31'}]) {
      rejected(await a.mutate('POST',`/api/orders/${orderA.id}/payments`,{...paymentA,id:randomUUID(),...changes}));
    }
    assert.equal(ok(await a.snapshot()).data.receipts.length,2);
  });
  await t.test('退款关联原收款，1000 收款退款 100 后净额为 900',async()=>{
    const refund={id:randomUUID(),orderId:orderA.id,type:'退款',amount:100,date:'2026-03-02',notes:'部分退款',receiptId:paymentA.id};
    const s=ok(await a.mutate('POST',`/api/orders/${orderA.id}/payments`,refund));
    assert.equal(s.data.orders.find(o=>o.id===orderA.id).paidAmount,900);
    assert.equal(s.data.receipts.length,3);
    rejected(await a.mutate('POST',`/api/orders/${orderA.id}/payments`,{...refund,id:randomUUID(),amount:301}));
  });
  await t.test('有历史流水订单保护：不能删除、篡改回款或无退款取消',async()=>{
    rejected(await a.mutate('DELETE',`/api/records/orders/${orderA.id}`));
    rejected(await a.put('orders',{...orderA,paidAmount:900,amount:899}));
    rejected(await a.put('orders',{...orderA,paidAmount:0}));
    rejected(await a.put('orders',{...orderA,paidAmount:900,status:'已取消'}));
    rejected(await a.mutate('DELETE',`/api/records/customers/${customerA.id}`));
    assert.equal(ok(await a.snapshot()).data.receipts.length,3);
  });
  await t.test('跨空间猜测订单 ID 无法收款、删除或取得流水',async()=>{
    rejected(await b.mutate('POST',`/api/orders/${orderA.id}/payments`,{...paymentA,id:randomUUID()}));
    rejected(await b.mutate('DELETE',`/api/records/orders/${orderA.id}`));
    assert.equal(ok(await b.snapshot()).data.receipts.length,0);
    assert.equal(ok(await a.snapshot()).data.orders.find(o=>o.id===orderA.id).paidAmount,900);
  });
  await t.test('期初库存留痕、出库及重试保护',async()=>{
    productA=product(randomUUID());
    const created=ok(await a.put('products',productA));
    assert.equal(created.data.stockMovements.filter(m=>m.productId===productA.id).reduce((sum,m)=>sum+m.delta,0),10);
    const move={id:randomUUID(),productId:productA.id,delta:-3,date:stockDate,notes:'交付出库'};
    const headers={'If-Match':`"${a.revision}"`,'Idempotency-Key':randomUUID()};
    ok(await a.mutate('POST',`/api/products/${productA.id}/stock-movements`,move,headers));
    ok(await a.mutate('POST',`/api/products/${productA.id}/stock-movements`,move,headers));
    assert.equal(ok(await a.snapshot()).data.products.find(p=>p.id===productA.id).stock,7);
  });
  await t.test('拒绝负库存与直接改库存，失败不产生半笔流水',async()=>{
    const prior=ok(await a.snapshot());
    rejected(await a.put('products',{...productA,stock:999}));
    rejected(await a.mutate('POST',`/api/products/${productA.id}/stock-movements`,{id:randomUUID(),productId:productA.id,delta:-8,date:stockDate,notes:'超量'}));
    const after=ok(await a.snapshot());
    assert.equal(after.revision,prior.revision);
    assert.deepEqual(after.data.stockMovements,prior.data.stockMovements);
    rejected(await a.mutate('DELETE',`/api/records/products/${productA.id}`));
  });
  await t.test('人工收支与业务审计按工作空间隔离',async()=>{
    const tx={id:randomUUID(),title:'办公室租金',type:'支出',category:'场地费用',amount:100,date:'2026-03-01',notes:''};
    ok(await a.put('transactions',tx));
    const audit=ok(await a.request('GET','/api/audit'));
    assert.ok(audit.events.length>=8);
    const other=ok(await b.request('GET','/api/audit'));
    assert.ok(other.events.every(e=>e.entityId!==tx.id&&e.entityId!==orderA.id));
  });
  await t.test('AI 仅使用服务端授权数据，忽略伪造 context',async()=>{
    const answer=ok(await a.request('POST','/api/assistant',{question:'未回款订单',context:{orders:[{amount:99999999}]}}));
    assert.equal(answer.mode,'rules');
    assert.ok(typeof answer.answer==='string' && answer.answer.length>0);
    assert.ok(!answer.answer.includes('99999999'));
  });
  await t.test('备份不包含密码/会话，空空间恢复后记录金额一致',async()=>{
    backup=ok(await a.request('GET','/api/backup'));
    assert.equal(backup.format,'yunji-commercial-backup');
    assert.ok(!JSON.stringify(backup).includes(password));
    assert.ok(!JSON.stringify(backup).includes(a.csrf));
    const recovery=actor();await recovery.register('恢复');
    const restored=ok(await recovery.mutate('POST','/api/restore',backup));
    for(const key of ['customers','orders','products','transactions','receipts','stockMovements']) {
      const normalize=list=>[...list].sort((x,y)=>x.id.localeCompare(y.id));
      assert.deepEqual(normalize(restored.data[key]),normalize(backup.data[key]),key);
    }
    rejected(await recovery.mutate('POST','/api/restore',backup));
    const moved=ok(await recovery.mutate('POST',`/api/products/${productA.id}/stock-movements`,{id:randomUUID(),productId:productA.id,delta:-1,date:stockDate,notes:'恢复后出库'}));
    assert.equal(moved.data.products.find(p=>p.id===productA.id).stock,6);
  });
  await t.test('拒绝篡改账本的备份且原子回滚',async()=>{
    const c=actor();await c.register('坏备份');
    const invalid=structuredClone(backup);invalid.data.orders[0].paidAmount=123;
    rejected(await c.mutate('POST','/api/restore',invalid));
    assert.equal(ok(await c.snapshot()).data.customers.length,0);
  });
  await t.test('修改密码撤销其他会话，旧密码无效',async()=>{
    const another=actor();ok(await another.request('POST','/api/auth/login',{email:a.email,password}));
    ok(await a.request('POST','/api/auth/password',{currentPassword:password,newPassword:password+'New'}));
    assert.equal((await another.snapshot()).status,401);
    assert.equal((await actor().request('POST','/api/auth/login',{email:a.email,password})).status,401);
    const latest=actor();ok(await latest.request('POST','/api/auth/login',{email:a.email,password:password+'New'}));
    assert.equal(ok(await latest.snapshot()).data.orders.find(o=>o.id===orderA.id).paidAmount,900);
  });
  await t.test('退出后会话失效',async()=>{
    ok(await b.request('POST','/api/auth/logout'));
    assert.equal((await b.snapshot()).status,401);
  });
});
