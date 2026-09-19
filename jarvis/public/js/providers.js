/**
 * Other AI providers.
 *
 * Almost every major API now speaks the OpenAI chat-completions shape — and
 * Google exposes Gemini through an OpenAI-compatible endpoint — so one adapter
 * covers all of them. Anthropic keeps its own client (brain.js) because its
 * wire format genuinely differs.
 *
 * The conversion helpers are pure so the message and tool translation can be
 * tested without a key.
 */

/**
 * Each provider: where to send requests, some current models, and where to get
 * a key. `browser` notes whether the API is usually callable straight from a
 * page — several block cross-origin requests, in which case use the local
 * server proxy or a gateway like OpenRouter.
 */
export const PROVIDERS = {
  anthropic: {
    label: 'Claude (Anthropic)',
    native: true, // handled by brain.js
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyPrefix: 'sk-ant-',
    browser: true,
  },
  openai: {
    label: 'OpenAI (GPT)',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini', 'o4-mini'],
    keyUrl: 'https://platform.openai.com/api-keys',
    keyPrefix: 'sk-',
    browser: true,
  },
  google: {
    label: 'Google Gemini',
    // Google's OpenAI-compatibility layer, so the same adapter works.
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
    keyUrl: 'https://aistudio.google.com/apikey',
    browser: true,
  },
  groq: {
    label: 'Groq (very fast)',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
    keyUrl: 'https://console.groq.com/keys',
    keyPrefix: 'gsk_',
    browser: true,
  },
  openrouter: {
    label: 'OpenRouter (one key, many models)',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      'anthropic/claude-sonnet-4.5',
      'openai/gpt-4o-mini',
      'google/gemini-2.0-flash-001',
      'meta-llama/llama-3.3-70b-instruct',
      'deepseek/deepseek-chat',
    ],
    keyUrl: 'https://openrouter.ai/keys',
    keyPrefix: 'sk-or-',
    browser: true,
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
    browser: false,
  },
  mistral: {
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    models: ['mistral-large-latest', 'mistral-small-latest', 'open-mistral-nemo'],
    keyUrl: 'https://console.mistral.ai/api-keys',
    browser: false,
  },
  xai: {
    label: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    models: ['grok-4', 'grok-3', 'grok-3-mini'],
    keyUrl: 'https://console.x.ai',
    keyPrefix: 'xai-',
    browser: false,
  },
  ollama: {
    label: 'Ollama (on your own machine)',
    baseUrl: 'http://localhost:11434/v1',
    models: ['llama3.2', 'qwen2.5', 'mistral', 'phi4'],
    keyUrl: 'https://ollama.com/download',
    noKey: true,
    browser: true,
  },
};

export function providerIds() {
  return Object.keys(PROVIDERS);
}

export function providerFor(id) {
  return PROVIDERS[id] || null;
}

/** Anthropic tool definitions -> OpenAI function definitions. */
export function toOpenAITools(tools) {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }));
}

/**
 * The Anthropic-shaped history app.js keeps -> OpenAI messages.
 * tool_use becomes an assistant message with tool_calls; tool_result becomes a
 * message with the `tool` role, which is what the OpenAI format expects.
 */
export function toOpenAIMessages(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages || []) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks = Array.isArray(m.content) ? m.content : [];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    const calls = blocks.filter((b) => b.type === 'tool_use');
    const results = blocks.filter((b) => b.type === 'tool_result');

    if (results.length) {
      for (const r of results) {
        out.push({
          role: 'tool',
          tool_call_id: r.tool_use_id,
          content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content),
        });
      }
      continue;
    }
    if (calls.length) {
      out.push({
        role: 'assistant',
        content: text || null,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.input || {}) },
        })),
      });
      continue;
    }
    if (text) out.push({ role: m.role, content: text });
  }
  return out;
}

/**
 * Fold a streamed delta into an accumulator of tool calls. OpenAI sends tool
 * call arguments in fragments keyed by index, exactly like Anthropic's
 * input_json_delta, so they have to be stitched together.
 */
export function accumulateToolCalls(acc, deltaCalls) {
  for (const call of deltaCalls || []) {
    const i = call.index ?? 0;
    if (!acc[i]) acc[i] = { id: call.id || `call_${i}`, name: '', args: '' };
    if (call.id) acc[i].id = call.id;
    if (call.function?.name) acc[i].name += call.function.name;
    if (call.function?.arguments) acc[i].args += call.function.arguments;
  }
  return acc;
}

/** Finished accumulator -> Anthropic-shaped tool_use blocks. */
export function toToolUseBlocks(acc) {
  return acc.filter(Boolean).map((c) => {
    let input = {};
    try {
      input = c.args ? JSON.parse(c.args) : {};
    } catch {
      input = {};
    }
    return { type: 'tool_use', id: c.id, name: c.name, input };
  });
}

/** Turn an HTTP failure into something a person can act on. */
export function explainError(status, body, providerLabel) {
  let message = body;
  try {
    const parsed = JSON.parse(body);
    message = parsed?.error?.message || parsed?.message || body;
  } catch {
    // Not JSON; use as-is.
  }
  if (status === 401 || status === 403) return `${providerLabel} rejected the key (${status}). Check it in settings.`;
  if (status === 404) return `${providerLabel} doesn't have that model (404). Pick another in settings.`;
  if (status === 429) return `${providerLabel} is rate limiting you (429). Wait a moment.`;
  return `${providerLabel} error ${status}: ${String(message).slice(0, 200) || 'no detail'}`;
}

/** Streams any OpenAI-compatible provider, exposing the same contract as Brain. */
export class ProviderBrain {
  /** @param {{getSettings: () => object}} options */
  constructor({ getSettings }) {
    this.getSettings = getSettings;
    this.controller = null;
    this.betas = [];
  }

  abort() {
    this.controller?.abort();
    this.controller = null;
  }

  #config() {
    const s = this.getSettings();
    const id = s.provider || 'openai';
    const provider = providerFor(id);
    if (!provider) throw new Error(`Unknown provider "${id}".`);
    const key = (s.providerKeys || {})[id] || '';
    if (!provider.noKey && !key) {
      throw new Error(`No API key for ${provider.label}. Add one in settings.`);
    }
    const model = (s.providerModels || {})[id] || provider.models?.[0];
    return { id, provider, key, model };
  }

  async stream({ system, messages, tools }, on = {}) {
    const { provider, key, model } = this.#config();

    const body = {
      model,
      messages: toOpenAIMessages(system, messages),
      stream: true,
      max_tokens: 1024,
    };
    const fnTools = toOpenAITools(tools);
    if (fnTools) body.tools = fnTools;

    this.controller = new AbortController();
    const headers = { 'content-type': 'application/json' };
    if (key) headers.authorization = `Bearer ${key}`;
    // OpenRouter asks callers to identify themselves.
    if (provider.baseUrl.includes('openrouter')) headers['x-title'] = 'JARVIS';

    let res;
    try {
      res = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: this.controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new Error(
        `Couldn't reach ${provider.label}.`
        + (provider.browser === false
          ? ' This provider usually blocks requests straight from a browser — try OpenRouter, or run the local server.'
          : ' Check your connection.'),
      );
    }

    if (!res.ok) {
      throw new Error(explainError(res.status, await res.text().catch(() => ''), provider.label));
    }

    return this.#consume(res, on, model);
  }

  async #consume(res, on, model) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let finish = null;
    const toolAcc = [];

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let split;
      while ((split = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, split).trim();
        buffer = buffer.slice(split + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;

        let event;
        try {
          event = JSON.parse(payload);
        } catch {
          continue;
        }
        const choice = event.choices?.[0];
        if (!choice) continue;
        if (choice.delta?.content) {
          text += choice.delta.content;
          on.text?.(choice.delta.content);
        }
        if (choice.delta?.tool_calls) accumulateToolCalls(toolAcc, choice.delta.tool_calls);
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    }

    this.controller = null;
    const blocks = [];
    if (text.trim()) blocks.push({ type: 'text', text });
    const calls = toToolUseBlocks(toolAcc);
    for (const call of calls) on.toolUse?.(call);
    blocks.push(...calls);

    return {
      content: blocks,
      stopReason: calls.length ? 'tool_use' : (finish === 'length' ? 'max_tokens' : 'end_turn'),
      model,
    };
  }
}
