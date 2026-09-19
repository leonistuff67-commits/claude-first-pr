/**
 * App-opening URLs. On a phone these launch the installed app; on a desktop
 * they fall back to the website. Both shapes are checked here.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { APPS, isMobile, buildAppUrl, appTool, describeOpen } from '../public/js/apps.js';

const ANDROID = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120';

test('phones get the app scheme, desktops get the website', () => {
  assert.equal(isMobile(ANDROID), true);
  assert.equal(isMobile(DESKTOP), false);

  const phone = buildAppUrl('spotify', { query: 'radiohead' }, ANDROID);
  assert.equal(phone.url, 'spotify:search:radiohead', 'launches the app');

  const desk = buildAppUrl('spotify', { query: 'radiohead' }, DESKTOP);
  assert.match(desk.url, /^https:\/\/open\.spotify\.com/, 'falls back to the web player');
  assert.equal(desk.fallback, desk.url);
});

test('a web fallback always exists, even on a phone', () => {
  const { fallback } = buildAppUrl('maps', { query: 'kings cross' }, ANDROID);
  assert.match(fallback, /^https:/, 'so a missing app is not a dead end');
});

test('messages arrive pre-typed', () => {
  const wa = buildAppUrl('whatsapp', { text: "I'm on my way", phone: '+44 7700 900123' }, ANDROID);
  assert.match(wa.url, /^whatsapp:\/\/send\?phone=447700900123/, 'formatting stripped from the number');
  assert.match(wa.url, /text=I'm%20on%20my%20way|text=I%27m%20on%20my%20way/);

  const sms = buildAppUrl('sms', { text: 'running late', phone: '555-0100' }, ANDROID);
  assert.match(sms.url, /^sms:5550100\?body=running%20late$/);
});

test('whatsapp without a number still opens ready to pick a contact', () => {
  assert.match(buildAppUrl('whatsapp', { text: 'hi' }, ANDROID).url, /^whatsapp:\/\/send\?text=hi$/);
  assert.match(buildAppUrl('whatsapp', { text: 'hi' }, DESKTOP).url, /^https:\/\/wa\.me\/\?text=hi$/);
});

test('the dialler is only ever opened, never dialled', () => {
  const call = buildAppUrl('phone', { phone: '+1 (555) 010-0200' }, ANDROID);
  assert.equal(call.url, 'tel:+15550100200', 'tel: opens the dialler; Android never auto-calls');
});

test('email carries recipient, subject and body', () => {
  const m = buildAppUrl('gmail', { to: 'sam@example.com', subject: 'Friday & Sat', text: 'Move it?' }, ANDROID);
  assert.match(m.url, /^mailto:sam%40example\.com/);
  assert.match(m.url, /subject=Friday%20%26%20Sat/, 'ampersand escaped, not a new parameter');
  assert.match(m.url, /body=Move%20it%3F/);
});

test('an unknown app is refused rather than opening nonsense', () => {
  assert.throws(() => buildAppUrl('myspace', {}, ANDROID), /don't know an app/);
});

test('the tool advertises every app it can actually open', () => {
  const tool = appTool();
  assert.equal(tool.name, 'open_app');
  for (const id of Object.keys(APPS)) {
    assert.ok(tool.description.includes(id), `${id} is listed for the model`);
  }
  assert.deepEqual(tool.input_schema.required, ['app']);
});

test('every app is described for the connectors page', () => {
  for (const [id, app] of Object.entries(APPS)) {
    assert.ok(app.name && app.blurb && app.example, `${id} is documented`);
    assert.equal(typeof app.native, 'function');
    assert.equal(typeof app.web, 'function');
  }
});

test('spoken confirmations match what happened', () => {
  assert.match(describeOpen('whatsapp', { text: 'hi' }), /message ready/);
  assert.match(describeOpen('spotify', { query: 'jazz' }), /Opening jazz in Spotify/);
  assert.match(describeOpen('phone', { phone: '555' }), /press call yourself/);
});
