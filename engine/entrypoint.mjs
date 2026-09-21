// Grapher-owned launcher. No global Pi fallback and no changes to upstream code.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { root, source, verifyBaseline } from "../scripts/pi-baseline.mjs";
import { configureAgentDir } from "./agent-dir.mjs";

const KNOWN_PROVIDER_ENV_VARS = {
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_BASE_URL"],
  openai: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"],
  groq: ["GROQ_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  "github-copilot": ["COPILOT_GITHUB_TOKEN"],
  cohere: ["COHERE_API_KEY", "CO_API_KEY"],
  perplexity: ["PERPLEXITY_API_KEY"],
  xai: ["XAI_API_KEY"],
};

try {
  configureAgentDir();
  verifyBaseline();
  const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".grapher", "pi-agent");
  let disabled = [];
  try {
    disabled = JSON.parse(readFileSync(join(dir, "disabled-providers.json"), "utf8"));
  } catch {}
  const childEnv = { ...process.env };
  if (Array.isArray(disabled)) {
    for (const p of disabled) {
      const vars = KNOWN_PROVIDER_ENV_VARS[p];
      if (vars) {
        for (const v of vars) delete childEnv[v];
      }
    }
  }
  const child = spawn(process.execPath, [
    join(source, "node_modules/tsx/dist/cli.mjs"),
    "--tsconfig", join(source, "tsconfig.json"),
    join(root, "engine/execution-cli.ts"),
    ...process.argv.slice(2),
    "--extension", join(root, "engine/prompt-extension.ts"),
  ], { stdio: "inherit", env: childEnv });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
  child.on("exit", (code, signal) => { process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143); });
} catch (error) {
  console.error(`Execution Instance Engine unavailable: ${error.message}`);
  process.exitCode = 1;
}
