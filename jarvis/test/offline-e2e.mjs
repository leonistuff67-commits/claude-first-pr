/**
 * The single file with NO API key: it must run entirely on the local brain and
 * never touch the network. Opens jarvis.html off disk, fails the run if any
 * request goes to the API, and drives a couple of tool commands through the
 * offline interpreter.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BUNDLE = path.join(ROOT, 'jarvis.html');

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
const check = (label, actual, expected) => {
  const ok = typeof expected === 'function' ? expected(actual) : actual === expected;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} -> ${actual}`);
  if (!ok) failures.push(label);
};

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const ctx = await browser.newContext({ permissions: ['microphone'] });
const page = await ctx.newPage();

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});

// Any call to the Anthropic API in offline mode is a bug — record it.
const apiCalls = [];
await page.route('**/v1/messages', async (route) => {
  apiCalls.push(route.request().url());
  await route.abort();
});

try {
  await page.goto(pathToFileURL(BUNDLE).href);
  await page.click('#boot-btn');
  await page.waitForTimeout(500);

  check('reports offline on the HUD', await page.locator('#stat-link').textContent(), 'no key');
  check('model readout says offline', await page.locator('#stat-model').textContent(), (t) => t.includes('offline'));

  // A timer, handled entirely locally.
  await page.fill('#composer-input', 'set a timer for 2 minutes for tea');
  await page.press('#composer-input', 'Enter');
  await page.waitForFunction(
    () => document.querySelector('#timers').textContent.includes('tea'),
    null,
    { timeout: 8000 },
  );
  check('timer set without a key', (await page.locator('#timers').textContent()).trim(), (t) => t.startsWith('tea —'));
  check('a tool ran offline', (await page.locator('.msg--tool').first().textContent()).trim(), '· set_timer');

  // Wait for the turn to fully finish before the next command, so it isn't
  // dropped while the app is still busy.
  await page.waitForFunction(() => document.body.dataset.busy === '0', null, { timeout: 8000 });

  // A memory command, also local.
  await page.fill('#composer-input', 'remember I take the 8am train');
  await page.press('#composer-input', 'Enter');
  await page.waitForFunction(
    () => document.querySelector('#facts').textContent.includes('8am train'),
    null,
    { timeout: 8000 },
  );
  check('fact stored offline', (await page.locator('#facts').textContent()), (t) => t.includes('8am train'));

  check('the API was never called', apiCalls.length, 0);
  check('no page errors', pageErrors.length, 0);
  if (pageErrors.length) console.error(pageErrors.join('\n'));
} finally {
  await browser.close();
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
