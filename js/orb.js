/**
 * The orb: a canvas visualizer that reacts to whatever JARVIS is doing.
 *
 * Structure, back to front — outer glow, three tilted rings, an orbiting
 * particle belt, and a wobbling core whose silhouette is driven by the live
 * audio level.
 */
const STATES = {
  idle:      { hueShift: 0,   spin: 0.10, wobble: 0.035, ringAlpha: 0.30, pulse: 0.35 },
  listening: { hueShift: -8,  spin: 0.28, wobble: 0.090, ringAlpha: 0.65, pulse: 0.90 },
  thinking:  { hueShift: -46, spin: 0.95, wobble: 0.060, ringAlpha: 0.85, pulse: 0.55 },
  speaking:  { hueShift: 34,  spin: 0.40, wobble: 0.120, ringAlpha: 0.75, pulse: 1.00 },
  error:     { hueShift: 150, spin: 0.05, wobble: 0.020, ringAlpha: 0.40, pulse: 0.20 },
};

/** Harmonics for the core silhouette: [angular frequency, speed, weight]. */
const HARMONICS = [
  [2, 0.7, 1.0],
  [3, -1.1, 0.6],
  [5, 0.45, 0.35],
  [7, -0.8, 0.22],
];

function hexToHsl(hex) {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s * 100, l * 100];
}

export class Orb {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.state = 'idle';
    this.level = 0;
    this.smoothLevel = 0;
    this.accent = '#34e7e4';
    this.hsl = hexToHsl(this.accent);
    this.t = 0;
    this.spinPhase = 0;
    this.blend = { ...STATES.idle };
    this.particles = Array.from({ length: 64 }, (_, i) => ({
      angle: (i / 64) * Math.PI * 2,
      radius: 0.78 + Math.random() * 0.5,
      speed: 0.12 + Math.random() * 0.4,
      size: 0.6 + Math.random() * 1.8,
    }));
    this.getLevel = () => 0;
    // When the local model is running it needs the GPU far more than we do.
    this.quiet = false;
    this.frame = 0;

    this.#resize();
    window.addEventListener('resize', () => this.#resize());
  }

  setAccent(hex) {
    this.accent = hex;
    this.hsl = hexToHsl(hex);
  }

  /** Drop to a trickle of frames so a local model can have the GPU. */
  setQuiet(quiet) {
    this.quiet = Boolean(quiet);
  }

  setState(state) {
    if (STATES[state]) this.state = state;
  }

  /** Supply a function returning the live 0..1 audio level. */
  bindLevel(fn) {
    this.getLevel = fn;
  }

  start() {
    const loop = () => {
      this.frame++;
      // In quiet mode render one frame in six — enough to stay alive, cheap
      // enough to leave the GPU to the model.
      if (!this.quiet || this.frame % 6 === 0) this.#frame();
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
    // The outermost ring sits at 2.05x the core radius, so leave room for it
    // and cap the size — a wall-filling orb reads as a background, not a face.
    const fit = Math.min(rect.width, rect.height) / 5.2;
    this.base = Math.max(50, Math.min(fit, 122));
  }

  #frame() {
    const target = STATES[this.state] || STATES.idle;
    // Ease between states so mode changes feel like a machine spinning up.
    for (const key of Object.keys(target)) {
      this.blend[key] += (target[key] - this.blend[key]) * 0.07;
    }

    const raw = this.getLevel();
    this.smoothLevel += (raw - this.smoothLevel) * (raw > this.smoothLevel ? 0.35 : 0.08);
    this.t += 0.016;
    this.spinPhase += this.blend.spin * 0.016;

    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.save();
    ctx.translate(this.w / 2, this.h / 2);
    ctx.globalCompositeOperation = 'lighter';

    const [h, s, l] = this.hsl;
    const hue = (h + this.blend.hueShift + 360) % 360;
    const breathe = 1 + Math.sin(this.t * 1.4) * 0.03 * this.blend.pulse;
    const energy = this.smoothLevel * this.blend.pulse;
    const R = this.base * breathe * (1 + energy * 0.22);

    this.#glow(hue, s, R, energy);
    this.#rings(hue, s, l, R);
    this.#particles(hue, s, R, energy);
    this.#core(hue, s, l, R, energy);

    ctx.restore();
  }

  #glow(hue, s, R, energy) {
    const ctx = this.ctx;
    // Keep the falloff inside the canvas — a clipped gradient shows up as a
    // hard-edged rectangle sitting behind the orb.
    const outer = Math.min(R * (3.1 + energy), Math.min(this.w, this.h) * 0.5);
    const g = ctx.createRadialGradient(0, 0, R * 0.2, 0, 0, outer);
    g.addColorStop(0, `hsla(${hue}, ${s}%, 62%, ${0.30 + energy * 0.25})`);
    g.addColorStop(0.35, `hsla(${hue}, ${s}%, 52%, 0.10)`);
    g.addColorStop(1, `hsla(${hue}, ${s}%, 50%, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, outer, 0, Math.PI * 2);
    ctx.fill();
  }

  #rings(hue, s, l, R) {
    const ctx = this.ctx;
    const configs = [
      { r: 1.42, tilt: 0.42, dir: 1, dash: [26, 12], width: 1.5 },
      { r: 1.72, tilt: -0.68, dir: -1, dash: [8, 16], width: 1.0 },
      { r: 1.98, tilt: 1.15, dir: 1, dash: [70, 46], width: 2.0 },
    ];
    for (const cfg of configs) {
      ctx.save();
      ctx.rotate(cfg.tilt + this.spinPhase * cfg.dir);
      ctx.strokeStyle = `hsla(${hue}, ${s}%, ${Math.min(78, l + 18)}%, ${this.blend.ringAlpha})`;
      ctx.lineWidth = cfg.width;
      ctx.setLineDash(cfg.dash);
      ctx.shadowBlur = 18;
      ctx.shadowColor = `hsla(${hue}, ${s}%, 60%, 0.8)`;
      ctx.beginPath();
      ctx.ellipse(0, 0, R * cfg.r, R * cfg.r * 0.32, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;
  }

  #particles(hue, s, R, energy) {
    const ctx = this.ctx;
    for (const p of this.particles) {
      p.angle += p.speed * 0.006 * (1 + energy * 2.5);
      const wobble = Math.sin(this.t * p.speed * 3 + p.angle * 4) * 0.06;
      const r = R * (p.radius + wobble + energy * 0.25);
      const x = Math.cos(p.angle) * r;
      const y = Math.sin(p.angle) * r * 0.55;
      const alpha = 0.18 + energy * 0.5;
      ctx.fillStyle = `hsla(${hue}, ${s}%, 78%, ${alpha})`;
      ctx.beginPath();
      ctx.arc(x, y, p.size * (1 + energy), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  #core(hue, s, l, R, energy) {
    const ctx = this.ctx;
    const amp = this.blend.wobble + energy * 0.16;
    const steps = 150;

    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const theta = (i / steps) * Math.PI * 2;
      let offset = 0;
      for (const [k, speed, weight] of HARMONICS) {
        offset += Math.sin(k * theta + this.t * speed * 2) * weight;
      }
      const r = R * (1 + amp * offset);
      const x = Math.cos(theta) * r;
      const y = Math.sin(theta) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();

    const fill = ctx.createRadialGradient(0, -R * 0.3, R * 0.05, 0, 0, R * 1.2);
    fill.addColorStop(0, `hsla(${hue}, ${Math.min(100, s + 10)}%, ${Math.min(92, l + 32)}%, 0.95)`);
    fill.addColorStop(0.55, `hsla(${hue}, ${s}%, ${l}%, 0.55)`);
    fill.addColorStop(1, `hsla(${(hue + 30) % 360}, ${s}%, ${Math.max(18, l - 22)}%, 0.15)`);
    ctx.fillStyle = fill;
    ctx.fill();

    // A soft rim rather than a hard outline, so the core reads as a sphere.
    ctx.strokeStyle = `hsla(${hue}, ${s}%, 90%, ${0.16 + energy * 0.35})`;
    ctx.lineWidth = 1;
    ctx.shadowBlur = 24;
    ctx.shadowColor = `hsla(${hue}, ${s}%, 70%, 0.55)`;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // A tight inner highlight so the core reads as a sphere, not a disc.
    ctx.beginPath();
    ctx.arc(-R * 0.26, -R * 0.3, R * 0.22, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${hue}, 60%, 96%, ${0.07 + energy * 0.14})`;
    ctx.fill();
  }
}
