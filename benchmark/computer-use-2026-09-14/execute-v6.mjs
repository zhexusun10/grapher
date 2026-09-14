// Execute a real Planner-produced audit graph through the current browser/backend.
import fs from 'node:fs';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const repo=path.resolve(import.meta.dirname,'../..');
const evidence=path.resolve(process.env.V6_EVIDENCE_DIR || path.join(import.meta.dirname,'v6-e2e'));fs.mkdirSync(evidence,{recursive:true});
const original=JSON.parse(fs.readFileSync(path.join(import.meta.dirname,'v6-contract-recheck/metadata.json')));
const project=path.join(original.root,'audit/project'),data=path.join(original.root,'audit/data');
const write=(name,value)=>fs.writeFileSync(path.join(evidence,name),typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');
const git=(...args)=>execFileSync('git',args,{cwd:project,encoding:'utf8'}).trim();
const baseline=git('rev-parse','HEAD');
const sourceManifest={};
for(const f of execFileSync('git',['ls-files','--cached','--others','--exclude-standard'],{cwd:repo,encoding:'utf8'}).split('\n').filter(f=>/^(backend\/(src|resources)\/|engine\/|src\/)/.test(f)))sourceManifest[f]=createHash('sha256').update(fs.readFileSync(path.join(repo,f))).digest('hex');
write('source-manifest.json',sourceManifest);
const metadata={project,data,baseline,model:'dashscope/qwen3.8-flash',thinking:'medium',nodeTimeoutSeconds:900,planningEvidence:'../v6-contract-recheck/audit',startedAt:new Date().toISOString(),sourceSha256:createHash('sha256').update(JSON.stringify(sourceManifest)).digest('hex')};write('metadata.json',metadata);
const fd=fs.openSync(path.join(evidence,'server.log'),'w');
const server=spawn(path.join(repo,'backend/target/debug/grapher'),[],{cwd:project,env:{...process.env,GRAPHER_PORT:'1500',GRAPHER_DATA_DIR:data,NODE_AGENT_MODEL:metadata.model,NODE_AGENT_THINKING:'medium',NODE_AGENT_TIMEOUT_SECONDS:'900',MERGER_MODEL:metadata.model,MERGER_THINKING:'medium'},stdio:['ignore',fd,fd]});
const api=async(command,body={})=>{const r=await fetch(`http://127.0.0.1:1500/api/${command}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const v=await r.json();if(v.error)throw Error(v.error);return v.result;};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const log=text=>{console.log(text);fs.appendFileSync(path.join(evidence,'progress.log'),`${new Date().toISOString()} ${text}\n`);};
let browser,page;
try{
 for(let i=0;i<100;i++){try{await api('bootstrap');break;}catch{await delay(100);}}
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE);
 browser=await chromium.launch({channel:'chrome',headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.goto('http://127.0.0.1:1500',{waitUntil:'domcontentloaded'});
 const before=await api('snapshot');write('before-approval.json',before);
 if(process.env.V6_RESUME_NODE){
  assert.equal(before.phase,'needs_attention');
  const node=process.env.V6_RESUME_NODE;
  await page.locator('.react-flow__node').filter({hasText:node}).click();
  const instruction='Complete the original release assessment using the two upstream reports and the source files already in this worktree. Keep reports/release.md focused (at most 600 words). Do not repeat disk-image, mount, crash, or ENOSPC experiments: preserve the upstream observed evidence and explicitly label unverified scenarios and reproduction setup limitations. Check the real current date and do not claim placeholder tests verify auth or storage. Correct unsupported statements in the three reports when necessary. Do not change application source or run Git commands. Provide the release recommendation, concrete blockers, tradeoffs, evidence links and remaining limits; avoid repeating exploratory probes that do not change that decision.';
  await page.getByPlaceholder(`向 [${node}] 发送微调或介入指令...`).fill(instruction);
  await Promise.all([
   page.waitForResponse(r=>r.url().endsWith('/api/control')&&r.request().postDataJSON().action==='intervene'),
   page.getByRole('button',{name:'发送消息',exact:true}).click(),
  ]);
  write('human-intervention.json',{node,instruction,at:new Date().toISOString()});log(`Targeted intervention submitted via browser: ${node}`);
 }else{
  assert.equal(before.phase,'awaiting_approval');assert.equal(before.executions.length,0);
  await page.getByRole('button',{name:'Approve & Start',exact:true}).click();
  await page.screenshot({path:path.join(evidence,'01-approval.png')});
  await page.getByRole('button',{name:'确认审批并启动'}).click();log('Current production build: real Planner graph approved via browser');
 }
 let last='',snap,start=Date.now(),capturedFast=false,capturedRunning=false;
 while(Date.now()-start<2400000){
  snap=await api('snapshot');
  const status=`${snap.phase}:${snap.executions.map(e=>`${e.node}/${e.attempt}/${e.status}`).join(',')}`;
  if(status!==last){log(status);last=status;write('latest-state.json',{phase:snap.phase,nodes:snap.nodes,executions:snap.executions.map(({output,...e})=>e)});}
  const running=snap.executions.filter(e=>e.status==='running');
  if(!capturedRunning&&running.length){
   await page.locator('.react-flow__node').filter({hasText:running[0].node}).click();
   await page.locator('.execution-timing').filter({hasText:'已运行'}).waitFor();
   const first=await page.locator('.execution-timing').innerText();await delay(2100);
   const after=await page.locator('.execution-timing').innerText();assert.notEqual(first,after);
   write('live-timer.json',{before:first,after});
   await page.screenshot({path:path.join(evidence,'02-running-node.png')});capturedRunning=true;
  }
  if(!capturedFast&&running.length&&snap.executions.some(e=>e.status==='completed')){
   write('fast-sibling-finished.json',snap);await page.reload({waitUntil:'domcontentloaded'});
   await page.locator('.react-flow__node').first().waitFor();await page.screenshot({path:path.join(evidence,'03-independent-completion.png')});capturedFast=true;
  }
  if(['completed','needs_attention','publication_failed'].includes(snap.phase))break;
  await delay(1500);
 }
 write('snapshot.json',snap);write('graph.json',snap.graph);write('events.json',snap.events);
 await page.reload({waitUntil:'domcontentloaded',timeout:60000});await page.locator('.react-flow__node').first().waitFor();
 await page.screenshot({path:path.join(evidence,'04-final.png')});write('final-browser.txt',await page.locator('body').innerText());
 write('browser-errors.json',errors);write('published.diff',git('diff',baseline,'HEAD'));write('git-log.txt',git('log','--oneline','--graph','--all'));
 assert.equal(snap.phase,'completed');assert.equal(git('status','--porcelain'),'');
 const changed=git('diff','--name-only',baseline,'HEAD').split('\n');assert.ok(changed.every(f=>f.startsWith('reports/')));
 for(const name of ['auth','storage','release'])assert.ok(fs.statSync(path.join(project,'reports',`${name}.md`)).size>100);
 fs.cpSync(path.join(project,'reports'),path.join(evidence,'reports'),{recursive:true});
 const expired=execFileSync(process.execPath,['--input-type=module','-e',`import {sessions,authenticate} from './server/auth.ts'; sessions.set('expired-proof',{userId:'test-user',expiresAt:Date.now()-1000}); console.log(authenticate('expired-proof'));`],{cwd:project,encoding:'utf8'}).trim();
 assert.equal(expired,'test-user');
 write('independent-acceptance.json',{status:'PASS',onlyReportsChanged:true,changed,sourceUnchanged:true,expiredSessionReturns:expired,releaseReportExists:true,cleanRepository:true,publication:snap.publication});
 metadata.status='PASS';log('Graph completed and published; independent source/report/expired-session checks passed');
}catch(error){metadata.status='FAIL';metadata.error=String(error);log(String(error));process.exitCode=1;}
finally{metadata.endedAt=new Date().toISOString();write('metadata.json',metadata);if(browser)await browser.close();server.kill('SIGINT');}
