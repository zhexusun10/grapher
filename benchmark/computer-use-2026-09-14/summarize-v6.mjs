// Derive compact review evidence from real persisted Pi sessions and runtime events.
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(process.argv[2]);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const lines = file => fs.readFileSync(file, 'utf8').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const summaries = [];
const samples = fs.existsSync(path.join(root, 'snapshot.json'))
  ? [{ name: 'audit-execution', directory: root }]
  : ['catalog', 'sdk', 'audit'].map(name => ({ name, directory: path.join(root, name) }));
for (const { name, directory } of samples) {
  if (!fs.existsSync(path.join(directory,'snapshot.json'))) continue;
  const snap=read(path.join(directory,'snapshot.json'));
  if (snap.evidenceProjection) {
    console.warn(`Skipping compact intermediate evidence ${directory}; use existing metrics or ${snap.evidenceProjection.fullHistory}`);
    continue;
  }
  const planning=read(path.join(directory,'planning/summary.json'));
  const roles={};
  for(const role of ['partition','planner']) {
    const logFile = path.join(directory,'planning',`${role}.jsonl`);
    if (!fs.existsSync(logFile)) { roles[role] = { status: 'not_run', tools: [] }; continue; }
    const events=lines(logFile);
    const sessionDir=path.join(directory,'planning',`${role}-session`);
    const messages=fs.readdirSync(sessionDir).filter(f=>f.endsWith('.jsonl')).flatMap(f=>lines(path.join(sessionDir,f)));
    const times=new Map();
    for(const entry of messages){
      const msg=entry.message;
      if(msg?.role==='assistant') for(const c of msg.content || []) if(c.type==='toolCall') times.set(c.id,{assistantCompletedAt:entry.timestamp});
      if(msg?.role==='toolResult') times.set(msg.toolCallId,{...times.get(msg.toolCallId),resultPersistedAt:entry.timestamp});
    }
    const tools=[];
    for(const event of events){
      if(event.type==='tool_execution_start') tools.push({id:event.toolCallId,name:event.toolName,args:event.args,...times.get(event.toolCallId)});
      if(event.type==='tool_execution_end'){
        const call=tools.find(t=>t.id===event.toolCallId);
        if(call)Object.assign(call,{isError:!!(event.isError||event.result?.isError),result:event.result});
      }
    }
    const lastToolAt = Math.max(0, ...tools.map(t => Date.parse(t.resultPersistedAt || '') || 0));
    const processEnd = events.findLast(e => e.type === 'grapher_process_exited')?.timestamp;
    roles[role]={...planning.roles[role],tools,postLastToolSeconds:lastToolAt && processEnd ? (processEnd-lastToolAt)/1000 : null,providerRetries:events.filter(e=>e.type==='auto_retry_start').length};
  }
  const executionMetrics=snap.executions.map(e=>{
    const events=linesFromOutput(e.output);
    const usage={input:0,output:0,cacheRead:0,cacheWrite:0,reasoning:0,totalTokens:0};
    for(const ev of events)if(ev.type==='message_end'&&ev.message?.role==='assistant')for(const k of Object.keys(usage))usage[k]+=ev.message.usage?.[k]||0;
    const lastToolTimestamp = Math.max(0, ...events.flatMap(ev => {
      if (ev.type === 'message_end' && ev.message?.role === 'toolResult') return [ev.message.timestamp || 0];
      return (ev.toolResults || []).map(result => result.timestamp || 0);
    }));
    const processExit = events.findLast(v=>v.type==='grapher_process_exited');
    return {node:e.node,id:e.id,sessionId:e.sessionId,attempt:e.attempt,status:e.status,startedAt:e.startedAt,completedAt:e.completedAt,durationSeconds:e.completedAt?(e.completedAt-e.startedAt)/1000:null,piProcessSeconds:(processExit?.elapsedMs ?? 0)/1000,postLastToolSeconds:lastToolTimestamp && processExit?.timestamp ? (processExit.timestamp-lastToolTimestamp)/1000 : null,toolCalls:events.filter(v=>v.type==='tool_execution_start').length,toolErrors:events.filter(v=>v.type==='tool_execution_end'&&(v.isError||v.result?.isError)).length,usage};
  });
  const approvals=snap.events.filter(e=>e.type==='approved');
  const last=snap.events.at(-1);
  const summary={sample:name,planningId:planning.planningId,runId:snap.runId,phase:snap.phase,planningDuration:planning.totalPlanningDuration,nodes:snap.graph.nodes.length,normalEdges:snap.graph.edges.filter(e=>!e.feedback).length,feedbackEdges:snap.graph.edges.filter(e=>e.feedback).length,roles,executions:executionMetrics,feedbackCounts:snap.feedbackCounts,publication:snap.publication,approvalToLastEventSeconds:approvals.length?(last.timestamp-approvals[0].timestamp)/1000:null};
  fs.writeFileSync(path.join(directory,'activity.json'),JSON.stringify(summary,null,2)+'\n');
  summaries.push({...summary,roles:Object.fromEntries(Object.entries(roles).map(([k,v])=>[k,{...v,tools:v.tools.length}]))});
}
function linesFromOutput(text){return (text||'').split('\n').flatMap(line=>{try{return[JSON.parse(line)];}catch{return[];}});}
if (!summaries.length) throw new Error('No complete snapshots to summarize; existing metrics were preserved.');
fs.writeFileSync(path.join(root,'metrics.json'),JSON.stringify(summaries,null,2)+'\n');
console.log(summaries.map(s=>({sample:s.sample,phase:s.phase,nodes:s.nodes,planning:s.planningDuration,planner:s.roles.planner.durationSeconds,tools:s.roles.planner.tools,errors:s.roles.planner.toolErrors,executions:s.executions.map(e=>({node:e.node,status:e.status,seconds:e.durationSeconds}))})));
