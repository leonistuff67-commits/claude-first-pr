/**
 * The Messages API rejects a transcript where a tool_use has no tool_result in
 * the next message — and because the transcript is saved, one bad round would
 * otherwise break every later request. These cover the repair that prevents it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { repair, sanitize } from '../public/js/history.js';

const user = (text) => ({ role: 'user', content: text });
const call = (id, name = 'open_app') => ({ type: 'tool_use', id, name, input: {} });
const answer = (id, content = 'done') => ({ type: 'tool_result', tool_use_id: id, content });

/** Every tool_use must be answered by the very next message. */
function pairsAreValid(messages) {
  for (let i = 0; i < messages.length; i++) {
    const blocks = Array.isArray(messages[i].content) ? messages[i].content : [];
    const ids = blocks.filter((b) => b.type === 'tool_use').map((b) => b.id);
    if (!ids.length) continue;
    const next = messages[i + 1];
    const answered = new Set(
      (Array.isArray(next?.content) ? next.content : [])
        .filter((b) => b.type === 'tool_result')
        .map((b) => b.tool_use_id),
    );
    if (!ids.every((id) => answered.has(id))) return false;
  }
  return true;
}

test('a complete tool round survives untouched', () => {
  const messages = [
    user('open gmail'),
    { role: 'assistant', content: [{ type: 'text', text: 'On it.' }, call('a')] },
    { role: 'user', content: [answer('a')] },
    { role: 'assistant', content: [{ type: 'text', text: 'Opened Gmail.' }] },
  ];
  assert.deepEqual(repair(messages), messages);
  assert.ok(pairsAreValid(repair(messages)));
});

test('a tool call that was never answered is dropped', () => {
  // What a reply cut off by the token ceiling leaves behind.
  const messages = [
    user('open gmail'),
    { role: 'assistant', content: [{ type: 'text', text: 'On it.' }, call('a')] },
  ];
  const out = repair(messages);
  assert.equal(out.length, 2);
  assert.deepEqual(out[1].content, [{ type: 'text', text: 'On it.' }]);
  assert.ok(pairsAreValid(out));
});

test('an assistant message left with nothing but a dead call is removed', () => {
  const out = repair([user('hi'), { role: 'assistant', content: [call('a')] }]);
  assert.deepEqual(out, [user('hi')]);
});

test('only the unanswered call of several is dropped', () => {
  const out = repair([
    user('do two things'),
    { role: 'assistant', content: [call('a'), call('b')] },
    { role: 'user', content: [answer('a')] },
  ]);
  assert.deepEqual(out[1].content, [call('a')]);
  assert.deepEqual(out[2].content, [answer('a')]);
  assert.ok(pairsAreValid(out));
});

test('a result with no matching call is dropped', () => {
  const out = repair([user('hi'), { role: 'user', content: [answer('ghost')] }]);
  assert.deepEqual(out, [user('hi')]);
});

test('a result that does not immediately follow its call is dropped', () => {
  const out = repair([
    user('hi'),
    { role: 'assistant', content: [{ type: 'text', text: 'one moment' }, call('a')] },
    { role: 'assistant', content: [{ type: 'text', text: 'actually...' }] },
    { role: 'user', content: [answer('a')] },
  ]);
  assert.ok(pairsAreValid(out));
  assert.ok(!JSON.stringify(out).includes('tool_result'));
});

test('bookkeeping fields the API would reject are stripped', () => {
  const out = repair([
    user('hi'),
    { role: 'assistant', content: [{ type: 'text', text: 'hi', _parseError: '{"ap' }] },
  ]);
  assert.deepEqual(out[1].content, [{ type: 'text', text: 'hi' }]);
});

test('is_error survives on a tool result', () => {
  const messages = [
    user('hi'),
    { role: 'assistant', content: [call('a')] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'no', is_error: true }] },
  ];
  assert.deepEqual(repair(messages), messages);
});

test('repair copes with junk input', () => {
  assert.deepEqual(repair(undefined), []);
  assert.deepEqual(repair([]), []);
  assert.deepEqual(repair([user('hi')]), [user('hi')]);
});

test('sanitize trims to the window and opens on a plain user turn', () => {
  const many = [];
  for (let i = 0; i < 30; i++) {
    many.push(user(`q${i}`), { role: 'assistant', content: [{ type: 'text', text: `a${i}` }] });
  }
  const out = sanitize(many, 10);
  assert.ok(out.length <= 10);
  assert.equal(out[0].role, 'user');
  assert.equal(typeof out[0].content, 'string');
});

test('sanitize never opens on an orphaned tool result', () => {
  const out = sanitize(
    [
      { role: 'user', content: [answer('a')] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      user('and now?'),
    ],
    10,
  );
  assert.equal(out[0].role, 'user');
  assert.equal(out[0].content, 'and now?');
});

test('a window cut through a tool round still leaves a valid transcript', () => {
  // The exact shape that produced "tool_use ids were found without tool_result
  // blocks immediately after": the saved window ends on an unanswered call.
  const messages = [
    user('one'),
    { role: 'assistant', content: [{ type: 'text', text: 'first' }] },
    user('open gmail'),
    { role: 'assistant', content: [{ type: 'text', text: 'Opening' }, call('a')] },
  ];
  const out = sanitize(messages, 40);
  assert.ok(pairsAreValid(out));
  assert.ok(!JSON.stringify(out).includes('tool_use'));
});
