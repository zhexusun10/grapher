import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function workerBody(mode) {
  const count = mode === 'flood' ? 50_000 : 5_000;
  let text = '';
  for (let i = 0; i < count; i++) {
    text += `ACCEPTANCE-LINE|${String(i).padStart(6, '0')}|长中文字符边界验证🚀🎉 ${'测试'.repeat(18)} \x1b[31mANSI\x1b[0m\n`;
  }
  return text + `ACCEPTANCE-END|${mode}|${count}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, marker] = process.argv.slice(2);
  fs.readFileSync(0, 'utf8'); // print-mode prompt / stdin EOF
  const write = text => new Promise((resolve, reject) => process.stdout.write(text, error => error ? reject(error) : resolve()));
  await write(workerBody(mode));
  fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, mode }));
  if (mode === 'hold') {
    setInterval(() => {}, 1000); // must be terminated by the acceptance test
  } else if (mode === 'fail') {
    process.exitCode = 13;
  } else {
    await write(JSON.stringify({ type: 'message_end', message: {
      role: 'assistant', content: [{ type: 'text', text: 'ACCEPTANCE_FINAL: complete worker response 完成🚀' }],
      usage: { input: 7, output: 3, totalTokens: 10 }, stopReason: 'stop',
    } }) + '\n');
  }
}
