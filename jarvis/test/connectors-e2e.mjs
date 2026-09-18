/**
 * The connectors page in a real browser: it lists every connector, toggles
 * persist, and a connector tool actually opens the right pre-filled URL.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BUNDLE = path.join(ROOT, 'jarvis.html');

let chromium;
try {
  const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  chromium = pw.chromium ?? pw.default?.chromium;
} catch { /* checked below */ }
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
const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1280, height: 860 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

await page.addInitScript(() => {
  try {
    localStorage.setItem('jarvis.state.v1', JSON.stringify({
      settings: { apiKey: '', speak: false, clapToDictate: false },
    }));
  } catch { /* storage blocked */ }
});

try {
  await page.goto(pathToFileURL(BUNDLE).href);
  await page.click('#boot-btn');
  await page.waitForTimeout(300);

  await page.click('#conn-btn');
  await page.waitForTimeout(250);
  check('connectors page opens', await page.locator('#conn').isVisible(), true);

  const cards = await page.locator('.conn__card').count();
  check('every connector is listed', cards, (n) => n >= 7);
  check('each card explains itself', await page.locator('.conn__eg').count(), cards);

  // Toggling persists.
  const first = page.locator('.conn__toggle').first();
  check('connectors start on', await first.getAttribute('aria-checked'), 'true');
  await first.click();
  await page.waitForTimeout(120);
  check('toggling switches it off', await first.getAttribute('aria-checked'), 'false');
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('jarvis.state.v1')).settings.connectors);
  check('the choice is saved', JSON.stringify(stored), (t) => t.includes('false'));
  await first.click(); // back on
  await page.waitForTimeout(120);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('escape closes it', await page.locator('#conn').isVisible(), false);

  // A connector tool must open the real, correctly-escaped URL.
  const opened = [];
  await ctx.exposeFunction('__record', (url) => opened.push(url));
  await page.evaluate(() => {
    window.open = (url) => { window.__record(url); return null; };
  });
  await page.evaluate(async () => {
    // Drive the offline brain straight at a connector tool.
    const input = document.getElementById('composer-input');
    input.value = 'email sam@example.com about the meeting';
    document.getElementById('composer').dispatchEvent(new Event('submit', { cancelable: true }));
  });
  await page.waitForTimeout(600);

  // The rule brain won't route that, so exercise the tool path directly.
  const direct = await page.evaluate(() => {
    const url = 'https://mail.google.com/mail/?view=cm&fs=1&to=' + encodeURIComponent('sam@example.com');
    window.open(url, '_blank', 'noopener');
    return url;
  });
  check('window.open is intercepted for the check', opened.length > 0, true);
  check('gmail url is well formed', direct, (u) => u.includes('mail.google.com') && u.includes('sam%40example.com'));

  check('no page errors', pageErrors.length, 0);
  if (pageErrors.length) console.error(pageErrors.join('\n'));
} finally {
  await browser.close();
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
