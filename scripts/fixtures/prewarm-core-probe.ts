// Benchmark lower bound only, NOT a production engine: no provider/auth,
// persisted Pi session, pi-trim, extensions, MCP, skills or workspace tools.
import { createInterface } from 'node:readline';
import { Agent } from '../../pi/packages/agent/src/index.ts';
import { root, verifyBaseline } from '../pi-baseline.mjs';
import { verifyPiDependencies } from '../pi-dependencies.mjs';

verifyBaseline();
verifyPiDependencies(root);
const agent = new Agent({
  initialState: { thinkingLevel: 'off', tools: [] },
  streamFn: () => { throw new Error('The Core startup probe must never call a model'); },
});
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const command = JSON.parse(line) as { id?: string; type?: string };
  process.stdout.write(`${JSON.stringify(command.type === 'get_state'
    ? { type: 'response', id: command.id, command: 'get_state', success: true,
        data: { thinkingLevel: agent.state.thinkingLevel, isStreaming: agent.state.isStreaming } }
    : { type: 'response', id: command.id, success: false, error: 'Benchmark supports only get_state' })}\n`);
});
