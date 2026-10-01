import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, acquireLock } from '../server.js';
import { createProvider } from '../lib/provider.js';
import { prepareProvider } from '../lib/prepare.js';
import { buildRequest, DecisionGate } from '../lib/decisions.js';
import { Simulation, SCENARIOS } from '../lib/simulation.js';
import { tacticalObservation } from '../lib/tactics.js';

const release = acquireLock(ROOT); process.on('exit', release);
const provider = createProvider(ROOT);
if (provider.name !== 'ollama') throw new Error('This diagnostic is local only');
await prepareProvider(ROOT, provider);
const gate = new DecisionGate({ provider }), records = [];
for (const scenario of Object.keys(SCENARIOS)) {
  const state = new Simulation({ scenario, seed: 68 }).snapshot();
  for (const includeActions of [true, false]) {
    const request = buildRequest(state, '', provider.model, 'guided-v2');
    request.state = tacticalObservation(state, { includeActions });
    await new Promise(resolve => setTimeout(resolve, 1000));
    const result = await gate.decide(request);
    records.push({ purpose: 'Static calibration fixture, not a battle or scored result', scenario, seed: 68, includeActions, identity: provider.identity, request, result });
    console.log(scenario, includeActions ? 'current actions present' : 'current actions omitted', JSON.stringify({ actions: result.actions, fallback: result.fallback, latencyMs: result.latencyMs }));
  }
}
const path = join(ROOT, '.local', 'access', `nimble-current-action-probe-${new Date().toISOString().replaceAll(':', '-')}.json`);
await writeFile(path, JSON.stringify(records, null, 2), { mode: 0o600 });
console.log(`Saved ${path}. No battlefield outcomes were measured.`);
