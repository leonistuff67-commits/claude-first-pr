/**
 * JARVIS — wiring.
 *
 * Owns the turn loop (user utterance -> streamed reply -> tool calls -> repeat),
 * the HUD, and the state machine that tells the orb what mood to be in.
 */
import { memory } from './memory.js';
import { Brain } from './brain.js';
import { Voice } from './voice.js';
import { Orb } from './orb.js';
import { createTools, fmtDuration } from './tools.js';

const $ = (id) => document.getElementById(id);
const MAX_TOOL_ROUNDS = 6;

const el = {
  hud: $('hud'), boot: $('boot'), bootBtn: $('boot-btn'), bootNote: $('boot-note'),
  orb: $('orb'), orbLabel: $('orb-label'), heard: $('heard'), transcript: $('transcript'),
  composer: $('composer'), input: $('composer-input'), micBtn: $('mic-btn'),
  settingsBtn: $('settings-btn'), settings: $('settings'), settingsForm: $('settings-form'),
  clockTime: $('clock-time'), clockDate: $('clock-date'),
  statStatus: $('stat-status'), statModel: $('stat-model'), statLink: $('stat-link'), statVoice: $('stat-voice'),
  timers: $('timers'), tasks: $('tasks'), facts: $('facts'),
  taskCount: $('task-count'), factCount: $('fact-count'),
  toast: $('toast'), wipeBtn: $('wipe-btn'),
};

let busy = false;
let proxyMode = false;

// --- presentation -----------------------------------------------------------

const orb = new Orb(el.orb);

function setState(state, label = state) {
  orb.setState(state);
  el.orbLabel.textContent = label;
  el.statStatus.textContent = label;
}

function setAccent(hex) {
  document.documentElement.style.setProperty('--accent', hex);
  orb.setAccent(hex);
}

let toastTimer;
function toast(text) {
  el.toast.textContent = text;
  el.toast.classList.add('is-up');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('is-up'), 3200);
}

function bubble(role, text = '') {
  const div = document.createElement('div');
  div.className = `msg msg--${role}`;
  div.textContent = text;
  el.transcript.append(div);
  el.transcript.scrollTop = el.transcript.scrollHeight;
  return div;
}

function renderLists() {
  const tasks = memory.tasks;
  el.taskCount.textContent = String(tasks.filter((t) => !t.done).length);
  el.tasks.innerHTML = '';
  if (!tasks.length) {
    el.tasks.innerHTML = '<li class="list__empty">nothing queued</li>';
  } else {
    for (const t of tasks.slice(-30).reverse()) {
      const li = document.createElement('li');
      li.textContent = t.text;
      if (t.done) li.classList.add('is-done');
      el.tasks.append(li);
    }
  }

  const facts = memory.facts;
  el.factCount.textContent = String(facts.length);
  el.facts.innerHTML = '';
  if (!facts.length) {
    el.facts.innerHTML = '<li class="list__empty">nothing stored yet</li>';
  } else {
    for (const f of facts.slice(-40).reverse()) {
      const li = document.createElement('li');
      li.textContent = f.text;
      el.facts.append(li);
    }
  }
}

function renderTimers(list) {
  el.timers.innerHTML = '';
  if (!list.length) {
    el.timers.innerHTML = '<li class="list__empty">none running</li>';
    return;
  }
  for (const t of list) {
    const li = document.createElement('li');
    li.textContent = `${t.label} — ${fmtDuration((t.endsAt - Date.now()) / 1000)}`;
    el.timers.append(li);
  }
}

function tickClock() {
  const now = new Date();
  el.clockTime.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  el.clockDate.textContent = now.toLocaleDateString([], {
    weekday: 'long', month: 'short', day: 'numeric',
  });
  renderTimers(tools.activeTimers());
}

// --- brain, voice, tools ----------------------------------------------------

const brain = new Brain({ proxy: false, getSettings: () => memory.settings });

const voice = new Voice({
  getSettings: () => memory.settings,
  on: {
    mode(mode) {
      el.micBtn.classList.toggle('is-hot', mode === 'capturing');
      if (busy) return;
      if (mode === 'capturing') setState('listening', 'listening');
      else if (mode === 'idle') setState('idle', 'standby');
      else setState('idle', 'muted');
    },
    hearing(text, live) {
      el.heard.textContent = live ? text : '';
      el.heard.classList.toggle('is-live', Boolean(live && text));
    },
    speaking(on) {
      if (on) setState('speaking', 'speaking');
      else if (!busy) setState('idle', 'standby');
      else setState('thinking', 'thinking');
    },
    bargeIn() {
      brain.abort();
      busy = false;
      setState('idle', 'standby');
      toast('Interrupted.');
    },
    command(text) {
      el.heard.textContent = '';
      el.heard.classList.remove('is-live');
      send(text);
    },
    error(message) {
      toast(message);
      el.statVoice.textContent = 'unavailable';
    },
  },
});

const tools = createTools({
  say: (text) => voice.say(text),
  notify: (text) => toast(text),
  setAccent,
  onTimers: renderTimers,
});

// --- the prompt -------------------------------------------------------------

function buildSystemPrompt() {
  const s = memory.settings;
  const now = new Date();
  const lines = [
    'You are JARVIS, a voice assistant running in the user\'s browser.',
    '',
    'Voice comes first. Your replies are read aloud by a speech synthesizer, so:',
    '- Keep answers to one to three sentences unless asked for more.',
    '- Write plain spoken prose. No markdown, no bullet lists, no emoji, no code blocks, no URLs read aloud.',
    '- Expand numbers and units the way a person would say them.',
    '- Never narrate what you are about to do; just do it and report the result.',
    '',
    'Personality: calm, precise, quietly witty. Loyal without being fawning. You do not',
    'apologise repeatedly, pad answers with filler, or ask permission for small things.',
    '',
    'Tools: call them rather than guessing. Use get_datetime for anything time-dependent.',
    'Call remember on your own initiative whenever the user reveals something durable about',
    'themselves — preferences, names, plans, how they like things done. Do not announce that',
    'you are remembering unless it matters.',
    '',
    `Current local time: ${now.toLocaleString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone}).`,
  ];

  if (s.name) lines.push(`The user's name is ${s.name}.`);

  const facts = memory.facts;
  if (facts.length) {
    lines.push('', 'What you already know about the user:');
    for (const f of facts.slice(-40)) lines.push(`- ${f.text}`);
  }

  const open = memory.tasks.filter((t) => !t.done);
  if (open.length) {
    lines.push('', 'Open tasks on their board:');
    for (const t of open.slice(-20)) lines.push(`- ${t.text}`);
  }

  return lines.join('\n');
}

/**
 * Drop leading messages until the history starts on a clean user turn, so a
 * trimmed transcript never opens with an orphaned tool_result.
 */
function sanitize(messages) {
  let out = messages.slice(-40);
  while (out.length) {
    const first = out[0];
    const orphanResult =
      Array.isArray(first.content) && first.content.some((b) => b.type === 'tool_result');
    if (first.role === 'user' && !orphanResult) break;
    out = out.slice(1);
  }
  return out;
}

// --- the turn loop ----------------------------------------------------------

async function send(text) {
  const clean = String(text).trim();
  if (!clean || busy) return;

  busy = true;
  bubble('user', clean);
  setState('thinking', 'thinking');

  const messages = sanitize([...memory.history, { role: 'user', content: clean }]);
  const toolDefs = tools.definitions;

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      let replyEl = null;

      const result = await brain.stream(
        { system: buildSystemPrompt(), messages, tools: toolDefs },
        {
          text(delta) {
            if (!replyEl) replyEl = bubble('jarvis');
            replyEl.textContent += delta;
            el.transcript.scrollTop = el.transcript.scrollHeight;
            voice.feed(delta);
          },
        },
      );

      if (!result.content.length) {
        bubble('error', 'Empty response from the model.');
        break;
      }

      messages.push({ role: 'assistant', content: result.content });

      if (result.stopReason !== 'tool_use') {
        voice.flush();
        break;
      }

      // Run every tool_use block in this turn, then hand all results back at once.
      const calls = result.content.filter((b) => b.type === 'tool_use');
      const results = [];
      for (const call of calls) {
        bubble('tool', `· ${call.name}`);
        const output = await tools.run(call.name, call.input);
        results.push({ type: 'tool_result', tool_use_id: call.id, content: output });
      }
      messages.push({ role: 'user', content: results });
      renderLists();

      if (round === MAX_TOOL_ROUNDS - 1) {
        bubble('error', 'Stopped after too many tool rounds.');
        voice.flush();
      }
    }

    memory.replaceHistory(sanitize(messages));
  } catch (err) {
    if (err.name === 'AbortError') {
      // Barge-in already reported it.
    } else {
      bubble('error', err.message);
      voice.say('Something went wrong.');
      setState('error', 'error');
      setTimeout(() => setState('idle', 'standby'), 2500);
    }
  } finally {
    busy = false;
    renderLists();
    if (!voice.speaking) setState('idle', 'standby');
  }
}

// --- settings ---------------------------------------------------------------

function loadVoiceOptions() {
  const select = $('set-voice');
  const voices = window.speechSynthesis?.getVoices() || [];
  const current = memory.settings.voiceURI;
  select.innerHTML = '<option value="">Automatic</option>';
  for (const v of voices) {
    const opt = document.createElement('option');
    opt.value = v.voiceURI;
    opt.textContent = `${v.name} (${v.lang})`;
    if (v.voiceURI === current) opt.selected = true;
    select.append(opt);
  }
}

function wireSettings() {
  const s = memory.settings;
  $('set-key').value = s.apiKey;
  $('set-model').value = s.model;
  $('set-effort').value = s.effort;
  $('set-wake').value = s.wakeWord;
  $('set-name').value = s.name;
  $('set-speak').checked = s.speak;
  $('set-always').checked = s.alwaysListen;
  $('set-rate').value = s.rate;
  $('rate-out').textContent = `${Number(s.rate).toFixed(2)}x`;
  $('set-accent').value = s.accent;

  if (proxyMode) {
    $('field-key').style.display = 'none';
  }

  const bind = (id, key, read = (e) => e.value) => {
    $(id).addEventListener('change', (ev) => {
      memory.setSetting(key, read(ev.target));
      applySettings();
    });
  };

  bind('set-key', 'apiKey');
  bind('set-model', 'model');
  bind('set-effort', 'effort');
  bind('set-wake', 'wakeWord');
  bind('set-name', 'name');
  bind('set-voice', 'voiceURI');
  bind('set-speak', 'speak', (e) => e.checked);
  bind('set-always', 'alwaysListen', (e) => e.checked);
  bind('set-accent', 'accent');

  $('set-rate').addEventListener('input', (ev) => {
    const rate = Number(ev.target.value);
    memory.setSetting('rate', rate);
    $('rate-out').textContent = `${rate.toFixed(2)}x`;
  });

  el.settingsBtn.addEventListener('click', () => {
    loadVoiceOptions();
    el.settings.showModal();
  });

  el.wipeBtn.addEventListener('click', () => {
    if (!confirm('Erase all stored facts, tasks and conversation history?')) return;
    memory.wipe();
    el.transcript.innerHTML = '';
    renderLists();
    toast('Memory erased.');
  });
}

function applySettings() {
  const s = memory.settings;
  setAccent(s.accent);
  el.statModel.textContent = s.model.replace('claude-', '');
  el.statVoice.textContent = Voice.supported ? (s.speak ? 'on' : 'muted') : 'unavailable';
  if (s.alwaysListen && Voice.supported) voice.start();
  else voice.stop();
}

// --- boot -------------------------------------------------------------------

async function boot() {
  el.boot.classList.add('is-gone');
  el.hud.classList.add('is-live');

  await voice.enableMic();
  orb.bindLevel(() => voice.level());
  orb.start();

  applySettings();
  renderLists();
  setState('idle', 'standby');

  // Replay whatever was said last session so the screen isn't blank.
  for (const message of memory.history.slice(-8)) {
    if (typeof message.content === 'string') {
      bubble(message.role === 'user' ? 'user' : 'jarvis', message.content);
    } else if (Array.isArray(message.content)) {
      const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (text) bubble(message.role === 'user' ? 'user' : 'jarvis', text);
    }
  }

  const greeting = memory.settings.name
    ? `Good to see you, ${memory.settings.name}. Standing by.`
    : 'Systems online. Standing by.';
  bubble('jarvis', greeting);
  voice.say(greeting);
}

async function init() {
  // Does the server hold an API key, or must the browser supply one? Opened
  // straight off disk there is no server to ask, and fetch on a file:// URL
  // logs an error even when it is caught — so don't ask.
  if (window.location.protocol === 'file:') {
    proxyMode = false;
  } else {
    try {
      const config = await fetch('/api/config').then((r) => r.json());
      proxyMode = Boolean(config.proxy);
    } catch {
      proxyMode = false;
    }
  }
  brain.proxy = proxyMode;
  el.statLink.textContent = proxyMode ? 'server proxy' : 'direct';

  setAccent(memory.settings.accent);
  wireSettings();
  renderLists();
  tickClock();
  setInterval(tickClock, 1000);

  if (!Voice.supported) {
    el.bootNote.textContent =
      'This browser has no speech recognition — Chrome or Edge handle the wake word. ' +
      'You can still type, and replies are still spoken aloud.';
  }
  if (!proxyMode && !memory.settings.apiKey) {
    el.bootNote.textContent =
      'No API key on the server. Open settings after initializing and paste an Anthropic ' +
      'API key — it stays in this browser.';
  }

  // speechSynthesis populates its voice list asynchronously.
  window.speechSynthesis?.addEventListener?.('voiceschanged', loadVoiceOptions);

  el.bootBtn.addEventListener('click', boot, { once: true });

  el.composer.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = el.input.value;
    el.input.value = '';
    send(text);
  });

  el.micBtn.addEventListener('click', () => {
    voice.cancelSpeech();
    voice.listenNow();
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      voice.cancelSpeech();
      brain.abort();
      return;
    }
    // Space anywhere outside a text field starts a capture.
    if (ev.code === 'Space' && !ev.repeat && !['INPUT', 'TEXTAREA'].includes(ev.target.tagName)) {
      ev.preventDefault();
      voice.cancelSpeech();
      voice.listenNow();
    }
  });

  memory.subscribe(() => {
    /* lists re-render on demand; this keeps storage writes observable */
  });
}

init();
