import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";
import { runtimeService } from "../src/services/runtime.ts";

// Transport/UI evidence only: no real backend, project or credentials.
test("environment APIs use explicit Run/arguments and request, not termination, semantics", async () => {
  const fetch = globalThis.fetch;
  const requests: { command: string; body: unknown }[] = [];
  globalThis.fetch = (async (url, init) => {
    assert.equal(init?.method, "POST");
    assert.deepEqual(init?.headers, { "Content-Type": "application/json" });
    const command = String(url).slice("/api/".length);
    requests.push({ command, body: JSON.parse(String(init?.body)) });
    const result = command === "cancel_result" ? { requested: true }
      : command === "launch_result" ? { output: "native output" } : { schema: 1 };
    return new Response(JSON.stringify({ result }));
  }) as typeof globalThis.fetch;
  try {
    await runtimeService.environmentCapabilities();
    await runtimeService.resultDescriptor("run-a");
    assert.equal((await runtimeService.launchResult("run-a", ["--smoke", "space value"])).output, "native output");
    assert.deepEqual(await runtimeService.cancelResult("run-a"), { requested: true });
    assert.deepEqual(requests, [
      { command: "environment_capabilities", body: { compact: true, detail: "metadata" } },
      { command: "result_descriptor", body: { runId: "run-a", compact: true, detail: "metadata" } },
      { command: "launch_result", body: { runId: "run-a", args: ["--smoke", "space value"], compact: true, detail: "metadata" } },
      { command: "cancel_result", body: { runId: "run-a", compact: true, detail: "metadata" } },
    ]);
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "No active result execution" }), { status: 400 });
    await assert.rejects(runtimeService.cancelResult("run-a"), /No active result execution/);
  } finally { globalThis.fetch = fetch; }
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test("settings expose no environment choices and result UI isolates invalid input and stale responses", { timeout: 60_000 }, async () => {
  const server = await createServer({
    appType: "custom", cacheDir: "node_modules/.vite-environment-ui",
    server: { host: "127.0.0.1", port: 0, strictPort: false, open: false, watch: null, hmr: false, ws: false },
  });
  const html = `<!doctype html><html><body><div id="root"></div><script type="module">
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { SettingsModal } from '/src/components/modals/SettingsModal.tsx';
    import { EnvironmentResult } from '/src/components/EnvironmentResult.tsx';
    const config = { repository: '/mock/project', model: 'test/model', thinkingLevel: 'off', maxParallel: 2, maxFeedback: 1, autoApprove: false, environment: { mode: 'native-workspace', scopes: ['.venv'], launch: { entry: 'backend-owned' } } };
    window.originalEnvironment = config.environment;
    const result = { domain: {}, codeRef: 'code', environmentRef: 'env', launchRef: 'launch', resourceRefs: [], layout: '/mock/workspace', generation: 'generation', selectedFrom: [] };
    const snapshot = (runId, phase = 'completed', status = null) => ({ runId, phase,
      publishedResult: { schema: 1, runId, result, config: {}, workspace: '/mock/workspace' },
      resultExecution: status ? { status } : null });
    window.saved = [];
    function Harness() {
      const [state, setState] = React.useState(snapshot('run-a'));
      window.showRun = (runId, phase, status) => setState(snapshot(runId, phase, status));
      return React.createElement(React.Fragment, null,
        React.createElement('span', { id: 'current-run' }, state.runId),
        React.createElement(SettingsModal, { isOpen: true, onClose() {}, config, dataPath: '/mock/data', onSaveConfig(value) { window.saved.push(value); } }),
        React.createElement(EnvironmentResult, { state }));
    }
    createRoot(document.getElementById('root')).render(React.createElement(Harness));
  </script></body></html>`;
  server.middlewares.use(async (request, response, next) => {
    if (request.url !== "/__environment-test") return next();
    try {
      response.setHeader("Content-Type", "text/html");
      response.end(await server.transformIndexHtml(request.url, html));
    } catch (error) { next(error); }
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let launchGate: ReturnType<typeof gate> | undefined;
  let cancelGate: ReturnType<typeof gate> | undefined;
  const commands: { command: string; runId?: string; args?: string[] }[] = [];
  const errors: string[] = [];
  try {
    await server.listen();
    browser = await chromium.launch({
      channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true,
    });
    const page = await browser.newPage({ locale: "en-US", reducedMotion: "reduce" });
    page.on("pageerror", error => errors.push(String(error)));
    await page.addInitScript(() => localStorage.setItem("grapher_language_v1", "en"));
    await page.route("**/api/*", async route => {
      const command = new URL(route.request().url()).pathname.slice(5);
      const body = route.request().postDataJSON();
      commands.push({ command, ...body });
      let result: unknown;
      switch (command) {
        case "provider_auth": result = { providers: [], models: [], warning: null }; break;
        case "pi_extensions": result = { globalDirectory: "/mock/pi", extensions: [] }; break;
        case "launch_result":
          await launchGate?.promise;
          result = { output: `output ${body.runId}` }; break;
        case "cancel_result":
          await cancelGate?.promise;
          return route.fulfill({ status: 400, json: { error: "Old Run cancellation failed" } });
        default:
          errors.push(`Unexpected API: ${command}`);
          return route.fulfill({ status: 400, json: { error: `Unexpected API: ${command}` } });
      }
      await route.fulfill({ json: { result } });
    });
    const origin = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`;
    await page.goto(`${origin}/__environment-test`, { waitUntil: "networkidle" });
    assert.deepEqual(errors, [], "UI must initialize without browser errors");
    assert.equal(await page.evaluate(() => typeof (window as any).showRun), "function", await page.content());

    await expect(page.getByLabel("Execution mode", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Environment policy JSON", { exact: true })).toHaveCount(0);
    await expect(page.locator("#environment-settings-title")).toHaveCount(0);
    const save = page.getByRole("button", { name: "Save settings", exact: true });
    await expect(save).toBeEnabled();
    await save.click();
    await page.waitForFunction(() => (window as any).saved.length === 1);
    assert.equal(await page.evaluate(() => JSON.stringify((window as any).saved[0].environment) === JSON.stringify((window as any).originalEnvironment)), true,
      "saving unrelated settings must not remove an old Run's backend environment policy");
    assert.equal(commands.some(item => item.command === "environment_capabilities"), false);

    await page.getByText("Launchable result descriptor", { exact: true }).click();
    const args = page.getByLabel("Entry arguments JSON (string array)");
    const launch = page.getByRole("button", { name: "Launch result (no model)", exact: true });
    await args.fill('["valid", 1]');
    await launch.click();
    await expect(page.getByRole("alert")).toHaveText("Entry arguments must be a string array.");
    assert.equal(commands.filter(item => item.command === "launch_result").length, 0);
    await args.fill('["--smoke", "space value"]');
    launchGate = gate();
    await launch.click();
    await expect(page.getByRole("button", { name: "Cancel result process" })).toBeVisible();
    await expect.poll(() => commands.filter(item => item.command === "launch_result").length).toBe(1);
    assert.deepEqual(commands.find(item => item.command === "launch_result")?.args, ["--smoke", "space value"]);
    await page.evaluate(() => (window as any).showRun("run-b", "completed"));
    await expect(page.locator("#current-run")).toHaveText("run-b");
    // Returning to the same Run must not resurrect an abandoned request scope.
    await page.evaluate(() => (window as any).showRun("run-a", "completed"));
    await expect(page.locator("#current-run")).toHaveText("run-a");
    const oldLaunch = page.waitForResponse(response => response.url().endsWith("/api/launch_result") && response.request().postDataJSON().runId === "run-a");
    launchGate.release();
    await (await oldLaunch).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(launch).toBeEnabled();
    await expect(page.locator("pre")).toHaveCount(0);
    await expect(args).toHaveValue("[]");

    await page.evaluate(() => (window as any).showRun("run-b", "needs_attention", "failed"));
    const retry = page.getByRole("button", { name: "Retry result with partial work", exact: true });
    await expect(retry).toBeEnabled();
    launchGate = gate(); cancelGate = gate();
    await retry.click();
    await expect.poll(() => commands.filter(item => item.command === "launch_result").length).toBe(2);
    await page.getByRole("button", { name: "Cancel result process" }).click();
    await expect.poll(() => commands.filter(item => item.command === "cancel_result").length).toBe(1);
    assert.equal(commands.find(item => item.command === "cancel_result")?.runId, "run-b");
    await page.evaluate(() => (window as any).showRun("run-c", "completed"));
    const oldResponses = Promise.all([
      page.waitForResponse(response => response.url().endsWith("/api/cancel_result")),
      page.waitForResponse(response => response.url().endsWith("/api/launch_result") && response.request().postDataJSON().runId === "run-b"),
    ]);
    cancelGate.release(); launchGate.release();
    await Promise.all((await oldResponses).map(response => response.finished()));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.locator("pre")).toHaveCount(0);

    launchGate = undefined;
    await launch.click();
    await expect(page.locator("pre")).toHaveText("output run-c");
    assert.deepEqual(errors, []);
    assert.equal(commands.some(item => /plan|message|steer|compile/.test(item.command)), false);
  } finally {
    launchGate?.release(); cancelGate?.release();
    await browser?.close();
    await server.close();
  }
});
