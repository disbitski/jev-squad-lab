import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, acquireLock } from '../server.js';
import { createProvider } from '../lib/provider.js';
import { buildRequest, validateResponse } from '../lib/decisions.js';
import { Simulation } from '../lib/simulation.js';

const release = acquireLock(ROOT); process.on('exit', release);
const provider = createProvider(ROOT, { ...process.env, JEV_PROVIDER: 'ollama', JEV_MODEL: 'nimble:latest' });
await provider.prepare();
const base = buildRequest(new Simulation().snapshot(), '', provider.model);
const rows = [];
for (const encoding of process.argv.includes('--compact-only') ? ['compact-text'] : ['object', 'compact-json', 'compact-text']) {
  for (let repeat = 1; repeat <= 2; repeat++) {
    const request = encoding === 'compact-text' ? buildRequest(new Simulation({ seed: 40 + repeat }).snapshot(), '', provider.model, encoding) : { ...base, state: encoding === 'object' ? base.state : JSON.stringify(base.state) };
    const start = performance.now();
    const response = await provider.evaluate(request, AbortSignal.timeout(30000));
    const latencyMs = Math.round(performance.now() - start);
    const actions = validateResponse(request, response);
    const row = { purpose: 'Exploratory latency measurement, not a scored battle', encoding, repeat, latencyMs, request, response, actions, identity: provider.identity };
    rows.push(row);
    console.log(JSON.stringify({ encoding, repeat, latencyMs, tokens: response.usage, actions }));
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
await mkdir(join(ROOT, '.local', 'access'), { recursive: true });
await writeFile(join(ROOT, '.local', 'access', `nimble-latency-${new Date().toISOString().replaceAll(':', '-')}.json`), JSON.stringify(rows, null, 2), { mode: 0o600 });
