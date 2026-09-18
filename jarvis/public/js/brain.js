/**
 * The talking-to-Claude half of JARVIS.
 *
 * Streams the Messages API over SSE and rebuilds the assistant's content
 * blocks as they arrive, so the UI can render text and the voice can start
 * speaking before the turn is finished.
 *
 * Two transports:
 *   - proxy mode  (default) -> POST /api/chat, key stays on the server
 *   - direct mode (fallback) -> api.anthropic.com from the browser, using a key
 *     the user pasted into settings
 */
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/** Deliberately short: this is a spoken assistant, not an essay writer. */
const MAX_TOKENS = 4096;

export class Brain {
  /** @param {{ proxy: boolean, getSettings: () => object }} options */
  constructor({ proxy, getSettings }) {
    this.proxy = proxy;
    this.getSettings = getSettings;
    this.controller = null;
  }

  abort() {
    this.controller?.abort();
    this.controller = null;
  }

  /**
   * Run one streamed turn.
   *
   * @param {object} req  { system, messages, tools }
   * @param {object} on   { text, toolUse, blockStart } callbacks
   * @returns {Promise<{content: object[], stopReason: string|null, model: string|null}>}
   */
  async stream({ system, messages, tools }, on = {}) {
    const settings = this.getSettings();
    const body = {
      model: settings.model,
      max_tokens: MAX_TOKENS,
      system,
      messages,
      stream: true,
      output_config: { effort: settings.effort || 'low' },
    };
    if (tools?.length) body.tools = tools;

    this.controller = new AbortController();
    const [url, init] = this.#request(body);
    const res = await fetch(url, init);

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(this.#explain(res.status, detail));
    }

    return this.#consume(res, on);
  }

  #request(body) {
    const settings = this.getSettings();
    if (this.proxy) {
      return [
        '/api/chat',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: this.controller.signal,
        },
      ];
    }
    if (!settings.apiKey) {
      throw new Error('No API key. Add one in settings, or start the server with ANTHROPIC_API_KEY set.');
    }
    return [
      API_URL,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': settings.apiKey,
          'anthropic-version': API_VERSION,
          // Required to call the API straight from a browser.
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
        signal: this.controller.signal,
      },
    ];
  }

  #explain(status, detail) {
    let message = detail;
    try {
      message = JSON.parse(detail)?.error?.message || JSON.parse(detail)?.error || detail;
    } catch {
      // Non-JSON error body; use it as-is.
    }
    if (status === 401) return 'The API key was rejected (401). Check it in settings.';
    if (status === 429) return 'Rate limited (429). Give it a moment and try again.';
    if (status === 501) return String(message);
    return `API error ${status}: ${message || 'no detail'}`;
  }

  /** Parse the SSE stream into finished content blocks. */
  async #consume(res, on) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const blocks = [];
    let stopReason = null;
    let model = null;
    let buffer = '';
    const partialJson = new Map(); // block index -> accumulated input_json_delta

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line.
      let split;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);

        const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;

        let event;
        try {
          event = JSON.parse(dataLine.slice(5).trim());
        } catch {
          continue;
        }

        switch (event.type) {
          case 'message_start':
            model = event.message?.model || null;
            break;

          case 'content_block_start': {
            const block = structuredClone(event.content_block);
            blocks[event.index] = block;
            if (block.type === 'tool_use' || block.type === 'server_tool_use') {
              partialJson.set(event.index, '');
            }
            on.blockStart?.(block);
            break;
          }

          case 'content_block_delta': {
            const block = blocks[event.index];
            const delta = event.delta;
            if (!block || !delta) break;
            if (delta.type === 'text_delta') {
              block.text = (block.text || '') + delta.text;
              on.text?.(delta.text);
            } else if (delta.type === 'thinking_delta') {
              block.thinking = (block.thinking || '') + delta.thinking;
            } else if (delta.type === 'signature_delta') {
              block.signature = (block.signature || '') + delta.signature;
            } else if (delta.type === 'input_json_delta') {
              partialJson.set(event.index, (partialJson.get(event.index) || '') + delta.partial_json);
            }
            break;
          }

          case 'content_block_stop': {
            const block = blocks[event.index];
            if (block && partialJson.has(event.index)) {
              const raw = partialJson.get(event.index);
              // Tool inputs always arrive as JSON text; an empty string means no args.
              try {
                block.input = raw ? JSON.parse(raw) : {};
              } catch {
                block.input = {};
                block._parseError = raw;
              }
              partialJson.delete(event.index);
              if (block.type === 'tool_use') on.toolUse?.(block);
            }
            break;
          }

          case 'message_delta':
            stopReason = event.delta?.stop_reason ?? stopReason;
            break;

          case 'error':
            throw new Error(event.error?.message || 'Stream error');

          default:
            break;
        }
      }
    }

    this.controller = null;
    return { content: blocks.filter(Boolean), stopReason, model };
  }
}
