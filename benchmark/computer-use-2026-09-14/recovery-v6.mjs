// Browser checks against a production backend with real persisted failed planning attempts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
const repo = path.resolve(import.meta.dirname, '../..');
const out = path.join(import.meta.dirname, 'v6', 'recovery');
fs.mkdirSync(out, { recursive: true });
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'grapher-recovery-v6-')));
const a = path.join(root, 'workspace-a');
const b = path.join(root, 'workspace-b');
for (const directory of [a,b]) {
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'README.md'), 'Browser recovery acceptance\n');
  for (const args of [['init','-q'], ['add','.'], ['-c','user.name=Acceptance','-c','user.email=acceptance@localhost','-c','commit.gpgsign=false','commit','-qm','baseline']]) execFileSync('git', args, {cwd:directory});
}
const fd = fs.openSync(path.join(out, 'server.log'), 'w');
const server = spawn(path.join(repo,'backend/target/debug/grapher'), [], {cwd:a,env:{...process.env,GRAPHER_PORT:'1470',GRAPHER_DATA_DIR:path.join(root,'data'),PARTITIONER_MODEL:'nonexistent-v6-provider/nonexistent-v6-model'},stdio:['ignore',fd,fd]});
const api = async (cmd, body={}) => {
  const r = await fetch(`http://127.0.0.1:1470/api/${cmd}`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  return await r.json();
};
const delay = ms => new Promise(r=>setTimeout(r,ms));
const actions=[];
const log = text => { actions.push({at:new Date().toISOString(),text}); console.log(text); };
let browser;
let page;
const network = [];
try {
  for(let i=0;i<100;i++){try{await api('bootstrap');break;}catch{await delay(100);}}
  const config={repository:a,model:'qwen3.8-flash',maxParallel:2,maxFeedback:2};
  const saved=await api('save_graph',{config,graph:{originalGoal:'Previous valid graph',nodes:[{name:'previous',task:'Write a report'}],edges:[]}});
  assert.ok(saved.result.runId);
  const failed=await api('plan_goal',{config,goal:'A failed planning attempt for workspace recovery acceptance'});
  assert.ok(failed.error);
  const summaries=(await api('list_plannings',{repository:a})).result;
  assert.equal(summaries[0].status,'failed');
  const failureId=summaries[0].planningId;
  fs.writeFileSync(path.join(out,'initial-failure.json'),JSON.stringify(summaries[0],null,2));
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE);
  browser=await chromium.launch({channel:'chrome',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.tracing.start({screenshots:true,snapshots:true});
  await context.addInitScript(({a,b,runId})=>{
    localStorage.setItem('grapher_projects',JSON.stringify([a,b].map(p=>({id:p,path:p,name:p.split('/').pop(),branch:'main',clean:true,lastOpened:Date.now()}))));
    localStorage.setItem('grapher_workspace_runs',JSON.stringify({[a]:[runId]}));
  },{a,b,runId:saved.result.runId});
  page=await context.newPage();
  page.on('response', async r => {
    if (r.url().includes('/api/')) {
      try { network.push({url:r.url(),body:r.request().postDataJSON(),response:await r.json()}); } catch {}
    }
  });
  const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.goto('http://127.0.0.1:1470');
  await page.getByText(failureId,{exact:false}).waitFor();
  log('A: actual persisted failed planning displayed together with previous valid graph');
  await page.screenshot({path:path.join(out,'01-a-failure.png')});
  const workspace = name => page.locator('.project-workspace-item').filter({hasText:name});
  await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/api/list_plannings') && r.request().postDataJSON().repository === b),
    workspace('workspace-b').click(),
  ]);
  await page.getByText(failureId,{exact:false}).waitFor({state:'hidden'});
  log('B: A failure cleared after workspace selection');
  await page.screenshot({path:path.join(out,'02-b.png')});
  await workspace('workspace-a').click();
  await page.getByText(failureId,{exact:false}).waitFor();
  await page.reload();
  await page.getByText(failureId,{exact:false}).waitFor();
  log('A: switching back and refreshing both restore the correct failure');

  // Delay a real server response across the start of repository detection.
  let releaseList, listArrived;
  const arrived = new Promise(r=>{listArrived=r;});
  const gate = new Promise(r=>{releaseList=r;});
  await page.route('**/api/list_plannings',async route=>{
    const response=await route.fetch(); listArrived(); await gate; await route.fulfill({response});
  });
  await page.reload(); await arrived;
  let releaseDetect, detectArrived;
  const detectGate=new Promise(r=>{releaseDetect=r;});
  const detecting=new Promise(r=>{detectArrived=r;});
  await page.route('**/api/detect_repository',async route=>{detectArrived();await detectGate;await route.continue();});
  await workspace('workspace-b').click();
  await detecting; releaseList(); await delay(500);
  assert.equal(await page.getByText(failureId,{exact:false}).count(),0);
  log('Race: A list response arrives while B detection is pending; old failure remains hidden');
  releaseDetect();await page.unroute('**/api/list_plannings');
  await delay(700);await page.unroute('**/api/detect_repository');
  await workspace('workspace-a').click();
  await page.getByText(failureId,{exact:false}).waitFor();
  await page.screenshot({path:path.join(out,'03-restored.png')});
  assert.deepEqual(errors,[]);
  await context.tracing.stop({path:path.join(out,'browser-trace.zip')});
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({status:'PASS',root,failureId,actions,errors},null,2));
} catch(error) {
  if (page) {
    await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});
    fs.writeFileSync(path.join(out,'failure-browser.txt'),await page.locator('body').innerText().catch(()=>''));
  }
  fs.writeFileSync(path.join(out,'network.json'),JSON.stringify(network,null,2));
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({status:'FAIL',root,error:String(error),actions},null,2));
  console.error(error);process.exitCode=1;
} finally {if(browser)await browser.close();server.kill('SIGINT');}
