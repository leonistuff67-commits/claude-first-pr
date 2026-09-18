/**
 * The local brain — a real language model running in this browser on WebGPU,
 * with no API key, no account and no cost.
 *
 * It speaks the same `stream()` contract as brain.js (Claude) and offline.js
 * (the rule matcher), so the turn loop in app.js doesn't care which is driving.
 *
 * Small local models are not reliable at native function calling, so tools are
 * offered through a plain JSON protocol described in the system prompt and
 * parsed back out here. The parsing and message conversion are pure functions
 * so they can be unit-tested without a GPU.
 */
const WEBLLM_CDN = 'https://esm.run/@mlc-ai/web-llm';

/**
 * Speed tiers offered in settings. Smaller is dramatically faster on modest
 * hardware; "balanced" is the default.
 */
export const SPEED_TIERS = [
  { id: 'fastest', label: 'Fastest — smallest model, ~0.4 GB', models: ['Qwen2.5-0.5B-Instruct-q4f16_1-MLC', 'Qwen2-0.5B-Instruct-q4f16_1-MLC', 'TinyLlama-1.1B-Chat-v1.0-q4f16_1-MLC'] },
  { id: 'balanced', label: 'Balanced — ~1 GB (default)', models: ['Qwen2.5-1.5B-Instruct-q4f16_1-MLC', 'Llama-3.2-1B-Instruct-q4f32_1-MLC', 'Llama-3.2-1B-Instruct-q4f16_1-MLC'] },
  { id: 'smartest', label: 'Smartest — ~2 GB, slowest', models: ['Llama-3.2-3B-Instruct-q4f16_1-MLC', 'gemma-2-2b-it-q4f16_1-MLC', 'Phi-3.5-mini-instruct-q4f16_1-MLC'] },
];

/** Preferred small models, best-first. Resolved against what WebLLM ships. */
const PREFERRED = [
  'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
  'Llama-3.2-1B-Instruct-q4f32_1-MLC',
  'Llama-3.2-1B-Instruct-q4f16_1-MLC',
  'gemma-2-2b-it-q4f16_1-MLC',
  'Phi-3.5-mini-instruct-q4f16_1-MLC',
];

export function webGpuSupported() {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

/**
 * Pick a model id that actually exists in this build of WebLLM. Preferring a
 * known-good list but falling back to the smallest instruct model avoids
 * hard-coding an id that may have been renamed.
 */
export function resolveModelId(available, wanted, tier) {
  const ids = (available || []).map((m) => (typeof m === 'string' ? m : m.model_id)).filter(Boolean);
  if (!ids.length) return wanted || PREFERRED[0];
  if (wanted && ids.includes(wanted)) return wanted;

  // Honour the chosen speed tier before the generic preference list.
  const wantedTier = SPEED_TIERS.find((t) => t.id === tier);
  if (wantedTier) {
    for (const id of wantedTier.models) if (ids.includes(id)) return id;
  }

  for (const id of PREFERRED) if (ids.includes(id)) return id;
  // Smallest instruct-tuned model we can find, by the parameter count in its name.
  const scored = ids
    .filter((id) => /instruct|-it-|chat/i.test(id))
    .map((id) => ({ id, size: Number((id.match(/(\d+(?:\.\d+)?)B/i) || [])[1] || 99) }))
    .sort((a, b) => a.size - b.size);
  return scored[0]?.id || ids[0];
}

/** The tool contract we teach the model, since small models can't be trusted with schemas. */
export function buildToolPrompt(tools) {
  if (!tools?.length) return '';
  const lines = tools.map((t) => {
    const params = Object.keys(t.input_schema?.properties || {});
    return `- ${t.name}(${params.join(', ')}): ${t.description.split('.')[0]}.`;
  });
  return [
    '',
    'You can use these tools:',
    ...lines,
    '',
    'To use one, reply with ONLY this JSON and nothing else:',
    '{"tool": "tool_name", "input": {"arg": "value"}}',
    'Otherwise just answer normally in one or two short sentences. Never mention the JSON format to the user.',
  ].join('\n');
}

/** Pull a tool call out of a model reply, tolerating code fences and stray prose. */
export function parseToolCall(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  if (start === -1) return null;

  // Walk braces so nested objects in `input` survive.
  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    if (cleaned[i] === '{') depth++;
    else if (cleaned[i] === '}') {
      depth--;
      if (depth === 0) {
        try {
          const obj = JSON.parse(cleaned.slice(start, i + 1));
          if (obj && typeof obj.tool === 'string') {
            return { name: obj.tool, input: obj.input && typeof obj.input === 'object' ? obj.input : {} };
          }
        } catch {
          return null;
        }
        return null;
      }
    }
  }
  return null;
}

/**
 * Convert the Anthropic-shaped history app.js keeps into flat chat messages.
 * Tool results become plain user text, which small models handle far better
 * than a structured tool-result role.
 */
export function toChatMessages(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages || []) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks = Array.isArray(m.content) ? m.content : [];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
    const calls = blocks.filter((b) => b.type === 'tool_use');
    const results = blocks.filter((b) => b.type === 'tool_result');

    if (results.length) {
      const joined = results
        .map((r) => (typeof r.content === 'string' ? r.content : JSON.stringify(r.content)))
        .join('\n');
      out.push({ role: 'user', content: `Tool result:\n${joined}\n\nAnswer the user using this result.` });
      continue;
    }
    if (calls.length) {
      out.push({ role: 'assistant', content: text || `(used ${calls.map((c) => c.name).join(', ')})` });
      continue;
    }
    if (text) out.push({ role: m.role, content: text });
  }
  return out;
}

let libPromise = null;
function loadWebLLM() {
  if (!libPromise) libPromise = import(/* @vite-ignore */ WEBLLM_CDN);
  return libPromise;
}

let callId = 0;

export class LocalBrain {
  /** @param {{getSettings: () => object, on?: {progress?: Function, ready?: Function}}} opts */
  constructor({ getSettings, on = {} }) {
    this.getSettings = getSettings;
    this.on = on;
    this.engine = null;
    this.modelId = null;
    this.loading = null;
    this.betas = [];
  }

  abort() {
    // WebLLM has no mid-generation abort we can rely on; the turn is short.
  }

  get ready() {
    return Boolean(this.engine);
  }

  /** Download + spin up the model. Safe to call repeatedly. */
  async load() {
    if (this.engine) return this.engine;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      if (!webGpuSupported()) {
        throw new Error('This browser has no WebGPU, so the local AI can’t run. Chrome or Edge on a recent machine can.');
      }
      const webllm = await loadWebLLM().catch(() => {
        throw new Error('Could not download the local AI engine. Check your connection and try again.');
      });
      const available = webllm.prebuiltAppConfig?.model_list || [];
      this.modelId = resolveModelId(available, this.getSettings().localModel, this.getSettings().localSpeed);

      this.engine = await webllm.CreateMLCEngine(this.modelId, {
        initProgressCallback: (p) => {
          this.on.progress?.(p?.progress ?? 0, p?.text || 'loading');
        },
      });
      this.on.ready?.(this.modelId);
      return this.engine;
    })();

    try {
      return await this.loading;
    } finally {
      this.loading = null;
    }
  }

  /** Same shape as Brain.stream / OfflineBrain.stream. */
  async stream(request, on = {}) {
    try {
      return await this.#generate(request, on);
    } finally {
      this.on.busy?.(false);
    }
  }

  async #generate({ system, messages, tools }, on = {}) {
    const engine = await this.load();
    const chat = toChatMessages(`${system}${buildToolPrompt(tools)}`, messages);

    // Spoken replies are short, and every extra token costs real time on a
    // small GPU. Tell the UI to stop animating while we generate.
    this.on.busy?.(true);
    const reply = await engine.chat.completions.create({
      messages: chat,
      stream: true,
      temperature: 0.6,
      max_tokens: 200,
    });

    // Buffer the opening characters: if it turns out to be a tool call we must
    // not have spoken the raw JSON aloud.
    let full = '';
    let emitted = 0;
    let decided = false;
    let isTool = false;

    for await (const chunk of reply) {
      const delta = chunk.choices?.[0]?.delta?.content || '';
      if (!delta) continue;
      full += delta;

      if (!decided) {
        const trimmed = full.trimStart();
        if (!trimmed) continue;
        // A tool call always starts with a brace (possibly fenced).
        const looksToolish = trimmed.startsWith('{') || trimmed.startsWith('```');
        if (looksToolish) {
          isTool = true;
          decided = true;
          continue;
        }
        if (trimmed.length >= 3) decided = true; // plain prose
      }
      if (decided && !isTool) {
        on.text?.(full.slice(emitted));
        emitted = full.length;
      }
    }

    if (isTool) {
      const call = parseToolCall(full);
      if (call) {
        const block = { type: 'tool_use', id: `local_${++callId}`, name: call.name, input: call.input };
        on.toolUse?.(block);
        return { content: [block], stopReason: 'tool_use', model: this.modelId };
      }
      // It opened with a brace but wasn't a usable call — speak it rather than
      // swallowing the turn.
      on.text?.(full);
    }

    const text = full.trim();
    return {
      content: [{ type: 'text', text }],
      stopReason: 'end_turn',
      model: this.modelId,
    };
  }
}
