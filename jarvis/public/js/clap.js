/**
 * Double-clap detector — a pure state machine, no DOM or audio APIs, so it can
 * be unit-tested with synthetic samples.
 *
 * You feed it the microphone's instantaneous peak level (0..1) on every frame
 * via `feed(level, now)`. It tracks a slow ambient floor, spots a clap as a
 * sharp onset that rises well above that floor, and fires `onDouble` when two
 * onsets land within a human double-clap window (but far enough apart not to be
 * one clap's own echo).
 *
 * The earlier version failed because its noise floor rose *fast* — a clap
 * immediately dragged the floor up toward itself, erasing the very margin the
 * test depended on. Here the floor only tracks quiet frames.
 */
export class ClapDetector {
  constructor(options = {}) {
    this.onClap = options.onClap || (() => {});
    this.onDouble = options.onDouble || (() => {});

    // Tunables (overridable for tests).
    this.minPeak = options.minPeak ?? 0.32;       // absolute floor a clap must clear
    this.margin = options.margin ?? 0.18;         // and how far above the ambient floor
    this.riseRatio = options.riseRatio ?? 2.2;    // spike must be this many× the floor
    this.refractoryMs = options.refractoryMs ?? 180; // ignore this long after an onset
    this.gapMinMs = options.gapMinMs ?? 120;      // closer than this = one clap ringing
    this.gapMaxMs = options.gapMaxMs ?? 650;      // farther than this = two separate claps
    this.floorAttack = options.floorAttack ?? 0.05; // how fast the ambient floor tracks quiet

    this.reset();
  }

  reset() {
    this.floor = 0.05;
    this.prevLevel = 0;
    this.lastOnsetAt = -Infinity;
    this.lastClapAt = -Infinity;
    this.armed = true;
  }

  /**
   * @param {number} level  instantaneous peak amplitude, 0..1
   * @param {number} now    timestamp in ms (monotonic)
   * @returns {'double'|'clap'|null} what, if anything, this frame triggered
   */
  feed(level, now) {
    const threshold = Math.max(this.minPeak, this.floor * this.riseRatio, this.floor + this.margin);

    // A clap is a rising edge: this frame is loud, the previous one wasn't.
    const isOnset =
      this.armed &&
      level >= threshold &&
      this.prevLevel < threshold &&
      now - this.lastOnsetAt > this.refractoryMs;

    let result = null;

    if (isOnset) {
      this.lastOnsetAt = now;
      this.armed = false; // re-armed once the level falls back down (below)

      const gap = now - this.lastClapAt;
      if (gap > this.gapMinMs && gap < this.gapMaxMs) {
        this.lastClapAt = -Infinity; // consume the pair
        result = 'double';
        this.onDouble();
      } else {
        this.lastClapAt = now;
        result = 'clap';
        this.onClap();
      }
    } else if (level < threshold * 0.6) {
      // Level has fallen well below threshold — ready for the next onset.
      this.armed = true;
    }

    // Update the ambient floor only from quiet frames, so a clap never inflates it.
    if (level < threshold) {
      this.floor += (level - this.floor) * this.floorAttack;
    }

    this.prevLevel = level;
    return result;
  }
}
