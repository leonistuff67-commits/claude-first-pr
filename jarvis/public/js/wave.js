/**
 * Voice-chat-style spectrum bars. A symmetric row of bars driven by the live
 * microphone spectrum (or JARVIS's speech envelope while it talks) — the raw
 * audio made visible, the way a game's voice-chat UI shows you're transmitting.
 */
export class Wave {
  constructor(canvas, { bars = 48 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.count = bars;
    this.data = new Uint8Array(bars);
    this.smooth = new Float32Array(bars);
    this.accent = '#34e7e4';
    this.rgb = [52, 231, 228];
    this.gain = 0;          // 0..1 overall visibility, eased toward target
    this.target = 0;
    this.getSpectrum = () => this.data;
    this.#resize();
    window.addEventListener('resize', () => this.#resize());
  }

  setAccent(hex) {
    this.accent = hex;
    this.rgb = Wave.#hexToRgb(hex);
  }

  static #hexToRgb(hex) {
    const c = hex.replace('#', '');
    const full = c.length === 3 ? c.split('').map((x) => x + x).join('') : c;
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
    ];
  }

  bind(fn) {
    this.getSpectrum = fn;
  }

  /** Fade the whole strip in (active) or down to a faint idle shimmer. */
  setActive(active) {
    this.target = active ? 1 : 0.12;
  }

  start() {
    const loop = () => {
      this.#frame();
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  stop() {
    cancelAnimationFrame(this.raf);
  }

  #resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = rect.width;
    this.h = rect.height;
  }

  #frame() {
    this.gain += (this.target - this.gain) * 0.08;
    this.getSpectrum(this.data);

    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);

    const n = this.count;
    const mid = this.h / 2;
    const gap = 2;
    const bw = Math.max(1.5, this.w / n - gap);

    for (let i = 0; i < n; i++) {
      const v = this.data[i] / 255;
      // Ease each bar so it falls smoothly rather than flickering.
      this.smooth[i] += (v - this.smooth[i]) * (v > this.smooth[i] ? 0.5 : 0.12);
      const idle = 0.04 + 0.03 * Math.sin(Date.now() * 0.004 + i * 0.5);
      const amp = Math.max(idle, this.smooth[i]) * this.gain;
      const bh = Math.max(2, amp * (this.h - 4));
      const x = i * (bw + gap);
      const y = mid - bh / 2;

      const alpha = 0.22 + amp * 0.78;
      const [r, g, b] = this.rgb;
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
      ctx.shadowBlur = amp * 12;
      ctx.shadowColor = `rgba(${r}, ${g}, ${b}, ${amp * 0.7})`;
      this.#bar(ctx, x, y, bw, bh);
    }
  }

  #bar(ctx, x, y, w, h) {
    const r = Math.min(w / 2, 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fill();
  }
}
