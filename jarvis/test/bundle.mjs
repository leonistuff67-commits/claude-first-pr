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

const SERIOUS_TURN = frames([
  { type: 'message_start', message: { model: 'claude-opus-5' } },
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: 'toolu_s', name: 'set_serious_mode', input: {} },
  },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"on": true}' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
  { type: 'message_stop' },
]);

const DONE_TURN = frames([
  { type: 'message_start', message: { model: 'claude-fable-5-1' } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Full power.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  { type: 'message_stop' },
]);

/** Was the most recent user turn a plain string containing `needle`? */
function lastUserSaid(body, needle) {
  const msgs = body.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user' && typeof msgs[i].content === 'string') {
      return msgs[i].content.toLowerCase().includes(needle);
    }
  }
  return false;
}

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
  // A continuation is when the LAST message is tool_results — not merely any
  // message in the (retained) history, which would misfire on the next turn.
  const last = body.messages?.[body.messages.length - 1];
  const usedTool = Array.isArray(last?.content) && last.content.some((b) => b.type === 'tool_result');

  // Continuation is decided first, otherwise the original prompt text still
  // matches and the turn loops forever.
  let out;
  if (usedTool) out = body.model === 'claude-fable-5-1' ? DONE_TURN : FINAL_TURN;
  else if (lastUserSaid(body, 'serious')) out = SERIOUS_TURN;
  else out = TOOL_TURN;

  await route.fulfill({ status: 200, contentType: 'text/event-stream', body: out });
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

  // --- model + effort pickers ---
  await page.click('#settings-btn');
  await page.waitForTimeout(150);
  check('model picker lists every model', await page.locator('#set-model option').count(), 4);
  check(
    'effort picker offers the full range',
    await page.locator('#set-effort option').count(),
    (n) => n === 5,
  );

  // Haiku has no effort knob — the picker should disable itself.
  await page.selectOption('#set-model', 'claude-haiku-4-5');
  check('effort disabled for Haiku', await page.locator('#set-effort').evaluate((s) => s.disabled), true);
  await page.selectOption('#set-model', 'claude-opus-5');
  check('effort re-enabled for Opus', await page.locator('#set-effort').evaluate((s) => s.disabled), false);
  await page.click('.settings__actions .primary');

  // --- serious mode via a tool call ---
  const before = seen.length;
  await page.fill('#composer-input', 'jarvis activate serious mode');
  await page.press('#composer-input', 'Enter');
  await page.waitForFunction(
    () => [...document.querySelectorAll('.msg--jarvis')].some((n) => n.textContent.includes('Full power')),
    null,
    { timeout: 10000 },
  );

  check('serious mode styles the page', await page.locator('body').evaluate((b) => b.classList.contains('is-serious')), true);
  const escalated = seen[seen.length - 1];
  check('escalated to the strongest model', escalated?.model, 'claude-fable-5-1');
  check('escalated to max effort', escalated?.effort, 'max');
  check('serious mode reads out on the HUD', (await page.locator('#stat-model').textContent()), (t) => t.includes('max'));
  check('server-side fallback header sent for Fable', escalated?.headers['anthropic-beta'], (h) => Boolean(h && h.includes('server-side-fallback')));
  check('serious mode used follow-up turns', seen.length > before, true);

  check('no page errors', pageErrors.length, 0);
  if (pageErrors.length) console.error(pageErrors.join('\n'));
} finally {
  await browser.close();
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
