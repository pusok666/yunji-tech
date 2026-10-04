import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from './browser.mjs';
import { openDatabase } from '../server/db.ts';
import { createApp } from '../server/app.ts';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'test-results/commercial');
await mkdir(output,{recursive:true});
const temp=await mkdtemp(path.join(os.tmpdir(),'yunji-commercial-browser-'));
const errors=[],steps=[];let browser,context,page,db,server,handler,base;
const email=`browser-${randomUUID()}@example.test`,password='Browser-Only-2026!';
const report={startedAt:new Date().toISOString(),steps,errors};
async function boot(port=0){
  db=await openDatabase({dataDir:path.join(temp,'database')});
  server=createServer((req,res)=>handler(req,res));server.listen(port,'127.0.0.1');await once(server,'listening');
  base=`http://127.0.0.1:${server.address().port}`;
  handler=createApp({db,config:{appOrigin:base,production:false,authRateLimit:1000,staticDir:path.join(root,'dist')}});
}
async function shutdown(){if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));server=null;}if(db){await db.close();db=null;}}
async function step(name,run){const start=Date.now();try{await run();steps.push({name,passed:true,ms:Date.now()-start});console.log(`PASS ${name}`);}catch(error){steps.push({name,passed:false,error:error.message});throw error;}}
async function route(value){await page.goto(base+'/#'+value);await page.locator('.main-content').waitFor();}
async function dialog(){const target=page.getByRole('dialog');await target.waitFor();return target;}
async function select(scope,label,text){await scope.getByLabel(label,{exact:true}).press('ArrowDown');await page.locator('.ant-select-dropdown:visible .ant-select-item-option').getByText(text,{exact:true}).click();await page.locator('.ant-select-dropdown:visible').waitFor({state:'hidden'});}
async function screenshot(name){await page.waitForFunction(()=>document.querySelectorAll('.ant-message-notice').length===0);await page.screenshot({path:path.join(output,name),fullPage:true,animations:'disabled'});}
async function saveForm(){const d=await dialog();const saved=page.waitForResponse(r=>r.url().includes('/api/records/')&&r.request().method()==='PUT');await d.getByRole('button',{name:'保存记录'}).click();const response=await saved;assert.equal(response.status(),200,await response.text());await d.waitFor({state:'hidden'});}
async function snapshot(){return page.evaluate(async()=>{const r=await fetch('/api/data');if(!r.ok)throw Error('data '+r.status);return r.json();});}
async function accountAction(name){await page.locator('.account-button').click();await page.getByRole('menuitem',{name}).click();}
function watch(p){p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error'&&!/Failed to load resource: the server responded with a status of (401|409)/.test(m.text()))errors.push(m.text());});}

try{
  await boot();
  browser=await chromium.launch({headless:true,...(process.env.BROWSER_CHANNEL?{channel:process.env.BROWSER_CHANNEL}:process.platform==='win32'?{channel:'msedge'}:{})});
  context=await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN'});page=await context.newPage();watch(page);page.setDefaultTimeout(12000);
  await step('真实注册和空经营空间',async()=>{
    await page.goto(base);await page.getByText('创建空间',{exact:true}).click();
    await page.getByLabel('你的姓名',{exact:true}).fill('验收经营者');await page.getByLabel('经营空间名称',{exact:true}).fill('商业化验收工作室');
    await page.getByLabel('邮箱',{exact:true}).fill(email);await page.getByLabel('密码',{exact:true}).fill(password);await page.getByLabel('确认密码',{exact:true}).fill(password);
    await page.getByRole('button',{name:'创建经营空间'}).click();await page.locator('.main-content').waitFor();
    assert.equal((await snapshot()).data.customers.length,0);
    assert.deepEqual(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('yunji-'))),[]);
    await screenshot('dashboard-empty.png');
  });
  await step('客户新增、搜索、编辑和无关联删除',async()=>{
    await route('/customers');await page.getByRole('button',{name:'新增客户'}).click();let d=await dialog();
    await d.getByLabel('客户名称',{exact:true}).fill('验收客户');await d.getByLabel('联系人',{exact:true}).fill('陈先生');await d.getByLabel('联系电话',{exact:true}).fill('13800000000');await saveForm();
    await page.getByLabel('搜索记录').fill('不存在的客户');assert.equal(await page.locator('.ant-table-row').count(),0);
    await page.getByLabel('搜索记录').fill('验收客户');await page.getByRole('button',{name:'编辑验收客户',exact:true}).click();d=await dialog();await d.getByLabel('客户名称',{exact:true}).fill('验收客户已编辑');await saveForm();await page.getByLabel('搜索记录').fill('');
    await page.getByRole('button',{name:'新增客户'}).click();d=await dialog();await d.getByLabel('客户名称',{exact:true}).fill('可删除客户');await d.getByLabel('联系人',{exact:true}).fill('李先生');await d.getByLabel('联系电话',{exact:true}).fill('13900000000');await saveForm();
    await page.getByRole('button',{name:'删除可删除客户',exact:true}).click();const deleted=page.waitForResponse(r=>r.request().method()==='DELETE');await page.getByRole('button',{name:'确认删除'}).click();assert.equal((await deleted).status(),200);assert.equal((await snapshot()).data.customers.length,1);
  });
  await step('新建订单并分次收款，金额不重复记账',async()=>{
    await route('/orders');await page.getByRole('button',{name:'新增订单'}).click();let d=await dialog();await d.getByLabel('订单名称',{exact:true}).fill('验收服务订单');await select(d,'关联客户','验收客户已编辑');await d.getByLabel('订单金额（元）',{exact:true}).fill('1000');await saveForm();
    await page.getByRole('button',{name:'收退款',exact:true}).click();d=await dialog();
    for(const amount of ['400','600']){await d.getByLabel('收款金额（元）',{exact:true}).fill(amount);const done=page.waitForResponse(r=>r.url().includes('/payments')&&r.request().method()==='POST');await d.getByRole('button',{name:'登记收款',exact:true}).click();assert.equal((await done).status(),200);await d.getByLabel('收款金额（元）',{exact:true}).waitFor();}
    assert.equal((await snapshot()).data.orders[0].paidAmount,1000);
    await d.getByRole('button',{name:/^关\s*闭$/}).click();
  });
  await step('关联原收款退款并保留历史流水',async()=>{
    await page.getByRole('button',{name:'收退款',exact:true}).click();const d=await dialog();await select(d,'操作类型','登记退款');await d.getByLabel('原收款流水',{exact:true}).press('ArrowDown');await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({hasText:'可退'}).first().click();await page.locator('.ant-select-dropdown:visible').waitFor({state:'hidden'});await d.getByLabel('退款金额（元）',{exact:true}).fill('100');
    const done=page.waitForResponse(r=>r.url().includes('/payments')&&r.request().method()==='POST');await d.getByRole('button',{name:'登记退款',exact:true}).click();assert.equal((await done).status(),200);
    const state=await snapshot();assert.equal(state.data.orders[0].paidAmount,900);assert.equal(state.data.receipts.length,3);await d.getByRole('button',{name:/^关\s*闭$/}).click();
  });
  await step('期初库存、出库和库存流水',async()=>{
    await route('/inventory');await page.getByRole('button',{name:'新增商品'}).click();let d=await dialog();await d.getByLabel('商品名称',{exact:true}).fill('验收商品');await d.getByLabel('SKU 编码',{exact:true}).fill('BROWSER-SKU-001');await d.getByLabel('期初库存',{exact:true}).fill('10');await d.getByLabel('销售单价（元）',{exact:true}).fill('30');await d.getByLabel('成本单价（元）',{exact:true}).fill('10');await saveForm();
    await page.getByRole('button',{name:'出入库',exact:true}).click();d=await dialog();await select(d,'变动类型','出库 / 盘亏');await d.getByLabel('数量',{exact:true}).fill('3');await d.getByLabel('变动原因',{exact:true}).fill('验收交付出库');const done=page.waitForResponse(r=>r.url().includes('/stock-movements')&&r.request().method()==='POST');await d.getByRole('button',{name:'登记库存变动'}).click();assert.equal((await done).status(),200);const s=await snapshot();assert.equal(s.data.products[0].stock,7);assert.equal(s.data.stockMovements.length,2);await d.getByRole('button',{name:/^关\s*闭$/}).click();
  });
  await step('手工支出、资金流水与统计页面',async()=>{
    await route('/finance');await page.getByRole('button',{name:'新增收支'}).click();const d=await dialog();await d.getByLabel('收支事项',{exact:true}).fill('验收办公费用');await select(d,'收支类型','支出');await d.getByLabel('金额（元）',{exact:true}).fill('200');await saveForm();
    const expense=(await snapshot()).data.transactions[0];assert.equal(expense.amount,200);assert.equal(expense.category,'其他支出');await route('/statistics');await screenshot('statistics.png');
  });
  await step('保存冲突保留表单，刷新后明确重试',async()=>{
    await route('/customers');await page.getByRole('button',{name:'编辑验收客户已编辑',exact:true}).click();const d=await dialog();await d.getByLabel('联系人',{exact:true}).fill('冲突后联系人');
    await page.evaluate(async()=>{const session=await(await fetch('/api/auth/session')).json();const state=await(await fetch('/api/data')).json();const c=state.data.customers[0];const r=await fetch('/api/records/customers/'+c.id,{method:'PUT',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken,'If-Match':`"${state.revision}"`,'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({value:{...c,notes:'来自另一设备'}})});if(!r.ok)throw Error('concurrent write failed');});
    const conflict=page.waitForResponse(r=>r.url().includes('/api/records/')&&r.request().method()==='PUT');await d.getByRole('button',{name:'保存记录'}).click();assert.equal((await conflict).status(),409);assert.equal(await d.getByLabel('联系人',{exact:true}).inputValue(),'冲突后联系人');
    await d.getByRole('button',{name:'刷新并保留输入'}).click();await d.getByRole('button',{name:'保存记录'}).waitFor();await saveForm();const merged=(await snapshot()).data.customers[0];assert.equal(merged.contact,'冲突后联系人');assert.equal(merged.notes,'来自另一设备','未修改字段必须保留另一设备的新值');
  });
  await step('同字段冲突需要明确选择',async()=>{
    await page.getByRole('button',{name:'编辑验收客户已编辑',exact:true}).click();const d=await dialog();await d.getByLabel('联系人',{exact:true}).fill('我确认的联系人');
    await page.evaluate(async()=>{const session=await(await fetch('/api/auth/session')).json();const state=await(await fetch('/api/data')).json();const c=state.data.customers[0];const r=await fetch('/api/records/customers/'+c.id,{method:'PUT',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken,'If-Match':`"${state.revision}"`,'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({value:{...c,contact:'其他设备联系人'}})});if(!r.ok)throw Error('concurrent field write failed');});
    const conflicted=page.waitForResponse(r=>r.url().includes('/api/records/')&&r.request().method()==='PUT');await d.getByRole('button',{name:'保存记录'}).click();assert.equal((await conflicted).status(),409);await d.getByRole('button',{name:'刷新并保留输入'}).click();await d.getByRole('button',{name:'保存记录'}).click();await d.getByText('检测到相同字段的并发修改',{exact:true}).waitFor();assert.equal((await snapshot()).data.customers[0].contact,'其他设备联系人');await d.getByRole('button',{name:'保留我的修改',exact:true}).click();await saveForm();assert.equal((await snapshot()).data.customers[0].contact,'我确认的联系人');
  });
  await step('服务器经营助手连续查询与规则标识',async()=>{
    await route('/assistant');for(const q of ['查询未回款订单','有哪些库存预警？','生成本周经营周报']){await page.getByLabel('向经营助手提问').fill(q);const done=page.waitForResponse(r=>r.url().includes('/api/assistant')&&r.request().method()==='POST');await page.getByRole('button',{name:'发送消息'}).click();assert.equal((await done).status(),200);await page.locator('.thinking').waitFor({state:'hidden'});}
    assert.equal(await page.locator('.chat-message.assistant').count(),3);assert.ok((await page.locator('.chat-body').innerText()).includes('规则生成'));await screenshot('assistant.png');
  });
  await step('空间设置与操作审计可见',async()=>{await route('/settings');await page.locator('.ant-table-row').first().waitFor();assert.ok(await page.locator('.ant-table-row').count()>0);});
  await step('真实导出与空空间导入备份',async()=>{
    const before=await snapshot();const downloadEvent=page.waitForEvent('download');await accountAction('导出经营备份');const download=await downloadEvent;const file=path.join(temp,'business-backup.json');await download.saveAs(file);
    const restorePage=await(await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN'})).newPage();watch(restorePage);await restorePage.goto(base);await restorePage.getByText('创建空间',{exact:true}).click();await restorePage.getByLabel('你的姓名',{exact:true}).fill('恢复验收');await restorePage.getByLabel('经营空间名称',{exact:true}).fill('恢复空间');await restorePage.getByLabel('邮箱',{exact:true}).fill(`restore-${randomUUID()}@example.test`);await restorePage.getByLabel('密码',{exact:true}).fill(password);await restorePage.getByLabel('确认密码',{exact:true}).fill(password);await restorePage.getByRole('button',{name:'创建经营空间'}).click();await restorePage.locator('.main-content').waitFor();await restorePage.locator('input[type=file]').setInputFiles(file);const done=restorePage.waitForResponse(r=>r.url().includes('/api/restore'));await restorePage.getByRole('button',{name:'校验并恢复'}).click();assert.equal((await done).status(),200);const restored=await restorePage.evaluate(async()=>(await(await fetch('/api/data')).json()).data);for(const key of ['customers','orders','products','transactions','receipts','stockMovements'])assert.equal(restored[key].length,before.data[key].length,key);await restorePage.context().close();
  });
  await step('服务与数据库重启后账户和经营数据保留',async()=>{
    const expected=await snapshot(),port=new URL(base).port;await shutdown();await boot(Number(port));await page.reload();await page.locator('.main-content').waitFor();const actual=await snapshot();assert.deepEqual(actual,expected);
  });
  await step('八个工作页的手机布局与导航',async()=>{
    await page.setViewportSize({width:390,height:844});for(const value of ['/','/customers','/orders','/inventory','/finance','/statistics','/assistant','/settings']){await route(value);const width=await page.evaluate(()=>({body:document.documentElement.scrollWidth,view:innerWidth}));assert.ok(width.body<=width.view+1,`${value}: ${JSON.stringify(width)}`);}await page.getByRole('button',{name:'打开导航'}).click();assert.ok(await page.locator('.sidebar.is-open').isVisible());await page.getByRole('button',{name:'关闭导航'}).click();await screenshot('mobile-settings.png');await page.setViewportSize({width:1440,height:1000});
  });
  await step('退出登录与重新登录',async()=>{
    await accountAction('退出工作台');await page.getByRole('button',{name:/登录工作台/}).waitFor();await page.getByLabel('邮箱',{exact:true}).fill(email);await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:/登录工作台/}).click();await page.locator('.main-content').waitFor();assert.equal((await snapshot()).data.orders[0].paidAmount,900);await screenshot('dashboard.png');
  });
  await step('旧账号慢响应及旧401不会覆盖或退出新会话',async()=>{
    const otherEmail=`race-${randomUUID()}@example.test`;
    for(const variant of ['old-data','old-401']){
      let release,announce,finish,first=true;
      const gate=new Promise(resolve=>{release=resolve;}),reached=new Promise(resolve=>{announce=resolve;}),completed=new Promise(resolve=>{finish=resolve;});
      const intercept=async request=>{
        if(!first){await request.continue();return;}
        first=false;const response=await request.fetch();announce();await gate;
        if(variant==='old-data')await request.fulfill({response});else await request.fulfill({status:401,contentType:'application/json',body:JSON.stringify({error:'旧会话已过期',code:'UNAUTHENTICATED'})});
        finish();
      };
      await page.route('**/api/data',intercept);
      try{
        await page.getByRole('button',{name:'刷新数据',exact:true}).click();await reached;
        await accountAction('退出工作台');await page.getByRole('button',{name:/登录工作台/}).waitFor();
        if(variant==='old-data'){
          await page.getByText('创建空间',{exact:true}).click();await page.getByLabel('你的姓名',{exact:true}).fill('第二账号');await page.getByLabel('经营空间名称',{exact:true}).fill('全新空空间');await page.getByLabel('邮箱',{exact:true}).fill(otherEmail);await page.getByLabel('密码',{exact:true}).fill(password);await page.getByLabel('确认密码',{exact:true}).fill(password);await page.getByRole('button',{name:'创建经营空间'}).click();
        }else{await page.getByLabel('邮箱',{exact:true}).fill(email);await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:/登录工作台/}).click();}
        await page.locator('.main-content').waitFor();release();await completed;
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        assert.ok((await page.locator('.workspace-switch').innerText()).includes(variant==='old-data'?'全新空空间':'商业化验收工作室'));
        await page.locator('nav a[href="#/orders"]').click();await page.locator('.records-panel').waitFor();
        assert.equal(await page.locator('.ant-table-row').count(),variant==='old-data'?0:1);
      }finally{release();await page.unroute('**/api/data',intercept);}
    }
  });
  await step('无页面异常及非预期控制台错误',async()=>{assert.deepEqual(errors,[]);});
  report.passed=true;
}catch(error){report.passed=false;report.failure=error.stack;console.error(error);if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));if(browser)await browser.close();await shutdown();const relative=path.relative(os.tmpdir(),temp);if(!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(temp).startsWith('yunji-commercial-browser-'))await rm(temp,{recursive:true,force:true});}
