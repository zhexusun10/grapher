// On-demand Pi RPC workers for extension commands outside a Grapher Run.
// Each worker uses the ordinary extension discovery and current project cwd.
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { globalAgentDir } from './global-extensions.ts';

type Event = Record<string, any>;
type Job = {
  repository: string;
  status: 'pending' | 'complete' | 'cancelled' | 'failed';
  events: Event[];
  dialogs: Map<string, Event>;
  worker?: Worker;
  timer?: ReturnType<typeof setTimeout>;
  error?: string;
};
const root = fileURLToPath(new URL('../', import.meta.url));
const resolver = pathToFileURL(resolve(root, 'pi/packages/coding-agent/src/experimental/source-resolver.ts')).href;
const blocked = new Set(['quit', 'exit', 'new', 'tree', 'fork', 'clone', 'resume', 'import', 'sessions', 'login', 'logout', 'settings', 'model', 'thinking', 'name', 'scoped-models', 'compact']);
const available = (command: Event) => typeof command.name === 'string' && command.source === 'extension' && !blocked.has(command.name.toLowerCase().split('/')[0]);

class Worker {
  child: ChildProcessWithoutNullStreams;
  readonly done: Promise<void>;
  private closing = false;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private closed = false;
  constructor(repository: string, event: (value: Event) => void) {
    this.child = spawn(process.execPath, ['--import', resolver, resolve(root, 'engine/extension-command-worker.ts')], {
      cwd: repository || process.env.PI_CODING_AGENT_DIR || globalAgentDir(), windowsHide: true,
      env: { ...process.env, GRAPHER_MODE: 'node', GRAPHER_EXECUTION_KIND: 'source', GRAPHER_COMMAND_PROJECT: repository ? '1' : '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.done = new Promise(resolve => this.child.once('close', () => resolve()));
    // Extension failures can echo UI input; diagnostics never enter durable logs.
    this.child.stderr.resume();
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      if (line.length > 4 * 1024 * 1024) { this.close(); return; }
      let value: Event;
      try { value = JSON.parse(line); } catch { return; }
      if (value.type === 'response') {
        const pending = this.pending.get(value.id);
        this.pending.delete(value.id);
        if (value.success) pending?.resolve(value.data);
        else pending?.reject(new Error('Extension command failed'));
      } else if (value.type === 'extension_ui_request') event(value);
      else if (value.type === 'extension_error') event({ type: 'extension_ui_request', id: randomUUID(), method: 'notify', message: 'An extension operation failed. Check its configuration and supported execution modes.' });
    });
    const ended = () => {
      this.closed = true;
      lines.close();
      for (const pending of this.pending.values()) pending.reject(new Error('Extension command worker stopped'));
      this.pending.clear();
    };
    this.child.once('error', ended);
    this.child.once('close', ended);
    this.child.stdin.on('error', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('Extension command worker disconnected'));
      this.pending.clear();
      this.close();
    });
  }
  request(body: Event): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Extension command worker stopped'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ ...body, id })}\n`, error => {
        if (error) { this.pending.delete(id); reject(new Error('Extension command worker disconnected')); }
      });
    });
  }
  respond(response: Event) {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify(response)}\n`);
  }
  close() {
    if (this.closed || this.closing) return this.done;
    this.closing = true;
    this.child.stdin.end();
    const timer = setTimeout(() => { if (!this.closed) this.child.kill(); }, 2_000);
    timer.unref();
    this.child.once('close', () => clearTimeout(timer));
    return this.done;
  }
}

export class ExtensionCommands {
  readonly instance = randomUUID();
  private jobs = new Map<string, Job>();
  private catalogs = new Set<Worker>();
  private closed = false;

  private leaseMs: number;
  constructor(leaseMs = 30_000) { this.leaseMs = leaseMs; }

  private touch(id: string, job: Job) {
    clearTimeout(job.timer);
    job.timer = setTimeout(() => { this.cancel(job); this.jobs.delete(id); }, this.leaseMs);
    job.timer.unref();
  }
  private cancel(job: Job) {
    if (job.status === 'pending') job.status = 'cancelled';
    for (const id of job.dialogs.keys()) job.worker?.respond({ type: 'extension_ui_response', id, cancelled: true });
    job.dialogs.clear();
    job.worker?.close();
  }
  private async execute(text: string, job: Job) {
    try {
      const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
      const worker = new Worker(job.repository, event => {
        if (job.status !== 'pending') return;
        if (['select', 'confirm', 'input', 'editor'].includes(event.method)) job.dialogs.set(event.id, event);
        job.events.push(event);
        if (job.events.length > 256) this.cancel(job);
      });
      job.worker = worker;
      const catalog = await worker.request({ type: 'get_commands' });
      if (job.status !== 'pending') return;
      if (!match || !catalog.commands.some((command: Event) => available(command) && command.name === match[1])) throw new Error('Unknown extension command');
      await worker.request({ type: 'prompt', message: `/${match[1]}${match[2] ? ` ${match[2]}` : ''}` });
      if (job.status === 'pending') job.status = 'complete';
    } catch {
      if (job.status === 'pending') {
        job.status = 'failed';
        job.error = 'Extension command failed or is unavailable in this project. Commands that need a conversation must run in an active session.';
      }
    } finally { job.worker?.close(); }
  }

  async dispatch(request: Event) {
    if (this.closed) throw new Error('Extension command host stopped');
    const repository = typeof request.repository === 'string' && request.repository ? resolve(request.repository) : '';
    if (request.operation === 'catalog') {
      if (this.catalogs.size >= 4) throw new Error('Too many extension catalog requests');
      const worker = new Worker(repository, () => {});
      this.catalogs.add(worker);
      const timeout = setTimeout(() => worker.close(), 25_000);
      try {
        const catalog = await worker.request({ type: 'get_commands' });
        return { instance: this.instance, commands: catalog.commands.filter(available) };
      } finally { clearTimeout(timeout); this.catalogs.delete(worker); worker.close(); }
    }
    if (request.instance !== this.instance) throw new Error('Extension command host changed; reopen the menu');
    const id = request.commandId;
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error('Invalid command identity');
    if (request.operation === 'execute') {
      if (this.jobs.has(id)) throw new Error('Extension command already started');
      if ([...this.jobs.values()].filter(job => job.status === 'pending').length >= 4) throw new Error('Too many pending extension commands');
      if (typeof request.text !== 'string' || request.text.length > 8192) throw new Error('Invalid extension command');
      const job: Job = { repository, status: 'pending', events: [], dialogs: new Map() };
      this.jobs.set(id, job);
      this.touch(id, job);
      void this.execute(request.text, job);
      return { status: job.status };
    }
    const job = this.jobs.get(id);
    if (!job || job.repository !== repository) throw new Error('Command expired or project changed; start it again');
    this.touch(id, job);
    if (request.operation === 'cancel') { this.cancel(job); return { status: job.status }; }
    if (request.operation === 'poll') return { status: job.status, events: job.events.splice(0), error: job.error };
    if (request.operation === 'respond') {
      const response = request.response;
      const prompt = job.dialogs.get(response?.id);
      if (job.status !== 'pending' || !prompt) throw new Error('Extension dialog is no longer active');
      const safe: Event = { type: 'extension_ui_response', id: prompt.id };
      if (response.cancelled) safe.cancelled = true;
      else if (prompt.method === 'confirm') {
        if (typeof response.confirmed !== 'boolean') throw new Error('Invalid confirmation');
        safe.confirmed = response.confirmed;
      } else {
        if (typeof response.value !== 'string' || response.value.length > 65536) throw new Error('Invalid dialog response');
        if (prompt.method === 'select' && !prompt.options?.includes(response.value)) throw new Error('Invalid selection');
        safe.value = response.value;
      }
      job.dialogs.delete(prompt.id);
      job.worker?.respond(safe);
      return { accepted: true };
    }
    throw new Error('Unknown extension command operation');
  }
  async close() {
    this.closed = true;
    const workers = [...this.catalogs, ...[...this.jobs.values()].flatMap(job => job.worker ? [job.worker] : [])];
    for (const job of this.jobs.values()) { clearTimeout(job.timer); this.cancel(job); }
    for (const worker of this.catalogs) worker.close();
    this.jobs.clear();
    await Promise.all(workers.map(worker => worker.close()));
  }
}
