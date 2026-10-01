import test from 'node:test';
import assert from 'node:assert/strict';
import Matter from 'matter-js';
import { Simulation, rules, legalActions, observation, active } from '../lib/simulation.js';
import { Run } from '../lib/run.js';

function position(unit, x, y) { unit.x = x; unit.y = y; Matter.Body.setPosition(unit.body, { x, y }); }
function finish(sim) { while (!sim.done) { if (sim.tick % 20 === 0) sim.apply({ ...rules(sim.snapshot()), ...rules(sim.snapshot(), 'enemy') }); sim.step(); } return sim.snapshot(); }

test('same seed and rules produce exactly repeatable snapshots', () => {
  for (const scenario of ['crossing', 'healer', 'withdraw']) assert.deepEqual(finish(new Simulation({ scenario, seed: 41 })), finish(new Simulation({ scenario, seed: 41 })));
});
test('seed changes deployment without changing unit stats', () => {
  const a = new Simulation({ seed: 41 }).snapshot(), b = new Simulation({ seed: 42 }).snapshot();
  assert.notEqual(a.units[0].x, b.units[0].x); assert.equal(a.units[0].maxHp, b.units[0].maxHp);
});
test('illegal, dead, and allied attack targets are rejected', () => {
  const sim = new Simulation(); sim.units[3].hp = 0;
  for (const action of ['attack:e-defender', 'attack:f-ranger', 'heal:f-ranger', '__proto__', 'teleport']) assert.deepEqual(sim.apply({ 'f-defender': action }).accepted, {});
  sim.units[0].hp = 0; assert.deepEqual(legalActions(sim.snapshot(), 'f-defender'), {});
});
test('healing only available to healer for injured living allies', () => {
  const sim = new Simulation(); sim.units[0].hp = 50;
  assert.ok(legalActions(sim.snapshot(), 'f-healer')['heal:f-defender']);
  assert.equal(legalActions(sim.snapshot(), 'f-ranger')['heal:f-defender'], undefined);
  assert.equal(legalActions(sim.snapshot(), 'f-healer')['heal:e-defender'], undefined);
});
test('damage is code-owned and obeys cooldown', () => {
  const sim = new Simulation(); position(sim.units[0], 200, 280); position(sim.units[3], 245, 280);
  sim.apply({ 'f-defender': 'attack:e-defender' }); sim.step(); const hp = sim.units[3].hp;
  assert.equal(hp, 190 - 13 * .75);
  for (let i = 0; i < 10; i++) sim.step(); assert.equal(sim.units[3].hp, hp);
  for (let i = 0; i < 13; i++) sim.step(); assert.ok(sim.units[3].hp < hp);
});
test('dead target invalidates an already-selected command', () => {
  const sim = new Simulation(); sim.apply({ 'f-defender': 'attack:e-defender' }); sim.units[3].hp = 0; sim.step(); assert.equal(sim.units[0].action, 'hold');
});
test('Matter collision stops a unit entering river outside the bridge', () => {
  const sim = new Simulation(); position(sim.units[0], 400, 100); position(sim.units[3], 560, 100);
  sim.apply({ 'f-defender': 'attack:e-defender' });
  for (let i = 0; i < 60; i++) { sim.step(); const u = sim.units[0]; assert.ok(!(u.x > 408 && u.x < 552 && u.y < 235)); }
});
test('advance reaches bridge rather than oscillating between banks', () => {
  const sim = new Simulation(); for (const u of sim.units.slice(1)) { u.hp = 0; u.body.collisionFilter.mask = 0; }
  sim.apply({ 'f-defender': 'advance' });
  for (let i = 0; i < 500 && !sim.done; i++) sim.step();
  assert.ok(Math.abs(sim.units[0].x - 476) < 4); assert.ok(sim.holdSeconds > 10);
});
test('withdrawal objective requires two extractions, not one', () => {
  const sim = new Simulation({ scenario: 'withdraw' }); position(sim.units[0], 100, 260); sim.step(); assert.equal(sim.done, false);
  position(sim.units[1], 100, 300); sim.step(); assert.equal(sim.result.success, true); assert.equal(sim.result.extracted, 2);
});
test('protect-healer immediately fails on healer death', () => { const sim = new Simulation({ scenario: 'healer' }); sim.units[2].hp = 0; sim.step(); assert.equal(sim.result.success, false); });
test('battle cap is exactly 90 simulated seconds', () => { const sim = new Simulation(); while (!sim.done) sim.step(); assert.equal(sim.time, 90); });
test('both controllers can receive the same computed observations and legal choices', () => {
  const sim = new Simulation(); const state = observation(sim.snapshot());
  for (const [id, action] of Object.entries(rules(state))) assert.ok(Object.hasOwn(legalActions(state, id), action));
  assert.ok(state.units.every(u => Number.isFinite(u.hpFraction) && Number.isFinite(u.distanceToBridge)));
});
test('pause freezes simulation and new runs start from initial state', () => {
  const run = new Run({ scenario: 'crossing', seed: 41 }); run.start(); run.step(); run.pause(); const state = run.sim.snapshot(); run.step(); assert.deepEqual(run.sim.snapshot(), state);
  const next = new Run({ scenario: 'crossing', seed: 41 }); assert.equal(next.sim.tick, 0); assert.notEqual(run.id, next.id);
});
test('exported replay contains snapshots and rules evidence, never invented model probabilities', async () => {
  const run = new Run({ scenario: 'withdraw', seed: 41, trial: true }); run.start();
  while (run.status === 'running') { run.step(); await run.pending; }
  const record = run.export(); assert.ok(record.frames.length > 10); assert.equal(record.meta.mode, 'scored'); assert.equal(record.checksum.length, 64);
  assert.ok(record.decisions.every(d => d.source === 'rules' && !d.response)); assert.ok(record.frames.at(-1).units.some(u => !active(u)));
  run.retire(); assert.equal(run.export().result.status, 'complete');
});
