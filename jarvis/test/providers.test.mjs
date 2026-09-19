/**
 * Multi-provider adapter: message/tool translation and stream parsing. These
 * are the parts that silently corrupt a conversation if they're wrong, so they
 * are tested without needing any key.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROVIDERS, providerFor, toOpenAITools, toOpenAIMessages,
  accumulateToolCalls, toToolUseBlocks, explainError, ProviderBrain,
} from '../public/js/providers.js';

test('every provider is usably described', () => {
  for (const [id, p] of Object.entries(PROVIDERS)) {
    assert.ok(p.label, `${id} has a label`);
    assert.ok(p.keyUrl, `${id} says where to get a key`);
    if (!p.native) {
      assert.ok(p.baseUrl, `${id} has an endpoint`);
      assert.ok(p.models?.length, `${id} suggests models`);
    }
  }
  assert.ok(providerFor('openai'));
  assert.equal(providerFor('nope'), null);
});

test('tool definitions convert to OpenAI functions', () => {
  const fns = toOpenAITools([
    { name: 'set_timer', description: 'Start a timer.', input_schema: { type: 'object', properties: { seconds: {} } } },
  ]);
  assert.equal(fns[0].type, 'function');
  assert.equal(fns[0].function.name, 'set_timer');
  assert.deepEqual(fns[0].function.parameters.properties, { seconds: {} });
  assert.equal(toOpenAITools([]), undefined, 'no tools means the field is omitted');
});

test('a tool round trip converts to the OpenAI message shape', () => {
  const msgs = toOpenAIMessages('You are JARVIS.', [
    { role: 'user', content: 'tea timer' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Setting that.' },
        { type: 'tool_use', id: 'call_1', name: 'set_timer', input: { seconds: 300 } },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'Timer set.' }] },
  ]);

  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[1].content, 'tea timer');

  const assistant = msgs[2];
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.tool_calls[0].id, 'call_1');
  assert.equal(assistant.tool_calls[0].function.name, 'set_timer');
  assert.equal(assistant.tool_calls[0].function.arguments, '{"seconds":300}', 'arguments are a JSON string');

  const toolMsg = msgs[3];
  assert.equal(toolMsg.role, 'tool', 'results use the tool role, not user');
  assert.equal(toolMsg.tool_call_id, 'call_1', 'and are tied back to the call');
});

test('tool call fragments stitch back together across deltas', () => {
  const acc = [];
  accumulateToolCalls(acc, [{ index: 0, id: 'call_9', function: { name: 'set_', arguments: '{"sec' } }]);
  accumulateToolCalls(acc, [{ index: 0, function: { name: 'timer', arguments: 'onds":600}' } }]);
  const blocks = toToolUseBlocks(acc);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].name, 'set_timer', 'the name arrived in two pieces');
  assert.deepEqual(blocks[0].input, { seconds: 600 });
  assert.equal(blocks[0].type, 'tool_use', 'converted back to the shape the app expects');
});

test('two parallel tool calls stay separate', () => {
  const acc = [];
  accumulateToolCalls(acc, [
    { index: 0, id: 'a', function: { name: 'one', arguments: '{}' } },
    { index: 1, id: 'b', function: { name: 'two', arguments: '{}' } },
  ]);
  assert.deepEqual(toToolUseBlocks(acc).map((b) => b.name), ['one', 'two']);
});

test('malformed tool arguments degrade instead of throwing', () => {
  const acc = [{ id: 'x', name: 'broken', args: '{not json' }];
  assert.deepEqual(toToolUseBlocks(acc)[0].input, {});
});

test('errors are explained in terms a person can act on', () => {
  assert.match(explainError(401, '{}', 'OpenAI'), /rejected the key/);
  assert.match(explainError(404, '{}', 'Groq'), /model/);
  assert.match(explainError(429, '{}', 'Groq'), /rate limiting/);
  assert.match(explainError(500, '{"error":{"message":"boom"}}', 'xAI'), /boom/);
});

test('a missing key is refused before any request is made', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; };
  const brain = new ProviderBrain({ getSettings: () => ({ provider: 'openai', providerKeys: {} }) });
  await assert.rejects(() => brain.stream({ system: '', messages: [], tools: [] }), /No API key for OpenAI/);
  assert.equal(called, false, 'no pointless network call');
});

test('streams text and tool calls out of an OpenAI-shaped SSE body', async () => {
  const frames = [
    { choices: [{ delta: { content: 'Setting ' } }] },
    { choices: [{ delta: { content: 'that.' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'set_timer', arguments: '{"seconds":60}' } }] } }] },
    { choices: [{ finish_reason: 'tool_calls' }] },
  ];
  const sse = `${frames.map((f) => `data: ${JSON.stringify(f)}`).join('\n')}\ndata: [DONE]\n`;
  const bytes = new TextEncoder().encode(sse);

  globalThis.fetch = async () => ({
    ok: true,
    body: new ReadableStream({
      start(c) {
        // Chop mid-frame, like a real network.
        for (let i = 0; i < bytes.length; i += 13) c.enqueue(bytes.slice(i, i + 13));
        c.close();
      },
    }),
  });

  const brain = new ProviderBrain({
    getSettings: () => ({ provider: 'groq', providerKeys: { groq: 'gsk_test' } }),
  });
  let spoken = '';
  const result = await brain.stream({ system: 's', messages: [], tools: [] }, { text: (d) => { spoken += d; } });

  assert.equal(spoken, 'Setting that.');
  assert.equal(result.stopReason, 'tool_use');
  assert.equal(result.content.find((b) => b.type === 'text').text, 'Setting that.');
  assert.deepEqual(result.content.find((b) => b.type === 'tool_use').input, { seconds: 60 });
});
