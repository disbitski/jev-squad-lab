import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pick = (object, keys) => Object.fromEntries(keys.filter(k => object && Object.hasOwn(object, k)).map(k => [k, object[k]]));
const fields = list => list.split(' ');
const resultKeys = fields('success survivors extracted elapsed holdSeconds switches status decisions attempts modelLabel modelDecisions jevDecisions fallbackCount inputTokens knownCostUsd estimatedCostUsd costBasis attemptsWithoutUsage throttledRequests inFlight fallbackFrequency discarded meanLatencyMs returnedModels');
const metaKeys = fields('id version createdAt scenario seed controller mode node provider model modelLabel requestEncoding tacticalBrief modelVersion versionPinned price configHash phase');
const unitKeys = fields('id role team hp damage range speed cooldown maxHp x y action remaining extracted heal');
const frameKeys = fields('version scenario seed tick time holdSeconds objective done switches');
const identityKeys = fields('digest ollamaVersion parameterSize quantization');
const frozenFiles = ['lib/simulation.js', 'lib/decisions.js', 'lib/tactics.js', 'lib/run.js', 'lib/provider.js', 'lib/ollama.js', 'lib/budget.js', 'package-lock.json', 'scripts/evaluate.js'];
function meta(source) {
  return { ...pick(source, metaKeys), modelIdentity: pick(source.modelIdentity, identityKeys), hashes: pick(source.hashes, frozenFiles) };
}
function response(source) {
  if (!source) return undefined;
  return {
    ...pick(source, ['model']),
    answers: Object.fromEntries(Object.entries(source.answers ?? {}).map(([id, a]) => [id, pick(a, ['type', 'choice', 'probabilities', 'confidence'])])),
    usage: pick(source.usage, ['input_tokens', 'output_tokens']),
  };
}
export function sanitize(source) {
  const original = { meta: source.meta, result: source.result, frames: source.frames, decisions: source.decisions };
  if (hash(original) !== source.checksum) throw new Error('Original replay checksum mismatch');
  if (source.meta.orders) throw new Error('Free-text orders are not eligible for this public archive');
  if (source.result.status !== 'complete' || !source.frames.at(-1)?.done) throw new Error('Incomplete recording');
  const record = {
    meta: meta(source.meta), result: pick(source.result, resultKeys),
    frames: source.frames.map(f => ({
      ...pick(f, frameKeys), result: f.result ? pick(f.result, resultKeys) : null,
      units: f.units.map(u => pick(u, unitKeys)),
      events: f.events.map(e => pick(e, ['from', 'to', 'type', 'value', 'tick'])),
    })),
    decisions: source.decisions.map(d => ({
      ...pick(d, ['at', 'tick', 'source', 'reason', 'actions', 'latencyMs', 'attempted']),
      ...(d.applied ? { applied: pick(d.applied, ['accepted', 'rejected']) } : {}),
      ...(d.request ? { request: pick(d.request, ['model', 'state', 'questions']) } : {}),
      ...(d.response ? { response: response(d.response) } : {}),
    })),
  };
  // Original evidence is private; public derivatives omit routing metadata and account data.
  const text = JSON.stringify(record);
  if (/(?:Bearer |\/Users\/|\/private\/|api[_-]?key|authorization|provider_metadata|ledger|sk-[\w-]{20}|vck_[\w-]+)/i.test(text)) throw new Error('Potential sensitive data in replay');
  return { ...record, sourceChecksum: source.checksum, checksum: hash(record), exportFormat: 'reviewed-replay-v1' };
}

export async function exportArchive(sourceRoot, outputRoot) {
  const seriesPath = join(sourceRoot, '.local/evaluations/ollama-guided-v2-holdout-2026-10-01T14-44-54.063Z/evaluation.json');
  const series = JSON.parse(await readFile(seriesPath, 'utf8'));
  if (series.rows.length !== 45 || series.phase !== 'holdout' || series.rows.some(r => r.status !== 'complete')) throw new Error('Expected the completed 45-battle guided series');
  const extras = [
    ['d12422a0-e025-4505-b8f5-51396161644b', 'Initial local series / original rules'],
    ['f8088b3a-8336-4d54-ace8-5ec378a4d7f6', 'Initial local series / unguided Nimble'],
    ['1b49f84a-fde3-4905-9f01-85b7f78a0cd7', 'Hosted Jev / partial-access hybrid'],
  ];
  await mkdir(join(outputRoot, 'replays'), { recursive: true });
  const records = [];
  for (const [id, group] of [...series.rows.map(r => [r.id, 'Guided holdout / scored']), ...extras]) {
    const original = JSON.parse(await readFile(join(sourceRoot, '.local/runs', `${id}.json`), 'utf8'));
    const clean = sanitize(original);
    const row = series.rows.find(r => r.id === id);
    if (row && (row.checksum !== clean.sourceChecksum || row.controller !== clean.meta.controller || row.success !== clean.result.success)) throw new Error('Series/replay mismatch');
    await writeFile(join(outputRoot, 'replays', `${id}.json`), JSON.stringify(clean));
    records.push({ id, group, file: `./data/replays/${id}.json`, meta: clean.meta, result: clean.result, sourceChecksum: clean.sourceChecksum, checksum: clean.checksum });
  }
  const results = {
    status: series.status, phase: series.phase, seeds: series.seeds, scenarios: series.scenarios,
    controllers: series.controllers, frozen: meta(series.frozen),
    rows: series.rows.map(row => ({ id: row.id, checksum: row.checksum, ...pick(row, resultKeys), scenario: row.scenario, seed: row.seed, controller: row.controller })),
  };
  await writeFile(join(outputRoot, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  const columns = ['id', 'scenario', 'seed', 'controller', ...resultKeys.filter(k => k !== 'returnedModels'), 'checksum'];
  const csv = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  await writeFile(join(outputRoot, 'results.csv'), [columns.join(','), ...results.rows.map(r => columns.map(c => csv(r[c])).join(','))].join('\n') + '\n');
  await writeFile(join(outputRoot, 'catalog.json'), JSON.stringify({
    schema: 1, defaultReplay: '832e3d55-2c52-492a-a473-c8a58051e5c0',
    scope: '45 guided holdout battles plus three historical examples. Not a Jev benchmark.', records,
  }, null, 2) + '\n');
  console.log(`Exported ${records.length} checked public derivatives; no inference performed.`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const source = process.argv[2];
  if (!source) throw new Error('Usage: npm run replays:export -- /path/to/original/experiment [output-directory]');
  await exportArchive(resolve(source), resolve(process.argv[3] || 'replay/data'));
}
