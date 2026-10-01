import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProvider } from '../lib/provider.js';
import { buildRequest, validateResponse } from '../lib/decisions.js';
import { Simulation } from '../lib/simulation.js';
import { Budget } from '../lib/budget.js';

test('local Nimble discovers identity and sends no cloud key, even with funded credentials present', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nimble-')); const calls = [];
  const transport = async (url, init = {}) => {
    calls.push({ url, init });
    let data;
    if (url.endsWith('/api/version')) data = { version: '0.35.0' };
    else if (url.endsWith('/api/tags')) data = { models: [{ name: 'nimble:latest', digest: 'a'.repeat(64), capabilities: ['decision'], details: { parameter_size: '9.0B', quantization_level: 'Q8_0' } }] };
    else {
      const body = JSON.parse(init.body);
      data = { model: body.model, usage: { input_tokens: 150, output_tokens: 0 }, answers: Object.fromEntries(Object.entries(body.questions).map(([id, q]) => [id, { type: 'choice', choice: 'hold', confidence: .8, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === 'hold' ? 1 : 0])) }])) };
    }
    return new Response(JSON.stringify(data), { status: 200 });
  };
  try {
    const p = createProvider(root, { JEV_PROVIDER: 'ollama', AI_GATEWAY_API_KEY: 'private-cloud-test-key', TYPESAFE_API_KEY: 'private-direct-test-key', JEV_PRICE_CONFIRMED: 'true' }, transport);
    assert.equal(p.status().ready, false);
    const request = buildRequest(new Simulation().snapshot(), '', p.model);
    await assert.rejects(p.evaluate(request), /local_model_not_verified/);
    await p.prepare();
    assert.equal(p.identity.digest, 'a'.repeat(64));
    assert.equal(p.status().ready, true);
    const result = await p.evaluate(request);
    assert.equal(validateResponse(request, result)['f-defender'], 'hold');
    assert.equal(calls[2].url, 'http://127.0.0.1:11434/v1/systemone');
    assert.equal(calls[2].init.redirect, 'error');
    assert.equal(new Headers(calls[2].init.headers).has('authorization'), false);
    assert.equal(p.budget.summary().accountedUsd, 0);
    assert.equal(p.budget.summary().tokens, 150);
    assert.ok(!JSON.stringify(calls).includes('test-key'));
    assert.throws(() => readFileSync(join(root, '.local', 'usage.json')), /ENOENT/);
    await assert.rejects(p.evaluate({ ...request, model: 'typesafe-ai/jev' }), /model_or_schema_mismatch/);
    assert.equal(calls.length, 3);
  } finally { rmSync(root, { recursive: true }); }
});

test('local mode rejects remote URLs, credentials, redirects and model substitution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nimble-guard-'));
  try {
    for (const url of ['https://api.typesafe.ai', 'http://127.0.0.1.evil.example:11434', 'http://key@127.0.0.1:11434', 'http://127.0.0.1:11434/path', 'http://127.0.0.1:11434?secret=x']) assert.throws(() => createProvider(root, { JEV_PROVIDER: 'ollama', OLLAMA_BASE_URL: url }), /loopback/);
    assert.throws(() => createProvider(root, { JEV_PROVIDER: 'ollama', JEV_MODEL: 'jev' }), /nimble/);
    assert.throws(() => new Budget({ path: join(root, 'test.json'), price: 0, provider: 'vercel' }), /Invalid budget/);
    const p = createProvider(root, { JEV_PROVIDER: 'ollama' }, async () => new Response('{}', { status: 503 }));
    await assert.rejects(p.prepare());
    assert.equal(p.status().ready, false);
    assert.equal(p.budget.summary().requests, 0);
  } finally { rmSync(root, { recursive: true }); }
});

test('zero-priced local requests still enforce the persisted request limit', () => {
  const root = mkdtempSync(join(tmpdir(), 'nimble-limit-'));
  try {
    const opts = { path: join(root, 'usage.json'), price: 0, provider: 'ollama', maxRequests: 1 };
    const budget = new Budget(opts); budget.reserve();
    assert.throws(() => new Budget(opts).reserve(), /request_limit/);
    assert.equal(budget.summary().uncertainRequests, 1);
    assert.equal(budget.summary().accountedUsd, 0);
  } finally { rmSync(root, { recursive: true }); }
});
