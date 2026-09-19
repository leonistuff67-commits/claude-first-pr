/**
 * The offline brain's phrase interpreter — the thing that makes JARVIS usable
 * with no API key. memory.js touches localStorage, which doesn't exist in Node,
 * so we stub just enough of it before importing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.localStorage = {
  _s: new Map(),
  getItem(k) { return this._s.has(k) ? this._s.get(k) : null; },
  setItem(k, v) { this._s.set(k, String(v)); },
  removeItem(k) { this._s.delete(k); },
};

const { interpret, parseDuration } = await import('../public/js/offline.js');

test('parses spoken and numeric durations', () => {
  assert.equal(parseDuration('10 minutes'), 600);
  assert.equal(parseDuration('set a timer for 90 seconds'), 90);
  assert.equal(parseDuration('two hours'), 7200);
  assert.equal(parseDuration('an hour and a half'), 5400);
  assert.equal(parseDuration('ten minutes'), 600);
  assert.equal(parseDuration('no duration here'), 0);
});

test('routes timers, tasks and memory to the right tools', () => {
  assert.deepEqual(interpret('set a timer for 10 minutes').tool, 'set_timer');
  assert.equal(interpret('set a timer for 10 minutes for the pasta').input.label, 'pasta');
  assert.equal(interpret('add milk to my list').tool, 'add_task');
  assert.equal(interpret('remember I like oat milk').tool, 'remember');
  assert.match(interpret('remember I like oat milk').input.fact, /oat milk/i);
  assert.equal(interpret('what do you know about me').tool, 'recall');
  assert.equal(interpret('what time is it').tool, 'get_datetime');
});

test('handles serious mode both ways', () => {
  assert.deepEqual(interpret('jarvis activate serious mode'), { tool: 'set_serious_mode', input: { on: true } });
  assert.deepEqual(interpret('serious mode off'), { tool: 'set_serious_mode', input: { on: false } });
});

test('maps colour requests to a hex accent', () => {
  const red = interpret('turn red');
  assert.equal(red.tool, 'set_accent');
  assert.match(red.input.color, /^#[0-9a-f]{6}$/i);
  assert.equal(interpret('go #ff8800').input.color, '#ff8800');
});

test('a timer with no duration asks instead of guessing', () => {
  assert.ok(interpret('set a timer').text);
});

test('a question it cannot answer becomes a web search, not a shrug', () => {
  const reply = interpret('what is the airspeed velocity of an unladen swallow');
  assert.equal(reply.tool, 'search_web');
  assert.match(reply.input.query, /airspeed velocity/);
});

test('falls back to a spoken reply for anything it cannot route', () => {
  const reply = interpret('sing me a lullaby about quantum foam');
  assert.ok(reply.text && !reply.tool, 'no tool fits, so it says so');
});

test('routes connector requests to the right hand-off', () => {
  const email = interpret('email sam@example.com about moving the meeting');
  assert.equal(email.tool, 'compose_email');
  assert.equal(email.input.to, 'sam@example.com');
  assert.match(email.input.body, /moving the meeting/);

  assert.equal(interpret('directions to the hardware store').tool, 'get_directions');
  assert.equal(interpret('directions to the hardware store').input.destination, 'the hardware store');

  assert.equal(interpret('play lo-fi beats').tool, 'play_video');
  assert.equal(interpret('look up how long to boil an egg').tool, 'search_web');

  const tr = interpret('translate where is the station into japanese');
  assert.equal(tr.tool, 'translate_text');
  assert.equal(tr.input.to, 'japanese');
});

test('a timer is still a timer, not a video', () => {
  assert.equal(interpret('put on a 5 minute timer').tool, 'set_timer');
});
