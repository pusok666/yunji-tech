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
const output=path.join(root,'test-results/auth-recovery');
await mkdir(output,{recursive:true});
const temp=await mkdtemp(path.join(os.tmpdir(),'yunji-auth-browser-'));
const mailbox=[],errors=[],steps=[];
const report={startedAt:new Date().toISOString(),steps,errors};
const email=`recovery-${randomUUID()}@example.test`;
const password='Recovery-Initial-2026!',newPassword='Recovery-Changed-2026!';
let db,server,app,browser,context,page,base,handler;
function watch(target){target.on('pageerror',error=>errors.push(error.message));target.on('console',message=>{if(message.type()==='error'&&!/Failed to load resource: the server responded with a status of (400|401)/.test(message.text()))errors.push(message.text());});}
async function step(name,run){try{await run();steps.push({name,passed:true});console.log(`PASS ${name}`);}catch(error){steps.push({name,passed:false,error:error.message});throw error;}}
async function requestFor(target,url,action){const [response]=await Promise.all([target.waitForResponse(r=>r.url().endsWith(url)&&r.request().method()==='POST'),action()]);return response;}
async function mailLink(route){await app.locals.drainMail();const mail=mailbox.findLast(m=>m.to===email&&m.text.includes('/#'+route+'?'));assert.ok(mail,`Missing fake mail for ${route}`);const link=mail.text.match(/https?:\/\/[^\s<>]+/g)?.find(value=>value.includes('/#'+route+'?'));assert.ok(link);assert.equal(new URL(link).origin,base);return link;}
async function login(target,secret){await target.goto(base+'/#/login');await target.getByLabel('邮箱',{exact:true}).fill(email);await target.getByLabel('密码',{exact:true}).fill(secret);const response=await requestFor(target,'/api/auth/login',()=>target.getByRole('button',{name:/登录工作台/}).click());return response;}
async function screenshot(target,name){await target.waitForFunction(()=>document.querySelectorAll('.ant-message-notice').length===0);await target.screenshot({path:path.join(output,name),fullPage:true,animations:'disabled'});}

try{
  db=await openDatabase({dataDir:path.join(temp,'database')});
  server=createServer((req,res)=>handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;
  app=createApp({db,config:{appOrigin:base,production:false,requireVerifiedEmail:true,authRateLimit:1000,mailRateLimit:1000,mailCooldownMs:0,staticDir:path.join(root,'dist')},mailer:{async send(message){mailbox.push(message);}}});handler=app;
  browser=await chromium.launch({headless:true,...(process.env.BROWSER_CHANNEL?{channel:process.env.BROWSER_CHANNEL}:process.platform==='win32'?{channel:'msedge'}:{})});
  context=await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN'});await context.tracing.start({screenshots:true,snapshots:true,sources:false});page=await context.newPage();watch(page);page.setDefaultTimeout(12000);
  let verificationLink,resetLink,otherContext,otherPage;

  await step('注册后进入邮箱验证引导，不提前请求经营数据',async()=>{
    const businessRequests=[];page.on('request',request=>{if(request.url().endsWith('/api/data'))businessRequests.push(request.url());});
    await page.goto(base);await page.getByText('创建空间',{exact:true}).click();await page.getByLabel('你的姓名',{exact:true}).fill('邮箱验收');await page.getByLabel('经营空间名称',{exact:true}).fill('邮箱恢复验收空间');await page.getByLabel('邮箱',{exact:true}).fill(email);await page.getByLabel('密码',{exact:true}).fill(password);await page.getByLabel('确认密码',{exact:true}).fill(password);await page.getByRole('button',{name:'创建经营空间'}).click();await page.getByTestId('verification-required').waitFor();
    verificationLink=await mailLink('/verify-email');assert.equal(businessRequests.length,0);await screenshot(page,'verification-required.png');
  });
  await step('邮件验证链接先清除地址栏令牌，明确确认后才能进入经营空间',async()=>{
    const confirmation=await context.newPage();watch(confirmation);await confirmation.goto(verificationLink);await confirmation.getByTestId('verify-email-page').waitFor();assert.ok(!confirmation.url().includes('token='));
    const before=await confirmation.evaluate(async()=>(await(await fetch('/api/auth/session')).json()).user.emailVerified);assert.equal(before,false);
    const response=await requestFor(confirmation,'/api/auth/verification/confirm',()=>confirmation.getByRole('button',{name:'确认验证邮箱',exact:true}).click());assert.equal(response.status(),200);await confirmation.getByRole('button',{name:'进入工作台',exact:true}).click();await confirmation.locator('.main-content').waitFor();
    await page.getByRole('button',{name:'我已验证，继续进入',exact:true}).click();await page.locator('.main-content').waitFor();await confirmation.close();
  });
  await step('已消费验证链接拒绝重放且保留当前账号',async()=>{
    const replay=await context.newPage();watch(replay);await replay.goto(verificationLink);await replay.getByTestId('verify-email-page').waitFor();const response=await requestFor(replay,'/api/auth/verification/confirm',()=>replay.getByRole('button',{name:'确认验证邮箱',exact:true}).click());assert.equal(response.status(),400);await replay.close();assert.equal((await context.request.get(base+'/api/auth/session')).status(),200);
  });
  await step('验证后创建业务，另一浏览器登录同一账号',async()=>{
    await page.goto(base+'/#/customers');await page.getByRole('button',{name:'新增客户'}).click();const dialog=page.getByRole('dialog');await dialog.getByLabel('客户名称',{exact:true}).fill('重置密码后保留的客户');await dialog.getByLabel('联系人',{exact:true}).fill('王女士');await dialog.getByLabel('联系电话',{exact:true}).fill('13800000001');
    const [response]=await Promise.all([page.waitForResponse(r=>r.url().includes('/api/records/customers/')&&r.request().method()==='PUT'),dialog.getByRole('button',{name:'保存记录'}).click()]);assert.equal(response.status(),200);await dialog.waitFor({state:'hidden'});
    otherContext=await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN'});otherPage=await otherContext.newPage();watch(otherPage);assert.equal((await login(otherPage,password)).status(),200);await otherPage.locator('.main-content').waitFor();
  });
  await step('公开找回入口对存在和不存在邮箱给出相同响应',async()=>{
    await page.locator('.account-button').click();await page.getByRole('menuitem',{name:'退出工作台'}).click();await page.getByRole('button',{name:/登录工作台/}).waitFor();
    async function forgot(address){await page.getByRole('button',{name:'忘记密码',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.getByLabel('注册邮箱',{exact:true}).fill(address);const response=await requestFor(page,'/api/auth/password/forgot',()=>dialog.getByRole('button',{name:'申请重置邮件',exact:true}).click());assert.equal(response.status(),202);const payload=await response.json();await dialog.locator('.ant-modal-close').click();await dialog.waitFor({state:'hidden'});await app.locals.drainMail();return payload;}
    const unknown=`unknown-${randomUUID()}@example.test`;const absent=await forgot(unknown);assert.ok(mailbox.every(message=>message.to!==unknown));const present=await forgot(email);assert.deepEqual(present,absent);resetLink=await mailLink('/reset-password');
  });
  await step('重置密码链接清理令牌并撤销其他浏览器会话',async()=>{
    await page.goto(resetLink);await page.getByTestId('reset-password-page').waitFor();assert.ok(!page.url().includes('token='));await screenshot(page,'reset-password.png');
    await page.getByLabel('新密码',{exact:true}).fill(newPassword);await page.getByLabel('确认新密码',{exact:true}).fill(newPassword);const response=await requestFor(page,'/api/auth/password/reset',()=>page.getByRole('button',{name:'重置密码',exact:true}).click());assert.equal(response.status(),200);await page.getByRole('button',{name:/登录工作台/}).waitFor();assert.ok(page.url().includes('reset=success'));
    assert.equal((await otherContext.request.get(base+'/api/auth/session')).status(),401);await otherPage.reload();await otherPage.getByRole('button',{name:/登录工作台/}).waitFor();
  });
  await step('旧密码失效，新密码可登录且经营数据保留',async()=>{
    assert.equal((await login(page,password)).status(),401);assert.equal((await login(page,newPassword)).status(),200);await page.locator('.main-content').waitFor();await page.goto(base+'/#/customers');await page.getByRole('button',{name:'编辑重置密码后保留的客户',exact:true}).waitFor();
    const identity=await page.evaluate(async()=>(await(await fetch('/api/auth/session')).json()));assert.equal(identity.user.emailVerified,true);await page.goto(base+'/#/settings');await page.getByText('邮箱已验证',{exact:true}).waitFor();
  });
  await step('重放已使用的重置链接被拒绝，手机页面无横向溢出',async()=>{
    const replay=await context.newPage();watch(replay);await replay.setViewportSize({width:390,height:844});await replay.goto(resetLink);await replay.getByTestId('reset-password-page').waitFor();await replay.getByLabel('新密码',{exact:true}).fill('Rejected-Replay-2026!');await replay.getByLabel('确认新密码',{exact:true}).fill('Rejected-Replay-2026!');const response=await requestFor(replay,'/api/auth/password/reset',()=>replay.getByRole('button',{name:'重置密码',exact:true}).click());assert.equal(response.status(),400);const width=await replay.evaluate(()=>({body:document.documentElement.scrollWidth,view:innerWidth}));assert.ok(width.body<=width.view+1);await screenshot(replay,'mobile-expired-link.png');await replay.close();assert.equal((await context.request.get(base+'/api/auth/session')).status(),200);
  });
  await step('邮件流程没有页面异常或非预期控制台错误',async()=>{assert.deepEqual(errors,[]);});
  report.passed=true;
}catch(error){report.passed=false;report.failure=error.stack;console.error(error);if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));if(context)await context.tracing.stop({path:path.join(output,'trace.zip')}).catch(()=>{});if(browser)await browser.close();if(app?.locals.drainMail)await app.locals.drainMail();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}if(db)await db.close();const relative=path.relative(os.tmpdir(),temp);if(!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(temp).startsWith('yunji-auth-browser-'))await rm(temp,{recursive:true,force:true});}
