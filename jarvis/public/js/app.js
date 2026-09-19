/**
 * JARVIS — wiring.
 *
 * Owns the turn loop (user utterance -> streamed reply -> tool calls -> repeat),
 * the HUD, and the state machine that tells the orb what mood to be in.
 */
import { memory } from './memory.js';
import { Brain } from './brain.js';
import { OfflineBrain } from './offline.js';
import { Voice } from './voice.js';
import { Orb } from './orb.js';
import { Wave } from './wave.js';
import { MindView } from './mind.js';
import { LocalBrain, webGpuSupported, SPEED_TIERS } from './localbrain.js';
import { CONNECTORS } from './connectors.js';
import { PROVIDERS, providerFor, ProviderBrain } from './providers.js';
import { Gmail, formatInbox } from './gmail.js';
import { createTools, fmtDuration } from './tools.js';
import { sanitize, repair } from './history.js';
import { cleanKey, keyWasDirty, describeKey } from './apikey.js';

const $ = (id) => document.getElementById(id);
const MAX_TOOL_ROUNDS = 6;

/** Where JARVIS is hosted, so it can be installed without running anything. */
const HOSTED_URL = 'https://leonistuff67-commits.github.io/claude-first-pr/';

const el = {
  hud: $('hud'), boot: $('boot'), bootBtn: $('boot-btn'), bootNote: $('boot-note'),
  orb: $('orb'), orbLabel: $('orb-label'), heard: $('heard'), transcript: $('transcript'), wave: $('wave'),
  composer: $('composer'), input: $('composer-input'), micBtn: $('mic-btn'),
  settingsBtn: $('settings-btn'), settings: $('settings'), settingsForm: $('settings-form'),
  clockTime: $('clock-time'), clockDate: $('clock-date'),
  statStatus: $('stat-status'), statModel: $('stat-model'), statLink: $('stat-link'), statVoice: $('stat-voice'),
  timers: $('timers'), tasks: $('tasks'), facts: $('facts'),
  taskCount: $('task-count'), factCount: $('fact-count'),
  toast: $('toast'), wipeBtn: $('wipe-btn'), exportBtn: $('export-btn'),
  mind: $('mind'), mindCanvas: $('mind-canvas'), mindSearch: $('mind-search'),
  mindClose: $('mind-close'), mindDetail: $('mind-detail'), mindStats: $('mind-stats'),
  brainBtn: $('brain-btn'),
  conn: $('conn'), connGrid: $('conn-grid'), connBtn: $('conn-btn'), connClose: $('conn-close'),
};

let busy = false;
let proxyMode = false;
let serious = false;

// --- presentation -----------------------------------------------------------

const orb = new Orb(el.orb);
const wave = new Wave(el.wave);

// --- memory brain -----------------------------------------------------------

const mind = new MindView(el.mindCanvas, {
  onHover(node) {
    if (!node) {
      el.mindDetail.classList.remove('is-live');
      el.mindDetail.innerHTML = '<p class="mind__hint">Hover a neuron to read the memory it holds.</p>';
      return;
    }
    el.mindDetail.classList.add('is-live');
    const when = new Date(node.at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    el.mindDetail.innerHTML = '';
    const text = document.createElement('p');
    text.textContent = node.text;
    const meta = document.createElement('p');
    meta.className = 'mind__meta';
    meta.textContent = `stored ${when} · ${node.degree} connection${node.degree === 1 ? '' : 's'}`;
    el.mindDetail.append(text, meta);
  },
});

function openMind() {
  el.mind.hidden = false;
  mind.setAccent(serious ? '#ff5f6d' : memory.settings.accent);
  mind.setFilter(el.mindSearch.value);
  mind.setFacts(memory.facts);
  renderMindStats();
  mind.start();
  el.mindSearch.focus();
}

function closeMind() {
  mind.stop();
  el.mind.hidden = true;
}

function renderMindStats() {
  const nodes = mind.nodes.length;
  const links = mind.edges.length;
  const busiest = mind.nodes.reduce((a, b) => (b.degree > (a?.degree ?? -1) ? b : a), null);
  el.mindStats.innerHTML = '';
  const stat = (value, label) => {
    const div = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = value;
    div.append(b, document.createTextNode(label));
    return div;
  };
  el.mindStats.append(stat(String(nodes), 'memories'), stat(String(links), 'connections'));
  if (busiest && busiest.degree > 0) {
    el.mindStats.append(stat(String(busiest.degree), 'strongest link'));
  }
}

function setState(state, label = state) {
  orb.setState(state);
  // Expose the state to CSS so the shell can react (composer glow, etc).
  document.body.dataset.state = state;
  // The spectrum bars light up while listening or speaking, idle otherwise.
  wave.setActive(state === 'listening' || state === 'speaking');
  el.orbLabel.textContent = serious && label === 'standby' ? 'serious' : label;
  el.statStatus.textContent = serious && (label === 'standby' || label === 'muted')
    ? `${label} · serious`
    : label;
}

function setAccent(hex) {
  document.documentElement.style.setProperty('--accent', hex);
  orb.setAccent(hex);
  wave.setAccent(hex);
  mind.setAccent(hex);
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

  // Keep the brain in sync if it's open — a new memory grows a new neuron.
  if (el.mind && !el.mind.hidden) {
    mind.setFacts(memory.facts);
    renderMindStats();
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
const offlineBrain = new OfflineBrain();
const providerBrain = new ProviderBrain({ getSettings: () => memory.settings });
const localBrain = new LocalBrain({
  getSettings: () => memory.settings,
  on: {
    progress(fraction, text) {
      const pct = Math.round((fraction || 0) * 100);
      el.statModel.textContent = `local AI ${pct}%`;
      setState('thinking', 'loading model');
      if (pct === 0 && text) toast('Downloading the local AI — one time, then it works offline.');
    },
    busy(on) {
      // The model and the visuals were fighting over the same GPU.
      orb.setQuiet(on);
      wave.setQuiet(on);
    },
    ready(modelId) {
      toast(`Local AI ready (${modelId.split('-').slice(0, 2).join(' ')}).`);
      applyModelReadout();
      if (!busy) setState('idle', 'standby');
    },
  },
});

/**
 * Which brain drives this turn.
 *  claude — the real model, needs a key (or the server proxy)
 *  local  — a language model running here in the browser, no key at all
 *  rules  — the built-in pattern matcher, no key and no download
 */
function brainKind() {
  const pref = memory.settings.brain || 'auto';
  if (pref === 'local') return 'local';
  if (pref === 'rules') return 'rules';
  if (pref === 'api' || pref === 'claude') return 'api';
  return proxyMode || hasProviderKey() ? 'api' : 'rules';
}

/** Is there a usable key for the selected provider? */
function hasProviderKey() {
  const s = memory.settings;
  const id = s.provider || 'anthropic';
  if (providerFor(id)?.noKey) return true;
  if (id === 'anthropic') return Boolean(s.apiKey || (s.providerKeys || {}).anthropic);
  return Boolean((s.providerKeys || {})[id]);
}

/** True when no Anthropic key is in play, whatever is driving instead. */
function isOffline() {
  return brainKind() !== 'api';
}

/** The engine this turn should use. */
function engine() {
  const kind = brainKind();
  if (kind === 'local') return localBrain;
  if (kind !== 'api') return offlineBrain;
  // Anthropic has its own client; everything else speaks the OpenAI shape.
  return (memory.settings.provider || 'anthropic') === 'anthropic' ? brain : providerBrain;
}

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
      engine().abort();
      setBusy(false);
      setState('idle', 'standby');
      toast('Interrupted.');
    },
    command(text) {
      el.heard.textContent = '';
      el.heard.classList.remove('is-live');
      send(text);
    },
    doubleClap() {
      // Same as tapping the mic: cut any speech and start capturing right away.
      toast('Heard a double-clap — listening.');
      voice.cancelSpeech();
      voice.listenNow();
    },
    engine(state, name) {
      const label = name === 'vosk' ? 'on-device' : 'browser';
      if (state === 'loading') {
        el.statVoice.textContent = 'loading model…';
        toast('Downloading the on-device voice model — first time only.');
      } else if (state === 'listening') {
        el.statVoice.textContent = memory.settings.speak ? `${label}` : `${label} · muted`;
      }
    },
    error(message) {
      toast(message);
      el.statVoice.textContent = 'unavailable';
    },
  },
});

const gmail = new Gmail({
  getSettings: () => memory.settings,
  onSession() {
    renderConnectors();
    applyModelReadout();
  },
});

const tools = createTools({
  gmail,
  formatInbox,
  say: (text) => voice.say(text),
  notify: (text) => toast(text),
  setAccent,
  onTimers: renderTimers,
  setSeriousMode: (on) => setSeriousMode(on),
});

// --- serious mode -----------------------------------------------------------

/**
 * Serious mode: jump to the strongest model at max effort for hard work, and
 * remember the previous settings so standing down restores them. Returns the
 * model/effort now in force, which the tool speaks back to the user.
 */
function setSeriousMode(on) {
  if (on === serious) {
    return { model: shortModel(memory.settings.model), effort: memory.settings.effort };
  }

  if (on) {
    memory.state.seriousPrev = { model: memory.settings.model, effort: memory.settings.effort };
    memory.setSetting('model', Brain.strongest);
    memory.setSetting('effort', 'max');
  } else {
    const prev = memory.state.seriousPrev || { model: 'claude-opus-5', effort: 'low' };
    memory.setSetting('model', prev.model);
    memory.setSetting('effort', prev.effort);
    memory.state.seriousPrev = null;
  }

  serious = on;
  document.body.classList.toggle('is-serious', on);
  if (on) {
    // Drop the inline accent so the serious-mode CSS colour wins; the orb still
    // gets recoloured directly.
    document.documentElement.style.removeProperty('--accent');
    orb.setAccent('#ff5f6d');
  } else {
    setAccent(memory.settings.accent);
  }
  syncSettingsControls();
  applyModelReadout();
  toast(on ? 'Serious mode engaged.' : 'Serious mode off.');
  return { model: shortModel(memory.settings.model), effort: memory.settings.effort };
}

function shortModel(id) {
  return Brain.models[id]?.label.split(' — ')[0] || id.replace('claude-', '');
}

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
    'Serious mode: when the user asks to "activate serious mode", "go full power" or similar,',
    'call set_serious_mode with on=true — it switches you to the strongest model at maximum',
    'effort for hard problems. Call it with on=false when they say to stand down or go casual.',
    serious
      ? 'Serious mode is currently ON — the user has asked for your most careful, thorough work.'
      : 'Serious mode is currently off.',
    '',
    `Current local time: ${now.toLocaleString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone}).`,
  ];

  if (s.name) lines.push(`The user's name is ${s.name}.`);

  // A small local model pays for every token of context in latency, so give it
  // a much tighter brief than Claude gets.
  const local = brainKind() === 'local';
  const factLimit = local ? 8 : 40;
  const taskLimit = local ? 5 : 20;

  const facts = memory.facts;
  if (facts.length) {
    lines.push('', 'What you already know about the user:');
    for (const f of facts.slice(-factLimit)) lines.push(`- ${f.text}`);
  }

  const open = memory.tasks.filter((t) => !t.done);
  if (open.length) {
    lines.push('', 'Open tasks on their board:');
    for (const t of open.slice(-taskLimit)) lines.push(`- ${t.text}`);
  }

  if (local) {
    // Drop the long persona section; keep the rules that matter for behaviour.
    return lines
      .filter((l) => !l.startsWith('Personality:') && !l.startsWith('apologise'))
      .join('\n');
  }
  return lines.join('\n');
}

// --- the turn loop ----------------------------------------------------------

/** Flip the busy flag and mirror it onto the DOM (handy for tests/automation). */
function setBusy(value) {
  busy = value;
  document.body.dataset.busy = value ? '1' : '0';
}

async function send(text) {
  const clean = String(text).trim();
  if (!clean || busy) return;

  setBusy(true);
  bubble('user', clean);
  setState('thinking', 'thinking');

  const messages = sanitize([...memory.history, { role: 'user', content: clean }]);
  const toolDefs = tools.definitions;

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      let replyEl = null;

      const result = await engine().stream(
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

      // What decides the next round is whether the model actually asked for a
      // tool, not what it said its stop reason was. A reply cut short by the
      // token ceiling still carries the tool_use blocks it managed to emit, and
      // leaving one unanswered would wedge every later request.
      const calls = result.content.filter((b) => b.type === 'tool_use');
      if (!calls.length) {
        voice.flush();
        if (result.stopReason === 'max_tokens') {
          bubble('error', 'That reply hit the length limit, so it may be cut off.');
        }
        break;
      }

      // Run every tool_use block in this turn, then hand all results back at once.
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
    setBusy(false);
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

/** Fill the provider picker. */
function populateProviderOptions() {
  const select = $('set-provider');
  if (select.options.length) return;
  for (const [id, meta] of Object.entries(PROVIDERS)) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = meta.label;
    select.append(opt);
  }
}

/** Current provider id, defaulting to Claude. */
function currentProvider() {
  return memory.settings.provider || 'anthropic';
}

/** Fill the model picker for whichever provider is selected. */
function populateModelOptions() {
  const select = $('set-model');
  const id = currentProvider();
  select.innerHTML = '';

  const entries = id === 'anthropic'
    ? Object.entries(Brain.models).map(([value, meta]) => [value, meta.label])
    : (providerFor(id)?.models || []).map((m) => [m, m]);

  for (const [value, label] of entries) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    select.append(opt);
  }

  const chosen = id === 'anthropic'
    ? memory.settings.model
    : (memory.settings.providerModels || {})[id];
  if (chosen && entries.some(([v]) => v === chosen)) select.value = chosen;
  else if (entries.length) select.value = entries[0][0];
}

/**
 * Send the smallest possible request and report exactly what came back. This
 * goes straight to the provider rather than through the brain, so it tests the
 * key and nothing else — no tools, no history, no model features.
 */
async function testCurrentKey() {
  const pid = currentProvider();
  const key = cleanKey(providerKey(pid));
  const shape = describeKey(key, pid === 'anthropic' ? 'sk-ant-' : '');

  if (pid !== 'anthropic') {
    return `Key looks like: ${shape}. Testing is only wired up for Claude so far.`;
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });

  if (res.ok) return `Key works. (${shape})`;
  const detail = await res.text().catch(() => '');
  let reason = detail;
  try {
    reason = JSON.parse(detail)?.error?.message || detail;
  } catch {
    // Keep the raw body.
  }
  return `Rejected with ${res.status}: ${reason}\n(${shape})`;
}

/** Read/write the key for the selected provider. */
function providerKey(id) {
  const s = memory.settings;
  if (id === 'anthropic') return (s.providerKeys || {}).anthropic || s.apiKey || '';
  return (s.providerKeys || {})[id] || '';
}

function setProviderKey(id, value) {
  const keys = { ...(memory.settings.providerKeys || {}) };
  keys[id] = value;
  memory.setSetting('providerKeys', keys);
  // Keep the legacy field in step so existing Anthropic setups keep working.
  if (id === 'anthropic') memory.setSetting('apiKey', value);
}

/** Fill the effort picker for whichever model is selected. */
function populateEffortOptions(model) {
  const select = $('set-effort');
  const efforts = Brain.effortsFor(model);
  select.innerHTML = '';

  if (!efforts.length) {
    // Haiku 4.5 has no effort knob — say so instead of showing an empty box.
    select.disabled = true;
    $('effort-note').textContent = '(not adjustable on this model)';
    return;
  }
  select.disabled = false;
  $('effort-note').textContent = '';
  for (const level of efforts) {
    const opt = document.createElement('option');
    opt.value = level;
    opt.textContent = level;
    select.append(opt);
  }
  // Keep the stored effort if it's still valid, else fall back to a safe one.
  const current = memory.settings.effort;
  select.value = efforts.includes(current) ? current : 'low';
  if (select.value !== current) memory.setSetting('effort', select.value);
}

/** Reflect the current settings into the dialog controls (also after serious mode). */
function syncSettingsControls() {
  const s = memory.settings;
  populateProviderOptions();
  const pid = currentProvider();
  const provider = providerFor(pid);
  const cloud = brainKind() === 'api';

  $('set-provider').value = pid;
  $('set-key').value = providerKey(pid);
  $('set-key').placeholder = provider?.keyPrefix ? `${provider.keyPrefix}...` : 'paste your key';
  $('key-where').textContent = provider?.noKey ? '(no key needed)' : '';
  $('field-provider').style.display = cloud ? '' : 'none';
  // In proxy mode the server holds the Anthropic key, so don't ask for one.
  const serverHoldsKey = proxyMode && pid === 'anthropic';
  $('field-key').style.display = cloud && !provider?.noKey && !serverHoldsKey ? '' : 'none';

  populateModelOptions();
  // Effort is an Anthropic concept; hide it for everyone else.
  const anthropic = pid === 'anthropic';
  $('field-effort').style.display = cloud && anthropic ? '' : 'none';
  if (anthropic) {
    populateEffortOptions(s.model);
    $('set-effort').value = Brain.effortsFor(s.model).includes(s.effort) ? s.effort : 'low';
  }
  $('set-wake').value = s.wakeWord;
  $('set-name').value = s.name;
  $('set-speak').checked = s.speak;
  $('set-always').checked = s.alwaysListen;
  $('set-clap').checked = s.clapToDictate;
  const speed = $('set-speed');
  if (!speed.options.length) {
    for (const tier of SPEED_TIERS) {
      const opt = document.createElement('option');
      opt.value = tier.id;
      opt.textContent = tier.label;
      speed.append(opt);
    }
  }
  speed.value = s.localSpeed;
  $('field-speed').style.display = brainKind() === 'local' ? '' : 'none';
  $('set-brain').value = s.brain;
  $('brain-note').textContent = webGpuSupported() ? '' : '(local AI needs WebGPU — not available here)';
  $('field-model').style.display = cloud ? '' : 'none';
  $('set-engine').value = s.speechEngine;
  $('engine-note').textContent = Voice.webSpeechSupported ? '' : '(browser engine unavailable here)';
  $('set-rate').value = s.rate;
  $('rate-out').textContent = `${Number(s.rate).toFixed(2)}x`;
  $('set-accent').value = s.accent;
}

function wireSettings() {
  populateModelOptions();
  syncSettingsControls();

  const bind = (id, key, read = (e) => e.value) => {
    $(id).addEventListener('change', (ev) => {
      memory.setSetting(key, read(ev.target));
      applySettings();
    });
  };

  bind('set-wake', 'wakeWord');
  bind('set-name', 'name');
  bind('set-voice', 'voiceURI');
  bind('set-speak', 'speak', (e) => e.checked);
  bind('set-always', 'alwaysListen', (e) => e.checked);
  bind('set-clap', 'clapToDictate', (e) => e.checked);
  bind('set-accent', 'accent');

  // Changing size means a different model, so drop the loaded one.
  $('set-speed').addEventListener('change', (ev) => {
    memory.setSetting('localSpeed', ev.target.value);
    memory.setSetting('localModel', '');
    localBrain.engine = null;
    localBrain.modelId = null;
    applyModelReadout();
    toast('Size changed — the new model downloads on your next message.');
  });

  $('set-brain').addEventListener('change', async (ev) => {
    memory.setSetting('brain', ev.target.value);
    syncSettingsControls();
    applyModelReadout();
    if (ev.target.value === 'local' && !localBrain.ready) {
      // Start the download now rather than stalling the first question.
      try {
        await localBrain.load();
      } catch (err) {
        // A toast can be overwritten by other notices, so leave a permanent
        // explanation in the transcript too.
        toast(err.message);
        bubble('error', `Local AI unavailable — ${err.message} Falling back to offline rules.`);
        memory.setSetting('brain', 'rules');
        syncSettingsControls();
        applyModelReadout();
      }
    }
  });

  // Switching speech engine restarts recognition on the new one.
  $('set-engine').addEventListener('change', (ev) => {
    memory.setSetting('speechEngine', ev.target.value);
    voice.reloadEngine();
  });

  $('set-key').addEventListener('change', (ev) => {
    // Strip every whitespace character, not just the ends: a key copied out of
    // a wrapped terminal or chat window carries a line break through its
    // middle, which looks like nothing at all in a password field.
    if (keyWasDirty(ev.target.value)) {
      toast('Removed stray spaces from that key.');
    }
    ev.target.value = cleanKey(ev.target.value);
    setProviderKey(currentProvider(), ev.target.value);
    applySettings();
  });

  $('set-provider').addEventListener('change', (ev) => {
    memory.setSetting('provider', ev.target.value);
    syncSettingsControls();
    applyModelReadout();
    const p = providerFor(ev.target.value);
    if (p && p.browser === false && !providerKey(ev.target.value)) {
      toast(`${p.label} often blocks browser requests — OpenRouter is the easy alternative.`);
    }
  });

  // Changing the model re-derives which effort levels are on offer.
  $('set-model').addEventListener('change', (ev) => {
    const pid = currentProvider();
    if (pid === 'anthropic') {
      memory.setSetting('model', ev.target.value);
      populateEffortOptions(ev.target.value);
      memory.setSetting('effort', $('set-effort').value);
    } else {
      const models = { ...(memory.settings.providerModels || {}) };
      models[pid] = ev.target.value;
      memory.setSetting('providerModels', models);
    }
    applySettings();
  });
  $('set-effort').addEventListener('change', (ev) => {
    memory.setSetting('effort', ev.target.value);
    applySettings();
  });

  $('set-rate').addEventListener('input', (ev) => {
    const rate = Number(ev.target.value);
    memory.setSetting('rate', rate);
    $('rate-out').textContent = `${rate.toFixed(2)}x`;
  });

  el.settingsBtn.addEventListener('click', () => {
    loadVoiceOptions();
    syncSettingsControls();
    el.settings.showModal();
  });

  // Hand the brain over to whatever else is running JARVIS — the desktop MCP
  // server takes this file as-is. Facts and tasks only: the settings hold API
  // keys and the history is this browser's business.
  // Answering "is it my key or is it you?" without needing anyone to read a
  // stack trace. One minimal call, and whatever the provider says, verbatim.
  $('test-key-btn').addEventListener('click', async () => {
    const button = $('test-key-btn');
    const out = $('key-test-result');
    const pid = currentProvider();
    const key = cleanKey(providerKey(pid));

    out.textContent = describeKey(key, pid === 'anthropic' ? 'sk-ant-' : '');
    if (!key && !proxyMode) {
      out.textContent = 'No key set for this provider.';
      return;
    }

    button.disabled = true;
    const previous = button.textContent;
    button.textContent = 'Testing…';
    try {
      const result = await testCurrentKey();
      out.textContent = result;
    } catch (err) {
      out.textContent = `Could not reach the provider: ${err.message}`;
    } finally {
      button.disabled = false;
      button.textContent = previous;
    }
  });

  el.exportBtn.addEventListener('click', () => {
    const brain = { facts: memory.facts, tasks: memory.tasks, exportedAt: new Date().toISOString() };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(brain, null, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'jarvis-brain.json';
    a.click();
    URL.revokeObjectURL(url);
    toast(`Exported ${brain.facts.length} facts and ${brain.tasks.length} tasks.`);
  });

  el.wipeBtn.addEventListener('click', () => {
    if (!confirm('Erase all stored facts, tasks and conversation history?')) return;
    memory.wipe();
    el.transcript.innerHTML = '';
    renderLists();
    toast('Memory erased.');
  });
}

function applyModelReadout() {
  const kind = brainKind();
  if (kind === 'local') {
    el.statModel.textContent = localBrain.ready
      ? `local AI · ${(localBrain.modelId || '').split('-')[0] || 'ready'}`
      : 'local AI (not loaded)';
    el.statLink.textContent = 'no key';
    return;
  }
  if (kind === 'rules') {
    el.statModel.textContent = 'offline (rules)';
    el.statLink.textContent = 'no key';
    return;
  }
  const pid = currentProvider();
  if (pid !== 'anthropic') {
    const model = (memory.settings.providerModels || {})[pid] || providerFor(pid)?.models?.[0] || '';
    el.statModel.textContent = model;
    el.statLink.textContent = providerFor(pid)?.label?.split(' ')[0].toLowerCase() || pid;
    return;
  }
  const s = memory.settings;
  const effort = Brain.effortsFor(s.model).length ? ` · ${s.effort}` : '';
  el.statModel.textContent = `${shortModel(s.model)}${effort}`;
  el.statLink.textContent = proxyMode ? 'server proxy' : 'direct';
}

function applySettings() {
  const s = memory.settings;
  // Serious mode owns the accent (red) while it's on; don't fight it.
  if (serious) {
    document.documentElement.style.removeProperty('--accent');
    orb.setAccent('#ff5f6d');
  } else {
    setAccent(s.accent);
  }
  applyModelReadout();
  el.statVoice.textContent = s.speak ? 'on' : 'muted';
  if (s.alwaysListen) voice.start();
  else voice.stop();
  // Clap detection only makes sense once the mic analyser is live (post-boot).
  if (s.clapToDictate) voice.startClapWatch();
  else voice.stopClapWatch();
}

// --- connectors -------------------------------------------------------------

/** Is this connector switched on? Unset means on. */
function connectorOn(id) {
  return (memory.settings.connectors || {})[id] !== false;
}

function renderConnectors() {
  el.connGrid.innerHTML = '';
  el.connGrid.append(buildGmailCard());
  for (const [id, connector] of Object.entries(CONNECTORS)) {
    const on = connectorOn(id);

    const card = document.createElement('div');
    card.className = `conn__card ${on ? 'is-on' : 'is-off'}`;

    const head = document.createElement('div');
    head.className = 'conn__head';
    const name = document.createElement('span');
    name.className = 'conn__name';
    name.textContent = connector.name;

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'conn__toggle';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(on));
    toggle.setAttribute('aria-label', `${connector.name} connector`);
    toggle.addEventListener('click', () => {
      const next = { ...(memory.settings.connectors || {}) };
      next[id] = !connectorOn(id);
      memory.setSetting('connectors', next);
      renderConnectors();
    });

    head.append(name, toggle);

    const blurb = document.createElement('p');
    blurb.className = 'conn__blurb';
    blurb.textContent = connector.blurb;

    const eg = document.createElement('p');
    eg.className = 'conn__eg';
    eg.textContent = connector.example;

    card.append(head, blurb, eg);
    el.connGrid.append(card);
  }
}

/**
 * Real Gmail. Needs a Google OAuth client id the user creates themselves — no
 * shared credentials, and the token never leaves this tab.
 */
function buildGmailCard() {
  const card = document.createElement('div');
  card.className = `conn__card ${gmail.connected ? 'is-on' : 'is-off'}`;

  const head = document.createElement('div');
  head.className = 'conn__head';
  const name = document.createElement('span');
  name.className = 'conn__name';
  name.textContent = 'Gmail — real inbox';
  head.append(name);

  const blurb = document.createElement('p');
  blurb.className = 'conn__blurb';
  blurb.textContent = gmail.connected
    ? 'Connected. JARVIS can read and search your mail, and save drafts. It cannot send.'
    : 'Read and search your actual inbox, and save real drafts. Needs a free Google OAuth client ID that you create — nothing is shared.';

  const eg = document.createElement('p');
  eg.className = 'conn__eg';
  eg.textContent = gmail.connected
    ? '"Jarvis, anything unread from my boss?"'
    : 'Paste your client ID below, then sign in.';

  card.append(head, blurb, eg);

  if (!gmail.connected) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'conn__input';
    input.placeholder = '1234-abc.apps.googleusercontent.com';
    input.value = memory.settings.googleClientId || '';
    input.addEventListener('change', () => {
      memory.setSetting('googleClientId', input.value.trim());
    });

    const help = document.createElement('a');
    help.className = 'conn__link';
    help.href = 'https://console.cloud.google.com/apis/credentials';
    help.target = '_blank';
    help.rel = 'noopener';
    help.textContent = 'Get a client ID →';

    const signIn = document.createElement('button');
    signIn.type = 'button';
    signIn.className = 'conn__signin';
    signIn.textContent = 'Sign in with Google';
    signIn.addEventListener('click', () => {
      memory.setSetting('googleClientId', input.value.trim());
      if (!gmail.connect()) toast('Paste your Google client ID first.');
    });

    card.append(input, help, signIn);
  } else {
    const out = document.createElement('button');
    out.type = 'button';
    out.className = 'conn__signin';
    out.textContent = 'Disconnect';
    out.addEventListener('click', () => {
      gmail.disconnect();
      toast('Gmail disconnected.');
    });
    card.append(out);
  }
  return card;
}

function openConnectors() {
  renderConnectors();
  el.conn.hidden = false;
}

function closeConnectors() {
  el.conn.hidden = true;
}

// --- install as an app ------------------------------------------------------

/**
 * The "Install as an app" button, made to always do something sensible instead
 * of silently vanishing. The browser only fires `beforeinstallprompt` on a
 * served https/localhost page in Chrome/Edge, so on a `file://` page or Safari
 * we explain how to install rather than showing a dead button.
 */
function setupInstall() {
  const btn = $('install-btn');
  if (!btn) return;

  const installed = window.matchMedia?.('(display-mode: standalone)')?.matches
    || window.navigator.standalone === true;
  if (installed) {
    btn.hidden = true; // already an app
    return;
  }

  let prompt = null;
  btn.hidden = false; // always offer it; the handler adapts

  window.addEventListener('beforeinstallprompt', (ev) => {
    ev.preventDefault();
    prompt = ev;
    btn.textContent = 'Install as an app';
  });
  window.addEventListener('appinstalled', () => {
    btn.hidden = true;
    toast('JARVIS installed.');
  });

  btn.addEventListener('click', async () => {
    if (prompt) {
      prompt.prompt();
      const { outcome } = await prompt.userChoice.catch(() => ({}));
      if (outcome === 'accepted') btn.hidden = true;
      prompt = null;
      return;
    }
    // No native prompt available — say why and what to do instead.
    if (location.protocol === 'file:') {
      toast(`Open ${HOSTED_URL} in Chrome or Edge, then press Install there.`);
      window.open(HOSTED_URL, '_blank', 'noopener');
    } else if (/safari/i.test(navigator.userAgent) && !/chrome|chromium|edg/i.test(navigator.userAgent)) {
      toast('In Safari: Share → Add to Dock (or Add to Home Screen) to install.');
    } else {
      toast('Use your browser’s install icon in the address bar to install JARVIS.');
    }
  });
}

// --- boot -------------------------------------------------------------------

async function boot() {
  el.boot.classList.add('is-gone');
  el.hud.classList.add('is-live');

  // Requests mic access via the browser's own permission prompt — never forced.
  await voice.enableMic();
  orb.bindLevel(() => voice.level());
  orb.start();
  wave.bind((out) => voice.spectrum(out));
  wave.start();

  // If serious mode was left on last session, its snapshot is still stored.
  if (memory.state.seriousPrev) {
    serious = true;
    document.body.classList.add('is-serious');
  }

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

  const who = memory.settings.name ? `, ${memory.settings.name}` : '';
  const kind = brainKind();
  let greeting;
  if (kind === 'local') {
    greeting = `Local brain online${who}. Running entirely on this machine, no key needed.`;
  } else if (kind === 'rules') {
    greeting = `Running offline${who} — timers, tasks and memory work. Switch the brain to Local AI in settings for real conversation without a key.`;
  } else {
    greeting = who ? `Good to see you${who}. Standing by.` : 'Systems online. Standing by.';
  }
  bubble('jarvis', greeting);
  voice.say(greeting);
}

async function init() {
  // A transcript saved by an older build (or by a turn that was cut short) can
  // hold a tool call with no result, which every later request would be
  // rejected for. Heal it once, here, rather than stranding the user with an
  // assistant that can only answer with the same API error forever.
  const healed = repair(memory.history);
  if (JSON.stringify(healed) !== JSON.stringify(memory.history)) memory.replaceHistory(healed);

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

  setAccent(memory.settings.accent);
  wireSettings();
  renderLists();
  tickClock();
  setInterval(tickClock, 1000);

  if (!Voice.webSpeechSupported) {
    el.bootNote.textContent =
      "This browser has no built-in speech recognition, so JARVIS will use its on-device " +
      'engine — pick it in settings (it downloads a small model once). Typing always works.';
  }
  if (!proxyMode && !memory.settings.apiKey) {
    el.bootNote.textContent =
      'No API key needed to start — JARVIS runs offline and still does timers, tasks, ' +
      'memory and the clock. Paste an Anthropic key in settings whenever you want the full model.';
  }

  // speechSynthesis populates its voice list asynchronously.
  window.speechSynthesis?.addEventListener?.('voiceschanged', loadVoiceOptions);

  // PWA: register the service worker so JARVIS installs and runs offline. Only
  // over http(s) — a file:// page or the standalone single-file build has no SW.
  // BUILD-STRIP-START (removed from the single-file bundle)
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      // Actively adopt a new build instead of waiting for a lucky second
      // reload — an installed app otherwise sits on a stale copy for days.
      reg.addEventListener('updatefound', () => {
        const fresh = reg.installing;
        if (!fresh) return;
        fresh.addEventListener('statechange', () => {
          if (fresh.state === 'installed' && navigator.serviceWorker.controller) {
            fresh.postMessage('skip-waiting');
            toast('Updating JARVIS…');
          }
        });
      });
      reg.update().catch(() => {});
    }).catch(() => {
      /* first run offline, or SW unsupported — the app still works. */
    });

    // When the new worker takes over, reload once so the fresh build is live.
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });
  }
  // BUILD-STRIP-END

  // Google may have just redirected back with a token in the fragment.
  const adopted = gmail.adoptRedirect();
  if (adopted?.error) toast(`Gmail sign-in failed: ${adopted.error}`);
  else if (adopted?.token) toast('Gmail connected.');

  setupInstall();

  // Memory brain: open from the panel, close with the button or Escape.
  el.brainBtn.addEventListener('click', openMind);
  el.connBtn.addEventListener('click', openConnectors);
  el.connClose.addEventListener('click', closeConnectors);
  el.mindClose.addEventListener('click', closeMind);
  el.mindSearch.addEventListener('input', (ev) => {
    mind.setFilter(ev.target.value);
  });

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
      if (!el.conn.hidden) {
        closeConnectors();
        return;
      }
      if (!el.mind.hidden) {
        closeMind();
        return;
      }
      voice.cancelSpeech();
      engine().abort();
      return;
    }
    // "B" opens the brain, unless you're typing.
    if ((ev.key === 'b' || ev.key === 'B') && !['INPUT', 'TEXTAREA'].includes(ev.target.tagName)) {
      if (el.mind.hidden) openMind();
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
