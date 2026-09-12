import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const dir=path.resolve(process.argv[2]);
const source=fs.readFileSync('src/App.tsx','utf8');
const ast=ts.createSourceFile('App.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const declarations=new Map();let timeline;
function visit(n){
 if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name))declarations.set(n.name.text,n);
 if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==='filter'&&n.arguments[0]?.getText(ast).includes('timelineFilter'))timeline=n.arguments[0].getText(ast);
 ts.forEachChild(n,visit);
}visit(ast);
const live=path.join(dir,'frontend-live');fs.mkdirSync(live,{recursive:true});
const host=spawn(path.resolve('src-tauri/target/debug/examples/benchmark'),[],{env:{...process.env,BENCHMARK_CASE:'B008',BENCHMARK_CASE_DIR:live,BENCHMARK_SERVE:'1'},stdio:['pipe','pipe','pipe']});
const hostLog=fs.createWriteStream(path.join(live,'host.log'));host.stderr.pipe(hostLog);
const queue=[];
createInterface({input:host.stdout}).on('line',line=>{const pending=queue.shift();if(!pending)return;try{const r=JSON.parse(line).result;r.Err!==undefined?pending.reject(r.Err):pending.resolve(r.Ok);}catch(e){pending.reject(e)}});
host.on('exit',code=>{for(const p of queue.splice(0))p.reject(Error(`IPC host exited ${code}`))});
const invoke=(command,body={})=>new Promise((resolve,reject)=>{queue.push({resolve,reject});host.stdin.write(JSON.stringify({command,body})+'\n')});
// The only substituted boundary is the native IPC transport. Run the actual service module.
globalThis.isTauri=true;
globalThis.window={__TAURI_INTERNALS__:{invoke}};
const storage=new Map();
const localStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)};
globalThis.localStorage=localStorage;
const serviceFile=path.join(dir,'runtime-service.mjs');
await build({entryPoints:[path.resolve('src/services/runtime.ts')],bundle:true,platform:'node',format:'esm',packages:'external',outfile:serviceFile});
const typesFile=path.join(dir,'types.mjs');
await build({entryPoints:[path.resolve('src/types.ts')],bundle:true,platform:'node',format:'esm',packages:'external',outfile:typesFile});
const {example}=await import(typesFile);
const {runtimeService,isDesktop}=await import(serviceFile);
assert.equal(isDesktop,true,'Benchmark must use the actual desktop service, never the browser simulator');
const context={runtimeService,localStorage,currentRepoPath:'default',workspaceRuns:{},console,Date,Promise,setTimeout,desktop:true,useCallback:fn=>fn,invoke,goal:'',selected:'A',instruction:'',state:{graph:{originalGoal:'',nodes:[],edges:[]}},runs:[],projects:[],error:'',historical:false};
for(const name of ['State','Goal','Config','IsPlanning','Selected','Messages','MainTab','Runs','Error','Busy','Historical','Modal','Instruction','RepoInfo','Projects','Args','DataPath','WorkspaceRuns','ConfirmModal'])context[`set${name}`]=value=>{const key=name[0].toLowerCase()+name.slice(1);context[key]=typeof value==='function'?value(context[key]):value;};
vm.createContext(context);
// Reuse production fixture and action closures; setters are a contract observation surface, not runtime truth.
vm.runInContext(ts.transpileModule(fs.readFileSync('src/types.ts','utf8').replace(/export /g,''),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText+'\nglobalThis.example=example;',context);
const code=['run','recordRunToWorkspace','handlePlanGoal','control','save','load','handleDeleteRun','handleClearHistory'].map(name=>`const ${declarations.get(name).getText(ast)};`).join('\n')+'\nglobalThis.actions={handlePlanGoal,control,save,load,handleDeleteRun,handleClearHistory};';
vm.runInContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
const checks=[];
async function test(name,fn){try{await fn();checks.push({name,status:'PASS'});}catch(e){checks.push({name,status:'FAIL',error:String(e)});}}
try{
 const bootstrap=await invoke('bootstrap');context.config={...bootstrap.config,engine:'fixture',repository:''};
 await test('production save action compiles hand-authored Graph IR without model or repository',async()=>{
  await context.actions.save({...example,originalGoal:'Fixture example graph'});
  assert.equal(context.error,'');assert.equal(context.state.phase,'awaiting_approval');assert.ok(context.state.graph.nodes.length>0);
  await context.actions.control('approve');assert.equal(context.error,'');
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){context.state=await invoke('snapshot');if(context.state.phase==='completed')break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(context.state.phase,'completed');assert.equal(context.state.executions.length,6);
 });
 await test('return to latest run restores interactive live state',async()=>{
  context.historical=false; // The existing Return to latest button does this immediately before load().
  await context.actions.load();
  assert.equal(context.historical,false,'load must not turn latest completed run back into a read-only historical view');
 });
 await test('frontend sees controlled backend execution failure',async()=>{
  context.config={...context.config,engine:'pi',repository:path.join(live,'fixture-repository'),piCommand:'/usr/bin/false',piArgs:[]};
  await context.actions.save({originalGoal:'Controlled failure',nodes:[{name:'A',task:'Controlled failure'}],edges:[]});
  assert.equal(context.error,'');await context.actions.control('approve');assert.equal(context.error,'');
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){context.state=await invoke('snapshot');if(context.state.phase==='needs_attention')break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(context.state.nodes.A.status,'failed');assert.match(context.state.nodes.A.error,/Pi exited/);
  fs.writeFileSync(path.join(dir,'frontend-failure.json'),JSON.stringify(context.state,null,2));
 });
 await test('backend-rejected deletion preserves frontend run index',async()=>{
  context.currentRepoPath='workspace-delete-test';
  context.config={...context.config,engine:'fixture',repository:context.currentRepoPath};
  await context.actions.save({originalGoal:'Protected active run',nodes:[{name:'protected',task:'Keep history until completion'}],edges:[]});
  const id=context.state.runId;
  await context.actions.control('approve');assert.equal(context.error,'');
  assert.equal((await runtimeService.snapshot()).phase,'running');
  await context.actions.handleDeleteRun(id);
  assert.ok(context.workspaceRuns[context.currentRepoPath].includes(id),'Rejected delete must not erase the frontend history index');
  assert.ok(context.error,'Backend rejection must be visible');
 });
 // Drain real work even if the preceding assertion fails, then test scoped history deletion.
 for(let i=0;i<100;i++){
  const snapshot=await runtimeService.snapshot();
  if(snapshot.phase==='completed'){context.state=snapshot;break;}
  await new Promise(r=>setTimeout(r,100));
 }
 await test('clear current workspace history preserves other workspaces',async()=>{
  const current=context.state.runId;
  context.workspaceRuns[context.currentRepoPath]=[current];
  const before=await runtimeService.bootstrap();
  const unrelated=before.runs.filter(id=>id!==current);
  assert.ok(unrelated.length>0,'Fixture must include unrelated real persisted runs');
  context.workspaceRuns[context.currentRepoPath].push(unrelated[0]); // Stale/misfiled sidebar entry must not authorize deleting another repository.
  const evidence=await Promise.all(unrelated.map(id=>runtimeService.history(id)));
  fs.writeFileSync(path.join(dir,'unrelated-history-before.json'),JSON.stringify(evidence,null,2));
  context.actions.handleClearHistory();
  await context.confirmModal.onConfirm();
  assert.equal(context.error,'');
  const after=await runtimeService.bootstrap();
  assert.ok(!after.runs.includes(current),'Current workspace run must be deleted');
  assert.ok(unrelated.every(id=>after.runs.includes(id)),'Current-workspace clear must not delete another workspace history');
  assert.deepEqual(await Promise.all(unrelated.map(id=>runtimeService.history(id))),evidence,'Unrelated persisted history must remain byte-for-byte equivalent');
 });
 const s=JSON.parse(fs.readFileSync(path.join(dir,'frontend-after.json')));
 assert.ok(timeline,'Production timeline filter not found');
 context.events=s.events;
 const filter=ts.transpileModule(`globalThis.filterEvent=${timeline};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInContext(filter,context);
 await test('node timeline includes real start and finish events',()=>{
  context.timelineFilter='node';const events=s.events.filter(context.filterEvent);assert.ok(events.some(e=>e.type==='started'));assert.ok(events.some(e=>e.type==='finished'));
 });
 await test('intervention timeline includes human invalidation',()=>{
  context.timelineFilter='intervention';assert.ok(s.events.filter(context.filterEvent).some(e=>e.type==='invalidated'&&e.human));
 });
}finally{
 host.stdin.write(JSON.stringify({command:'shutdown'})+'\n');host.stdin.end();
 await new Promise(resolve=>host.once('exit',resolve));
 fs.writeFileSync(path.join(dir,'frontend-actions.json'),JSON.stringify(checks,null,2));
}
console.log(JSON.stringify(checks,null,2));
process.exitCode=checks.some(c=>c.status==='FAIL')?1:0;
