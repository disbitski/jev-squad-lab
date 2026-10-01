import { mkdir, cp, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const output = 'docs';
await mkdir(join(output, 'vendor'), { recursive: true });
// Explicit allowlist: no local simulator, credentials, provider adapter, or server enters Pages.
for (const name of ['index.html', 'viewer.js', 'style.css', 'playback.js', 'data']) await cp(join('replay', name), join(output, name), { recursive: true });
await cp('public/assets', join(output, 'assets'), { recursive: true });
for (const [source, target] of [
  ['node_modules/phaser/dist/phaser.min.js', 'phaser.js'],
  ['node_modules/lucide/dist/umd/lucide.min.js', 'lucide.js'],
  ['node_modules/phaser/LICENSE.md', 'phaser-LICENSE.md'],
  ['node_modules/lucide/LICENSE', 'lucide-LICENSE'],
]) {
  const bytes = await readFile(source);
  const text = bytes.toString().replace(/\r\n/g, '\n');
  await writeFile(join(output, 'vendor', target), (target.endsWith('.js') ? text.replace(/\/\/# sourceMappingURL=.*$/gm, '') : text).trimEnd() + '\n');
}
await writeFile(join(output, '.nojekyll'), '');
console.log('Static replay viewer built in docs/.');
