import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const require=createRequire(import.meta.url);
let modulePath;try{modulePath=require.resolve('playwright');}catch{modulePath=path.join(process.env.USERPROFILE||'', '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');}
export const {chromium}=await import(pathToFileURL(modulePath).href);
