import { Budget } from './budget.js';
import { join } from 'node:path';

export function createOllamaProvider(root, env, fetchImpl = fetch) {
  const model = env.JEV_MODEL || 'nimble:latest';
  if (model !== 'nimble:latest') throw new Error('Local experiment requires nimble:latest explicitly');
  const url = new URL(env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434');
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Ollama requires an uncredentialed loopback HTTP origin');
  const budget = new Budget({ path: join(root, '.local', 'usage-ollama-nimble.json'), price: 0, provider: 'ollama', maxRequests: Number(env.JEV_MAX_REQUESTS || 1500) });
  let identity = null;
  let connection = { state: 'not_checked', checkedAt: null, httpStatus: null };
  const provider = {
    name: 'ollama', label: 'Nimble', model, modelVersion: null, budget,
    get identity() { return identity; },
    status() {
      return { name: 'ollama', label: 'Nimble', model, modelVersion: null, versionPinned: false, identity, configured: true, ready: Boolean(identity), reason: identity ? 'Local model verified' : 'Local model verification required', connection: { ...connection }, budget: budget.summary() };
    },
    async prepare() {
      const get = async path => {
        const res = await fetchImpl(new URL(path, url).href, { signal: AbortSignal.timeout(5000), redirect: 'error' });
        if (!res.ok) throw new Error('Local Ollama discovery failed');
        return res.json();
      };
      const version = await get('/api/version');
      const numbers = String(version.version).split('.').map(Number);
      if ((numbers[0] === 0 && numbers[1] < 35) || !numbers.every(Number.isFinite)) throw new Error('Ollama 0.35.0 or newer is required');
      const tags = await get('/api/tags');
      const installed = tags.models?.find(m => m.name === model);
      if (!installed || !/^[a-f0-9]{64}$/.test(installed.digest) || !installed.capabilities?.includes('decision')) throw new Error('Installed Nimble decision model not found');
      identity = { digest: installed.digest, ollamaVersion: version.version, parameterSize: installed.details?.parameter_size, quantization: installed.details?.quantization_level };
      return identity;
    },
    async evaluate(request, signal) {
      if (!identity) throw new Error('local_model_not_verified');
      if (request.model !== model) throw new Error('model_or_schema_mismatch');
      const reservation = budget.reserve();
      try {
        const res = await fetchImpl(new URL('/v1/systemone', url).href, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request, keep_alive: '30m' }), signal, redirect: 'error' });
        if (!res.ok) { const error = new Error('Local decision request failed'); error.status = res.status; throw error; }
        const response = await res.json();
        budget.settle(reservation, response.usage?.input_tokens);
        connection = { state: 'available', checkedAt: new Date().toISOString(), httpStatus: 200 };
        return response;
      } catch (error) {
        connection = { state: error.status === 429 || error.status === 529 ? 'busy' : 'unavailable', checkedAt: new Date().toISOString(), httpStatus: Number.isInteger(error.status) ? error.status : null };
        throw error;
      }
    },
    async warmup() {
      const request = { model, state: 'Warm-up fixture, not a battle. A unit is at its refuge.', questions: { warmup: { type: 'choice', instructions: 'Select hold to remain at the refuge.', criteria: { hold: 'Remain here.', advance: 'Leave the refuge.' } } } };
      const start = performance.now();
      const response = await provider.evaluate(request, AbortSignal.timeout(60000));
      return { purpose: 'Local warm-up only; excluded from battle results', identity, request, response, latencyMs: Math.round(performance.now() - start) };
    },
  };
  return provider;
}
