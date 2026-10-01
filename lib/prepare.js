import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateResponse } from './decisions.js';

export async function prepareProvider(root, provider) {
  if (!provider.prepare) return;
  await provider.prepare();
  const evidence = await provider.warmup();
  validateResponse(evidence.request, evidence.response);
  const dir = join(root, '.local', 'access');
  await mkdir(dir, { recursive: true });
  const at = new Date().toISOString();
  await writeFile(join(dir, `nimble-warmup-${at.replaceAll(':', '-')}.json`), JSON.stringify({ at, ...evidence }, null, 2), { mode: 0o600 });
  console.log(`Nimble verified and warmed (${evidence.latencyMs}ms). No cloud inference.`);
}
