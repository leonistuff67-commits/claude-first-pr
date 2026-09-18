/**
 * The memory brain in a real browser: opens from the Memory panel, renders a
 * neuron per memory, reports stats, reads out a memory on hover, filters on
 * search, and closes with Escape.
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

const MEMORIES = [
  'Drinks espresso every morning, never drip coffee',
  'Buys espresso beans from the market on Saturdays',
  'Takes the 8am train into the city',
  'Ships releases on Fridays',
  'Working on a Rust parser called driftwood',
  'Runs a marathon in April',
];

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1280, height: 820 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});

await page.addInitScript((texts) => {
  try {
    const facts = texts.map((t, i) => ({ id: `f${i}`, text: t, at: Date.now() - i * 86400000 }));
    localStorage.setItem(
      'jarvis.state.v1',
      JSON.stringify({ settings: { apiKey: '', speak: false, clapToDictate: false }, facts, tasks: [] }),
    );
  } catch {
    // Storage blocked.
  }
}, MEMORIES);

try {
  await page.goto(pathToFileURL(BUNDLE).href);
  await page.click('#boot-btn');
  await page.waitForTimeout(350);

  check('memory panel counts the facts', await page.locator('#fact-count').textContent(), String(MEMORIES.length));

  await page.click('#brain-btn');
  await page.waitForTimeout(400);
  check('brain opens', await page.locator('#mind').isVisible(), true);

  const stats = (await page.locator('#mind-stats').innerText()).replace(/\s+/g, ' ');
  check('one neuron per memory', stats, (t) => t.startsWith(`${MEMORIES.length} MEMORIES`));
  check('synapses were wired', stats, (t) => /(\d+) CONNECTIONS/.test(t) && Number(t.match(/(\d+) CONNECTIONS/)[1]) > 0);

  // Let the layout settle, then sweep for a neuron and read it out.
  await page.waitForTimeout(2500);
  const box = await page.locator('#mind-canvas').boundingBox();
  let hovered = false;
  for (let gx = 0; gx < 10 && !hovered; gx++) {
    for (let gy = 0; gy < 7 && !hovered; gy++) {
      await page.mouse.move(box.x + box.width * (0.15 + gx * 0.075), box.y + box.height * (0.2 + gy * 0.085));
      await page.waitForTimeout(70);
      hovered = await page.evaluate(() => document.getElementById('mind-detail').classList.contains('is-live'));
    }
  }
  check('hovering a neuron reads out its memory', hovered, true);
  if (hovered) {
    const detail = await page.locator('#mind-detail').innerText();
    check('the readout is one of the stored memories', detail, (t) => MEMORIES.some((m) => t.includes(m)));
    check('the readout shows when it was stored', detail, (t) => /STORED/i.test(t));
  }

  // Search narrows the brain without destroying it.
  await page.fill('#mind-search', 'espresso');
  await page.waitForTimeout(300);
  check('search keeps the graph intact', (await page.locator('#mind-stats').innerText()).replace(/\s+/g, ' '),
    (t) => t.startsWith(`${MEMORIES.length} MEMORIES`));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  check('escape closes the brain', await page.locator('#mind').isVisible(), false);

  // The "B" shortcut reopens it.
  await page.keyboard.press('b');
  await page.waitForTimeout(250);
  check('B reopens the brain', await page.locator('#mind').isVisible(), true);

  check('no page errors', pageErrors.length, 0);
  if (pageErrors.length) console.error(pageErrors.join('\n'));
} finally {
  await browser.close();
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
