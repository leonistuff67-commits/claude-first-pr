/**
 * The memory brain.
 *
 * Every stored fact becomes a neuron. Facts that share meaningful words are
 * wired together with synapses, and signals pulse along those synapses, so the
 * whole thing reads as a living brain rather than a list. Hover a neuron to
 * read the memory it holds.
 *
 * `buildGraph` is pure so the wiring logic can be unit-tested; `MindView`
 * handles physics, rendering and pointer interaction.
 */

/** Words too common to imply a connection between two memories. */
const STOPWORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'they', 'them', 'their', 'have',
  'has', 'had', 'was', 'were', 'been', 'being', 'for', 'not', 'but', 'you',
  'your', 'yours', 'she', 'her', 'his', 'him', 'its', 'our', 'ours', 'are',
  'who', 'what', 'when', 'where', 'which', 'how', 'why', 'all', 'any', 'can',
  'will', 'would', 'should', 'could', 'into', 'over', 'than', 'then', 'there',
  'here', 'more', 'most', 'some', 'such', 'only', 'very', 'just', 'like',
  'likes', 'prefer', 'prefers', 'user', 'about', 'also', 'does', 'did', 'get',
  'gets', 'got', 'one', 'two', 'out', 'off', 'own', 'per', 'via',
]);

/**
 * Crude stemmer so "meeting"/"meetings" and "coffee"/"coffees" link up.
 * Plural first, then verb ending — "meetings" -> "meeting" -> "meet".
 */
function stem(word) {
  let s = word;
  if (s.endsWith('ies') && s.length > 4) s = `${s.slice(0, -3)}y`;
  else if (/(ss|sh|ch|x|z)es$/.test(s)) s = s.slice(0, -2);
  else if (s.endsWith('s') && !s.endsWith('ss') && s.length > 3) s = s.slice(0, -1);

  if (s.endsWith('ing') && s.length > 5) s = s.slice(0, -3);
  else if (s.endsWith('ed') && s.length > 4) s = s.slice(0, -2);
  return s;
}

/** Meaningful lowercase word stems from a memory. */
export function keywords(text) {
  const words = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const out = new Set();
  for (const w of words) {
    const clean = w.replace(/^['-]+|['-]+$/g, '');
    if (clean.length < 4 || STOPWORDS.has(clean)) continue;
    out.add(stem(clean));
  }
  return out;
}

/**
 * Wire facts into a graph.
 *
 * Two kinds of synapse: a bright one where memories share a meaningful word,
 * and a faint temporal thread between memories stored next to each other in
 * time. The temporal backbone keeps the brain one connected organism — nothing
 * floats alone — and gives it the density that makes it read as a brain.
 *
 * @param {Array<{id: string, text: string, at: number}>} facts
 * @returns {{nodes: Array, edges: Array}}
 */
export function buildGraph(facts) {
  const nodes = facts.map((f, i) => ({
    id: f.id,
    text: f.text,
    at: f.at,
    index: i,
    words: keywords(f.text),
    degree: 0,
  }));

  const edges = [];
  const pairs = new Set();
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      let shared = 0;
      for (const w of nodes[i].words) if (nodes[j].words.has(w)) shared++;
      if (!shared) continue;
      edges.push({ a: i, b: j, weight: shared });
      pairs.add(`${i}-${j}`);
      nodes[i].degree++;
      nodes[j].degree++;
    }
  }

  // A temporal backbone: things you mentioned around the same time are
  // associated too. This also guarantees nothing floats alone, and gives the
  // graph the density that makes it read as a brain rather than a constellation.
  const byTime = nodes.map((n) => n.index).sort((x, y) => nodes[x].at - nodes[y].at);
  for (let k = 0; k + 1 < byTime.length; k++) {
    const a = Math.min(byTime[k], byTime[k + 1]);
    const b = Math.max(byTime[k], byTime[k + 1]);
    const key = `${a}-${b}`;
    if (pairs.has(key)) continue; // already wired by meaning
    pairs.add(key);
    edges.push({ a, b, weight: 0.35, temporal: true });
    nodes[a].degree++;
    nodes[b].degree++;
  }

  return { nodes, edges };
}

/** Canvas renderer: physics layout, pulses, and hover interaction. */
export class MindView {
  constructor(canvas, { onHover } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onHover = onHover || (() => {});
    this.nodes = [];
    this.edges = [];
    this.accent = '#34e7e4';
    this.rgb = [52, 231, 228];
    this.pointer = { x: -1e6, y: -1e6 };
    this.hovered = null;
    this.t = 0;
    this.energy = 1;   // anneals to near-zero so the layout settles and holds still
    this.running = false;
    this.filter = '';

    canvas.addEventListener('pointermove', (ev) => {
      const r = canvas.getBoundingClientRect();
      this.pointer = { x: ev.clientX - r.left, y: ev.clientY - r.top };
    });
    canvas.addEventListener('pointerleave', () => {
      this.pointer = { x: -1e6, y: -1e6 };
    });
    window.addEventListener('resize', () => this.#resize());
  }

  setAccent(hex) {
    this.accent = hex;
    const c = hex.replace('#', '');
    const full = c.length === 3 ? c.split('').map((x) => x + x).join('') : c;
    this.rgb = [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
    ];
  }

  /** Load facts, seeding positions in a ring so the layout settles fast. */
  setFacts(facts) {
    const { nodes, edges } = buildGraph(facts);
    this.#resize();
    const cx = this.w / 2;
    const cy = this.h / 2;
    const R = Math.min(this.w, this.h) * 0.28;

    this.nodes = nodes.map((n, i) => {
      const prev = this.nodes.find((p) => p.id === n.id);
      const angle = (i / Math.max(1, nodes.length)) * Math.PI * 2;
      return {
        ...n,
        x: prev ? prev.x : cx + Math.cos(angle) * R + (Math.random() - 0.5) * 20,
        y: prev ? prev.y : cy + Math.sin(angle) * R + (Math.random() - 0.5) * 20,
        vx: 0,
        vy: 0,
        // A per-node phase so pulses don't blink in lockstep.
        phase: Math.random() * Math.PI * 2,
        born: prev ? prev.born : performance.now(),
      };
    });
    this.edges = edges;
    this.energy = 1;
  }

  setFilter(query) {
    this.filter = String(query || '').trim().toLowerCase();
  }

  /** Does this node match the current search? */
  #matches(node) {
    return !this.filter || node.text.toLowerCase().includes(this.filter);
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.#step();
      this.#draw();
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  #resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = rect.width || 1;
    this.h = rect.height || 1;
  }

  /** One tick of a small force-directed layout. */
  #step() {
    this.t += 0.016;
    const n = this.nodes.length;
    if (!n) return;
    const cx = this.w / 2;
    const cy = this.h / 2;

    // Repulsion — every neuron pushes every other apart.
    for (let i = 0; i < n; i++) {
      const a = this.nodes[i];
      for (let j = i + 1; j < n; j++) {
        const b = this.nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          d2 = 1;
        }
        const force = Math.min(1400, 26000 / d2);
        const d = Math.sqrt(d2);
        const fx = (dx / d) * force;
        const fy = (dy / d) * force;
        a.vx += fx * 0.0009;
        a.vy += fy * 0.0009;
        b.vx -= fx * 0.0009;
        b.vy -= fy * 0.0009;
      }
      // Gentle pull to centre keeps the brain from drifting off-screen.
      a.vx += (cx - a.x) * 0.0011;
      a.vy += (cy - a.y) * 0.0011;
    }

    // Springs along synapses.
    const rest = Math.min(this.w, this.h) * 0.2;
    for (const e of this.edges) {
      const a = this.nodes[e.a];
      const b = this.nodes[e.b];
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const pull = (d - rest) * 0.0015;
      const fx = (dx / d) * pull;
      const fy = (dy / d) * pull;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }

    // Simulated annealing: lively at first, then it settles so memories stay
    // put and are easy to hover.
    this.energy += (0.06 - this.energy) * 0.012;
    for (const p of this.nodes) {
      p.vx *= 0.86;
      p.vy *= 0.86;
      p.x += p.vx * this.energy;
      p.y += p.vy * this.energy;
      const m = 40;
      p.x = Math.max(m, Math.min(this.w - m, p.x));
      p.y = Math.max(m, Math.min(this.h - m, p.y));
    }

    // Hover detection.
    let best = null;
    let bestD = 34;
    for (const p of this.nodes) {
      const d = Math.hypot(p.x - this.pointer.x, p.y - this.pointer.y);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    if (best?.id !== this.hovered?.id) {
      this.hovered = best;
      this.onHover(best);
    }
  }

  #draw() {
    const ctx = this.ctx;
    const [r, g, b] = this.rgb;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.globalCompositeOperation = 'lighter';

    // Synapses, with signals travelling along them.
    for (const e of this.edges) {
      const a = this.nodes[e.a];
      const c = this.nodes[e.b];
      if (!a || !c) continue;
      const lit = this.#matches(a) && this.#matches(c);
      const strength = Math.min(1, e.weight / 2);
      // Meaning links are brighter than the faint temporal threads.
      const base = e.temporal ? 0.07 : 0.18;
      const alpha = lit ? base + strength * 0.26 : 0.03;

      ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
      ctx.lineWidth = e.temporal ? 0.5 : 0.7 + strength * 1.3;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(c.x, c.y);
      ctx.stroke();

      if (!lit || e.temporal) continue;
      // A pulse sliding from one neuron to the other.
      const p = ((this.t * 0.35 + (e.a + e.b) * 0.17) % 1);
      const px = a.x + (c.x - a.x) * p;
      const py = a.y + (c.y - a.y) * p;
      const fade = Math.sin(p * Math.PI);
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${0.55 * fade})`;
      ctx.beginPath();
      ctx.arc(px, py, 1.8 + strength, 0, Math.PI * 2);
      ctx.fill();
    }

    // Neurons.
    for (const p of this.nodes) {
      const lit = this.#matches(p);
      const isHover = this.hovered?.id === p.id;
      const breathe = 1 + Math.sin(this.t * 1.6 + p.phase) * 0.12;
      // Newly stored memories flare briefly.
      const age = (performance.now() - p.born) / 1400;
      const flare = age < 1 ? (1 - age) : 0;
      const radius = (4 + Math.min(5, p.degree) * 1.5) * breathe * (isHover ? 1.5 : 1) + flare * 8;

      const halo = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius * 4);
      const glow = lit ? (isHover ? 0.5 : 0.26) + flare * 0.5 : 0.05;
      halo.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${glow})`);
      halo.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius * 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = lit
        ? `rgba(255, 255, 255, ${isHover ? 0.98 : 0.8})`
        : `rgba(${r}, ${g}, ${b}, 0.22)`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalCompositeOperation = 'source-over';
  }
}
