// Final read-only verification of the published real run + browser regressions.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';
const repo=path.resolve(import.meta.dirname,'../..'),out=path.join(import.meta.dirname,'v6-browser-final');fs.mkdirSync(out,{recursive:true});
const previous=JSON.parse(fs.readFileSync(path.join(import.meta.dirname,'v6-e2e-recovery/metadata.json')));
const write=(name,value)=>fs.writeFileSync(path.join(out,name),typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');
const git=(...args)=>execFileSync('git',args,{cwd:previous.project,encoding:'utf8'}).trim();
const fd=fs.openSync(path.join(out,'server.log'),'w');
const server=spawn(path.join(repo,'backend/target/debug/grapher'),[],{cwd:previous.project,env:{...process.env,GRAPHER_PORT:'1500',GRAPHER_DATA_DIR:previous.data},stdio:['ignore',fd,fd]});
const api=async(command,body={})=>{const r=await fetch(`http://127.0.0.1:1500/api/${command}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const v=await r.json();if(v.error)throw Error(v.error);return v.result;};
const delay=ms=>new Promise(r=>setTimeout(r,ms));let browser;const result={startedAt:new Date().toISOString(),errors:[]};
try{
 for(let i=0;i<100;i++){try{await api('bootstrap',{compact:true});break;}catch{await delay(100);}}
 const full=await api('snapshot'),compact=await api('snapshot',{compact:true});
 assert.equal(full.phase,'completed');assert.equal(full.publication.status,'completed');
 assert.ok(full.events.some(e=>e.type==='feedback'&&e.accepted));
 assert.deepEqual(compact.executions,full.executions);
 assert.deepEqual(compact.events,full.events.filter(e=>e.type!=='output'));
 result.snapshotBytes={full:Buffer.byteLength(JSON.stringify(full)),compact:Buffer.byteLength(JSON.stringify(compact)),fullEvents:full.events.length,compactEvents:compact.events.length};
 const changed=git('diff','--name-only',previous.baseline,'HEAD').split('\n');assert.ok(changed.every(f=>f.startsWith('reports/')));assert.equal(git('status','--porcelain'),'');assert.equal(git('rev-parse','HEAD'),full.publication.head);
 for(const name of ['auth','storage','release'])assert.ok(fs.statSync(path.join(previous.project,'reports',`${name}.md`)).size>100);
 const expired=execFileSync(process.execPath,['--input-type=module','-e',"import {sessions,authenticate} from './server/auth.ts'; sessions.set('expired-proof',{userId:'test-user',expiresAt:Date.now()-1000}); console.log(authenticate('expired-proof'));"],{cwd:previous.project,encoding:'utf8'}).trim();assert.equal(expired,'test-user');
 write('independent-acceptance.json',{status:'PASS',runId:full.runId,publication:full.publication,changed,sourceUnchanged:true,cleanRepository:true,expiredSessionReturns:expired,reviewAccepted:true});
 fs.cpSync(path.join(previous.project,'reports'),path.join(out,'reports'),{recursive:true});write('published.diff',git('diff',previous.baseline,'HEAD'));write('git-log.txt',git('log','--oneline','--graph','--all'));
 const manifest={};for(const f of execFileSync('git',['ls-files','--cached','--others','--exclude-standard'],{cwd:repo,encoding:'utf8'}).split('\n').filter(f=>/^(src\/|backend\/(src|resources)\/|engine\/)/.test(f)))manifest[f]=createHash('sha256').update(fs.readFileSync(path.join(repo,f))).digest('hex');write('source-manifest.json',manifest);write('source.diff',execFileSync('git',['diff','HEAD','--','backend','engine','src'],{cwd:repo,encoding:'utf8'}));
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE);browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();page.on('pageerror',e=>result.errors.push(String(e)));page.on('crash',()=>result.errors.push('page crashed'));
 const t=Date.now();await page.goto('http://127.0.0.1:1500',{waitUntil:'domcontentloaded'});await page.getByText('已写回工作文件夹',{exact:true}).waitFor();result.initialReadyMs=Date.now()-t;
 await delay(700);await page.screenshot({path:path.join(out,'01-published.png')});write('final-browser.txt',await page.locator('body').innerText());
 const cdp=await context.newCDPSession(page);await cdp.send('HeapProfiler.collectGarbage');result.heapBefore=await cdp.send('Runtime.getHeapUsage');
 let inFlight=0,maxInFlight=0,requests=0;
 await page.route('**/api/snapshot',async route=>{inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);requests++;try{const response=await route.fetch();await delay(5000);await route.fulfill({response});}finally{inFlight--;}});
 await delay(20000);while(inFlight)await delay(100);await page.unroute('**/api/snapshot');assert.equal(maxInFlight,1);result.delayedPolling={requests,maxInFlight,delayMs:5000};
 const reloads=[];for(let i=0;i<20;i++){const t=Date.now();await page.reload({waitUntil:'domcontentloaded'});await page.getByText('已写回工作文件夹',{exact:true}).waitFor();reloads.push(Date.now()-t);}
 result.reloadMs=reloads;await cdp.send('HeapProfiler.collectGarbage');result.heapAfter=await cdp.send('Runtime.getHeapUsage');
 await page.locator('.react-flow__node').filter({hasText:'storage_crash_audit'}).click();await page.locator('.virtualized-transcript-container').waitFor();
 await page.locator('.transcript-scroll-area').evaluate(el=>{el.scrollTop=el.scrollHeight;el.dispatchEvent(new Event('scroll'));});await delay(500);assert.ok(await page.locator('.transcript-row').count()>0);result.longTranscriptHasRows=true;
 await page.screenshot({path:path.join(out,'02-long-transcript.png')});

 // Synthetic transport fixtures exercise actual App/rendering without altering
 // the real run or being counted as model-quality evidence.
 const testContext=await browser.newContext({viewport:{width:1440,height:1000}});const testPage=await testContext.newPage();let stage=0;
 const node='release_readiness_assessment';const attempts=compact.executions.filter(e=>e.node===node);const line=v=>JSON.stringify(v)+'\n';
 const oldOutput=line({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'OLD_ATTEMPT_ONLY'}});
 const parts=[line({type:'message_update',assistantMessageEvent:{type:'thinking_delta',delta:'NEW_THINK_FIRST'}}),line({type:'message_update',assistantMessageEvent:{type:'thinking_delta',delta:' NEW_THINK_SECOND'}}),line({type:'message_update',assistantMessageEvent:{type:'thinking_end'}})+line({type:'tool_execution_start',toolName:'bash',toolCallId:'new-tool',args:{command:'echo NEW_TOOL'}}),line({type:'tool_execution_end',toolName:'bash',toolCallId:'new-tool',result:{content:[{type:'text',text:'NEW_TOOL_RESULT'}],details:{exitCode:0}}})];
 const fixture=()=>({...compact,events:[],executions:compact.executions.map(e=>({...e,output:e.id===attempts[0].id?oldOutput:e.id===attempts.at(-1).id?parts.slice(0,stage+1).join(''):''}))});
 await testPage.route('**/api/bootstrap',async route=>{const response=await route.fetch();const value=await response.json();value.result.snapshot=fixture();await route.fulfill({response,json:value});});
 await testPage.route('**/api/snapshot',route=>route.fulfill({json:{result:fixture()}}));
 await testPage.goto('http://127.0.0.1:1500');await testPage.locator('.react-flow__node').filter({hasText:node}).click();
 await testPage.getByText('NEW_THINK_FIRST',{exact:true}).waitFor();stage=1;await testPage.getByText('NEW_THINK_FIRST NEW_THINK_SECOND',{exact:true}).waitFor();
 stage=2;await testPage.locator('.tool-call-card.running').waitFor();stage=3;await testPage.locator('.tool-call-card.success').waitFor();await testPage.locator('.tool-call-header').click();await testPage.getByText('NEW_TOOL_RESULT',{exact:true}).waitFor();
 const select=testPage.locator('.attempt-picker select');await select.selectOption(attempts[0].id);await testPage.getByText('OLD_ATTEMPT_ONLY',{exact:true}).waitFor();
 await select.selectOption(attempts.at(-1).id);await testPage.getByText('OLD_ATTEMPT_ONLY',{exact:true}).waitFor({state:'hidden'});await testPage.getByText('NEW_THINK_FIRST NEW_THINK_SECOND',{exact:true}).waitFor();
 result.transcriptRegression={streamingThinking:true,toolStatusUpdated:true,executionIdentityIsolated:true,unchangedStructuralEventCount:true};await testPage.screenshot({path:path.join(out,'03-transcript-regression.png')});await testContext.close();
 assert.deepEqual(result.errors,[]);result.status='PASS';console.log(JSON.stringify(result,null,2));
}catch(error){result.status='FAIL';result.error=String(error);console.error(error);process.exitCode=1;}
finally{result.endedAt=new Date().toISOString();write('result.json',result);if(browser)await browser.close();server.kill('SIGINT');}
