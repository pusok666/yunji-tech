import { chromium } from './browser.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';

// A reserved HTTP test origin reproduces LAN browser security rules. Files are
// fulfilled from dist; the test does not expose a port or alter the firewall.
const origin = 'http://yunji-lan.test';
const root = path.resolve('dist');
const browser = await chromium.launch({channel:'msedge',headless:true});
const page = await browser.newPage();
const errors=[];
page.on('pageerror',e=>errors.push(String(e)));
page.on('console',m=>{if(['error','warning'].includes(m.type()))errors.push(m.text());});
await page.route(`${origin}/**`,async route=>{
  const pathname=decodeURIComponent(new URL(route.request().url()).pathname);
  const file=path.resolve(root,`.${pathname==='/'?'/index.html':pathname}`);
  if(!file.startsWith(root+path.sep)){await route.abort();return;}
  const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'}[path.extname(file)]||'application/octet-stream';
  await route.fulfill({path:file,contentType:mime});
});
try {
  await page.goto(origin);
  assert.equal(await page.evaluate(()=>window.isSecureContext),false);
  assert.equal(await page.evaluate(()=>typeof crypto.randomUUID),'undefined');
  await page.getByRole('button',{name:'免登录体验演示'}).click();
  await page.goto(`${origin}/#/assistant`);
  for(const [i,question] of ['本月收入有多少？','有哪些库存预警？'].entries()){
    await page.getByRole('textbox',{name:'向经营助手提问'}).fill(question);
    await page.getByRole('button',{name:'发送消息'}).click();
    await page.waitForFunction(n=>document.querySelectorAll('.chat-message.assistant').length===n,i+1);
  }
  await page.reload();
  await page.locator('.chat-message.assistant').first().waitFor();
  assert.equal(await page.locator('.chat-message.assistant').count(),2);
  const messages=await page.evaluate(()=>JSON.parse(localStorage.getItem('yunji-chat')));
  assert.equal(new Set(messages.map(m=>m.id)).size,4);
  assert.deepEqual(errors,[]);
  await fs.mkdir('test-results',{recursive:true});
  await fs.writeFile('test-results/lan.json',JSON.stringify({secureContext:false,randomUUIDAvailable:false,checks:['HTTP 普通来源可登录','AI 连续两次发送成功','ID 唯一','刷新保留对话'],errors},null,2));
  console.log('PASS HTTP LAN-origin compatibility: login, repeated AI requests, unique IDs, persisted chat; zero console errors');
} finally {await browser.close();}
