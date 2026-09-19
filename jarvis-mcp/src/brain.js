/**
 * JARVIS's brain, independent of where it is running.
 *
 * The browser version keeps facts and tasks in localStorage; this keeps the
 * same shapes in a JSON file so the two can be moved between each other. Every
 * function here is pure — it takes a state and returns a new one — which keeps
 * the MCP server a thin wrapper and makes the behaviour testable without a
 * server, a browser or a model.
 */

/** Matches the web app's stored shape, so an export drops straight in. */
export function createState() {
  return { facts: [], tasks: [] };
}

/** Accept anything vaguely shaped like a brain; ignore what we don't know. */
export function normalise(raw) {
  const state = createState();
  if (!raw || typeof raw !== 'object') return state;
  if (Array.isArray(raw.facts)) {
    state.facts = raw.facts
      .filter((f) => f && typeof f.text === 'string' && f.text.trim())
      .map((f) => ({ id: String(f.id ?? newId()), text: f.text.trim(), at: Number(f.at) || Date.now() }));
  }
  if (Array.isArray(raw.tasks)) {
    state.tasks = raw.tasks
      .filter((t) => t && typeof t.text === 'string' && t.text.trim())
      .map((t) => ({
        id: String(t.id ?? newId()),
        text: t.text.trim(),
        done: Boolean(t.done),
        at: Number(t.at) || Date.now(),
      }));
  }
  return state;
}

let counter = 0;
function newId() {
  counter += 1;
  return `${Date.now().toString(36)}${counter.toString(36)}`;
}

const norm = (s) => String(s || '').trim();
const fold = (s) => norm(s).toLowerCase();

// --- facts ------------------------------------------------------------------

/**
 * Store a durable fact. Repeating something already known is not an error and
 * does not duplicate it — the assistant volunteers facts on its own initiative,
 * so it will say the same thing twice sooner or later.
 */
export function remember(state, text) {
  const clean = norm(text);
  if (!clean) return { state, fact: null, added: false };
  const existing = state.facts.find((f) => fold(f.text) === fold(clean));
  if (existing) return { state, fact: existing, added: false };
  const fact = { id: newId(), text: clean, at: Date.now() };
  return { state: { ...state, facts: [...state.facts, fact] }, fact, added: true };
}

/** Forget by id, or by the text itself when the model only has the wording. */
export function forget(state, idOrText) {
  const key = fold(idOrText);
  if (!key) return { state, removed: [] };
  const removed = state.facts.filter((f) => f.id === idOrText || fold(f.text) === key);
  if (!removed.length) return { state, removed: [] };
  const ids = new Set(removed.map((f) => f.id));
  return { state: { ...state, facts: state.facts.filter((f) => !ids.has(f.id)) }, removed };
}

/**
 * Rank facts against a query by how many of its words they contain, newest
 * first among equals. An empty query returns the most recent facts, which is
 * what "what do you know about me" should produce.
 */
export function recall(state, query, limit = 20) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const scored = state.facts.map((fact) => {
    const haystack = fold(fact.text);
    const hits = words.filter((w) => haystack.includes(w)).length;
    return { fact, score: words.length ? hits : 1 };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.fact.at - a.fact.at)
    .slice(0, Math.max(1, limit))
    .map((s) => s.fact);
}

// --- tasks ------------------------------------------------------------------

export function addTask(state, text) {
  const clean = norm(text);
  if (!clean) return { state, task: null };
  const task = { id: newId(), text: clean, done: false, at: Date.now() };
  return { state: { ...state, tasks: [...state.tasks, task] }, task };
}

/** Complete by id or by text, matching the most recent open task on a tie. */
export function completeTask(state, idOrText) {
  const key = fold(idOrText);
  const open = state.tasks.filter((t) => !t.done);
  const hit =
    open.find((t) => t.id === idOrText) ||
    open.filter((t) => fold(t.text) === key).pop() ||
    open.filter((t) => fold(t.text).includes(key) && key).pop();
  if (!hit) return { state, task: null };
  return {
    state: { ...state, tasks: state.tasks.map((t) => (t.id === hit.id ? { ...t, done: true } : t)) },
    task: { ...hit, done: true },
  };
}

export function listTasks(state, { includeDone = false } = {}) {
  return state.tasks.filter((t) => includeDone || !t.done);
}

// --- whole brain ------------------------------------------------------------

export function stats(state) {
  return {
    facts: state.facts.length,
    tasks: state.tasks.length,
    openTasks: state.tasks.filter((t) => !t.done).length,
    newestFact: state.facts.length ? Math.max(...state.facts.map((f) => f.at)) : null,
  };
}

/**
 * Fold a brain exported from the browser into this one. Facts and tasks are
 * matched on their text, so importing the same export twice is a no-op rather
 * than a second copy of everything.
 */
export function merge(state, incoming) {
  const other = normalise(incoming);
  let out = state;
  for (const fact of other.facts) out = remember(out, fact.text).state;
  const known = new Set(out.tasks.map((t) => fold(t.text)));
  const tasks = other.tasks.filter((t) => !known.has(fold(t.text)));
  return {
    state: { ...out, tasks: [...out.tasks, ...tasks] },
    added: { facts: out.facts.length - state.facts.length, tasks: tasks.length },
  };
}
