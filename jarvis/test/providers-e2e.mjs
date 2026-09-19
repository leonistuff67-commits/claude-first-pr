/**
 * The provider picker in a real browser: every provider listed, per-provider
 * keys kept separate, and provider-specific rows shown or hidden correctly.
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
const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1280, height: 960 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

await page.addInitScript(() => {
  try {
    localStorage.setItem('jarvis.state.v1', JSON.stringify({
      settings: { speak: false, clapToDictate: false, alwaysListen: false },
    }));
  } catch { /* storage blocked */ }
});

const boot = async () => {
  await page.click('#boot-btn');
  await page.waitForFunction(() => document.getElementById('boot').classList.contains('is-gone'), null, { timeout: 5000 });
  await page.waitForTimeout(700);
};

try {
  await page.goto(pathToFileURL(BUNDLE).href);
  await boot();
  await page.click('#settings-btn');
  await page.waitForTimeout(250);

  await page.selectOption('#set-brain', 'api');
  await page.waitForTimeout(200);
  check('several providers are offered', await page.locator('#set-provider option').count(), (n) => n >= 8);
  check('provider row appears for cloud AI', await page.locator('#field-provider').isVisible(), true);
  check('Claude is the default', await page.locator('#set-provider').inputValue(), 'anthropic');
  check('effort applies to Claude', await page.locator('#field-effort').isVisible(), true);

  await page.selectOption('#set-provider', 'openai');
  await page.waitForTimeout(250);
  const models = await page.locator('#set-model option').allTextContents();
  check('models follow the provider', models.join(','), (t) => t.includes('gpt'));
  check('effort is hidden for non-Claude', await page.locator('#field-effort').isVisible(), false);

  // Keys must not bleed between providers.
  await page.fill('#set-key', 'sk-openai-test');
  await page.dispatchEvent('#set-key', 'change');
  await page.waitForTimeout(150);
  await page.selectOption('#set-provider', 'groq');
  await page.waitForTimeout(250);
  check('another provider starts with no key', await page.locator('#set-key').inputValue(), '');
  await page.selectOption('#set-provider', 'openai');
  await page.waitForTimeout(250);
  check('each provider remembers its own key', await page.locator('#set-key').inputValue(), 'sk-openai-test');

  await page.selectOption('#set-provider', 'ollama');
  await page.waitForTimeout(250);
  check('a keyless provider hides the key box', await page.locator('#field-key').isVisible(), false);

  await page.click('.settings__actions .primary');
  await page.waitForTimeout(200);
  check('the HUD names the provider', await page.locator('#stat-link').textContent(), (t) => t.length > 0 && t !== '—');

  check('no page errors', pageErrors.length, 0);
  if (pageErrors.length) console.error(pageErrors.join('\n'));
} finally {
  await browser.close();
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
