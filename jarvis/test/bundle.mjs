/**
 * Verifies the built single-file jarvis.html actually works off the filesystem:
 * loaded over file://, with a pasted API key, calling api.anthropic.com directly.
 * The API itself is intercepted so the test costs nothing.
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

const frames = (list) => list.map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join('');

const TOOL_TURN = frames([
  { type: 'message_start', message: { model: 'claude-opus-5' } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Noted.' } },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'toolu_1', name: 'remember', input: {} },
  },
  {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"fact": "Drinks oat milk flat whites"}' },
  },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
  { type: 'message_stop' },
]);

const FINAL_TURN = frames([
  { type: 'message_start', message: { model: 'claude-opus-5' } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Filed away.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  { type: 'message_stop' },
]);

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

// Seed a key so the app runs in direct-to-API mode, as it would off a disk.
await page.addInitScript(() => {
  try {
    localStorage.setItem(
      'jarvis.state.v1',
      JSON.stringify({ settings: { apiKey: 'sk-ant-test', speak: false } }),
    );
  } catch {
    // Storage blocked; the settings panel is the fallback path.
  }
});

const seen = [];
await page.route('**/v1/messages', async (route) => {
  const body = JSON.parse(route.request().postData() || '{}');
  seen.push({
    headers: route.request().headers(),
    hasTools: Array.isArray(body.tools) && body.tools.length > 0,
    model: body.model,
    effort: body.output_config?.effort,
  });
  const usedTool = body.messages?.some(
    (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'),
  );
  await route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: usedTool ? FINAL_TURN : TOOL_TURN,
  });
});

try {
  await page.goto(pathToFileURL(BUNDLE).href);
  await page.click('#boot-btn');
  await page.waitForTimeout(500);

  check('runs from file://', page.url().startsWith('file://'), true);
  check('falls back to direct API mode', await page.locator('#stat-link').textContent(), 'direct');

  await page.fill('#composer-input', 'I only drink oat milk flat whites');
  await page.press('#composer-input', 'Enter');
  await page.waitForFunction(
    () => [...document.querySelectorAll('.msg--jarvis')].some((n) => n.textContent.includes('Filed away')),
    null,
    { timeout: 10000 },
  );

  check('tool ran', (await page.locator('.msg--tool').first().textContent()).trim(), '· remember');
  check(
    'fact landed in the memory panel',
    (await page.locator('#facts').textContent()).trim(),
    (t) => t.includes('oat milk'),
  );
  check('memory counter updated', await page.locator('#fact-count').textContent(), '1');
  check('two API round trips', seen.length, 2);
  check('tools were declared', seen[0]?.hasTools, true);
  check('model sent', seen[0]?.model, 'claude-opus-5');
  check('effort sent', seen[0]?.effort, 'low');
  check(
    'browser-access header set',
    seen[0]?.headers['anthropic-dangerous-direct-browser-access'],
    'true',
  );
  check('api version header set', seen[0]?.headers['anthropic-version'], '2023-06-01');
  check('no page errors', pageErrors.length, 0);
  if (pageErrors.length) console.error(pageErrors.join('\n'));
} finally {
  await browser.close();
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
