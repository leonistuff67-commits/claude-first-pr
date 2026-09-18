/**
 * Unit test for the SSE parser in public/js/brain.js.
 *
 * The stream is deliberately cut into chunks that split frames mid-way, because
 * that is what a real network delivers and it is the easiest thing to get wrong.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Brain } from '../public/js/brain.js';

const FRAMES = [
  { type: 'message_start', message: { model: 'claude-opus-5' } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Checking' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' that.' } },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'toolu_1', name: 'set_timer', input: {} },
  },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"seco' } },
  {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: 'nds": 600, "label": "pasta"}' },
  },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
  { type: 'message_stop' },
];

function streamOf(frames, chunkSize = 17) {
  const sse = frames.map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join('');
  const bytes = new TextEncoder().encode(sse);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize));
      }
      controller.close();
    },
  });
}

const settings = () => ({ model: 'claude-opus-5', effort: 'low' });

test('rebuilds text and tool blocks from a chunk-split stream', async () => {
  globalThis.fetch = async () => ({ ok: true, body: streamOf(FRAMES) });

  const brain = new Brain({ proxy: true, getSettings: settings });
  let spoken = '';
  const toolCalls = [];

  const result = await brain.stream(
    { system: 'test', messages: [{ role: 'user', content: 'ten minute pasta timer' }], tools: [] },
    { text: (d) => { spoken += d; }, toolUse: (b) => toolCalls.push(b) },
  );

  assert.equal(spoken, 'Checking that.', 'text deltas arrive in order');
  assert.equal(result.stopReason, 'tool_use');
  assert.equal(result.model, 'claude-opus-5');
  assert.equal(result.content.length, 2);
  assert.equal(result.content[0].text, 'Checking that.');
  assert.deepEqual(
    result.content[1].input,
    { seconds: 600, label: 'pasta' },
    'input_json_delta fragments reassemble into one object',
  );
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].name, 'set_timer');
});

test('turns an HTTP failure into a readable message', async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ error: { message: 'invalid x-api-key' } }),
  });

  const brain = new Brain({ proxy: true, getSettings: settings });
  await assert.rejects(
    () => brain.stream({ system: '', messages: [], tools: [] }, {}),
    /rejected \(401\)/,
  );
});

test('malformed tool JSON degrades instead of throwing', async () => {
  const broken = FRAMES.map((f) =>
    f.type === 'content_block_delta' && f.delta?.type === 'input_json_delta'
      ? { ...f, delta: { ...f.delta, partial_json: '{not json' } }
      : f,
  );
  globalThis.fetch = async () => ({ ok: true, body: streamOf(broken) });

  const brain = new Brain({ proxy: true, getSettings: settings });
  const result = await brain.stream({ system: '', messages: [], tools: [] }, {});
  assert.deepEqual(result.content[1].input, {}, 'falls back to empty input');
});
