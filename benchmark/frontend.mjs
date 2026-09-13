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
// Expose existing private view functions to this test bundle only. No production source rewrite.
const source=fs.readFileSync('src/App.tsx','utf8');
const moduleFile=path.join(dir,'view.mjs');
await build({stdin:{contents:source+'\nexport { TaskNode, readableLog };',resolveDir:path.resolve('src'),loader:'tsx'},bundle:true,platform:'node',format:'esm',packages:'external',alias:{'@':path.resolve('src')},outfile:moduleFile,jsx:'automatic'});
const {TaskNode,readableLog}=await import(moduleFile);
for(let i=0;i<snapshots.length;i++){
 const s=snapshots[i], node=s.graph.nodes[0], state=s.nodes[node.name];
 const html=renderToStaticMarkup(React.createElement(ReactFlowProvider,null,React.createElement(TaskNode,{id:node.name,data:{name:node.name,task:node.task,status:state.status,attempts:s.executions.length,revision:state.revision,hint:'',reviewer:false,selected:true,worktree:s.executions.at(-1).worktree}})));
 fs.writeFileSync(path.join(dir,`frontend-${i}.html`),html);
 assert.ok(html.includes(i===2?"FAILED":"DONE"));assert.equal(state.revision,i===2?1:i+1);assert.equal(s.executions.at(-1).revision,state.revision);assert.ok(html.includes(`#${s.executions.length}`));assert.ok(html.includes(node.name));
 if(i<2) assert.match(readableLog(s.executions.at(-1).output),/Implemented/);
}
console.log('PASS: actual dispatcher snapshots satisfy frontend Snapshot; production TaskNode renders DONE/FAILED and attempt counts; wire data preserves revisions r1/r2; production output formatter preserves result. Browser interaction/effects automation remains a gap.');
