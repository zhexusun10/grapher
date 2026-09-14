// Targeted real replanning after correcting sandbox and feedback instructions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { cases, repositoryFiles } from '../planning-cases.mjs';
const repo=path.resolve(import.meta.dirname,'../..');
const out=path.resolve(process.env.V6_EVIDENCE_DIR || path.join(import.meta.dirname,'v6-contract-recheck'));
const basePort=Number(process.env.V6_PORT || 1488);
fs.mkdirSync(out,{recursive:true});
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'grapher-v6-recheck-')));
const write=(p,v)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,typeof v==='string'?v:JSON.stringify(v,null,2)+'\n');};
const model='dashscope/qwen3.8-flash';
const sourceManifest={};
for(const file of ['backend/resources/prompts/partitioner.md','backend/resources/prompts/planner.md','backend/resources/planner.ts','engine/prompt-extension.ts','src/App.tsx','src/services/planningRecovery.ts'])sourceManifest[file]=createHash('sha256').update(fs.readFileSync(path.join(repo,file))).digest('hex');
write(path.join(out,'metadata.json'),{root,model,thinking:'medium',sourceManifest,startedAt:new Date().toISOString()});
await Promise.all((process.env.V6_SAMPLES || 'sdk,audit').split(',').map(async(name,index)=>{
 const directory=path.join(root,name),project=path.join(directory,'project'),data=path.join(directory,'data');
 for(const[f,c]of Object.entries(repositoryFiles))write(path.join(project,f),c);
 for(const args of [['init','-q'],['add','.'],['-c','user.name=Acceptance','-c','user.email=acceptance@localhost','-c','commit.gpgsign=false','commit','-qm','baseline']])execFileSync('git',args,{cwd:project});
 const fd=fs.openSync(path.join(out,`${name}-server.log`),'w');
 const env={...process.env,GRAPHER_DATA_DIR:data,GRAPHER_PORT:String(basePort+index)};
 for(const role of ['PARTITIONER','PLANNER']){env[`${role}_MODEL`]=model;env[`${role}_THINKING`]='medium';env[`${role}_TIMEOUT_SECONDS`]='600';}
 const child=spawn(path.join(repo,'backend/target/debug/grapher'),[],{cwd:project,env,stdio:['ignore',fd,fd]});
 const api=async(cmd,body={})=>{
  const r=await fetch(`http://127.0.0.1:${basePort+index}/api/${cmd==='plan_goal'?'plan_goal_stream':cmd}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(cmd==='plan_goal'){
   const events=(await r.text()).split('\n\n').flatMap(block=>{const line=block.split('\n').find(l=>l.startsWith('data: '));return line?[{type:block.split('\n')[0],value:JSON.parse(line.slice(6))}]:[];});
   const error=events.find(e=>e.type==='event: error');if(error)throw Error(error.value.error);
   const done=events.findLast(e=>e.type==='event: complete');if(!done)throw Error('Missing planning completion');return done.value.snapshot;
  }
  const v=await r.json();if(v.error)throw Error(v.error);return v.result;
 };
 try{
  for(let i=0;i<100;i++){try{await api('bootstrap');break;}catch{await new Promise(r=>setTimeout(r,100));}}
  const goal=cases.find(c=>c.id===(name==='sdk'?'P005':'P006')).goal;
  console.log(name,'started');
  const snap=await api('plan_goal',{goal,config:{repository:project,model,maxParallel:2,maxFeedback:2}});
  write(path.join(out,name,'snapshot.json'),snap);write(path.join(out,name,'graph.json'),snap.graph);
  write(path.join(out,name,'compiler.json'),await api('compile_graph',{graph:snap.graph}));
  fs.cpSync(path.join(data,'planning',snap.planning.planningId),path.join(out,name,'planning'),{recursive:true});
  assert.equal(snap.phase,'awaiting_approval');assert.equal(snap.executions.length,0);
  console.log(name,'completed',snap.graph.nodes.length,snap.planning.totalPlanningDuration);
 }catch(error){write(path.join(out,name,'error.json'),{error:String(error)});console.error(error);process.exitCode=1;}
 finally{child.kill('SIGINT');}
}));
