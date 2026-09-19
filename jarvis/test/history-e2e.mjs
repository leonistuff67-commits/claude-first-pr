/**
 * Regression for the 400 that wedged a conversation for good:
 *
 *   messages.38: `tool_use` ids were found without `tool_result` blocks
 *   immediately after
 *
 * A reply that runs out of tokens part-way through a tool call still carries
 * the tool_use block. The turn loop used to look at the stop reason rather than
 * at the blocks, so it saved that call with nothing answering it — and since
 * the transcript is persisted, every later request was rejected the same way.
 *
 * This drives both halves: a transcript already poisoned in localStorage must
 * heal itself on boot, and a truncated tool call must never be saved unanswered.
 */
import net from 'node:net';
import http from 'node:http';
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

const cleanups = [];
const cleanup = () => {
  while (cleanups.length) {
    try {
      cleanups.pop()();
    } catch {
      // Best effort.
    }
  }
};
process.on('exit', cleanup);

const failures = [];
const check = (label, actual, expected) => {
  const ok = typeof expected === 'function' ? expected(actual) : actual === expected;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} -> ${actual}`);
  if (!ok) failures.push(label);
};

/** Every tool_use must be answered by the very next message — the API's rule. */
function unpairedToolUse(messages = []) {
  for (let i = 0; i < messages.length; i++) {
    const blocks = Array.isArray(messages[i].content) ? messages[i].content : [];
    const ids = blocks.filter((b) => b.type === 'tool_use').map((b) => b.id);
    if (!ids.length) continue;
    const next = messages[i + 1];
    const answered = new Set(
      (Array.isArray(next?.content) ? next.content : [])
        .filter((b) => b.type === 'tool_result')
        .map((b) => b.tool_use_id),
    );
    const missing = ids.filter((id) => !answered.has(id));
    if (missing.length) return `messages.${i}: ${missing.join(',')}`;
  }
  return null;
}

/**
 * A mock that answers the first request with a tool call cut short by the token
 * ceiling, and everything after with plain text. It records each payload and
 * rejects one the real API would reject, so a regression fails here too.
 */
const seen = [];
const rejected = [];
const mock = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const payload = JSON.parse(body || '{}');
  seen.push(payload);

  const bad = unpairedToolUse(payload.messages);
  if (bad) {
    rejected.push(bad);
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: { message: `${bad}: \`tool_use\` ids were found without \`tool_result\` blocks immediately after.` },
    }));
    return;
  }

  const sse = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  sse({ type: 'message_start', message: { model: payload.model } });

  // Only the *last* message matters: an older tool_result further back just
  // means the conversation has history, not that a tool just ran.
  const last = payload.messages?.[payload.messages.length - 1];
  const sawToolResult =
    Array.isArray(last?.content) && last.content.some((b) => b.type === 'tool_result');

  if (seen.length === 1) {
    // A tool call the model never finished describing: the stop reason is
    // max_tokens, not tool_use, but the block is there all the same.
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Opening Gmail' } });
    sse({ type: 'content_block_stop', index: 0 });
    sse({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_truncated', name: 'open_app', input: {} },
    });
    sse({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"app": "gm' },
    });
    sse({ type: 'content_block_stop', index: 1 });
    sse({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } });
  } else {
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    sse({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: sawToolResult ? 'Gmail is open.' : 'All good here.' },
    });
    sse({ type: 'content_block_stop', index: 0 });
    sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
  }

  sse({ type: 'message_stop' });
  res.end();
});

const mockPort = await new Promise((resolve) => {
  mock.listen(0, '127.0.0.1', () => resolve(mock.address().port));
});
cleanups.push(() => mock.close());

const APP_PORT = await freePort();
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

for (let i = 0; i < 50; i++) {
  try {
    await fetch(`http://127.0.0.1:${APP_PORT}/api/config`);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
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
  // Seed the exact broken state a previous build would have left behind: a
  // saved transcript whose last message is a tool call nothing answered.
  await page.goto(`http://127.0.0.1:${APP_PORT}/`, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    localStorage.setItem('jarvis.state.v1', JSON.stringify({
      history: [
        { role: 'user', content: 'open gmail' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Opening Gmail' },
            { type: 'tool_use', id: 'toolu_stranded', name: 'open_app', input: {} },
          ],
        },
      ],
    }));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.click('#boot-btn');
  await page.waitForTimeout(700);

  const healed = await page.evaluate(
    () => JSON.parse(localStorage.getItem('jarvis.state.v1')).history,
  );
  check('the stranded call is gone from storage', unpairedToolUse(healed), null);

  // First turn: the model's tool call is cut off by the token ceiling.
  await page.fill('#composer-input', 'open gmail');
  await page.press('#composer-input', 'Enter');
  await page.waitForFunction(() => document.body.dataset.busy === '0', null, { timeout: 15000 });

  const saved = await page.evaluate(
    () => JSON.parse(localStorage.getItem('jarvis.state.v1')).history,
  );
  check('a truncated tool call is never saved unanswered', unpairedToolUse(saved), null);

  // Second turn: this is the one that used to come back as a 400 forever.
  await page.fill('#composer-input', 'are you still there');
  await page.press('#composer-input', 'Enter');
  await page.waitForFunction(
    () => [...document.querySelectorAll('.msg--jarvis')].some((n) => n.textContent.includes('All good here')),
    null,
    { timeout: 15000 },
  );

  check('the next turn still works', true, true);
  check('the API never saw an unanswered tool call', rejected.join(' | '), '');
  check('no 400 surfaced in the transcript',
    await page.locator('#transcript').innerText(),
    (t) => !t.includes('tool_result'));
  check('no page errors', pageErrors.length, 0);
  if (pageErrors.length) console.error(pageErrors.join('\n'));
} finally {
  cleanup();
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
