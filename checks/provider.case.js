import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProvider } from '../lib/provider.js';
import { buildRequest, validateResponse } from '../lib/decisions.js';
import { Simulation } from '../lib/simulation.js';

test('official SDK sends native pinned request with no browser credentials, retries or provider switch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jev-sdk-')); const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init }); const body = JSON.parse(init.body);
    return new Response(JSON.stringify({ model: body.model, usage: { input_tokens: 123, output_tokens: 0 }, answers: Object.fromEntries(Object.entries(body.questions).map(([id, q]) => [id, { type: 'choice', choice: 'hold', confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === 'hold' ? 1 : 0])) }])) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const provider = createProvider(root, { TYPESAFE_API_KEY: 'synthetic-test-key', JEV_PRICE_CONFIRMED: 'true' }, fetchImpl);
    const req = buildRequest(new Simulation().snapshot());
    const result = await provider.evaluate(req, new AbortController().signal);
    assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/systemone');
    assert.deepEqual(JSON.parse(calls[0].init.body), req); assert.equal(validateResponse(req, result)['f-healer'], 'hold');
    assert.equal(provider.budget.summary().tokens, 123); assert.equal(provider.budget.summary().uncertainRequests, 0);
    assert.equal(provider.status().configured, true);
    assert.equal(provider.status().connection.state, 'available');
    assert.ok(!JSON.stringify(provider.status()).includes('synthetic-test-key'));
  } finally { rmSync(root, { recursive: true }); }
});

test('configured access stays distinct from busy, failed, and recovered transport', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jev-health-'));
  let status = 429;
  const fetchImpl = async (_url, init) => {
    if (status !== 200) return new Response(JSON.stringify({ message: 'Do not leak private-health-key or provider details' }), { status, headers: { 'Content-Type': 'application/json' } });
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify({ model: body.model, usage: { input_tokens: 123, output_tokens: 0 }, answers: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const provider = createProvider(root, { TYPESAFE_API_KEY: 'private-health-key', JEV_PRICE_CONFIRMED: 'true' }, fetchImpl);
    const req = buildRequest(new Simulation().snapshot());
    assert.equal(provider.status().connection.state, 'not_checked');
    for (const [httpStatus, state] of [[429, 'busy'], [503, 'unavailable']]) {
      status = httpStatus;
      await assert.rejects(provider.evaluate(req));
      const health = provider.status();
      assert.equal(health.configured, true);
      assert.equal(health.ready, true);
      assert.equal(health.connection.state, state);
      assert.equal(health.connection.httpStatus, httpStatus);
      assert.ok(!JSON.stringify(health).includes('private-health-key'));
      assert.ok(!JSON.stringify(health).includes('provider details'));
    }
    status = 200;
    await provider.evaluate(req);
    assert.equal(provider.status().connection.state, 'available');
  } finally { rmSync(root, { recursive: true }); }
});
test('no paid transport calls without both a key and explicit price confirmation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jev-sdk-'));
  try {
    const fetchImpl = async () => { assert.fail('Transport must not run'); };
    for (const [env, error] of [[{}, /missing_key/], [{ TYPESAFE_API_KEY: 'synthetic-test-key' }, /price_not_confirmed/]]) {
      const provider = createProvider(root, env, fetchImpl); assert.equal(provider.status().ready, false);
      await assert.rejects(provider.evaluate(buildRequest(new Simulation().snapshot()), new AbortController().signal), error);
      assert.equal(provider.budget.summary().requests, 0);
    }
  } finally { rmSync(root, { recursive: true }); }
});

test('Vercel uses only its gateway key and records the documented Jev alias honestly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jev-gateway-')); const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init }); const body = JSON.parse(init.body);
    return new Response(JSON.stringify({ model: body.model, answers: Object.fromEntries(Object.entries(body.questions).map(([id, q]) => [id, { type: 'choice', choice: 'hold', confidence: .8, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === 'hold' ? 1 : 0])) }])), usage: { input_tokens: 321, output_tokens: 0 }, provider_metadata: { gateway: { routing: { finalProvider: 'typesafe-ai' } } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const provider = createProvider(root, { JEV_PROVIDER: 'vercel', TYPESAFE_API_KEY: 'wrong-provider-test-key', AI_GATEWAY_API_KEY: 'gateway-test-key', JEV_PRICE_CONFIRMED: 'true' }, fetchImpl);
    const request = buildRequest(new Simulation().snapshot(), '', provider.model);
    const response = await provider.evaluate(request, new AbortController().signal);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://ai-gateway.vercel.sh/typesafe/v1/systemone');
    assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer gateway-test-key');
    assert.deepEqual(JSON.parse(calls[0].init.body), request);
    assert.equal(request.model, 'typesafe-ai/jev');
    assert.equal(provider.modelVersion, null);
    assert.equal(provider.status().versionPinned, false);
    assert.equal(response.provider_metadata.gateway.routing.finalProvider, 'typesafe-ai');
    assert.equal(validateResponse(request, response)['f-defender'], 'hold');
    assert.equal(provider.budget.summary().tokens, 321);
    assert.ok(!JSON.stringify(provider.status()).includes('test-key'));
    assert.throws(() => validateResponse(request, { ...response, model: 'another-model' }), /model_or_schema_mismatch/);
    await assert.rejects(provider.evaluate({ ...request, model: 'another-model' }), /model_or_schema_mismatch/);
    assert.equal(calls.length, 1);
  } finally { rmSync(root, { recursive: true }); }
});

test('gateway selection cannot silently reuse a TypeSafe credential or model identifier', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jev-gateway-'));
  try {
    const fetchImpl = async () => { assert.fail('Transport must not run'); };
    const provider = createProvider(root, { JEV_PROVIDER: 'vercel', TYPESAFE_API_KEY: 'direct-test-key', JEV_PRICE_CONFIRMED: 'true' }, fetchImpl);
    assert.equal(provider.status().ready, false);
    assert.equal(provider.status().reason, 'Waiting for AI_GATEWAY_API_KEY');
    await assert.rejects(provider.evaluate(buildRequest(new Simulation().snapshot())), /missing_key/);
    assert.throws(() => createProvider(root, { JEV_PROVIDER: 'vercel', JEV_MODEL: 'jev-1.13.0' }, fetchImpl), /requires typesafe-ai\/jev/);
    assert.equal(provider.budget.summary().requests, 0);
  } finally { rmSync(root, { recursive: true }); }
});
