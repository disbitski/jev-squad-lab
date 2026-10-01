import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, SCENARIOS, legalActions, rules } from '../lib/simulation.js';
import { buildRequest } from '../lib/decisions.js';
import { tacticalRules, tacticalObservation } from '../lib/tactics.js';
import { Run } from '../lib/run.js';

test('guided briefing preserves every legal option and does not rewrite state or score', () => {
  for (const scenario of Object.keys(SCENARIOS)) {
    const sim = new Simulation({ scenario, seed: 61 }), state = sim.snapshot();
    const original = JSON.stringify(state);
    const plain = buildRequest(state, '', 'nimble:latest', 'compact-text');
    const guided = buildRequest(state, '', 'nimble:latest', 'guided-v2');
    assert.equal(guided.state, tacticalObservation(state, { includeActions: false }));
    assert.ok(!guided.state.includes('; action '));
    assert.notEqual(guided.state, plain.state);
    for (const unit of state.units) assert.ok(guided.state.includes(`${unit.id}: HP ${unit.hp}/${unit.maxHp}`));
    for (const [id, q] of Object.entries(guided.questions)) {
      assert.deepEqual(Object.keys(q.criteria), Object.keys(legalActions(state, id)));
      assert.ok(q.instructions.includes(id));
      assert.ok(q.instructions.length < 600);
    }
    assert.equal(JSON.stringify(state), original);
  }
});

test('guided projection distinguishes death, injury, extraction and mission progress without a chosen-action hint', () => {
  const sim = new Simulation({ scenario: 'withdraw', seed: 64 });
  sim.units[0].hp = 0; sim.units[1].extracted = true;
  const text = tacticalObservation(sim.snapshot());
  assert.ok(text.includes('dead.')); assert.ok(text.includes('extracted.')); assert.ok(text.includes('48%'));
  assert.ok(text.includes('Extract at least two'));
  assert.ok(!text.includes('recommended')); assert.ok(!text.includes('best action'));
});

test('mission-aware rules withdraw, focus fire, and preserve healer self-healing priority', () => {
  for (const scenario of Object.keys(SCENARIOS)) {
    const sim = new Simulation({ scenario, seed: 61 });
    sim.units.find(u => u.id === 'f-healer').hp -= 10;
    sim.units.find(u => u.id === 'f-defender').hp -= 60;
    const state = sim.snapshot(), actions = tacticalRules(state);
    for (const [id, action] of Object.entries(actions)) assert.ok(Object.hasOwn(legalActions(state, id), action));
    if (scenario === 'withdraw') assert.ok(Object.values(actions).every(a => a === 'retreat'));
    else {
      assert.equal(actions['f-ranger'], 'attack:e-ranger');
      assert.equal(actions['f-defender'], 'attack:e-ranger');
      assert.equal(actions['f-healer'], scenario === 'healer' ? 'heal:f-healer' : 'heal:f-defender');
    }
    assert.ok(tacticalObservation(state).includes('Commander policy:'));
  }
});

test('mission-aware reference can meet unchanged objectives on calibration seed, without inference', async () => {
  for (const scenario of Object.keys(SCENARIOS)) {
    const outcomes = [];
    for (let repeat = 0; repeat < 2; repeat++) {
      const run = new Run({ scenario, seed: 61, controller: 'rules-tactical', gate: { decide() { throw new Error('Unexpected inference'); } } });
      run.start();
      while (run.status === 'running') { run.step(); await run.pending; }
      assert.ok(run.sim.result.success, scenario);
      assert.equal(run.usage().attempts, 0);
      outcomes.push(run.sim.result);
    }
    assert.deepEqual(outcomes[0], outcomes[1]);
  }
});

test('target death changes reference target and never adds illegal actions', () => {
  const sim = new Simulation(); sim.units.find(u => u.id === 'e-ranger').hp = 0;
  assert.equal(tacticalRules(sim.snapshot())['f-ranger'], 'attack:e-defender');
  for (const u of sim.units.filter(u => u.team === 'enemy')) u.hp = 0;
  assert.equal(tacticalRules(sim.snapshot())['f-ranger'], 'advance');
  assert.equal(rules(new Simulation({ scenario: 'withdraw' }).snapshot())['f-ranger'], 'retreat');
});

test('timeout on the two-second boundary falls back to current rules, but pause still discards it', async () => {
  for (const paused of [false, true]) {
    let resolve;
    const run = new Run({ scenario: 'withdraw', seed: 61, controller: 'jev', gate: { decide: () => new Promise(r => { resolve = r; }) } });
    run.start(); run.step();
    for (let i = 0; i < 40; i++) run.step();
    if (paused) run.pause();
    resolve({ fallback: 'timeout', latencyMs: 2001, attempted: true }); await run.pending;
    assert.equal(run.decisions.at(-1).source, paused ? 'discarded' : 'fallback');
    assert.equal(run.sim.units[0].action, paused ? 'hold' : 'retreat');
  }
});
