/**
 * End-to-end smoke test: boots the real server against a mock API, drives the
 * page in Chromium, and checks a full turn — stream, tool call, tool result,
 * final reply — plus the orb, the settings dialog and persistence.
 *
 * Needs Playwright. `npm install` pulls it in; set PLAYWRIGHT_MODULE to an
 * absolute path if you have it installed somewhere unusual.
 */
import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockApi } from './mock-api.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Ask the OS for a free port, so a repeat run never collides with a leftover. */
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

/** Whatever we start gets torn down, however this script exits. */
const cleanups = [];
function cleanup() {
  while (cleanups.length) {
    try {
      cleanups.pop()();
    } catch {
      // Best effort.
    }
  }
}
process.on('exit', cleanup);
process.on('uncaughtException', (err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});

const APP_PORT = await freePort();

let chromium;
try {
  const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  // Playwright is CommonJS, so depending on how it resolves the export lands on
  // the namespace or on `default`.
  chromium = pw.chromium ?? pw.default?.chromium;
} catch {
  // Fall through to the check below.
}
if (!chromium) {
  console.error('Playwright is not available. Run `npm install` in jarvis/ first.');
  process.exit(1);
}

const check = (label, actual, expected) => {
  const ok = typeof expected === 'function' ? expected(actual) : actual === expected;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} -> ${actual}`);
  if (!ok) failures.push(label);
};
const failures = [];

const { server: mock, port: mockPort } = await startMockApi();
cleanups.push(() => mock.close());

const app = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(APP_PORT),
    ANTHROPIC_API_KEY: 'test-key',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${mockPort}`,
  },
  stdio: 'ignore',
});
cleanups.push(() => app.kill());

// Wait for the server to answer rather than guessing at a sleep duration.
for (let i = 0; i < 50; i++) {
  try {
    await fetch(`http://127.0.0.1:${APP_PORT}/api/config`);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
cleanups.push(() => browser.close());
const ctx = await browser.newContext({ permissions: ['microphone'] });
const page = await ctx.newPage();

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});

try {
  await page.goto(`http://127.0.0.1:${APP_PORT}/`, { waitUntil: 'networkidle' });
  await page.click('#boot-btn');
  await page.waitForTimeout(700);

  check('proxy mode detected', await page.locator('#stat-link').textContent(), 'server proxy');
  check('greeting spoken into the transcript',
    await page.locator('.msg--jarvis').first().textContent(),
    (t) => t.includes('Standing by'));

  await page.fill('#composer-input', 'set a tea timer');
  await page.press('#composer-input', 'Enter');

  await page.waitForSelector('.msg--tool', { timeout: 10000 }).catch(async (err) => {
    console.error('transcript at failure:\n' + await page.locator('#transcript').innerText());
    throw err;
  });
  await page.waitForFunction(
    () => [...document.querySelectorAll('.msg--jarvis')].some((n) => n.textContent.includes('ninety seconds')),
    null,
    { timeout: 10000 },
  );

  check('tool call surfaced', (await page.locator('.msg--tool').first().textContent()).trim(), '· set_timer');
  check('timer landed on the HUD',
    (await page.locator('#timers').textContent()).trim(),
    (t) => t.startsWith('tea —'));
  check('final reply rendered',
    await page.locator('.msg--jarvis').last().textContent(),
    'Tea timer running for ninety seconds.');

  const lit = await page.locator('#orb').evaluate((c) => {
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < data.length; i += 4 * 97) if (data[i] > 8) n++;
    return n;
  });
  check('orb is painting', lit, (n) => n > 50);

  await page.click('#settings-btn');
  await page.waitForTimeout(150);
  check('settings dialog opens', await page.locator('#settings').evaluate((d) => d.open), true);
  check('api key field hidden in proxy mode',
    await page.locator('#field-key').evaluate((n) => n.style.display), 'none');
  await page.click('.settings__actions .primary');

  await page.reload({ waitUntil: 'networkidle' });
  await page.click('#boot-btn');
  await page.waitForTimeout(600);
  check('conversation replays after reload', await page.locator('.msg').count(), (n) => n >= 3);

  check('no page errors', pageErrors.length, 0);
  if (pageErrors.length) console.error(pageErrors.join('\n'));
} finally {
  await browser.close();
  cleanup();
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
