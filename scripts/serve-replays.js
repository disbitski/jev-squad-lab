import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const root = resolve('docs');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.csv': 'text/csv' };
const server = createServer(async (req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
  let path;
  try { path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname)); } catch { res.writeHead(400); return res.end(); }
  if (path === root) path += '/index.html';
  if (!path.startsWith(root + sep)) { res.writeHead(403); return res.end(); }
  try { const bytes = await readFile(path); res.writeHead(200, { 'Content-Type': types[extname(path)] || 'text/plain', 'X-Content-Type-Options': 'nosniff' }); res.end(req.method === 'HEAD' ? undefined : bytes); }
  catch { res.writeHead(404); res.end('Not found'); }
});
server.listen(Number(process.env.PORT || 4214), '127.0.0.1');
