import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TACTICAL_BRIEF } from './tactics.js';

export function provenance(root, provider, { guided = provider.name === 'ollama' } = {}) {
  const files = ['lib/simulation.js', 'lib/decisions.js', 'lib/tactics.js', 'lib/run.js', 'lib/provider.js', 'lib/ollama.js', 'lib/budget.js', 'package-lock.json', 'scripts/evaluate.js'];
  const hashes = Object.fromEntries(files.map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]));
  const profile = { requestEncoding: guided ? TACTICAL_BRIEF : provider.name === 'ollama' ? 'compact-text' : 'object', tacticalBrief: guided ? TACTICAL_BRIEF : 'unbriefed-v1' };
  return { node: process.version, provider: provider.name, model: provider.model, modelLabel: provider.label || 'Jev', ...profile, modelVersion: provider.modelVersion ?? null, versionPinned: Boolean(provider.modelVersion), ...(provider.identity ? { modelIdentity: provider.identity } : {}), price: provider.budget.price, hashes, configHash: createHash('sha256').update(JSON.stringify({ hashes, profile })).digest('hex') };
}
