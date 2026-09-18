/**
 * Persistent state for JARVIS: settings, long-term facts, tasks and timers.
 * Everything lives in localStorage, so it survives reloads but never leaves
 * the machine.
 */
const KEY = 'jarvis.state.v1';

const DEFAULTS = {
  settings: {
    apiKey: '',              // only used when the server has no key of its own
    model: 'claude-opus-5',
    effort: 'low',           // voice wants latency over deliberation
    wakeWord: 'jarvis',
    alwaysListen: true,
    speak: true,
    voiceURI: '',
    rate: 1.05,
    pitch: 0.9,
    accent: '#34e7e4',
    webSearch: false,
    name: '',
    clapToDictate: true,     // double-clap starts a capture
    brain: 'auto',           // auto | claude | local (in-browser LLM) | rules
    localModel: '',          // override the in-browser model id
    speechEngine: 'auto',    // auto | web-speech | vosk (on-device)
    voskModelUrl: '',        // override the default on-device model
  },
  // Set while serious mode is on, so a reload can restore the prior model/effort
  // when it's switched back off.
  seriousPrev: null,
  facts: [],     // { id, text, at }
  tasks: [],     // { id, text, done, at }
  history: [],   // Messages API content, trimmed to the last N turns
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return clone(DEFAULTS);
    const saved = JSON.parse(raw);
    return {
      ...clone(DEFAULTS),
      ...saved,
      settings: { ...DEFAULTS.settings, ...(saved.settings || {}) },
    };
  } catch {
    return clone(DEFAULTS);
  }
}

const state = load();
const listeners = new Set();

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Quota exceeded or storage disabled — degrade to in-memory only.
  }
  for (const fn of listeners) fn(state);
}

function id() {
  return Math.random().toString(36).slice(2, 10);
}

export const memory = {
  state,

  subscribe(fn) {
    listeners.add(fn);
    fn(state);
    return () => listeners.delete(fn);
  },

  get settings() {
    return state.settings;
  },

  setSetting(key, value) {
    state.settings[key] = value;
    persist();
  },

  // --- long-term facts -----------------------------------------------------

  remember(text) {
    const fact = { id: id(), text: String(text).trim(), at: Date.now() };
    if (!fact.text) return null;
    state.facts.push(fact);
    persist();
    return fact;
  },

  recall(query = '') {
    const q = String(query).toLowerCase().trim();
    if (!q) return state.facts.slice(-25);
    return state.facts.filter((f) => f.text.toLowerCase().includes(q));
  },

  forget(query) {
    const q = String(query).toLowerCase().trim();
    const before = state.facts.length;
    state.facts = state.facts.filter(
      (f) => f.id !== query && !(q && f.text.toLowerCase().includes(q)),
    );
    persist();
    return before - state.facts.length;
  },

  // --- tasks ---------------------------------------------------------------

  addTask(text) {
    const task = { id: id(), text: String(text).trim(), done: false, at: Date.now() };
    if (!task.text) return null;
    state.tasks.push(task);
    persist();
    return task;
  },

  completeTask(query) {
    const q = String(query).toLowerCase().trim();
    const task = state.tasks.find(
      (t) => !t.done && (t.id === query || t.text.toLowerCase().includes(q)),
    );
    if (task) {
      task.done = true;
      persist();
    }
    return task;
  },

  clearDoneTasks() {
    state.tasks = state.tasks.filter((t) => !t.done);
    persist();
  },

  get tasks() {
    return state.tasks;
  },

  get facts() {
    return state.facts;
  },

  // --- conversation --------------------------------------------------------

  get history() {
    return state.history;
  },

  pushHistory(message) {
    state.history.push(message);
    // Keep the transcript bounded so the request stays small and fast.
    if (state.history.length > 40) state.history = state.history.slice(-40);
    persist();
  },

  replaceHistory(messages) {
    state.history = messages.slice(-40);
    persist();
  },

  clearHistory() {
    state.history = [];
    persist();
  },

  wipe() {
    Object.assign(state, clone(DEFAULTS), { settings: state.settings });
    persist();
  },
};
