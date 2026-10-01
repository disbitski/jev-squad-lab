import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ROOT } from '../server.js';
import { SCENARIOS } from '../lib/simulation.js';
import { validateResponse } from '../lib/decisions.js';

const series = JSON.parse(await readFile(join(ROOT, '.local', 'evaluation.json'), 'utf8'));
assert.equal(series.frozen.provider, 'ollama');
assert.equal(series.frozen.model, 'nimble:latest');
assert.notEqual(series.phase, 'calibration', 'Do not report calibration as scored evidence');
const guided = series.frozen.tacticalBrief === 'guided-v2';
const controllers = guided ? ['rules', 'rules-tactical', 'jev'] : ['rules', 'jev'];
const seeds = guided ? [71, 72, 73, 74, 75] : [41, 42, 43, 44, 45];
assert.deepEqual(series.seeds, seeds);
assert.equal(series.rows.length, controllers.length * seeds.length * 3, 'Report requires the complete frozen series');
const label = controller => controller === 'rules' ? 'Original rules' : controller === 'rules-tactical' ? 'Tactical rules' : 'Nimble';
const records = [];
const keys = new Set();
for (const row of series.rows) {
  const record = JSON.parse(await readFile(join(ROOT, '.local', 'runs', `${row.id}.json`), 'utf8'));
  const { checksum, ...payload } = record;
  assert.equal(checksum, createHash('sha256').update(JSON.stringify(payload)).digest('hex'));
  assert.equal(checksum, row.checksum);
  assert.equal(record.meta.configHash, series.frozen.configHash);
  assert.deepEqual(record.meta.modelIdentity, series.frozen.modelIdentity);
  assert.equal(record.result.status, 'complete');
  assert.equal(record.meta.mode, 'scored');
  assert.equal(record.meta.orders, '');
  assert.equal(record.result.knownCostUsd, 0);
  const key = `${record.meta.scenario}/${record.meta.seed}/${record.meta.controller}`;
  assert.ok(!keys.has(key)); keys.add(key);
  for (const d of record.decisions) if (d.response) validateResponse(d.request, d.response);
  records.push(record);
}
for (const scenario of Object.keys(SCENARIOS)) for (const seed of seeds) for (const controller of controllers) assert.ok(keys.has(`${scenario}/${seed}/${controller}`));
const learned = records.filter(r => r.meta.controller === 'jev');
const events = learned.flatMap(r => r.decisions);
const sum = (rows, key) => rows.reduce((n, r) => n + (r.result[key] || 0), 0);
const average = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const latencies = events.filter(d => d.attempted && d.latencyMs != null).map(d => d.latencyMs).sort((a, b) => a - b);
const p95 = latencies[Math.ceil(latencies.length * .95) - 1];
const reasons = Object.fromEntries([...new Set(events.filter(d => d.reason).map(d => d.reason))].map(reason => [reason, events.filter(d => d.reason === reason).length]));
const withdrawalWarnings = learned.filter(r => r.meta.scenario === 'withdraw').flatMap(r => r.decisions.filter(d => d.source === 'fallback'));
const withdrawalOnlyInactive = withdrawalWarnings.length && withdrawalWarnings.every(d => d.response && Object.values(d.applied?.rejected || {}).every(action => action === 'retreat') && Object.entries(d.actions).every(([id, action]) => action === d.response.answers[id]?.choice));
const summaryRows = [];
for (const [scenario, mission] of Object.entries(SCENARIOS)) for (const controller of controllers) {
  const group = records.filter(r => r.meta.scenario === scenario && r.meta.controller === controller);
  summaryRows.push(`| ${mission.title} | ${label(controller)} | ${group.filter(r => r.result.success).length}/5 | ${average(group.map(r => r.result.survivors)).toFixed(1)} | ${average(group.map(r => r.result.elapsed)).toFixed(2)} | ${sum(group, 'modelDecisions')} | ${sum(group, 'fallbackCount')} | ${sum(group, 'discarded')} |`);
}
const calibrationRows = [];
if (guided) {
  const paths = (await readdir(join(ROOT, '.local', 'evaluations'))).filter(name => name.startsWith('ollama-guided-v2-calibration-')).sort();
  for (const name of paths) {
    const calibration = JSON.parse(await readFile(join(ROOT, '.local', 'evaluations', name, 'evaluation.json'), 'utf8'));
    const modelRows = calibration.rows.filter(r => r.controller === 'jev');
    calibrationRows.push(`| ${calibration.seeds.join(',')} | ${calibration.frozen.configHash.slice(0, 12)} | ${modelRows.filter(r => r.success).length}/${modelRows.length} | ${modelRows.reduce((n, r) => n + r.attempts, 0)} | ${modelRows.reduce((n, r) => n + r.fallbackCount, 0)} | ${modelRows.reduce((n, r) => n + r.discarded, 0)} | ${modelRows.reduce((n, r) => n + r.attemptsWithoutUsage, 0)} |`);
  }
}
const representatives = [...new Set([records.find(r => r.meta.controller === 'rules' && r.result.success), records.find(r => r.meta.controller === 'rules-tactical' && r.result.success), ...Object.keys(SCENARIOS).map(s => learned.find(r => r.meta.scenario === s && r.result.success)), learned.find(r => !r.result.success), learned.find(r => r.result.fallbackCount)].filter(Boolean))];
const examples = representatives.map(record => ({ runId: record.meta.id, checksum: record.checksum, meta: record.meta, result: record.result, decision: record.decisions.find(d => d.source === 'nimble') }));
const suffix = guided ? '-guided-v2' : '';
await writeFile(join(ROOT, '.local', 'access', `nimble${suffix}-examples.json`), JSON.stringify(examples, null, 2), { mode: 0o600 });
const report = `# Local Nimble Squad Lab Results

All ${records.length} runs completed: three missions, five paired seeds (${seeds[0]}-${seeds.at(-1)}), ${controllers.length} frozen controllers. Local inference only. This is a small comparison of controller plus its real-time integration, not a general model benchmark.

## Identity And Method

- Model: ${series.frozen.model}, ${series.frozen.modelIdentity.parameterSize}, ${series.frozen.modelIdentity.quantization}; Ollama ${series.frozen.modelIdentity.ollamaVersion}; Node ${series.frozen.node}.
- Observed model digest: \`${series.frozen.modelIdentity.digest}\`. Exact numbered model version remains unspecified; discovery digest is not an immutable API pin.
- Frozen controller/config hash: \`${series.frozen.configHash}\`.
- Nimble is Bespoke Labs' independently developed decision model, NOT TypeSafe Jev. Do not pool the old hosted access trials into these outcomes.
- Same seeded deployments, legal actions, enemy policy, 50ms simulation ticks, 90 simulated-second limit, and mission scoring. Rules run quickly; Nimble runs in real time, so latency has tactical consequences.
- At most one request in flight, at least one second between starts, two-second deadline. ${guided ? 'Task-focused text gives named unit health/percentages, positions, cooldowns, alive/dead/extracted flags, objective and progress. It omits previous-action labels, unused static physics stats and bookkeeping from v1. This is a changed observation encoding as well as a changed briefing, not an isolated prompt-only ablation.' : 'Compact text preserves all observed unit fields and computed distances; role stats appear once.'} No exploratory orders, extra tools, or changes during evaluation.
- Briefing: **${series.frozen.tacticalBrief || 'unbriefed-v1'}**.${guided ? ' Human-authored commander policy specifies focus fire, defender support and forward healer positioning, healer self-preservation, and evacuation priority. Every legal choice remains available; code does not substitute a preferred action for the model. This guidance is extra input relative to v1, not evidence that model weights learned. The tactical-rules reference implements the same guidance without inference. The original enemy, physics, health, scoring and action set remain unchanged. Calibration uses only the separate 61-70 range; these scored seeds (71-75) were not used for tuning. All calibration variants, including timeout-heavy failures, retain distinct source hashes and recordings. The evaluator verifies source hashes between runs and verifies local model identity again at completion.' : ''}
- Warm-ups and latency tuning are separate, unscored records. Repeated identical requests reuse cached work and are not a live latency benchmark. The original verbose local exploratory battle timed out frequently before the format was compacted; those failures are preserved too.

## Outcomes

| Mission | Controller | Objectives met | Mean survivors | Mean simulated seconds | Valid model batches | Fallback batches | Discarded batches |
| --- | --- | --- | --- | --- | --- | --- | --- |
${summaryRows.join('\n')}

${guided ? `## Calibration History (Not Scored)

These variants were changed between trials. Their outcomes are not pooled with the holdout and not evidence of generalization. Each row has three local model battles; each associated series also records both rules references. The static seed-68 current-action ablation measured choices only, not battle outcomes.

| Calibration seed | Config hash prefix | Model objectives met | Requests | Fallbacks | Discarded | Unknown usage |
| --- | --- | --- | --- | --- | --- | --- |
${calibrationRows.join('\n')}

The initial larger briefing exceeded the deadline. Later variants made target effects explicit, moved the human policy into shared context, added healer positioning, and removed previous-action labels after a static diagnostic. A timeout boundary fix now applies fresh rules after a transport failure while still rejecting responses invalidated by pause/reset. This is iterative harness development, not weight training.` : ''}

## Transport And Usage

- ${sum(learned, 'attempts')} battle requests; ${sum(learned, 'modelDecisions')} valid applied Nimble batches; ${sum(learned, 'fallbackCount')} fallback batches; ${sum(learned, 'discarded')} discarded batches.
- ${sum(learned, 'inputTokens').toLocaleString()} returned input tokens; ${sum(learned, 'attemptsWithoutUsage')} requests without returned usage; ${sum(learned, 'throttledRequests')} HTTP throttles.
- Round-trip request latency: mean ${Math.round(average(latencies))}ms, p95 ${p95}ms, min ${latencies[0]}ms, max ${latencies.at(-1)}ms. These are request batches, not per-unit model compute times.
- Warning reasons: ${JSON.stringify(reasons)}. A stale target can disappear during inference; code revalidates it and repairs the affected choice with rules. A late response after a terminal state is recorded and discarded, not applied.
${withdrawalOnlyInactive ? `- Withdrawal warning audit: ${withdrawalWarnings.length} batches carry the existing fallback label because a returned retreat order belonged to an actor that was no longer active. Retreat is legal for every active friendly, so these are dead/extracted actor rejections, not a target-choice error. Recorded accepted actions all match the returned Nimble choices; no active-unit order was substituted by rules in those batches. Raw counters remain unchanged. The defender died in each scored Nimble withdrawal, while both rules references saved all three units.` : ''}
- Local API charge: **$0**. Hardware, electricity, and memory use are not measured. Unknown token usage stays unknown even though there is no paid API call. The separate cloud ledger is not used.
- Before this, ten scheduled hosted Jev access trials each served just one valid batch, followed by fallbacks: 53 HTTP 429 responses and three timeouts. Successful responses establish some hosted access; those errors do not prove false marketing or identify where rate limiting occurred.

## Review Recordings

The [local sandbox](http://127.0.0.1:4196/?view=trials) has all records under Replays and all ${records.length} latest scored runs under Trials. The evaluation selector retains v1 and explicitly unscored calibration history. Playback and scrubbing use stored snapshots, not inference. Each run keeps full request/response evidence and a verified SHA-256 checksum.

${representatives.map(r => `- ${label(r.meta.controller)} / ${SCENARIOS[r.meta.scenario].title}, seed ${r.meta.seed}, objective ${r.result.success ? 'met' : 'missed'}: [watch replay](http://127.0.0.1:4196/?replay=${r.meta.id}), [recorded evidence](http://127.0.0.1:4196/api/replay/${r.meta.id}), checksum \`${r.checksum}\`.`).join('\n')}

Full table: \`.local/evaluation.csv\`. Immutable series copy: \`.local/evaluations/\`. Representative request/response records: \`.local/access/nimble${suffix}-examples.json\`.

## Interpretation Limits

Operational availability and tactical effectiveness are separate. A valid response is not a good decision. Report actual choices without inventing the model's reasoning; confidence describes the returned distribution, not correctness. Fallback/repair runs are hybrid outcomes. The rules baseline is deliberately simple and not an optimized RTS opponent. Results apply to these prompts and scenarios, not Warcraft III, other games, or general Nimble/Jev superiority. No confidence-calibration or LLM-cost-saving claim is established.

${guided ? 'The preserved v1 comparison had 0/5 Nimble successes in every mission, while original rules won withdrawal 5/5. Guided Nimble now meets withdrawal in 5/5, but still misses both combat objectives in 5/5. Tactical rules meet all 15 objectives and save three units every time. No performance advantage for this model over the well-authored policy is established. The change demonstrates better evacuation-policy execution in this harness, not autonomous discovery of tactics. The model remains interesting as a natural-language tactical interface, but that flexibility must be tested separately; it is not proven by these outcomes. The held-out seeds vary initial placement slightly; they do not introduce new opponents, missions, or maps.' : ''}

No public field note, social post, podcast audio, or public inference service was published by this local evaluation. Dave's review comes next. An eventual public demo must remain replay-only, with no inference endpoint or API-key entry.
`;
const path = join(ROOT, '.local', `nimble${suffix}-results-2026-10-01.md`);
await writeFile(path, report, { mode: 0o600 });
console.log(report);
console.log(`Verified ${records.length} payload checksums and all returned decision schemas. Report: ${path}`);
