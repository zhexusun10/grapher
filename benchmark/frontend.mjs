import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider } from '@xyflow/react';
const dir=path.resolve(process.argv[2]);
const snapshots=['frontend-before.json','frontend-after.json','frontend-failure.json'].map(f=>JSON.parse(fs.readFileSync(path.join(dir,f))));
const contractFile=path.join(dir,'contract.ts');
fs.writeFileSync(contractFile,`import type { Snapshot } from ${JSON.stringify(path.resolve('src/types.ts'))};\nfunction check<T extends Snapshot>(value:T):T { return value; }\nconst snapshots = [${snapshots.map(s=>`check(${JSON.stringify(s)})`).join(",")}];\n`);
const program=ts.createProgram([contractFile],{noEmit:true,strict:true,skipLibCheck:true,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,allowImportingTsExtensions:true});
const diagnostics=ts.getPreEmitDiagnostics(program);
assert.equal(diagnostics.length,0,ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCurrentDirectory:()=>process.cwd(),getCanonicalFileName:x=>x,getNewLine:()=> '\n'}));
// Expose existing view components to this test bundle.
const moduleFile=path.join(dir,'view.mjs');
await build({entryPoints:[path.resolve('src/components/graph/TaskNode.tsx')],bundle:true,platform:'node',format:'esm',packages:'external',outfile:moduleFile,jsx:'automatic'});
const {TaskNode}=await import(moduleFile);
function readableLog(output){
 return (output||'').split('\n').map(line=>{
  try{
   const event=JSON.parse(line);
   if(event.type==='message_update'&&event.assistantMessageEvent?.type==='text_delta')return event.assistantMessageEvent.delta;
   if(event.type==='tool_execution_start')return `\n$ ${event.toolName}\n${JSON.stringify(event.args,null,2)}\n`;
   if(event.type==='tool_execution_end')return `\n${(event.result?.content??[]).filter(item=>item.type==='text').map(item=>item.text).join('\n')}\n`;
   if(event.type==='session')return `Session ${event.id}\n`;
   return '';
  }catch{return `${line}\n`;}
 }).join('');
}
for(let i=0;i<snapshots.length;i++){
 const s=snapshots[i], node=s.graph.nodes[0], state=s.nodes[node.name];
 const html=renderToStaticMarkup(React.createElement(ReactFlowProvider,null,React.createElement(TaskNode,{id:node.name,data:{name:node.name,task:node.task,status:state.status,attempts:s.executions.length,revision:state.revision,hint:'',reviewer:false,selected:true,worktree:s.executions.at(-1).worktree}})));
 fs.writeFileSync(path.join(dir,`frontend-${i}.html`),html);
 assert.ok(html.includes(i===2?"FAILED":"DONE"));assert.equal(state.revision,i===2?1:i+1);assert.equal(s.executions.at(-1).revision,state.revision);assert.ok(html.includes(`#${s.executions.length}`));assert.ok(html.includes(node.name));
 if(i<2) assert.match(readableLog(s.executions.at(-1).output),/Implemented/);
}
console.log('PASS: actual dispatcher snapshots satisfy frontend Snapshot; production TaskNode renders DONE/FAILED and attempt counts; wire data preserves revisions r1/r2; production output formatter preserves result. Browser interaction/effects automation remains a gap.');
