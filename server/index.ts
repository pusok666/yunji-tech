import { createApp } from './app.ts';
import { openDatabase } from './db.ts';

const production = process.env.NODE_ENV === 'production';
const appOrigin = process.env.APP_ORIGIN || (production ? '' : 'http://127.0.0.1:5174');
const inviteCode = process.env.INVITE_CODE;
if (production && (!process.env.DATABASE_URL || !appOrigin.startsWith('https://') || !inviteCode || inviteCode.length < 16)) throw new Error('生产启动已拒绝：需要 DATABASE_URL、HTTPS APP_ORIGIN 和至少 16 位 INVITE_CODE');
const port = Number(process.env.PORT ?? 4100);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 无效');
const db = await openDatabase({ dataDir: process.env.DATA_DIR, url: process.env.DATABASE_URL });
const app = createApp({ db, config: { appOrigin, production, inviteCode, trustProxy: process.env.TRUST_PROXY === '1' } });
const server = app.listen(port, process.env.HOST ?? '127.0.0.1', () => console.log(`Yunji Commercial API listening on ${process.env.HOST ?? '127.0.0.1'}:${port} (${db.engine})`));
server.on('error', async error => { console.error('API 启动失败:', error.message); await db.close(); process.exitCode = 1; });
let shuttingDown = false;
const stop = () => { if (shuttingDown) return; shuttingDown = true; server.close(async () => { await db.close(); process.exitCode = 0; }); setTimeout(() => process.exit(1), 10000).unref(); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
