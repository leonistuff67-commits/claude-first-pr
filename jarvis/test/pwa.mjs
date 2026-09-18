/**
 * PWA checks against the served app: the manifest is valid and installable, the
 * service worker registers and activates, and once it's cached the app boots
 * with the server DOWN — i.e. it's genuinely installable and offline-capable.
 */
import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

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

const port = await freePort();
let app = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(port) },
  stdio: 'ignore',
});
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 60; i++) {
  try { await fetch(`${base}/api/config`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const ctx = await browser.newContext({ permissions: ['microphone'] });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

try {
  // Manifest is valid and installable-shaped.
  const manifest = await (await fetch(`${base}/manifest.webmanifest`)).json();
  check('manifest has a name', manifest.name === 'JARVIS', manifest.name);
  check('manifest is standalone', manifest.display === 'standalone', manifest.display);
  check('manifest has 192 + 512 icons',
    ['192x192', '512x512'].every((s) => manifest.icons.some((i) => i.sizes === s)));
  check('manifest has a maskable icon', manifest.icons.some((i) => i.purpose === 'maskable'));

  const icon = await fetch(`${base}/icons/icon-512.png`);
  check('512 icon served as png', icon.headers.get('content-type') === 'image/png');

  await page.goto(`${base}/`, { waitUntil: 'networkidle' });

  // Service worker registers and reaches activated.
  const swActive = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return false;
    const reg = await navigator.serviceWorker.ready;
    return Boolean(reg.active);
  });
  check('service worker is active', swActive);

  // Give it a beat to finish precaching the shell.
  await page.waitForTimeout(600);
  const cached = await page.evaluate(async () => {
    const keys = await caches.keys();
    const cache = await caches.open(keys[0]);
    const reqs = await cache.keys();
    return reqs.map((r) => new URL(r.url).pathname);
  });
  check('app shell precached', cached.some((p) => p.endsWith('/index.html')) &&
    cached.some((p) => p.endsWith('/js/app.js')));

  // Now take the server DOWN and prove the app still loads (true offline).
  app.kill();
  await new Promise((r) => setTimeout(r, 400));
  await ctx.setOffline(true);

  const offlinePage = await ctx.newPage();
  const offErrors = [];
  offlinePage.on('pageerror', (e) => offErrors.push(e.message));
  await offlinePage.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await offlinePage.click('#boot-btn');
  await offlinePage.waitForTimeout(500);
  const booted = await offlinePage.locator('.msg--jarvis').count();
  check('app boots with the server offline', booted > 0, `${booted} messages`);
  check('no errors offline', offErrors.length === 0);
  if (offErrors.length) console.error(offErrors.join('\n'));

  check('no page errors', pageErrors.length === 0);
} finally {
  await browser.close();
  app.kill();
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
