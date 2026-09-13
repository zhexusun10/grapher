import { randomUUID } from "node:crypto";

// Versioned transport DTOs only. Provider implementation, credential storage and
// refresh are owned by the injected upstream ModelRuntime, never by Grapher.
export class ProviderAuthAdapter {
  constructor(createRuntime, { timeoutMs = 600000, retentionMs = 60000 } = {}) {
    this.createRuntime = createRuntime;
    this.timeoutMs = timeoutMs;
    this.retentionMs = retentionMs;
    this.jobs = new Map();
  }

  async catalog(refresh = false) {
    const runtime = await this.createRuntime({ allowModelNetwork: refresh, signal: AbortSignal.timeout(25000) });
    const available = new Set(runtime.getAvailableSnapshot().map(m => `${m.provider}/${m.id}`));
    const providers = await Promise.all(runtime.getProviders().map(async provider => {
      const methods = [];
      if (provider.auth.apiKey?.login) methods.push({ id: "api_key", name: provider.auth.apiKey.name });
      if (provider.auth.oauth?.login) methods.push({ id: "oauth", name: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name });
      let auth;
      try { auth = await runtime.checkAuth(provider.id, { signal: AbortSignal.timeout(5000) }); } catch { /* Unavailable is not a transport error. */ }
      return { id: provider.id, name: provider.name, methods, configured: !!auth, authType: auth?.type ?? null };
    }));
    return {
      providers,
      models: runtime.getModels().map(m => ({ provider: m.provider, id: m.id, name: m.name, api: m.api,
        contextWindow: m.contextWindow, available: available.has(`${m.provider}/${m.id}`) })),
      warning: runtime.getError() ? "Some provider/model configuration could not be loaded; inspect local configuration." : null,
    };
  }

  view(job) {
    return { id: job.id, provider: job.provider, status: job.status, events: job.events,
      prompt: job.prompt ?? null, error: job.error ?? null };
  }

  get(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error("Authentication session expired or engine restarted; start login again.");
    return job;
  }

  async start(provider, method) {
    if (typeof provider !== "string" || !["api_key", "oauth"].includes(method)) throw new Error("Invalid authentication method.");
    if ([...this.jobs.values()].some(j => j.provider === provider && j.status === "pending")) throw new Error("Login already in progress for this provider.");
    if ([...this.jobs.values()].filter(j => j.status === "pending").length >= 4) throw new Error("Too many pending logins.");
    const job = { id: randomUUID(), provider, status: "pending", events: [], controller: new AbortController() };
    this.jobs.set(job.id, job);
    job.timer = setTimeout(() => job.controller.abort(), this.timeoutMs);
    job.timer.unref?.();
    // Return immediately; interactive upstream login continues while HTTP polls.
    job.task = (async () => {
      try {
        const runtime = await this.createRuntime({ refreshOnCreate: false, signal: job.controller.signal });
        const selected = runtime.getProviders().find(p => p.id === provider);
        if (!selected || !(method === "oauth" ? selected.auth.oauth?.login : selected.auth.apiKey?.login)) throw new Error("unsupported");
        await runtime.login(provider, method, {
          signal: job.controller.signal,
          prompt: prompt => this.prompt(job, prompt),
          notify: event => {
            if (job.status !== "pending") return;
            const safe = this.event(event);
            if (safe) job.events = [...job.events.slice(-31), safe];
          },
        });
        job.status = "complete";
      } catch (error) {
        job.status = job.controller.signal.aborted ? "cancelled" : "failed";
        // Never expose raw upstream errors: they can contain credential material.
        job.error = error?.name === "CredentialSynchronizationError"
          ? "Credentials changed, but model status could not be refreshed. Refresh providers before retrying."
          : job.status === "cancelled" ? "Authentication cancelled or timed out." : "Authentication failed. Check provider configuration and try again.";
      } finally {
        clearTimeout(job.timer);
        job.pending?.reject(new Error("Authentication ended"));
        job.prompt = undefined;
        job.pending = undefined;
        job.cleanup = setTimeout(() => this.jobs.delete(job.id), this.retentionMs);
        job.cleanup.unref?.();
      }
    })();
    return this.view(job);
  }

  event(event) {
    // Project only public UI events; never serialize runtime/provider objects.
    if (event.type === "auth_url") return { type: event.type, url: event.url, instructions: event.instructions };
    if (event.type === "device_code") return { type: event.type, userCode: event.userCode, verificationUri: event.verificationUri, expiresInSeconds: event.expiresInSeconds };
    if (event.type === "info") return { type: event.type, message: event.message, links: event.links?.map(l => ({ url: l.url, label: l.label })) };
    if (event.type === "progress") return { type: event.type, message: event.message };
    return null;
  }

  prompt(job, prompt) {
    if (!["text", "secret", "select", "manual_code"].includes(prompt.type)) return Promise.reject(new Error("Unsupported upstream auth prompt"));
    const signal = prompt.signal ? AbortSignal.any([job.controller.signal, prompt.signal]) : job.controller.signal;
    if (signal.aborted) return Promise.reject(new Error("Cancelled"));
    if (job.pending) return Promise.reject(new Error("Concurrent prompts are unsupported"));
    const id = randomUUID();
    job.prompt = { id, type: prompt.type, message: prompt.message, placeholder: prompt.placeholder,
      options: prompt.type === "select" ? prompt.options.map(o => ({ id: o.id, label: o.label, description: o.description })) : undefined };
    return new Promise((resolve, reject) => {
      const finish = (fn, value) => {
        signal.removeEventListener("abort", abort);
        if (job.prompt?.id === id) { job.prompt = undefined; job.pending = undefined; }
        fn(value);
      };
      const abort = () => finish(reject, new Error("Cancelled"));
      job.pending = { resolve: value => finish(resolve, value), reject: error => finish(reject, error) };
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  respond(id, promptId, value) {
    const job = this.get(id);
    if (job.status !== "pending" || !job.pending || job.prompt?.id !== promptId) throw new Error("Authentication prompt is no longer active.");
    if (typeof value !== "string" || value.length > 65536) throw new Error("Invalid authentication response.");
    if (job.prompt.type === "select" && !job.prompt.options.some(o => o.id === value)) throw new Error("Invalid selection.");
    job.pending.resolve(value);
    return this.view(job);
  }

  cancel(id) {
    const job = this.get(id);
    if (job.status === "pending") job.controller.abort();
    return this.view(job);
  }

  async logout(provider) {
    if (typeof provider !== "string") throw new Error("Invalid provider.");
    if ([...this.jobs.values()].some(j => j.provider === provider && j.status === "pending")) throw new Error("Cancel the pending login first.");
    const runtime = await this.createRuntime({ refreshOnCreate: false, signal: AbortSignal.timeout(25000) });
    if (!runtime.getProviders().some(p => p.id === provider)) throw new Error("Unknown provider.");
    await runtime.logout(provider, { signal: AbortSignal.timeout(25000) });
    return { loggedOut: true }; // Ambient env/profile auth can remain configured.
  }

  async dispatch(request) {
    if (request.version !== 1) throw new Error("Unsupported Provider/Auth Adapter protocol version.");
    switch (request.operation) {
      case "catalog": return this.catalog(request.refresh === true);
      case "login": return this.start(request.provider, request.method);
      case "poll": return this.view(this.get(request.id));
      case "respond": return this.respond(request.id, request.promptId, request.value);
      case "cancel": return this.cancel(request.id);
      case "logout": return this.logout(request.provider);
      default: throw new Error("Unknown Provider/Auth Adapter operation.");
    }
  }

  close() {
    for (const job of this.jobs.values()) {
      job.controller.abort();
      clearTimeout(job.timer);
      clearTimeout(job.cleanup);
    }
    this.jobs.clear();
  }
}
