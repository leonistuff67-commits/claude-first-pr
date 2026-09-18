/**
 * Client-side tools. Each entry pairs a Messages API tool definition with the
 * handler that runs in the browser when Claude calls it. Handlers return a
 * string (or a promise for one) which is sent back as the tool_result.
 */
import { memory } from './memory.js';
import { connectorTools, findConnectorTool } from './connectors.js';

const timers = new Map();

function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return [h && `${h}h`, m && `${m}m`, (r || !s) && `${r}s`].filter(Boolean).join(' ');
}

/**
 * @param {object} ctx  Hooks back into the app: { say, notify, setAccent, onTimers }
 */
export function createTools(ctx) {
  const defs = [
    {
      name: 'get_datetime',
      description:
        "Get the user's current local date, time and timezone. Use this whenever the " +
        'answer depends on "now" — never guess the time.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'remember',
      description:
        'Store a durable fact about the user (preferences, names, routines, context worth ' +
        'keeping). Store one fact per call, phrased so it still makes sense weeks later.',
      input_schema: {
        type: 'object',
        properties: { fact: { type: 'string', description: 'The fact to remember.' } },
        required: ['fact'],
      },
    },
    {
      name: 'recall',
      description:
        'Search stored facts about the user. Known facts are already in your system prompt; ' +
        'use this only to search beyond what you were given.',
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Substring to search for. Empty returns recent facts.' } },
        required: [],
      },
    },
    {
      name: 'forget',
      description: 'Delete stored facts matching a phrase. Confirm with the user before calling.',
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Phrase identifying the fact(s) to delete.' } },
        required: ['query'],
      },
    },
    {
      name: 'add_task',
      description: "Add an item to the user's task board.",
      input_schema: {
        type: 'object',
        properties: { task: { type: 'string' } },
        required: ['task'],
      },
    },
    {
      name: 'list_tasks',
      description: 'List the tasks on the board with their status.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'complete_task',
      description: 'Mark a task done by describing it.',
      input_schema: {
        type: 'object',
        properties: { task: { type: 'string', description: 'Text identifying the task.' } },
        required: ['task'],
      },
    },
    {
      name: 'set_timer',
      description:
        'Start a countdown timer. JARVIS announces it out loud when it fires. Convert any ' +
        'spoken duration ("ten minutes", "an hour and a half") into seconds yourself.',
      input_schema: {
        type: 'object',
        properties: {
          seconds: { type: 'number', description: 'Duration in seconds.' },
          label: { type: 'string', description: 'What the timer is for, e.g. "pasta".' },
        },
        required: ['seconds'],
      },
    },
    {
      name: 'cancel_timer',
      description: 'Cancel a running timer by label, or all of them.',
      input_schema: {
        type: 'object',
        properties: { label: { type: 'string', description: 'Label to cancel. Omit to cancel everything.' } },
        required: [],
      },
    },
    {
      name: 'set_accent',
      description:
        "Recolor the interface. Accepts a CSS hex color. Use when the user asks JARVIS to " +
        'change its look or mood.',
      input_schema: {
        type: 'object',
        properties: { color: { type: 'string', description: 'Hex color such as #ff5f6d.' } },
        required: ['color'],
      },
    },
    {
      name: 'open_url',
      description:
        'Open a URL in a new browser tab. Only call this when the user clearly asked to open ' +
        'or go to something.',
      input_schema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Absolute https:// URL.' } },
        required: ['url'],
      },
    },
    {
      name: 'system_status',
      description:
        'Read the local device status: battery level, charging state, network type and screen ' +
        'size. Use for "how am I doing on battery" style questions.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'set_serious_mode',
      description:
        'Turn "serious mode" on or off. On serious mode, JARVIS switches to the most capable ' +
        'model at maximum effort for hard, high-stakes work — call it with on=true when the ' +
        'user says something like "activate serious mode" or "go full power", and on=false when ' +
        'they say "back to normal", "casual mode" or "stand down". Tell the user in one short ' +
        'sentence what you switched to.',
      input_schema: {
        type: 'object',
        properties: { on: { type: 'boolean', description: 'true to engage, false to stand down.' } },
        required: ['on'],
      },
    },
  ];

  const handlers = {
    get_datetime() {
      const now = new Date();
      return JSON.stringify({
        iso: now.toISOString(),
        local: now.toLocaleString(),
        weekday: now.toLocaleDateString(undefined, { weekday: 'long' }),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
    },

    remember({ fact }) {
      const stored = memory.remember(fact);
      return stored ? `Stored: "${stored.text}"` : 'Nothing to store — the fact was empty.';
    },

    recall({ query = '' }) {
      const hits = memory.recall(query);
      if (!hits.length) return 'No stored facts match that.';
      return hits.map((f) => `- ${f.text}`).join('\n');
    },

    forget({ query }) {
      const n = memory.forget(query);
      return n ? `Deleted ${n} fact(s) matching "${query}".` : `Nothing matched "${query}".`;
    },

    add_task({ task }) {
      const added = memory.addTask(task);
      return added ? `Added to the board: "${added.text}"` : 'Nothing to add.';
    },

    list_tasks() {
      const list = memory.tasks;
      if (!list.length) return 'The task board is empty.';
      return list.map((t) => `[${t.done ? 'x' : ' '}] ${t.text}`).join('\n');
    },

    complete_task({ task }) {
      const done = memory.completeTask(task);
      return done ? `Marked done: "${done.text}"` : `No open task matches "${task}".`;
    },

    set_timer({ seconds, label = 'timer' }) {
      const secs = Number(seconds);
      if (!Number.isFinite(secs) || secs <= 0) return 'Invalid duration.';
      const key = String(label).toLowerCase();
      clearTimeout(timers.get(key)?.handle);
      const handle = setTimeout(() => {
        timers.delete(key);
        ctx.onTimers?.([...timers.values()]);
        ctx.notify?.(`Timer done: ${label}`);
        ctx.say?.(`Your ${label} timer is up.`);
      }, secs * 1000);
      timers.set(key, { handle, label, endsAt: Date.now() + secs * 1000 });
      ctx.onTimers?.([...timers.values()]);
      return `Timer "${label}" set for ${fmtDuration(secs)}.`;
    },

    cancel_timer({ label } = {}) {
      if (!label) {
        const n = timers.size;
        for (const t of timers.values()) clearTimeout(t.handle);
        timers.clear();
        ctx.onTimers?.([]);
        return n ? `Cancelled ${n} timer(s).` : 'No timers were running.';
      }
      const key = String(label).toLowerCase();
      const found = timers.get(key);
      if (!found) return `No timer named "${label}".`;
      clearTimeout(found.handle);
      timers.delete(key);
      ctx.onTimers?.([...timers.values()]);
      return `Cancelled the "${label}" timer.`;
    },

    set_accent({ color }) {
      const hex = String(color).trim();
      if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) return `"${color}" is not a hex color.`;
      ctx.setAccent?.(hex);
      memory.setSetting('accent', hex);
      return `Accent set to ${hex}.`;
    },

    open_url({ url }) {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return `"${url}" is not a valid URL.`;
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return 'Only http(s) URLs can be opened.';
      }
      window.open(parsed.href, '_blank', 'noopener');
      return `Opened ${parsed.href}.`;
    },

    async system_status() {
      const status = {
        screen: `${window.screen.width}x${window.screen.height}`,
        online: navigator.onLine,
        language: navigator.language,
      };
      const conn = navigator.connection;
      if (conn) status.network = { type: conn.effectiveType, downlinkMbps: conn.downlink };
      if (navigator.getBattery) {
        try {
          const b = await navigator.getBattery();
          status.battery = { percent: Math.round(b.level * 100), charging: b.charging };
        } catch {
          // Battery API refused; leave it out.
        }
      }
      return JSON.stringify(status);
    },

    set_serious_mode({ on }) {
      const result = ctx.setSeriousMode?.(Boolean(on));
      if (!result) return on ? 'Serious mode engaged.' : 'Back to normal.';
      return on
        ? `Serious mode engaged: ${result.model} at ${result.effort} effort.`
        : `Stood down to ${result.model} at ${result.effort} effort.`;
    },
  };

  /** Built-in tools plus whichever connectors are switched on. */
  function allDefinitions() {
    return [...defs, ...connectorTools(memory.settings.connectors || {})];
  }

  return {
    get definitions() {
      return allDefinitions();
    },

    /** Run a tool_use block and return its string result. */
    async run(name, input) {
      // Connector tools build a URL and hand off to the real app.
      const hit = findConnectorTool(name, memory.settings.connectors || {});
      if (hit) {
        try {
          const url = hit.tool.build(input || {});
          const parsed = new URL(url);
          if (parsed.protocol !== 'https:') return 'Refused: connectors only open https links.';
          window.open(parsed.href, '_blank', 'noopener');
          ctx.notify?.(`Opened ${hit.connector.name}`);
          return hit.tool.say?.(input || {}) || `Opened ${hit.connector.name}.`;
        } catch (err) {
          return `Could not open ${hit.connector.name}: ${err.message}`;
        }
      }

      const fn = handlers[name];
      if (!fn) return `Unknown tool "${name}".`;
      try {
        return String(await fn(input || {}));
      } catch (err) {
        return `Tool "${name}" failed: ${err.message}`;
      }
    },

    activeTimers() {
      return [...timers.values()];
    },
  };
}

export { fmtDuration };
