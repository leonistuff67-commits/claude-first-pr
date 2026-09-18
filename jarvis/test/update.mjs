/**
 * Regression test for the bug where an installed copy kept serving a stale
 * build forever: load the app (installing the service worker), then change the
 * deployed files and reload. The new content must appear.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, 'public');

let chromium;
try {
  const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  chromium = pw.chromium ?? pw.default?.chromium;
} catch {
  // Checked below.
}
if (!chromium) {
  console.error('Playwright is not available. Run `npm install` in jarvis/ first.');
  process.exit(1);
}

const failures = [];
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? ` -> ${extra}` : ''}`);
  if (!ok) failures.push(label);
};

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Serve a disposable copy so the test can mutate the "deployment".
const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'jarvis-update-'));
await fsp.cp(PUBLIC, dir, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};
const port = await freePort();
const server = http.createServer((req, res) => {
  const rel = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const file = path.join(dir, path.normalize(rel));
  if (!file.startsWith(dir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end('nope'); return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(port, '127.0.0.1', r));
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const ctx = await browser.newContext({ permissions: ['microphone'] });
const page = await ctx.newPage();

try {
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  const controlled = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return Boolean(reg.active);
  });
  check('service worker installed on first visit', controlled);
  await page.waitForTimeout(600);

  // Ship an "update": a new control that didn't exist in the cached build.
  const html = await fsp.readFile(path.join(dir, 'index.html'), 'utf8');
  await fsp.writeFile(
    path.join(dir, 'index.html'),
    html.replace('</dialog>', '<div id="brand-new-control">SHIPPED</div></dialog>'),
  );

  // Reload the way a user would. The update must arrive (the SW may reload the
  // page itself once when the new worker takes over).
  let found = false;
  for (let attempt = 0; attempt < 3 && !found; attempt++) {
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    found = await page.evaluate(() => Boolean(document.getElementById('brand-new-control')));
  }
  check('an installed app picks up a new build', found, found ? 'update applied' : 'still serving the stale build');

  // And it must still work with the network gone.
  await ctx.setOffline(true);
  server.close();
  const offline = await ctx.newPage();
  await offline.goto(`${base}/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const booted = await offline.evaluate(() => Boolean(document.getElementById('boot-btn')));
  check('still boots offline after the update', booted);
} finally {
  await browser.close();
  try { server.close(); } catch { /* already closed */ }
  await fsp.rm(dir, { recursive: true, force: true });
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
