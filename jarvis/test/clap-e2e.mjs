/**
 * Proves the double-clap gesture works from real microphone audio — not just
 * the unit-tested detector. Generates a WAV with two claps, feeds it to
 * Chromium's fake audio capture, opens the built single file, and waits for the
 * app to react to the double-clap.
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeClapsWav } from './make-claps-wav.mjs';

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

const wav = path.join(os.tmpdir(), `jarvis-claps-${process.pid}.wav`);
makeClapsWav(wav);

const failures = [];
const check = (label, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures.push(label);
};

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${wav}%noloop`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const ctx = await browser.newContext({ permissions: ['microphone'] });
const page = await ctx.newPage();

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

// No key, wake word off, clap on — so only the clap can start a capture.
await page.addInitScript(() => {
  try {
    localStorage.setItem(
      'jarvis.state.v1',
      JSON.stringify({ settings: { apiKey: '', speak: false, alwaysListen: false, clapToDictate: true } }),
    );
  } catch {
    // Storage blocked.
  }
});

try {
  await page.goto(pathToFileURL(BUNDLE).href);
  await page.click('#boot-btn');

  // The WAV plays from t=0 with claps at ~0.8s and ~1.12s. The app shows a
  // "double-clap" toast when it hears the gesture.
  let detected = true;
  try {
    await page.waitForFunction(() => {
      const t = document.querySelector('#toast');
      return t && /double-clap/i.test(t.textContent) && t.classList.contains('is-up');
    }, null, { timeout: 7000 });
  } catch {
    detected = false;
  }
  check('double-clap detected from real audio', detected);
  check('no page errors', pageErrors.length === 0);
  if (pageErrors.length) console.error(pageErrors.join('\n'));
} finally {
  await browser.close();
  fs.rmSync(wav, { force: true });
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
