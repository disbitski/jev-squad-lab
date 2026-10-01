import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Simulation, observation } from '../lib/simulation.js';
import { buildRequest, compactObservation, DecisionGate, responseIsCurrent, validateResponse } from '../lib/decisions.js';
import { Budget } from '../lib/budget.js';
import { Run } from '../lib/run.js';

const request = () => buildRequest(new Simulation().snapshot());
// Synthetic responses are transport fixtures only; never exported as Jev observations.
function response(req) { return { model: req.model, usage: { input_tokens: 100, output_tokens: 0 }, answers: Object.fromEntries(Object.entries(req.questions).map(([id, q]) => [id, { type: 'choice', choice: 'hold', confidence: .5, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === 'hold' ? 1 : 0])) }])) }; }
test('one explicit per-unit question, legal criteria only, pinned model', () => {
  const req = request(); assert.equal(req.model, 'jev-1.13.0'); assert.equal(Object.keys(req.questions).length, 3);
  for (const [id, q] of Object.entries(req.questions)) assert.ok(q.instructions.includes(id));
});
test('compact encoding preserves every observed unit field and the same legal choices', () => {
  for (const scenario of ['crossing', 'healer', 'withdraw']) {
    const state = new Simulation({ scenario }).snapshot(), obs = observation(state);
    const [statsLine, battleLine, , columnsLine, ...rows] = compactObservation(state).split('\n');
    const stats = JSON.parse(statsLine.split(': ').slice(1).join(': '));
    assert.deepEqual(JSON.parse(battleLine.slice('Battle: '.length)), Object.fromEntries(Object.entries(obs).filter(([key]) => key !== 'units')));
    const columns = columnsLine.split(',');
    for (let i = 0; i < obs.units.length; i++) {
      const cells = rows[i].split(',');
      const encoded = { ...stats[obs.units[i].role], ...Object.fromEntries(columns.map((key, index) => [key, cells[index]])) };
      for (const [key, value] of Object.entries(obs.units[i])) assert.equal(String(encoded[key]), String(value), `${scenario}/${key}`);
    }
    const full = buildRequest(state), compact = buildRequest(state, '', 'nimble:latest', 'compact-text');
    for (const id of Object.keys(full.questions)) assert.deepEqual(Object.keys(compact.questions[id].criteria), Object.keys(full.questions[id].criteria));
  }
});
test('response validation rejects model drift, malformed choices and probabilities', () => {
  const req = request(), data = response(req); assert.equal(validateResponse(req, data)['f-defender'], 'hold');
  assert.throws(() => validateResponse(req, { ...data, model: 'jev-latest' }), /model_or_schema/);
  data.answers['f-defender'].choice = 'teleport'; assert.throws(() => validateResponse(req, data), /invalid_answer/);
  data.answers['f-defender'].choice = 'hold'; data.answers['f-defender'].probabilities.hold = -1; assert.throws(() => validateResponse(req, data), /invalid_probabilities/);
});
test('decision requests are single-flight and no more than once per second', async () => {
  let finish; let now = 5000;
  const req = request(), gate = new DecisionGate({ provider: { evaluate: () => new Promise(resolve => { finish = resolve; }) }, now: () => now });
  const one = gate.decide(req); assert.equal((await gate.decide(req)).skipped, 'in_flight'); finish(response(req)); await one;
  assert.equal((await gate.decide(req)).skipped, 'rate_limited'); now += 1000;
  const next = gate.decide(req); await Promise.resolve(); finish(response(req)); assert.ok((await next).actions);
});
test('timeout cancels request and returns a visible fallback reason', async () => {
  let signal; const gate = new DecisionGate({ timeoutMs: 15, provider: { evaluate: (_, s) => { signal = s; return new Promise(() => {}); } } });
  const result = await gate.decide(request()); assert.equal(result.fallback, 'timeout'); assert.equal(signal.aborted, true);
  assert.equal((await gate.decide(request())).skipped, 'in_flight');
});
test('provider 429 backs off and API failures never leak raw error secrets', async () => {
  const gate = new DecisionGate({ provider: { evaluate: async () => { throw Object.assign(new Error('PRIVATE KEY DETAIL'), { status: 429 }); } } });
  assert.equal((await gate.decide(request())).fallback, 'provider_rate_limit'); assert.equal((await gate.decide(request())).skipped, 'rate_limited');
});
test('throttle status honors the provider retry delay without sending more calls', async () => {
  let now = 1000, calls = 0;
  const gate = new DecisionGate({ now: () => now, provider: { evaluate: async () => { calls++; throw Object.assign(new Error('busy'), { status: 429, retryAfterMs: 12000 }); } } });
  await gate.decide(request());
  assert.equal(gate.status().throttleWaitMs, 12000);
  now += 11000;
  assert.equal((await gate.decide(request())).skipped, 'rate_limited');
  assert.equal(calls, 1);
  now += 1000;
  assert.equal(gate.status().throttleWaitMs, 0);
});
test('battle spend uses reported cost, keeps unknown usage separate, and resets per run', () => {
  const run = new Run({ scenario: 'crossing', seed: 41, controller: 'jev' });
  const req = request(), data = response(req);
  data.provider_metadata = { gateway: { cost: '0.00009513' } };
  run.record({ source: 'jev', request: req, response: data, attempted: true });
  run.record({ source: 'fallback', reason: 'provider_rate_limit', request: req, attempted: true });
  run.record({ source: 'fallback', reason: 'budget_exhausted', request: req, attempted: false });
  const usage = run.state().usage;
  assert.equal(usage.knownCostUsd, .00009513);
  assert.equal(usage.costBasis, 'reported');
  assert.equal(usage.attempts, 2);
  assert.equal(usage.attemptsWithoutUsage, 1);
  assert.equal(usage.throttledRequests, 1);
  assert.equal(usage.jevDecisions, 1);
  assert.equal(usage.fallbackCount, 2);
  assert.equal(run.export().result.fallbackFrequency, 2 / 3);
  assert.equal(run.export().result.knownCostUsd, usage.knownCostUsd);
  assert.equal(new Run({ scenario: 'crossing', seed: 41 }).usage().knownCostUsd, 0);
  run.record({ source: 'discarded', request: req, response: response(req), attempted: true });
  assert.equal(run.usage().costBasis, 'estimated');
  assert.equal(run.usage().inputTokens, 200);
  assert.ok(run.usage().knownCostUsd > usage.knownCostUsd);
});
test('local battle counters identify Nimble without claiming Jev decisions or paid spend', () => {
  const run = new Run({ scenario: 'crossing', seed: 41, controller: 'jev', provenance: { provider: 'ollama', model: 'nimble:latest', modelLabel: 'Nimble', price: 0 } });
  const req = buildRequest(run.sim.snapshot(), '', 'nimble:latest'), data = response(req);
  run.record({ source: 'nimble', request: req, response: data, attempted: true });
  const usage = run.usage();
  assert.equal(usage.modelDecisions, 1); assert.equal(usage.jevDecisions, 0);
  assert.equal(usage.knownCostUsd, 0); assert.equal(usage.costBasis, 'local');
  assert.equal(run.state().modelLabel, 'Nimble');
});
test('old run, old epoch, paused state and stale tick all reject responses', () => {
  const token = { runId: 'a', epoch: 1, tick: 20 }, current = { ...token, status: 'running', tick: 30 };
  assert.equal(responseIsCurrent(token, current), true);
  for (const diff of [{ runId: 'b' }, { epoch: 2 }, { status: 'paused' }, { tick: 61 }]) assert.equal(responseIsCurrent(token, { ...current, ...diff }), false);
});
test('a delayed decision after pause is logged but never applied', async () => {
  let finish;
  const gate = { decide: req => new Promise(resolve => { finish = () => resolve({ actions: { 'f-defender': 'advance' }, response: response(req) }); }) };
  const run = new Run({ scenario: 'crossing', seed: 41, controller: 'jev', gate }); run.start(); run.step(); run.pause(); finish(); await run.pending;
  assert.equal(run.sim.units[0].action, 'hold'); assert.equal(run.decisions.at(-1).source, 'discarded');
});
test('API failure applies the rules controller and preserves the reason', async () => {
  const run = new Run({ scenario: 'withdraw', seed: 41, controller: 'jev', gate: { decide: async () => ({ fallback: 'api_failure', latencyMs: 5 }) } });
  run.start(); run.step(); await run.pending; assert.equal(run.sim.units[0].action, 'retreat'); assert.equal(run.decisions.at(-1).reason, 'api_failure');
});
test('budget persists reservations across restart and limits requests', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-budget-'));
  try {
    const opts = { path: join(dir, 'ledger.json'), ceiling: .01, maxRequests: 2 };
    const budget = new Budget(opts), reservation = budget.reserve(); budget.settle(reservation, 100);
    assert.ok(Math.abs(budget.summary().accountedUsd - .0000042) < 1e-10);
    const reloaded = new Budget(opts); reloaded.reserve(); assert.equal(reloaded.summary().uncertainRequests, 1); assert.throws(() => reloaded.reserve(), /request_limit/);
  } finally { rmSync(dir, { recursive: true }); }
});
test('budget blocks before the conservative reservation exceeds ceiling and prevents provider mixing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-budget-'));
  try {
    const path = join(dir, 'ledger.json'); const budget = new Budget({ path, ceiling: .001 }); assert.throws(() => budget.reserve(), /budget_exhausted/); budget.save();
    assert.throws(() => new Budget({ path, provider: 'vercel' }), /differs/);
    assert.throws(() => new Budget({ path, ceiling: 500 }), /Invalid/);
  } finally { rmSync(dir, { recursive: true }); }
});
