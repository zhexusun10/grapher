// Checks actual persisted planning history and live SSE presentation without paid model calls.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
const repo=path.resolve(import.meta.dirname,'../..');
const base=import.meta.dirname;const out=path.join(base,'v6-follow-up');fs.mkdirSync(out,{recursive:true});
const m=JSON.parse(fs.readFileSync(path.join(base,'v6-browser-final/review-server.json')));
const fd=fs.openSync(path.join(out,'server.log'),'w');
const server=spawn(path.join(repo,'backend/target/debug/grapher'),[],{cwd:m.project,env:{...process.env,GRAPHER_DATA_DIR:m.data,GRAPHER_PORT:'1501'},stdio:['ignore',fd,fd]});
const delay=ms=>new Promise(r=>setTimeout(r,ms));let browser, live;const result={errors:[]};
try{
 for(let i=0;i<50;i++){try{await fetch('http://127.0.0.1:1501');break;}catch{await delay(100);}}
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE);browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1050}});page.on('pageerror',e=>result.errors.push(String(e)));
 const fetched=[];page.on('request',r=>{if(r.url().endsWith('/get_planning_output'))fetched.push(r.postDataJSON());});
 await page.goto('http://127.0.0.1:1501');await page.getByRole('button',{name:'查看规划活动',exact:true}).waitFor();
 assert.equal(fetched.length,0,'history must load on demand');
 await page.getByRole('button',{name:'查看规划活动',exact:true}).click();
 await page.getByText('正在加载规划活动…',{exact:true}).waitFor({state:'hidden'});
 await page.locator('.planning-activity .thinking-card').first().waitFor();
 assert.ok(fetched.filter(r=>r.role==='planner').length>=2,'actual multi-page trace loaded');
 await page.screenshot({path:path.join(out,'01-planner-history.png')});
 await page.getByRole('button',{name:'Partitioner',exact:true}).click();
 await page.getByText('正在加载规划活动…',{exact:true}).waitFor({state:'hidden'});
 await page.locator('.planning-activity .thinking-card').first().waitFor();
 assert.ok(fetched.some(r=>r.role==='partition'));
 await page.screenshot({path:path.join(out,'02-partitioner-history.png')});
 await page.reload();await page.getByRole('button',{name:'查看规划活动',exact:true}).click();
 await page.getByText('正在加载规划活动…',{exact:true}).waitFor({state:'hidden'});
 await page.locator('.planning-activity .thinking-card').first().waitFor();
 const timeline=page.locator('.planning-activity .transcript-scroll-area');
 await timeline.evaluate(el=>{el.scrollTop=el.scrollHeight;el.dispatchEvent(new Event('scroll'));});
 await page.locator('.planning-activity .tool-call-card').first().waitFor();
 result.history={onDemand:true,paginated:true,partitioner:true,planner:true,refreshRestored:true,toolCards:true,requests:fetched.length};

 // Replay controlled provider events through the actual App SSE client to
 // verify records remain after complete (separate from real history evidence).
 live=await browser.newPage({viewport:{width:1440,height:1050}});
 const snap=(await(await fetch('http://127.0.0.1:1501/api/snapshot',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"compact":true}'})).json()).result;
 await live.route('**/api/bootstrap',async route=>{const response=await route.fetch();const data=await response.json();data.result.snapshot={...snap,runId:'',graph:{nodes:[],edges:[],originalGoal:''},planning:null,planningId:null,events:[],executions:[]};await route.fulfill({response,json:data});});
 const event=(type,data)=>`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
 await live.route('**/api/plan_goal_stream',route=>route.fulfill({contentType:'text/event-stream',body:[
  event('route_decision',{planType:'graph'}),
  event('planner',{event:{type:'message_update',assistantMessageEvent:{type:'thinking_delta',delta:'PLANNER_VISIBLE_THINKING'}}}),
  event('planner',{event:{type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'PLANNER_VISIBLE_TEXT'}}}),
  event('planner',{event:{type:'tool_execution_start',toolName:'node',toolCallId:'visible-call',args:{name:'visible_node'}}}),
  event('planner',{event:{type:'tool_execution_end',toolName:'node',toolCallId:'visible-call',result:{content:[{type:'text',text:'mutationApplied'}]}}}),
  event('complete',{snapshot:snap})].join('')}));
 await live.goto('http://127.0.0.1:1501');await live.locator('.project-workspace-item').first().waitFor();await live.getByPlaceholder('描述你想完成的工作或项目目标...').fill('Replay planner rendering');
 await live.getByRole('button',{name:'发送消息',exact:true}).click();
 await live.getByText('PLANNER_VISIBLE_THINKING',{exact:true}).waitFor();await live.getByText('PLANNER_VISIBLE_TEXT',{exact:true}).waitFor();
 await live.locator('.planner-tools-stream .tool-call-card.success').waitFor();await delay(500);
 await live.screenshot({path:path.join(out,'03-live-complete.png')});
 result.liveReplay={textAfterComplete:true,thinkingAfterComplete:true,toolsAfterComplete:true};
 assert.deepEqual(result.errors,[]);result.status='PASS';
}catch(error){if(live){fs.writeFileSync(path.join(out,'failure-page.txt'),await live.locator('body').innerText().catch(()=>''));await live.screenshot({path:path.join(out,'failure-page.png')}).catch(()=>{});}result.status='FAIL';result.error=String(error);console.error(error);process.exitCode=1;}
finally{fs.writeFileSync(path.join(out,'planning-activity-result.json'),JSON.stringify(result,null,2));if(browser)await browser.close();server.kill('SIGINT');}
