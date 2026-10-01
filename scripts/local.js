import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mode = process.argv[2];
const target = { start: ['server.js'], background: ['scripts/service.js', 'start'], evaluate: ['scripts/evaluate.js'], demo: ['scripts/demo.js'] }[mode];
if (!target) throw new Error('Choose start, background, evaluate, or demo');
const child = spawn(process.execPath, ['--env-file-if-exists=.env', join(root, target[0]), ...target.slice(1), ...process.argv.slice(3)], {
  cwd: root, stdio: 'inherit', env: { ...process.env, JEV_PROVIDER: 'ollama', JEV_MODEL: 'nimble:latest' },
});
child.on('error', () => { console.error('Local launcher failed'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
