/**
 * Generate a 16-bit mono WAV with two short claps ~320ms apart over a quiet
 * floor, for Chromium's --use-file-for-fake-audio-capture. Lets the clap e2e
 * test feed real audio through getUserMedia and exercise the whole path.
 *
 * Run directly to write a file, or import makeClapsWav().
 */
import fs from 'node:fs';

export function makeClapsWav(outPath, { rate = 44100, seconds = 3 } = {}) {
  const n = rate * seconds;
  const samples = new Int16Array(n);

  // A clap: a very short burst of white noise with a fast exponential decay.
  const clap = (atSec, amp = 0.9, decay = 55) => {
    const start = Math.floor(atSec * rate);
    const len = Math.floor(rate * 0.12);
    for (let i = 0; i < len && start + i < n; i++) {
      const env = Math.exp((-i / rate) * decay);
      const noise = (Math.random() * 2 - 1) * amp * env;
      samples[start + i] += Math.max(-1, Math.min(1, noise)) * 32767;
    }
  };

  // Quiet ambient hiss so the floor isn't literally zero.
  for (let i = 0; i < n; i++) samples[i] = (Math.random() * 2 - 1) * 0.01 * 32767;

  clap(0.8);
  clap(1.12); // ~320ms later — squarely inside the double-clap window

  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);        // PCM
  buf.writeUInt16LE(1, 22);        // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);        // block align
  buf.writeUInt16LE(16, 34);       // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 44 + i * 2);

  fs.writeFileSync(outPath, buf);
  return outPath;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2] || 'claps.wav';
  makeClapsWav(out);
  console.log(`wrote ${out}`);
}
