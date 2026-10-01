import { createServer } from 'node:http';
import { readFile, readdir, mkdir, writeFile, rename } from 'node:fs/promises';
import { mkdirSync, openSync, writeFileSync, closeSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createProvider } from './lib/provider.js';
import { DecisionGate } from './lib/decisions.js';
import { Run } from './lib/run.js';
import { SCENARIOS } from './lib/simulation.js';
import { provenance } from './lib/provenance.js';
import { prepareProvider } from './lib/prepare.js';

export const ROOT = dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const FILES = {
  '/': 'public/index.html', '/app.js': 'public/app.js', '/style.css': 'public/style.css',
  '/assets/crossing.svg': 'public/assets/crossing.svg', '/assets/defender.svg': 'public/assets/defender.svg', '/assets/ranger.svg': 'public/assets/ranger.svg', '/assets/healer.svg': 'public/assets/healer.svg',
  '/vendor/phaser.js': 'node_modules/phaser/dist/phaser.min.js', '/vendor/lucide.js': 'node_modules/lucide/dist/umd/lucide.min.js',
};

export function acquireLock(root) {
  mkdirSync(join(root, '.local'), { recursive: true });
  const path = join(root, '.local', 'process.lock');
  try { const fd = openSync(path, 'wx', 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd); }
  catch { throw new Error('Another sandbox/evaluation may own the budget. Stop it first; see README for stale-lock recovery.'); }
  return () => { try { unlinkSync(path); } catch {} };
}

export function createApp({ root = ROOT, provider = createProvider(root) } = {}) {
  const gate = new DecisionGate({ provider });
  const providerStatus = () => ({ ...provider.status(), ...gate.status() });
  const frozen = provenance(root, provider);
  const csrf = randomBytes(32).toString('hex');
  let run = null, savedId = null, serverError = null;
  const makeRun = opts => new Run({ ...opts, gate, provenance: frozen });
  run = makeRun({ scenario: 'crossing', seed: 41 });
  async function save(record) {
    const dir = join(root, '.local', 'runs'); await mkdir(dir, { recursive: true });
    const path = join(dir, `${record.meta.id}.json`);
    await writeFile(`${path}.tmp`, JSON.stringify(record), { mode: 0o600 }); await rename(`${path}.tmp`, path);
  }
  const timer = setInterval(() => {
    run.step();
    if (run.status === 'complete' && !run.pending && savedId !== run.id) {
      savedId = run.id; save(run.export()).catch(() => { serverError = 'Could not save replay'; });
    }
  }, 50);
  const server = createServer(async (req, res) => {
    const port = server.address()?.port;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'");
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (!hosts.includes(req.headers.host)) return json(403, { error: 'Loopback host required' });
    if (req.headers.origin && !hosts.some(host => req.headers.origin === `http://${host}`)) return json(403, { error: 'Cross-origin request denied' });
    if (!['GET', 'HEAD', 'POST'].includes(req.method)) return json(405, { error: 'Method not allowed' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (req.method === 'POST') {
        if (req.headers['x-lab-token'] !== csrf || !req.headers['content-type']?.startsWith('application/json')) return json(403, { error: 'Local session required' });
        let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 8192) return json(413, { error: 'Request too large' }); }
        let data; try { data = JSON.parse(body); } catch { return json(400, { error: 'Invalid JSON' }); }
        if (url.pathname === '/api/run') {
          const { scenario, seed, controller, orders = '' } = data;
          if (!Object.hasOwn(SCENARIOS, scenario) || !Number.isInteger(seed) || seed < 0 || seed > 2147483647 || !['rules', 'rules-tactical', 'jev'].includes(controller) || typeof orders !== 'string' || orders.length > 400) return json(400, { error: 'Invalid run configuration' });
          if (controller === 'jev' && !provider.status().ready) return json(409, { error: provider.status().reason });
          run.retire(); await run.pending; if (run.sim.tick > 0) await save(run.export());
          run = makeRun({ scenario, seed, controller, orders: controller === 'jev' ? orders : '' }); savedId = null; serverError = null;
          return json(200, run.state());
        }
        if (url.pathname === '/api/control') {
          if (!['start', 'pause'].includes(data.action)) return json(400, { error: 'Unknown control' });
          if (data.action === 'start') run.start(); else run.pause();
          return json(200, run.state());
        }
        if (url.pathname === '/api/save') { await save(run.export()); return json(200, { id: run.id }); }
        return json(404, { error: 'Not found' });
      }
      if (url.pathname === '/api/config') return json(200, { csrf, scenarios: SCENARIOS, provider: providerStatus(), frozen });
      if (url.pathname === '/api/state') return json(200, { ...run.state(), provider: providerStatus(), error: serverError });
      if (url.pathname === '/api/runs') {
        const names = await readdir(join(root, '.local', 'runs')).catch(() => []);
        const records = await Promise.all(names.filter(n => /^[\w-]+\.json$/.test(n)).map(async n => { const r = JSON.parse(await readFile(join(root, '.local', 'runs', n), 'utf8')); return { meta: r.meta, result: { ...r.result, jevDecisions: r.decisions.filter(d => d.source === 'jev').length } }; }));
        return json(200, records.sort((a, b) => b.meta.createdAt.localeCompare(a.meta.createdAt)));
      }
      if (url.pathname.startsWith('/api/replay/')) {
        const id = url.pathname.slice('/api/replay/'.length);
        if (!/^[\w-]{1,100}$/.test(id)) return json(400, { error: 'Invalid replay' });
        const bytes = await readFile(join(root, '.local', 'runs', `${id}.json`));
        res.writeHead(200, { 'Content-Type': TYPES['.json'] }); return res.end(req.method === 'HEAD' ? undefined : bytes);
      }
      if (url.pathname === '/api/results') {
        const selected = url.searchParams.get('series');
        if (selected && !/^[A-Za-z0-9][A-Za-z0-9.-]{1,180}$/.test(selected)) return json(400, { error: 'Invalid evaluation' });
        const path = selected ? join(root, '.local', 'evaluations', selected, 'evaluation.json') : join(root, '.local', 'evaluation.json');
        const data = await readFile(path, 'utf8').catch(() => null);
        return json(200, data ? JSON.parse(data) : { rows: [], status: 'Not evaluated' });
      }
      if (url.pathname === '/api/evaluations') {
        const entries = await readdir(join(root, '.local', 'evaluations'), { withFileTypes: true }).catch(() => []);
        const records = [];
        for (const entry of entries.filter(e => e.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9.-]{1,180}$/.test(e.name))) {
          const data = await readFile(join(root, '.local', 'evaluations', entry.name, 'evaluation.json'), 'utf8').catch(() => null);
          if (!data) continue;
          const result = JSON.parse(data);
          records.push({ id: entry.name, createdAt: result.createdAt, profile: result.frozen?.tacticalBrief || 'unbriefed-v1', phase: result.phase || 'holdout', count: result.rows.length, seeds: result.seeds });
        }
        return json(200, records.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      }
      const file = Object.hasOwn(FILES, url.pathname) ? FILES[url.pathname] : null; if (!file) return json(404, { error: 'Not found' });
      const bytes = await readFile(join(root, file));
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)], 'Content-Length': bytes.length }); res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) { json(error.code === 'ENOENT' ? 404 : 500, { error: error.code === 'ENOENT' ? 'Not found' : 'Local operation failed' }); }
  });
  server.on('close', () => clearInterval(timer));
  server.on('error', () => clearInterval(timer));
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const release = acquireLock(ROOT);
  process.on('exit', release);
  const provider = createProvider(ROOT);
  await prepareProvider(ROOT, provider);
  const server = createApp({ provider });
  const port = Number(process.env.PORT || 4196);
  server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `Port ${port} is occupied. Choose another PORT.` : 'Server could not start'); process.exit(1); });
  server.listen(port, '127.0.0.1', () => console.log(`JEV Squad Lab: http://127.0.0.1:${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
}
