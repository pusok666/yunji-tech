import { chromium } from './browser.mjs';
import fs from 'node:fs';
fs.mkdirSync('test-results',{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1100},deviceScaleFactor:1});
const errors=[];page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error'||m.type()==='warning')errors.push(m.type()+': '+m.text());});
await page.goto('http://127.0.0.1:5173');await page.getByRole('button',{name:'免登录体验演示'}).waitFor();await page.screenshot({path:'test-results/login-desktop.png',fullPage:true,animations:'disabled'});await page.getByRole('button',{name:'免登录体验演示'}).click();await page.getByRole('heading',{name:'经营概览',exact:true}).waitFor();await page.waitForTimeout(1500);
await page.screenshot({path:'test-results/dashboard-desktop.png',fullPage:true,animations:'disabled'});
for(const [path,title] of [['customers','客户管理'],['orders','订单管理'],['inventory','库存管理'],['finance','收支管理'],['statistics','数据统计'],['assistant','AI 经营助手']]){await page.goto('http://127.0.0.1:5173/#/'+path);await page.getByRole('heading',{name:title,exact:true}).waitFor();await page.waitForTimeout(1500);await page.screenshot({path:`test-results/${path}-desktop.png`,fullPage:true,animations:'disabled'});console.log('PASS route',path);}
await page.setViewportSize({width:390,height:844});await page.goto('http://127.0.0.1:5173/#/');await page.getByRole('heading',{name:'经营概览',exact:true}).waitFor();await page.waitForTimeout(1500);await page.screenshot({path:'test-results/dashboard-mobile.png',fullPage:true,animations:'disabled'});
console.log(JSON.stringify({errors},null,2));fs.writeFileSync('test-results/smoke.json',JSON.stringify({errors},null,2));await browser.close();if(errors.length)process.exitCode=1;
