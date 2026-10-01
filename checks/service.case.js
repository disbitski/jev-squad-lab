import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('a failed process inspection never removes a live owner lock', () => {
  const root = mkdtempSync(join(tmpdir(), 'jev-service-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, '.local'));
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    copyFileSync(new URL('../scripts/service.js', import.meta.url), join(root, 'scripts/service.js'));
    const lock = join(root, '.local/process.lock');
    writeFileSync(lock, String(process.pid));
    const result = spawnSync(process.execPath, [join(root, 'scripts/service.js'), 'stop'], {
      env: { ...process.env, PATH: '' }, encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Cannot (inspect|verify).*lock owner/);
    assert.equal(readFileSync(lock, 'utf8'), String(process.pid));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
