/**
 * The local (in-browser) brain's pure logic: model resolution, the tool
 * protocol, and converting Anthropic-shaped history into flat chat messages.
 * No GPU or network needed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveModelId, buildToolPrompt, parseToolCall, toChatMessages,
} from '../public/js/localbrain.js';

test('prefers a known-good model when the runtime offers it', () => {
  const available = [
    { model_id: 'Llama-3.1-70B-Instruct-q4f16_1-MLC' },
    { model_id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC' },
  ];
  assert.equal(resolveModelId(available), 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC');
});

test('honours an explicit choice when it exists, ignores it when it does not', () => {
  const available = [{ model_id: 'gemma-2-2b-it-q4f16_1-MLC' }, { model_id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC' }];
  assert.equal(resolveModelId(available, 'gemma-2-2b-it-q4f16_1-MLC'), 'gemma-2-2b-it-q4f16_1-MLC');
  assert.equal(
    resolveModelId(available, 'Some-Model-That-Was-Renamed'),
    'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
    'falls back rather than requesting a dead id',
  );
});

test('falls back to the smallest instruct model when nothing is recognised', () => {
  const available = [
    { model_id: 'Mystery-13B-Instruct-q4f16_1-MLC' },
    { model_id: 'Mystery-2B-Instruct-q4f16_1-MLC' },
    { model_id: 'Mystery-7B-Instruct-q4f16_1-MLC' },
  ];
  assert.equal(resolveModelId(available), 'Mystery-2B-Instruct-q4f16_1-MLC');
});

test('tool prompt lists every tool with its arguments', () => {
  const prompt = buildToolPrompt([
    { name: 'set_timer', description: 'Start a countdown timer. More detail.', input_schema: { properties: { seconds: {}, label: {} } } },
  ]);
  assert.match(prompt, /set_timer\(seconds, label\)/);
  assert.match(prompt, /"tool"/);
  assert.equal(buildToolPrompt([]), '', 'no tools, no prompt noise');
});

test('parses a tool call, fenced or bare, with nested input', () => {
  assert.deepEqual(
    parseToolCall('{"tool":"set_timer","input":{"seconds":600,"label":"pasta"}}'),
    { name: 'set_timer', input: { seconds: 600, label: 'pasta' } },
  );
  assert.deepEqual(
    parseToolCall('```json\n{"tool":"list_tasks","input":{}}\n```'),
    { name: 'list_tasks', input: {} },
  );
  assert.deepEqual(
    parseToolCall('{"tool":"remember","input":{"fact":"likes {curly} braces"}}').input.fact,
    'likes {curly} braces',
  );
});

test('plain prose is not mistaken for a tool call', () => {
  assert.equal(parseToolCall('Your timer is set for ten minutes.'), null);
  assert.equal(parseToolCall(''), null);
  assert.equal(parseToolCall('{not json at all'), null);
  assert.equal(parseToolCall('{"something":"else"}'), null, 'JSON without a tool key is not a call');
});

test('history converts to flat chat messages', () => {
  const chat = toChatMessages('You are JARVIS.', [
    { role: 'user', content: 'set a tea timer' },
    { role: 'assistant', content: [{ type: 'text', text: 'Setting that.' }, { type: 'tool_use', name: 'set_timer', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', content: 'Timer "tea" set for 5m.' }] },
  ]);
  assert.equal(chat[0].role, 'system');
  assert.equal(chat[1].content, 'set a tea timer');
  assert.equal(chat[2].role, 'assistant');
  assert.match(chat[3].content, /Timer "tea" set for 5m/);
  assert.equal(chat[3].role, 'user', 'tool results arrive as user text for small models');
});
