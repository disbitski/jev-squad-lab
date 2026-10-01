import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, acquireLock } from '../server.js';
import { createProvider } from '../lib/provider.js';
import { DecisionGate } from '../lib/decisions.js';
import { provenance } from '../lib/provenance.js';
import { Run } from '../lib/run.js';
import { SCENARIOS } from '../lib/simulation.js';
import { prepareProvider } from '../lib/prepare.js';
import assert from 'node:assert/strict';

const release = acquireLock(ROOT); process.on('exit', release);
const rulesOnly = process.argv.includes('--rules-only');
const calibration = process.argv.includes('--calibrate');
const guided = process.argv.includes('--guided');
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const seeds = option('seeds') ? option('seeds').split(',').map(Number) : guided ? [71, 72, 73, 74, 75] : [41, 42, 43, 44, 45];
const scenarios = option('scenarios')?.split(',') ?? Object.keys(SCENARIOS);
if (!seeds.length || seeds.some(n => !Number.isInteger(n) || n < 0 || n > 2147483647) || new Set(seeds).size !== seeds.length || scenarios.some(s => !Object.hasOwn(SCENARIOS, s)) || new Set(scenarios).size !== scenarios.length) throw new Error('Invalid seeds or scenarios');
if (!calibration && guided && JSON.stringify(seeds) !== '[71,72,73,74,75]') throw new Error('Guided holdout seeds are fixed; use --calibrate for exploratory tuning');
if (calibration && guided && seeds.some(seed => seed < 61 || seed > 70)) throw new Error('Calibration seeds must stay separate from the frozen holdout');
if (!calibration && guided && JSON.stringify(scenarios) !== JSON.stringify(Object.keys(SCENARIOS))) throw new Error('Guided holdout must cover every mission');
const provider = createProvider(ROOT);
if (guided && provider.name !== 'ollama') throw new Error('Guided local experiment must not call a paid provider');
if (!rulesOnly) await prepareProvider(ROOT, provider);
if (!rulesOnly && !provider.status().ready) throw new Error(`${provider.status().reason}. No scored model trials were run.`);
const gate = new DecisionGate({ provider });
const frozen = provenance(ROOT, provider, { guided });
const ledgerBefore = provider.budget.summary();
const rows = [], controllers = rulesOnly ? ['rules'] : guided ? ['rules', 'rules-tactical', 'jev'] : ['rules', 'jev'];
const phase = calibration ? 'calibration' : 'holdout';
const series = join(ROOT, '.local', 'evaluations', `${rulesOnly ? 'rules' : provider.name}-${frozen.tacticalBrief}-${phase}-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(series, { recursive: true });
await mkdir(join(ROOT, '.local', 'runs'), { recursive: true });
for (const scenario of scenarios) {
  for (const seed of seeds) {
    for (const controller of controllers) {
      assert.equal(provenance(ROOT, provider, { guided }).configHash, frozen.configHash, 'Controller files changed during evaluation');
      const run = new Run({ scenario, seed, controller, trial: !calibration, gate, provenance: { ...frozen, phase } });
      run.start();
      const start = performance.now();
      while (run.status === 'running') {
        if (performance.now() - start > 110000) { run.pause(); break; }
        run.step();
        if (controller !== 'jev') await run.pending;
        else await new Promise(resolve => setTimeout(resolve, Math.max(0, start + run.sim.tick * 50 - performance.now())));
      }
      await run.pending;
      const record = run.export();
      await writeFile(join(ROOT, '.local', 'runs', `${run.id}.json`), JSON.stringify(record), { mode: 0o600 });
      rows.push({ id: run.id, scenario, seed, controller, checksum: record.checksum, ...record.result });
      await writeFile(join(series, 'progress.json'), JSON.stringify({ frozen, seeds, scenarios, controllers, phase, rows }, null, 2), { mode: 0o600 });
      console.log(`${phase} / ${scenario} / ${seed} / ${controller === 'jev' ? provider.label || 'Jev' : controller}: ${record.result.success ? 'objective met' : 'objective missed'} in ${record.result.elapsed}s / ${record.result.modelDecisions} model batches / ${record.result.fallbackCount} fallbacks / ${record.result.discarded} discarded / ${run.id}`);
    }
  }
}
assert.equal(provenance(ROOT, provider, { guided }).configHash, frozen.configHash, 'Controller files changed during evaluation');
if (provider.name === 'ollama') {
  await provider.prepare();
  assert.deepEqual(provider.identity, frozen.modelIdentity, 'Local model identity changed during evaluation');
}
const result = { status: calibration ? 'Exploratory calibration only; not a scored result.' : rulesOnly ? 'Rules baseline only. Not a comparative result.' : `${frozen.tacticalBrief}: Rules${guided ? ' + tactical rules' : ''} vs ${provider.label || 'Jev'} / ${seeds.length} paired seeds per mission. Inspect fallbacks and model evidence before interpretation.`, createdAt: new Date().toISOString(), frozen, seeds, scenarios, controllers, phase, ledgerBefore, ledgerAfter: provider.budget.summary(), rows };
await writeFile(join(series, 'evaluation.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
const header = 'scenario,seed,controller,success,survivors,elapsed,switches,fallbackCount,meanLatencyMs,inputTokens,estimatedCostUsd';
const csv = `${header}\n${rows.map(r => header.split(',').map(k => r[k] ?? '').join(',')).join('\n')}\n`;
await writeFile(join(series, 'evaluation.csv'), csv, { mode: 0o600 });
if (!calibration) {
  for (const file of ['evaluation.json', 'evaluation.csv']) {
    const old = await readFile(join(ROOT, '.local', file), 'utf8').catch(() => null);
    if (old) await writeFile(join(series, `previous-${file}`), old, { mode: 0o600 });
  }
  await writeFile(join(ROOT, '.local', 'evaluation.json'), JSON.stringify(result, null, 2));
  await writeFile(join(ROOT, '.local', 'evaluation.csv'), csv);
}
console.log(`Saved ${series} and all replay evidence.${calibration ? ' Latest scored results unchanged.' : ' Latest scored results updated.'}`);
