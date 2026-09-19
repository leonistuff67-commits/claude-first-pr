/**
 * Offline brain — JARVIS with no API key and no network.
 *
 * It can't reason like the model, but it recognises the things the built-in
 * tools already do (timers, tasks, memory, the clock, recolouring, serious
 * mode) by matching plain phrases, and answers small talk from a canned set.
 * The point is that the whole interface — voice, orb, memory, tools — stays
 * usable while you're between keys.
 *
 * It mimics just enough of Brain's shape (a `stream` that drives the same
 * callbacks and returns tool_use blocks) that app.js can treat it the same way.
 */
import { memory } from './memory.js';

const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40,
  'forty-five': 45, sixty: 60, ninety: 90,
};

/** Parse "10 minutes", "an hour and a half", "90 seconds" into seconds. */
function parseDuration(text) {
  const t = text.toLowerCase();
  let total = 0;
  let matched = false;
  const re = /(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|forty-five|sixty|ninety)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    matched = true;
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1]] ?? 1;
    const unit = m[2][0];
    total += unit === 'h' ? n * 3600 : unit === 'm' ? n * 60 : n;
  }
  if (t.includes('half an hour') || t.includes('half hour')) { total += 1800; matched = true; }
  if (/\band a half\b/.test(t) && t.includes('hour')) total += 1800;
  return matched ? total : 0;
}

/** Strip a label out of "set a timer for X for the pasta". */
function timerLabel(text) {
  const m = text.match(/\bfor (?:the |my )?([a-z][a-z\s]{1,30})$/i);
  if (m && !/\b(minutes?|seconds?|hours?|mins?|secs?)\b/i.test(m[1])) return m[1].trim();
  if (/\bpasta|tea|coffee|eggs|laundry|oven|break\b/i.test(text)) {
    return text.match(/\bpasta|tea|coffee|eggs|laundry|oven|break\b/i)[0].toLowerCase();
  }
  return 'timer';
}

const GREETINGS = [
  "I'm here.", 'Standing by.', 'At your service.', 'Go ahead.',
];
const UNKNOWN = [
  "I'm running offline right now, so I can only handle timers, tasks, memory, " +
    'the time, and colours. Add an API key in settings for the full brain.',
  "That's beyond what I can do without an API key — but I can still set timers, " +
    'keep tasks and remember things. Open settings to connect the full model.',
];

const pick = (list) => list[Math.floor(Math.random() * list.length)];

/**
 * Turn a phrase into a tool call the app can run, or a plain spoken reply.
 * Returns { tool, input } or { text }.
 */
function interpret(raw) {
  const text = raw.trim();
  const t = text.toLowerCase();

  if (/\b(serious mode|full power|maximum power|max power)\b/.test(t)) {
    const on = !/\b(off|stand down|normal|casual|stop|exit|deactivate)\b/.test(t);
    return { tool: 'set_serious_mode', input: { on } };
  }

  if (/\bwhat("?s| is)? the time|what time is it|current time\b/.test(t)) {
    return { tool: 'get_datetime', input: {} };
  }
  if (/\bwhat("?s| is)? (the |today("?s)? )?date|what day is it\b/.test(t)) {
    return { tool: 'get_datetime', input: {} };
  }

  if (/\b(set|start|make|put on)\b.*\btimer\b/.test(t) || /\btimer\b.*\bfor\b/.test(t) || /\bremind me in\b/.test(t)) {
    const seconds = parseDuration(t);
    if (!seconds) return { text: 'How long should the timer run?' };
    return { tool: 'set_timer', input: { seconds, label: timerLabel(text) } };
  }
  if (/\bcancel\b.*\btimer|stop the timer\b/.test(t)) {
    const label = t.match(/\bcancel (?:the )?([a-z]+) timer\b/)?.[1];
    return { tool: 'cancel_timer', input: label ? { label } : {} };
  }

  if (/\b(add|new|create)\b.*\btask\b|\badd .* to (my |the )?(list|tasks|board)\b|\bremind me to\b|\bi need to\b/.test(t)) {
    const task = text
      .replace(/^.*?\b(add|new task|create a task|remind me to|i need to)\b[:,]?\s*/i, '')
      .replace(/\bto (my|the) (list|tasks|board)\b/i, '')
      .trim();
    return { tool: 'add_task', input: { task: task || text } };
  }
  if (/\b(what|show|list|read).*(tasks|to-?do|list|board)\b/.test(t)) {
    return { tool: 'list_tasks', input: {} };
  }
  if (/\b(done|finished|completed|complete|check off|mark)\b/.test(t) && memory.tasks.some((x) => !x.done)) {
    const task = text.replace(/^.*?\b(done|finished|completed|complete|check off|mark)\b\s*(with|the)?\s*/i, '').trim();
    return { tool: 'complete_task', input: { task } };
  }

  if (/\b(remember|note|keep in mind|don'?t forget)\b/.test(t)) {
    const fact = text.replace(/^.*?\b(remember|note|keep in mind that|keep in mind|don'?t forget)\b[:,]?\s*(that )?/i, '').trim();
    return fact ? { tool: 'remember', input: { fact } } : { text: 'What should I remember?' };
  }
  if (/\bwhat do you (know|remember)\b|\bwhat have you got on me\b/.test(t)) {
    return { tool: 'recall', input: {} };
  }
  if (/\bforget\b/.test(t)) {
    const query = text.replace(/^.*?\bforget\b\s*(about |that )?/i, '').trim();
    return query ? { tool: 'forget', input: { query } } : { text: 'Forget what, exactly?' };
  }

  const colour = t.match(/#[0-9a-f]{6}\b/) ||
    t.match(/\b(red|crimson|orange|amber|gold|yellow|lime|green|teal|cyan|blue|indigo|violet|purple|magenta|pink|white)\b/);
  if (colour && /\b(colou?r|accent|turn|go|make|paint|mood)\b/.test(t)) {
    const NAMED = {
      red: '#ff5f6d', crimson: '#dc143c', orange: '#ff8c42', amber: '#ffbf00', gold: '#ffd700',
      yellow: '#ffe14d', lime: '#7cff6b', green: '#34e77a', teal: '#34e7e4', cyan: '#22d3ee',
      blue: '#4d9fff', indigo: '#6366f1', violet: '#8b5cf6', purple: '#a855f7', magenta: '#ff4dd8',
      pink: '#ff7eb6', white: '#e8f0f8',
    };
    return { tool: 'set_accent', input: { color: colour[0].startsWith('#') ? colour[0] : NAMED[colour[0]] } };
  }

  if (/\bbattery|how am i doing on power|system status\b/.test(t)) {
    return { tool: 'system_status', input: {} };
  }

  // --- connectors: hand off to a real app with everything filled in ---

  if (/\b(email|e-mail|mail)\b/.test(t) && !/\bemail address\b/.test(t)) {
    const to = (text.match(/[\w.+-]+@[\w-]+\.[\w.]+/) || [''])[0];
    const about = text.replace(/^.*?\b(about|saying|re)\b\s*/i, '');
    const body = about && about !== text ? about : text;
    return { tool: 'compose_email', input: { to, subject: body.slice(0, 60), body } };
  }
  if (/\bdirections?\b|\bhow do i get to\b|\bnavigate to\b/.test(t)) {
    const destination = text.replace(/^.*?\b(directions? to|how do i get to|navigate to)\b\s*/i, '').trim();
    return destination
      ? { tool: 'get_directions', input: { destination } }
      : { text: 'Where do you want to go?' };
  }
  // "open spotify", "text dan ...", "call the dentist"
  const appMatch = t.match(/\b(?:open|launch|start)\s+(spotify|youtube|maps|whatsapp|telegram|gmail|calendar|instagram|notes|phone)\b/);
  if (appMatch) return { tool: 'open_app', input: { app: appMatch[1] } };

  if (/\btext\b|\bmessage\b/.test(t) && !/\bemail\b/.test(t)) {
    const body = text.replace(/^.*?\b(?:text|message)\b\s*/i, '').replace(/^\w+\s+(?:that|saying)\s*/i, '');
    return { tool: 'open_app', input: { app: 'sms', text: body || text } };
  }
  if (/\bcall\b/.test(t)) {
    const digits = (text.match(/[\d+][\d\s()-]{5,}/) || [''])[0].trim();
    return digits
      ? { tool: 'open_app', input: { app: 'phone', phone: digits } }
      : { text: 'What number should I bring up?' };
  }
  if (/\bplay\b.*\bspotify\b|\bspotify\b.*\bplay\b/.test(t)) {
    const query = text.replace(/^.*?\bplay\b\s*/i, '').replace(/\bon spotify\b/i, '').trim();
    return { tool: 'open_app', input: { app: 'spotify', query } };
  }

  if (/\b(play|put on)\b/.test(t) && !/\btimer\b/.test(t)) {
    const query = text.replace(/^.*?\b(play|put on)\b\s*/i, '').trim();
    return query ? { tool: 'play_video', input: { query } } : { text: 'Play what?' };
  }
  if (/\btranslate\b/.test(t)) {
    const to = (t.match(/\b(?:in|into|to)\s+([a-z]+)\s*$/) || [])[1] || 'es';
    const phrase = text.replace(/^.*?\btranslate\b\s*/i, '').replace(/\b(?:in|into|to)\s+[a-z]+\s*$/i, '').trim();
    return phrase ? { tool: 'translate_text', input: { text: phrase, to } } : { text: 'Translate what?' };
  }
  if (/\b(search|look up|google|what is|who is)\b/.test(t)) {
    const query = text.replace(/^.*?\b(search for|search|look up|google)\b\s*/i, '').trim();
    return { tool: 'search_web', input: { query: query || text } };
  }

  if (/\b(hi|hey|hello|yo|jarvis|you there|you awake)\b/.test(t) && t.length < 30) {
    return { text: pick(GREETINGS) };
  }
  if (/\b(thanks|thank you|cheers|nice|great|perfect)\b/.test(t)) {
    return { text: pick(['Any time.', 'Of course.', 'Happy to help.']) };
  }
  if (/\bhow are you|how'?s it going\b/.test(t)) {
    return { text: 'Running fine — offline, but fine.' };
  }

  return { text: pick(UNKNOWN) };
}

let idCounter = 0;

export class OfflineBrain {
  constructor() {
    this.betas = [];
  }

  abort() {}

  static get isOffline() {
    return true;
  }

  /**
   * Same signature as Brain.stream. If the interpreter picks a tool we return a
   * tool_use block (app.js runs it and calls us back with the result); if it
   * picks text we "type" it out through the on.text callback so the UI and
   * voice behave exactly as they do online.
   */
  async stream({ messages }, on = {}) {
    const last = messages[messages.length - 1];

    // A continuation: the app handed us tool results. Speak a short confirmation
    // built from them and end the turn.
    if (Array.isArray(last?.content) && last.content.some((b) => b.type === 'tool_result')) {
      const said = last.content
        .filter((b) => b.type === 'tool_result')
        .map((b) => (typeof b.content === 'string' ? b.content : ''))
        .join(' ')
        .trim();
      const reply = said || 'Done.';
      await this.#type(reply, on);
      return { content: [{ type: 'text', text: reply }], stopReason: 'end_turn', model: 'offline' };
    }

    const utterance = typeof last?.content === 'string'
      ? last.content
      : (last?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');

    const decision = interpret(utterance);

    if (decision.tool) {
      const block = {
        type: 'tool_use',
        id: `offline_${++idCounter}`,
        name: decision.tool,
        input: decision.input,
      };
      on.toolUse?.(block);
      return { content: [block], stopReason: 'tool_use', model: 'offline' };
    }

    await this.#type(decision.text, on);
    return { content: [{ type: 'text', text: decision.text }], stopReason: 'end_turn', model: 'offline' };
  }

  /** Reveal text a few characters at a time so streaming/voice feel unchanged. */
  async #type(text, on) {
    if (!on.text) return;
    const words = text.split(/(\s+)/);
    for (const chunk of words) {
      on.text(chunk);
      await new Promise((r) => setTimeout(r, 18));
    }
  }
}

export { interpret, parseDuration };
