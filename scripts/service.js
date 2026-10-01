import { spawn, execFileSync } from 'node:child_process';
import { openSync, closeSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const lock = join(root, '.local', 'process.lock');
const command = process.argv[2];
if (!['start', 'stop'].includes(command)) throw new Error('Use start or stop');
function owner() {
  if (!existsSync(lock)) return null;
  const pid = Number(readFileSync(lock, 'utf8'));
  if (!Number.isInteger(pid) || pid <= 1) throw new Error('Invalid process lock; inspect manually');
  try { process.kill(pid, 0); }
  catch (error) {
    if (error.code === 'ESRCH') { unlinkSync(lock); return null; }
    throw new Error('Cannot verify the lock owner. No lock was removed or process stopped.');
  }
  let args;
  try { args = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }); }
  catch { throw new Error('Cannot inspect the live lock owner. No lock was removed or process stopped.'); }
  if (!args.includes(join(root, 'server.js'))) throw new Error('Lock belongs to another command or foreground server. Inspect it; no process was stopped.');
  return pid;
}
const pid = owner();
if (command === 'stop') {
  if (pid) { process.kill(pid, 'SIGTERM'); console.log('Local sandbox stopped.'); }
  else console.log('No background sandbox running.');
} else if (pid) console.log(`Sandbox already running (PID ${pid}).`);
else {
  mkdirSync(join(root, '.local'), { recursive: true });
  const log = openSync(join(root, '.local', 'server.log'), 'a', 0o600);
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', join(root, 'server.js')], { cwd: root, detached: true, stdio: ['ignore', log, log] });
  closeSync(log); child.unref();
  await new Promise(resolve => setTimeout(resolve, 900));
  if (!existsSync(lock)) throw new Error('Server did not start. Inspect .local/server.log; choose another PORT if occupied.');
  console.log(`Background sandbox started (PID ${child.pid}). See .local/server.log for the localhost URL.`);
}
