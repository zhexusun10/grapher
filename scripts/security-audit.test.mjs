// Exercise the real CI scripts with mock clients: no network or allowlist.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workflow = readFileSync(new URL('../.github/workflows/security-audit.yml', import.meta.url), 'utf8').split(/\r?\n/);
function script(name) {
  const start = workflow.indexOf(`      - name: ${name}`);
  assert.ok(start >= 0, `Missing workflow step: ${name}`);
  let end = start + 1;
  while (end < workflow.length && !workflow[end].startsWith('      - ')) end++;
  const lines = workflow.slice(start + 1, end);
  // Explicit Actions bash uses -e -o pipefail; default run's bash -e does not.
  assert.ok(lines.includes('        shell: bash'), `${name} must preserve failed audit exit status through tee`);
  const run = lines.findIndex(line => line.startsWith('        run: '));
  assert.ok(run >= 0);
  return lines[run] === '        run: |'
    ? lines.slice(run + 1).filter(line => line.startsWith('          ')).map(line => line.slice(10)).join('\n')
    : lines[run].slice('        run: '.length);
}

function check(name, { scope, client, args, artifact, code }) {
  const directory = mkdtempSync(join(tmpdir(), 'grapher-security-audit-'));
  const report = code === 2 ? { error: { code: 'EAI_AGAIN', summary: 'simulated registry failure' } }
    : { auditReportVersion: 2, metadata: { vulnerabilities: { high: code === 1 ? 1 : 0 } } };
  try {
    const mock = `${client}() { printf '%s\\n' "$*" > audit-args.txt; printf '%s\\n' "$AUDIT_REPORT"; return "$AUDIT_EXIT"; }`;
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', `${mock}\n${script(name)}`], {
      cwd: directory, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, SCOPE: scope ?? '', AUDIT_REPORT: JSON.stringify(report), AUDIT_EXIT: String(code) },
    });
    assert.ifError(result.error);
    assert.equal(result.status, code, `Do not swallow audit findings/errors: ${result.stderr}`);
    assert.ok(result.stdout.includes(JSON.stringify(report)), 'show the audit evidence in the CI log');
    assert.deepEqual(JSON.parse(readFileSync(join(directory, artifact), 'utf8')), report, 'retain evidence even on failure');
    assert.equal(readFileSync(join(directory, 'audit-args.txt'), 'utf8').trim(), args);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

for (const scope of ['grapher', 'pi']) {
  for (const code of [0, 1, 2]) {
    test(`${scope} audit logs evidence and preserves exit code ${code}`, () => check('Audit all installed dependencies without changing locks', {
      scope, client: 'npm', args: `audit${scope === 'pi' ? ' --prefix engine/pi-dependencies' : ''} --audit-level=high --json`,
      artifact: 'npm-audit.json', code,
    }));
  }
}
for (const code of [0, 1]) {
  test(`Pi production-view audit preserves exit code ${code}`, () => check("Also report the Pi profile's production dependency view", {
    client: 'npm', args: 'audit --prefix engine/pi-dependencies --omit=dev --audit-level=high --json',
    artifact: 'npm-audit-production.json', code,
  }));
  test(`Rust audit logs evidence and preserves exit code ${code}`, () => check('Audit the backend lock against current RustSec advisories', {
    client: 'cargo', args: 'audit --file backend/Cargo.lock --json', artifact: 'rust-audit.json', code,
  }));
}
