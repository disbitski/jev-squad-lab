import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, acquireLock } from '../server.js';
import { createProvider } from '../lib/provider.js';
import { buildRequest, validateResponse } from '../lib/decisions.js';
import { Simulation } from '../lib/simulation.js';

const provider = createProvider(ROOT);
const status = provider.status();
if (!status.ready) {
  console.error(`${status.reason}. No inference request was sent. See README.md > Jev Access.`);
  process.exitCode = 1;
} else {
  const release = acquireLock(ROOT);
  try {
    const request = buildRequest(new Simulation({ scenario: 'crossing', seed: 41 }).snapshot(), '', provider.model);
    const start = performance.now();
    const record = { createdAt: new Date().toISOString(), purpose: 'connection preflight, not a scored trial', provider: provider.name, model: provider.model, modelVersion: provider.modelVersion, request };
    try {
      record.response = await provider.evaluate(request, AbortSignal.timeout(2000));
      record.latencyMs = Math.round(performance.now() - start);
      record.actions = validateResponse(request, record.response);
      record.ok = true;
    } catch (error) {
      // Never log raw SDK errors: these may contain request headers or credentials.
      record.ok = false;
      record.httpStatus = Number.isInteger(error.status) ? error.status : null;
      record.error = ['budget_exhausted', 'request_limit', 'model_or_schema_mismatch', 'invalid_usage', 'invalid_answer', 'invalid_probabilities'].includes(error.message) ? error.message : ['TimeoutError', 'AbortError', 'APITimeoutError', 'APIUserAbortError'].includes(error.name) ? 'timeout' : 'provider_request_failed';
      process.exitCode = 1;
    }
    record.budget = provider.budget.summary();
    const directory = join(ROOT, '.local', 'access');
    await mkdir(directory, { recursive: true });
    const path = join(directory, `preflight-${Date.now()}.json`);
    await writeFile(path, JSON.stringify(record, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ ok: record.ok, provider: record.provider, model: record.response?.model ?? record.model, modelVersion: record.modelVersion, latencyMs: record.latencyMs, httpStatus: record.httpStatus, error: record.error, accountedUsd: record.budget.accountedUsd, evidence: path }, null, 2));
    if (record.ok && !provider.modelVersion) console.log('Gateway alias only: the exact Jev version is not exposed. Do not report this as a pinned jev-1.13.0 result.');
  } finally { release(); }
}
