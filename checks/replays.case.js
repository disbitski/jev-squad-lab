import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { frameAt, decisionAt, derivativePayload } from '../replay/playback.js';
import { sanitize, hash } from '../scripts/export-replays.js';
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const catalog = await read('replay/data/catalog.json');
const results = await read('replay/data/results.json');
test('all scored rows have a verified, complete, sanitized replay', async () => {
  assert.equal(catalog.records.length, 48); assert.equal(results.rows.length, 45);
  assert.equal(new Set(catalog.records.map(r => r.id)).size, 48);
  for (const entry of catalog.records) {
    const record = await read(`replay/data/replays/${entry.id}.json`);
    assert.equal(hash(derivativePayload(record)), entry.checksum);
    assert.equal(record.sourceChecksum, entry.sourceChecksum);
    assert.equal(record.frames.at(-1).done, true);
    assert.equal(record.result.status, 'complete');
    assert.equal(record.meta.orders, undefined);
    assert.ok(record.frames.every((f, i) => !i || f.time >= record.frames[i - 1].time));
    const row = results.rows.find(r => r.id === entry.id);
    if (row) { assert.equal(row.checksum, record.sourceChecksum); assert.equal(row.success, record.result.success); assert.equal(row.inputTokens, record.result.inputTokens); }
    assert.doesNotMatch(JSON.stringify(record), /(?:\/Users\/|provider_metadata|authorization|api[_-]?key|ledger|Bearer )/i);
  }
});
test('paired seeds, exact outcomes, and unchanged frozen source hashes', async () => {
  for (const scenario of ['crossing', 'healer', 'withdraw']) for (const controller of ['rules', 'rules-tactical', 'jev']) {
    const rows = results.rows.filter(r => r.scenario === scenario && r.controller === controller);
    assert.deepEqual(rows.map(r => r.seed), [71, 72, 73, 74, 75]);
    const expected = controller === 'rules-tactical' || scenario === 'withdraw' ? 5 : controller === 'rules' && scenario === 'crossing' ? 1 : 0;
    assert.equal(rows.filter(r => r.success).length, expected);
  }
  for (const [path, expected] of Object.entries(results.frozen.hashes)) {
    assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), expected, path);
  }
  const model = results.rows.filter(r => r.controller === 'jev');
  assert.equal(model.reduce((n, r) => n + r.attempts, 0), 158);
  assert.equal(model.reduce((n, r) => n + r.inputTokens, 0), 465858);
  assert.equal(model.reduce((n, r) => n + r.fallbackCount, 0), 16);
  assert.equal(model.reduce((n, r) => n + r.discarded, 0), 6);
});
test('playback chooses saved frames and only already-observed decisions', () => {
  const frames = [{ time: 0, tick: 0 }, { time: .2, tick: 4 }, { time: .4, tick: 8 }];
  assert.equal(frameAt(frames, .3), 1); assert.equal(frameAt(frames, 999), 2); assert.equal(frameAt(frames, -1), 0);
  assert.equal(decisionAt([{ at: .25, tick: 0, source: 'nimble' }], frames[1]), undefined);
  assert.equal(decisionAt([{ at: .25, tick: 0, source: 'nimble' }], frames[2]).source, 'nimble');
});
test('export rejects modified evidence and drops account metadata', async () => {
  const source = await read('replay/data/replays/' + catalog.defaultReplay + '.json');
  source.meta.orders = '';
  source.decisions[0].response.provider_metadata = { privateAccount: 'do-not-export' };
  const payload = derivativePayload(source); payload.meta.orders = '';
  source.checksum = hash(payload);
  const exported = sanitize(source);
  assert.doesNotMatch(JSON.stringify(exported), /do-not-export/);
  source.result.survivors++;
  assert.throws(() => sanitize(source), /checksum/);
});
test('Pages build contains only allowlisted static replay resources', async () => {
  const root = await readdir('docs');
  assert.deepEqual(root.filter(n => n !== '.nojekyll').sort(), ['assets', 'data', 'index.html', 'playback.js', 'style.css', 'vendor', 'viewer.js']);
  for (const file of ['index.html', 'viewer.js', 'playback.js']) {
    const content = await readFile(join('docs', file), 'utf8');
    assert.doesNotMatch(content, /\/api\/|\/v1\/systemone|AI_GATEWAY_API_KEY|TYPESAFE_API_KEY|method:\s*['"]POST/);
  }
  assert.match(await readFile('docs/index.html', 'utf8'), /connect-src 'self'/);
});
