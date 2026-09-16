import { chromium } from './browser.mjs';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const base=process.env.TEST_URL||'http://127.0.0.1:5173';
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];
page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(['error','warning'].includes(m.type()))errors.push(m.text());});
const menu=async label=>{await page.locator('.account-button').click();await page.getByRole('menuitem').filter({hasText:label}).click();};
try{
 await page.goto(base);await page.getByRole('button',{name:'免登录体验演示'}).click();await page.locator('.page-heading').waitFor();
 const downloading=page.waitForEvent('download');await menu('导出数据备份');const download=await downloading;const exported=JSON.parse(await fs.readFile(await download.path(),'utf8'));assert.equal(exported.version,1);assert.equal(exported.customers.length,12);console.log('PASS JSON 备份可解析且包含完整业务记录');
 const imported=structuredClone(exported);imported.customers.push({...imported.customers[0],id:'BACKUP-TEST',name:'备份导入客户'});await page.locator('input[type=file]').setInputFiles({name:'test-backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(imported))});await page.getByRole('button',{name:'确认导入',exact:true}).click();await page.waitForFunction(()=>JSON.parse(localStorage.getItem('yunji-business-v1')).customers.length===13);await page.reload();assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('yunji-business-v1')).customers.length),13);console.log('PASS 导入备份后刷新仍保留');
 await page.locator('input[type=file]').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from('{"version":99}')});await page.getByText('备份数据格式不正确或存在重复、关联缺失等问题',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('yunji-business-v1')).customers.length),13);console.log('PASS 非法备份被拒绝，原数据保留');
 await page.evaluate(()=>localStorage.setItem('yunji-business-v1','broken-json'));await page.reload();await page.getByText('本地数据异常',{exact:true}).waitFor();const rawDownloadPromise=page.waitForEvent('download');await menu('导出数据备份');const rawDownload=await rawDownloadPromise;assert.equal(await fs.readFile(await rawDownload.path(),'utf8'),'broken-json');assert.equal(await page.evaluate(()=>localStorage.getItem('yunji-business-v1')),'broken-json');console.log('PASS 损坏数据未覆盖，所有备份入口导出原始文本');
 await menu('恢复演示数据');await page.getByRole('button',{name:'确认恢复',exact:true}).click();await page.waitForFunction(()=>JSON.parse(localStorage.getItem('yunji-business-v1')).customers.length===12);await page.getByText('本地数据已保存',{exact:true}).waitFor();console.log('PASS 显式恢复后解除异常，重新持久化');assert.deepEqual(errors,[]);await fs.writeFile('test-results/backup.json',JSON.stringify({checks:5,errors},null,2));
}catch(e){console.error(e);process.exitCode=1;}finally{await browser.close();}
