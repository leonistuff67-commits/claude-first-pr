/**
 * Connector URL builders — pure, so every link JARVIS can open is checked here
 * rather than discovered by opening a broken tab.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONNECTORS, calendarStamp, connectorTools, findConnectorTool, defaultConnectorSettings,
} from '../public/js/connectors.js';

const build = (name, input) => findConnectorTool(name, {}).tool.build(input);

test('gmail composes with everything escaped', () => {
  const url = build('compose_email', {
    to: 'sam@example.com',
    subject: 'Moving Friday & Saturday',
    body: 'Can we push it?\nThanks',
  });
  assert.match(url, /^https:\/\/mail\.google\.com\/mail\/\?view=cm/);
  assert.match(url, /to=sam%40example\.com/);
  assert.match(url, /su=Moving%20Friday%20%26%20Saturday/, 'ampersand escaped, not a new param');
  assert.match(url, /body=Can%20we%20push%20it%3F%0AThanks/);
});

test('gmail works with only a body', () => {
  const url = build('compose_email', { body: 'hello' });
  assert.match(url, /to=&/, 'empty recipient is fine');
  assert.match(url, /body=hello/);
});

test('calendar stamps a UTC range from a start and duration', () => {
  const url = build('create_calendar_event', {
    title: 'Dentist',
    start: '2026-09-22T15:00:00Z',
    minutes: 30,
  });
  assert.match(url, /text=Dentist/);
  assert.match(url, /dates=20260922T150000Z%2F20260922T153000Z|dates=20260922T150000Z\/20260922T153000Z/);
});

test('calendar defaults to an hour', () => {
  const url = build('create_calendar_event', { title: 'Standup', start: '2026-09-22T09:00:00Z' });
  assert.ok(url.includes('20260922T090000Z') && url.includes('20260922T100000Z'));
});

test('calendarStamp rejects nonsense rather than producing a broken link', () => {
  assert.throws(() => calendarStamp('not a date'), /invalid date/);
});

test('maps includes origin and mode only when given', () => {
  const bare = build('get_directions', { destination: 'Kings Cross' });
  assert.match(bare, /destination=Kings%20Cross/);
  assert.ok(!bare.includes('origin='));
  const full = build('get_directions', { destination: 'Kings Cross', from: 'Soho', mode: 'transit' });
  assert.match(full, /origin=Soho/);
  assert.match(full, /travelmode=transit/);
});

test('whatsapp strips formatting from phone numbers', () => {
  assert.match(build('send_whatsapp', { message: 'late!', phone: '+44 7700 900123' }), /wa\.me\/447700900123\?/);
  assert.match(build('send_whatsapp', { message: 'hi' }), /^https:\/\/wa\.me\/\?text=hi$/);
});

test('search and translate escape their input', () => {
  assert.match(build('search_web', { query: 'c++ vs rust' }), /q=c%2B%2B%20vs%20rust/);
  assert.match(build('translate_text', { text: 'where is the station?', to: 'ja' }), /tl=ja/);
});

test('tool definitions are exposed without the internals', () => {
  const tools = connectorTools(defaultConnectorSettings());
  assert.ok(tools.length >= 7);
  for (const t of tools) {
    assert.ok(t.name && t.description && t.input_schema, 'looks like an Anthropic tool');
    assert.equal(t.build, undefined, 'builder is not leaked to the model');
    assert.equal(t.say, undefined);
  }
});

test('disabling a connector removes its tools and lookups', () => {
  const off = { ...defaultConnectorSettings(), gmail: false };
  const names = connectorTools(off).map((t) => t.name);
  assert.ok(!names.includes('compose_email'));
  assert.equal(findConnectorTool('compose_email', off), null, 'cannot be invoked when off');
  assert.ok(names.includes('search_web'), 'others are unaffected');
});

test('every connector declares what it is for', () => {
  for (const [id, c] of Object.entries(CONNECTORS)) {
    assert.ok(c.name && c.blurb && c.example, `${id} is described for the settings page`);
    assert.ok(c.tools.length > 0);
  }
});
