import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const manifest=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
if(manifest.name!=='yunji-business-commercial')throw Error('Wrong project: checkpoint aborted.');
function git(args){try{return execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}catch{if(process.platform==='win32')return execFileSync('D:\\Git\\cmd\\git.exe',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();throw Error('Git is required.');}}
let browser=null;
try{const report=JSON.parse(await readFile(path.join(root,'test-results/commercial/report.json'),'utf8'));browser={passed:report.passed,finishedAt:report.finishedAt,steps:report.steps.map(({name,passed})=>({name,passed}))};}catch{}
let postgres=null;
try{const r=JSON.parse(await readFile(path.join(root,'.local/test-results/postgres-verification.json'),'utf8'));postgres={finishedAt:r.finishedAt,version:r.version,clientVersion:r.clientVersion,apiPassed:r.apiPassed,normalRole:r.normalRole,productionConfigPassed:r.productionConfigPassed,dumpRestorePassed:r.dumpRestorePassed,stopped:r.stopped,cleaned:r.cleaned,mappingRemoved:r.mappingRemoved};}catch{}
const state={updatedAt:new Date().toISOString(),project:manifest.name,branch:git(['branch','--show-current']),head:git(['rev-parse','HEAD']),workingTree:git(['status','--short']),browserVerification:browser,postgresVerification:postgres,resumeEntry:'COMMERCIAL_PROGRESS.md',frontendCheckpoint:'src/FRONTEND_CHECKPOINT.md',backendCheckpoint:'server/BACKEND_CHECKPOINT.md',userActions:'docs/USER_ACTIONS.md',protectedPresentationDirectory:'D:\\云迹科技',note:'Reports describe their recorded run, not any later edits. This records state, not a source or database backup. Preserve local changes and commit completed stages separately. No credentials or database contents are recorded.'};
await writeFile(path.join(root,'CHECKPOINT.json'),JSON.stringify(state,null,2)+'\n');
console.log(`Checkpoint saved: ${state.branch} @ ${state.head.slice(0,7)}; browser=${browser?browser.passed?'passed':'incomplete':'not run'}`);
