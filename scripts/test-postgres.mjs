// Windows-only, isolated real PostgreSQL compatibility and restore verification.
// Tool bootstrap (outside application dependencies):
// pnpm --dir .local/pg-native-tools add --ignore-workspace --ignore-scripts @embedded-postgres/windows-x64@17.10.0-beta.17
// Clients: EDB postgresql-17.11-4-windows-x64-binaries.zip, extract pgsql/bin
// to .local/pg-client-tools. Verify the published SHA256 before extraction:
// b9424ee7bc60b52450ff910a3630225df32e633f3cb29c1d126d9299d59aea28
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { openDatabase } from '../server/db.ts';
import { createApp } from '../server/app.ts';

if(process.platform!=='win32') throw new Error('This local binary runner is Windows-only. On other platforms use TEST_DATABASE_URL with the API suite.');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const local=join(root,'.local');
const toolsRoot=join(local,'pg-native-tools','node_modules','@embedded-postgres','windows-x64');
const binaries={...await import(pathToFileURL(join(toolsRoot,'dist','index.js')).href)};
const symlinks=JSON.parse(await readFile(join(toolsRoot,'native','pg-symlinks.json'),'utf8'));
assert.deepEqual(symlinks,[],'Review symlink targets before running a package with nonempty symlinks');
let clientBin=join(local,'pg-client-tools','pgsql','bin'),mappingDrive,mappingRoot;
await access(join(clientBin,'pg_dump.exe')); await access(join(clientBin,'pg_restore.exe'));
const run=promisify(execFile);
const command=(file,args,options={})=>run(file,args,{cwd:mappingRoot??root,windowsHide:true,encoding:'utf8',maxBuffer:8*1024*1024,timeout:60000,...options});
async function mappingTargetMatches() {
  if(!mappingDrive) return false;
  const {stdout}=await command('subst.exe',[],{encoding:'buffer'});
  for(const encoding of ['utf-8','gb18030']) {
    const line=new TextDecoder(encoding).decode(stdout).split(/\r?\n/).find(value=>value.toUpperCase().startsWith(`${mappingDrive}\\: => `));
    if(line && resolve(line.slice(line.indexOf(' => ')+4)).toLowerCase()===resolve(local).toLowerCase()) return true;
  }
  return false;
}
const port=55439;
const probe=createServer(); probe.listen(port,'127.0.0.1'); await once(probe,'listening'); await new Promise(r=>probe.close(r));
await mkdir(local,{recursive:true});
const runDir=await mkdtemp(join(local,'pg-native-run-'));
let dataDir=join(runDir,'data'), logFile=join(runDir,'postgres.log');
const reports=join(local,'test-results'); await mkdir(reports,{recursive:true});
const adminPassword=randomBytes(32).toString('hex'), appPassword=randomBytes(32).toString('hex');
const adminName='yunji_test_admin',appName='yunji_test_app';
const makeUrl=(name,password,database)=>`postgresql://${name}:${password}@127.0.0.1:${port}/${database}`;
const dbName='yunji_api_test', restoredName='yunji_restore_test';
const admin=new pg.Client({connectionString:makeUrl(adminName,adminPassword,'postgres')});
const report={startedAt:new Date().toISOString(),database:'postgres',port,host:'127.0.0.1',version:'',apiPassed:false,recoveryPassed:false,normalRole:false,productionConfigPassed:false,dumpRestorePassed:false,authStateRestorePassed:false,stopped:false,cleaned:false,mappingRemoved:false};
let started=false,adminConnected=false,appDb,source,restored,productionServer;

try {
  // PostgreSQL's Windows ANSI path handling can fail with a Chinese directory.
  // An unused temporary drive maps ONLY this project's .local; no data moves.
  const logical=JSON.parse((await command('powershell.exe',['-NoProfile','-Command','[Environment]::GetLogicalDrives() | ConvertTo-Json -Compress'])).stdout);
  const occupied=new Set([logical].flat().map(value=>value.slice(0,2).toUpperCase()));
  mappingDrive=['Z:','Y:','X:','W:','V:','U:','T:'].find(drive=>!occupied.has(drive));
  assert.ok(mappingDrive,'No unused drive letter is available for this isolated test');
  try { await access(mappingDrive+'\\'); throw new Error('Selected drive unexpectedly exists'); } catch(error) { if(!['ENOENT','ENOTDIR'].includes(error.code)) throw error; }
  await command('subst.exe',[mappingDrive,local]);
  assert.ok(await mappingTargetMatches(),'Temporary drive does not map to this project .local');
  mappingRoot=mappingDrive+'\\'; report.temporaryDrive=mappingDrive;
  const asciiPath=value=>join(mappingRoot,relative(local,value));
  for(const key of ['postgres','initdb','pg_ctl']) binaries[key]=asciiPath(binaries[key]);
  clientBin=asciiPath(clientBin); dataDir=asciiPath(dataDir);logFile=asciiPath(logFile);
  report.version=(await command(binaries.postgres,['--version'])).stdout.trim(); console.log(report.version);
  report.clientVersion=(await command(join(clientBin,'pg_dump.exe'),['--version'])).stdout.trim();console.log(report.clientVersion);
  // initdb --pwfile uses a Windows named pipe, never a plaintext password file.
  const pipeName=`\\\\.\\pipe\\yunji-pg-init-${randomUUID()}`;
  const pipe=createServer(socket=>socket.end(adminPassword+'\n'));
  pipe.listen(pipeName); await once(pipe,'listening');
  try {
    await command(binaries.initdb,['-D',dataDir,'-U',adminName,'--auth=scram-sha-256','--encoding=UTF8','--locale=C',`--pwfile=${pipeName}`]);
  } finally { await new Promise(r=>pipe.close(r)); }
  started=true;
  await command(binaries.pg_ctl,['-D',dataDir,'-l',logFile,'-o',`-h 127.0.0.1 -p ${port} -c max_connections=30`,'-w','-t','30','start']);
  await admin.connect(); adminConnected=true;
  // Hex-only random passwords are inserted as SQL literals; never printed.
  await admin.query(`CREATE ROLE ${appName} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${appPassword}'`);
  await admin.query(`CREATE DATABASE ${dbName} OWNER ${appName}`);
  await admin.query(`CREATE DATABASE ${restoredName} OWNER ${appName}`);
  const appUrl=makeUrl(appName,appPassword,dbName), restoreUrl=makeUrl(appName,appPassword,restoredName);
  source=new pg.Client({connectionString:appUrl}); await source.connect();
  const role=(await source.query('SELECT current_user,rolsuper,rolcreatedb FROM pg_roles WHERE rolname=current_user')).rows[0];
  assert.equal(role.rolsuper,false); assert.equal(role.rolcreatedb,false); report.normalRole=true;
  console.log('Running API suite through pg with a non-superuser database owner...');
  const api=await command(process.execPath,['--experimental-strip-types','--test','tests/api.test.mjs'],{cwd:root,env:{...process.env,TEST_DATABASE_URL:appUrl},timeout:120000});
  console.log(api.stdout); await writeFile(join(reports,'postgres-api.log'),api.stdout+api.stderr,'utf8'); report.apiPassed=true;
  const recovery=await command(process.execPath,['--experimental-strip-types','--test','server/tests/recovery.test.ts'],{cwd:root,env:{...process.env,RECOVERY_TEST_DATABASE_URL:appUrl},timeout:180000});
  console.log(recovery.stdout);await writeFile(join(reports,'postgres-recovery.log'),recovery.stdout+recovery.stderr,'utf8');report.recoveryPassed=true;
  appDb=await openDatabase({url:appUrl});
  productionServer=createApp({db:appDb,config:{production:true,appOrigin:'https://yunji.example.test',inviteCode:'test-only-'+randomBytes(16).toString('hex'),smtp:{host:'smtp.example.test',port:587,user:'isolated-test',password:randomBytes(16).toString('hex'),from:'accounts@example.test'}},mailer:{async send(){throw new Error('This production configuration check must never send mail');}}}).listen(0,'127.0.0.1');
  await once(productionServer,'listening');
  const health=await fetch(`http://127.0.0.1:${productionServer.address().port}/api/health`);
  assert.equal((await health.json()).database,'postgres'); assert.match(health.headers.get('strict-transport-security'),/max-age=/);
  report.productionConfigPassed=true;
  productionServer.closeAllConnections(); await new Promise(r=>productionServer.close(r)); productionServer=undefined;
  await appDb.close();appDb=undefined;
  // Seed NONEMPTY authentication state only in this freshly created test cluster.
  // Recovery tests use disposable schemas, so their rows are intentionally gone.
  const owner=(await source.query('SELECT id,email,credential_version FROM users ORDER BY id LIMIT 1')).rows[0];
  assert.ok(owner,'The API test must create at least one account');
  await source.query('UPDATE users SET email_verified_at=now() WHERE id=$1',[owner.id]);
  for(const [index,status] of ['pending','sent','sent','failed'].entries()) {
    const sent=status==='sent'?new Date().toISOString():null;
    const consumed=index===2?new Date().toISOString():null;
    const invalidated=status==='failed'?new Date().toISOString():null;
    await source.query('INSERT INTO auth_tokens(id,user_id,purpose,token_hash,email_snapshot,credential_version,expires_at,delivery_status,sent_at,consumed_at,invalidated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [randomUUID(),owner.id,index%2?'reset_password':'verify_email',randomBytes(32).toString('hex'),owner.email,owner.credential_version,new Date(Date.now()+3600000).toISOString(),status,sent,consumed,invalidated]);
  }
  await source.query('INSERT INTO auth_request_limits(key,window_started_at,attempts,next_allowed_at) VALUES($1,now(),3,now()+interval \'1 minute\')',[randomBytes(32).toString('hex')]);
  const dumpPath=join(dirname(dataDir),'test-backup.dump');
  const toolEnv={...process.env,PGHOST:'127.0.0.1',PGPORT:String(port),PGUSER:appName,PGPASSWORD:appPassword};
  await command(join(clientBin,'pg_dump.exe'),['--format=custom','--no-owner','--file',dumpPath,dbName],{env:toolEnv});
  await command(join(clientBin,'pg_restore.exe'),['--exit-on-error','--no-owner','--dbname',restoredName,dumpPath],{env:toolEnv});
  restored=new pg.Client({connectionString:restoreUrl});await restored.connect();
  const summarize=async client=>{
    const counts={}; for(const table of ['users','workspaces','sessions','records','receipts','stock_movements','audit_events','idempotency_keys','schema_migrations','auth_tokens','auth_request_limits']) counts[table]=Number((await client.query(`SELECT count(*)::int AS total FROM ${table}`)).rows[0].total);
    const money=(await client.query("SELECT COALESCE(sum(CASE WHEN payload->>'type'='收款' THEN (payload->>'amount')::numeric ELSE -(payload->>'amount')::numeric END),0)::text AS net FROM receipts")).rows[0].net;
    const stocks=(await client.query("SELECT COALESCE(sum((payload->>'delta')::bigint),0)::text AS total FROM stock_movements")).rows[0].total;
    return {counts,netReceipts:money,stockMovementTotal:stocks};
  };
  const expected=await summarize(source),actual=await summarize(restored);assert.deepEqual(actual,expected);
  assert.ok(expected.counts.auth_tokens>=4 && expected.counts.auth_request_limits>=1,'Authentication restore must test nonempty rows');
  // Compare every token/limiter field and account credential state without logging secrets.
  for(const sql of ['SELECT * FROM auth_tokens ORDER BY id','SELECT * FROM auth_request_limits ORDER BY key','SELECT id,password_hash,email_verified_at,credential_version FROM users ORDER BY id']) {
    assert.deepEqual((await restored.query(sql)).rows,(await source.query(sql)).rows);
  }
  report.authStateRestorePassed=true;report.dumpRestorePassed=true;report.restoredSummary=actual;
  console.log('Production configuration and pg_dump/pg_restore checks passed.');
} finally {
  if(productionServer) { productionServer.closeAllConnections(); await new Promise(r=>productionServer.close(r)); }
  if(appDb) await appDb.close();
  if(source) await source.end();if(restored) await restored.end();if(adminConnected) await admin.end();
  try {
    if(started) {
      let pidText;
      try { pidText=await readFile(join(dataDir,'postmaster.pid'),'utf8'); } catch(error) {
        if(error.code!=='ENOENT') throw error;
        try { await command(binaries.pg_ctl,['-D',dataDir,'status']); throw new Error('Unexpected running server without pid file'); } catch(statusError) { if(statusError.code!==3) throw statusError; }
        report.stopped=true;
      }
      if(pidText) {
        const pidLines=pidText.split(/\r?\n/); assert.ok(Number(pidLines[0])>0);
        assert.equal((await realpath(pidLines[1])).toLowerCase(),(await realpath(dataDir)).toLowerCase(),'Database process belongs to unexpected data directory');
        await command(binaries.pg_ctl,['-D',dataDir,'-m','fast','-w','-t','30','stop']);report.stopped=true;
      }
    }
    const absolute=await realpath(runDir),allowed=await realpath(local);
    assert.ok(absolute.toLowerCase().startsWith((allowed+sep).toLowerCase()) && dirname(absolute).toLowerCase()===allowed.toLowerCase() && absolute.split(sep).at(-1).startsWith('pg-native-run-'),'Unsafe cleanup path');
    // Only this script's fresh temporary cluster is removed. Tool download remains cached.
    if(!started || report.stopped) { await rm(absolute,{recursive:true,force:true});report.cleaned=true; }
  } finally {
    if(mappingDrive && (!started || report.stopped) && await mappingTargetMatches()) { await command('subst.exe',[mappingDrive,'/D'],{cwd:root});report.mappingRemoved=true;mappingRoot=undefined; }
    report.finishedAt=new Date().toISOString();await writeFile(join(reports,'postgres-verification.json'),JSON.stringify(report,null,2),'utf8');
    console.log(JSON.stringify(report,null,2));
  }
}
