import { TypeSafeClient } from '@typesafe-ai/sdk';
import { Budget } from './budget.js';
import { join } from 'node:path';
import { createOllamaProvider } from './ollama.js';

export function createProvider(root, env = process.env, fetchImpl) {
  const name = env.JEV_PROVIDER || 'typesafe';
  if (name === 'ollama') return createOllamaProvider(root, env, fetchImpl);
  if (!['typesafe', 'vercel'].includes(name)) throw new Error('Choose typesafe or vercel explicitly');
  const expectedModel = name === 'typesafe' ? 'jev-1.13.0' : 'typesafe-ai/jev';
  const model = env.JEV_MODEL || expectedModel;
  if (model !== expectedModel) throw new Error(`Provider ${name} requires ${expectedModel}; no model substitution is allowed`);
  const modelVersion = name === 'typesafe' ? model : null;
  const keyName = name === 'typesafe' ? 'TYPESAFE_API_KEY' : 'AI_GATEWAY_API_KEY';
  const key = env[keyName]?.trim() || '';
  const priceConfirmed = env.JEV_PRICE_CONFIRMED === 'true';
  const budget = new Budget({ path: join(root, '.local', 'usage.json'), ceiling: Number(env.JEV_BUDGET_USD || 5), maxRequests: Number(env.JEV_MAX_REQUESTS || 1500), price: Number(env.JEV_PRICE_PER_MILLION || .042), provider: name });
  const baseURL = name === 'typesafe' ? 'https://api.typesafe.ai' : 'https://ai-gateway.vercel.sh/typesafe';
  const client = key ? new TypeSafeClient({ apiKey: key, baseURL, timeout: 2000, retry: { maxRetries: 0 }, logLevel: 'off', ...(fetchImpl ? { fetch: fetchImpl } : {}) }) : null;
  let connection = { state: 'not_checked', checkedAt: null, httpStatus: null };
  return {
    name, model, modelVersion, budget,
    status() { return { name, model, modelVersion, versionPinned: modelVersion !== null, configured: Boolean(key), ready: Boolean(key && priceConfirmed), reason: !key ? `Waiting for ${keyName}` : !priceConfirmed ? 'Price confirmation required' : 'Ready', connection: { ...connection }, budget: budget.summary() }; },
    async evaluate(request, signal) {
      if (!client) throw new Error('missing_key');
      if (!priceConfirmed) throw new Error('price_not_confirmed');
      if (request.model !== model) throw new Error('model_or_schema_mismatch');
      const reservation = budget.reserve();
      try {
        const response = await client.systemOne(request, { signal });
        budget.settle(reservation, response.usage?.input_tokens);
        connection = { state: 'available', checkedAt: new Date().toISOString(), httpStatus: 200 };
        return response;
      } catch (error) {
        // Status is deliberately coarse: never send raw SDK errors or headers to the browser.
        connection = { state: error.status === 429 || error.status === 529 ? 'busy' : 'unavailable', checkedAt: new Date().toISOString(), httpStatus: Number.isInteger(error.status) ? error.status : null };
        throw error;
      }
    },
  };
}
