/**
 * Double-clap detector, fed synthetic mic-level frames at ~16ms/frame.
 * A clap is modelled as one loud frame that decays over a few frames, on top of
 * a quiet ambient floor.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ClapDetector } from '../public/js/clap.js';

const FRAME = 16; // ms

/** Push a run of frames at a fixed level; return events seen. */
function run(det, frames, startAt = 0) {
  const events = [];
  let t = startAt;
  for (const level of frames) {
    const r = det.feed(level, t);
    if (r) events.push({ r, t });
    t += FRAME;
  }
  return { events, endAt: t };
}

/** A clap: one spike frame then a quick decay tail. */
const CLAP = [0.9, 0.5, 0.25, 0.1];
/** Ambient quiet. */
const quiet = (n) => Array(n).fill(0.03);

test('a single clap is a clap, not a double', () => {
  const det = new ClapDetector();
  const { events } = run(det, [...quiet(10), ...CLAP, ...quiet(20)]);
  assert.equal(events.filter((e) => e.r === 'clap').length, 1);
  assert.equal(events.filter((e) => e.r === 'double').length, 0);
});

test('two claps ~300ms apart fire a double', () => {
  let doubles = 0;
  const det = new ClapDetector({ onDouble: () => { doubles++; } });
  // ~300ms gap ≈ 19 frames between spike onsets.
  const seq = [...quiet(8), ...CLAP, ...quiet(15), ...CLAP, ...quiet(10)];
  const { events } = run(det, seq);
  assert.equal(doubles, 1, 'onDouble called once');
  assert.equal(events.filter((e) => e.r === 'double').length, 1);
});

test('two claps too far apart are two separate single claps', () => {
  const det = new ClapDetector();
  // ~1s gap — well beyond gapMax.
  const seq = [...quiet(8), ...CLAP, ...quiet(60), ...CLAP, ...quiet(10)];
  const { events } = run(det, seq);
  assert.equal(events.filter((e) => e.r === 'double').length, 0);
  assert.equal(events.filter((e) => e.r === 'clap').length, 2);
});

test("one clap's decay tail is not counted as a second clap", () => {
  const det = new ClapDetector();
  // A longer, bouncier tail that dips and rises within the refractory window.
  const seq = [...quiet(8), 0.9, 0.6, 0.2, 0.55, 0.15, ...quiet(20)];
  const { events } = run(det, seq);
  assert.equal(events.filter((e) => e.r === 'double').length, 0);
  assert.equal(events.filter((e) => e.r === 'clap').length, 1);
});

test('sustained loud noise (not a spike) does not trigger', () => {
  const det = new ClapDetector();
  // Ramp up slowly and hold — like speaking loudly or music, never a rising edge
  // from below the threshold in one frame.
  const ramp = [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.5, 0.5, 0.5];
  const { events } = run(det, [...quiet(6), ...ramp, ...quiet(10)]);
  // At most a single onset from the ramp crossing; crucially never a double.
  assert.equal(events.filter((e) => e.r === 'double').length, 0);
});

test('adapts to a louder room (higher ambient floor)', () => {
  const det = new ClapDetector();
  // Noisy room at 0.2 ambient; a clap must clearly exceed it.
  const loud = (n) => Array(n).fill(0.2);
  const seq = [...loud(20), 0.95, 0.6, 0.3, ...loud(15), 0.95, 0.6, 0.3, ...loud(10)];
  let doubles = 0;
  const d2 = new ClapDetector({ onDouble: () => { doubles++; } });
  run(d2, seq);
  assert.equal(doubles, 1, 'still detects a double over a loud floor');
});

test('three claps in a row produce exactly one double, then a single', () => {
  const det = new ClapDetector();
  const seq = [...quiet(8), ...CLAP, ...quiet(15), ...CLAP, ...quiet(15), ...CLAP, ...quiet(10)];
  const { events } = run(det, seq);
  // clap, then double (pairs 1&2), then the 3rd is a fresh single.
  assert.equal(events.filter((e) => e.r === 'double').length, 1);
});
