const port = Number(process.env.PORT || 4196);
const base = `http://127.0.0.1:${port}`;
const config = await (await fetch(`${base}/api/config`)).json();
if (!config.provider.ready) throw new Error(config.provider.reason);
async function api(path, data) {
  const response = await fetch(base + path, data ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lab-Token': config.csrf }, body: JSON.stringify(data) } : {});
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}
const existing = await api('/api/state');
if (['running', 'paused'].includes(existing.status)) throw new Error('A battle is already running or paused; do not interrupt it.');
if (process.env.JEV_PROVIDER === 'ollama' && config.provider.name !== 'ollama') throw new Error('Local demo requires the Ollama server; no cloud battle started.');
const run = await api('/api/run', { scenario: 'crossing', seed: 41, controller: 'jev' });
await api('/api/control', { action: 'start' });
const label = config.provider.label || 'Jev';
console.log(`Live exploratory ${label} battle ${run.runId}: ${base}`);
const deadline = Date.now() + 110_000;
let complete = false, lastProgress = -1;
try {
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const state = await api('/api/state');
    if (state.runId !== run.runId) throw new Error('Battle changed externally; leaving the replacement untouched.');
    if (state.status === 'paused') throw new Error('Battle paused externally; leaving it paused.');
    const progress = Math.floor(state.snapshot.time / 10);
    if (progress !== lastProgress) {
      lastProgress = progress;
      console.log(JSON.stringify({ seconds: state.snapshot.time, connection: state.provider.connection, usage: state.usage }));
    }
    if (state.status === 'complete') { complete = true; break; }
  }
  if (!complete) throw new Error('Battle did not finish within its wall-clock safety limit.');
} finally {
  const state = await api('/api/state');
  if (state.runId === run.runId) {
    if (state.status === 'running') await api('/api/control', { action: 'pause' });
    // Wait for the two-second decision deadline before saving the final evidence.
    await new Promise(resolve => setTimeout(resolve, 2200));
    const current = await api('/api/state');
    if (current.runId === run.runId) await api('/api/save', {});
  }
}
const record = await api(`/api/replay/${run.runId}`);
const realDecisions = record.decisions.filter(d => ['jev', 'nimble'].includes(d.source)).length;
console.log(JSON.stringify({ id: run.runId, realDecisions, ...record.result }, null, 2));
if (!realDecisions) { console.error(`No valid ${label} actions were applied. This is failure evidence.`); process.exitCode = 1; }
else if (record.result.fallbackCount || record.result.discarded) {
  console.error(`Battle finished with fallbacks/discards. Review the recording as a hybrid run, not an uninterrupted ${label} demo.`);
  process.exitCode = 2;
}
