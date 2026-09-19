/**
 * The desktop tools must be invisible in a browser tab and present in the app,
 * and a refusal from the permission gate has to come back as something JARVIS
 * can say out loud rather than an exception.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopAvailable, desktopTools, desktopHandlers, say } from '../public/js/desktop.js';

const bridge = (overrides = {}) => ({
  jarvisDesktop: {
    version: 1,
    listApps: async () => ['Spotify', 'Discord'],
    openApp: async () => ({ ok: true, opened: 'Spotify' }),
    openFile: async () => ({ ok: true, opened: 'C:\\notes.txt' }),
    readClipboard: async () => ({ ok: true, text: 'copied thing' }),
    writeClipboard: async () => ({ ok: true }),
    notify: async () => ({ ok: true }),
    ...overrides,
  },
});

test('a plain browser tab has no desktop bridge', () => {
  assert.equal(desktopAvailable({}), false);
  assert.equal(desktopAvailable({ jarvisDesktop: { version: 0 } }), false);
  assert.equal(desktopAvailable(bridge()), true);
});

test('every desktop tool has a schema the API will accept', () => {
  for (const tool of desktopTools()) {
    assert.ok(tool.name, 'name');
    assert.ok(tool.description.length > 20, `${tool.name} description`);
    assert.equal(tool.input_schema.type, 'object');
  }
});

test('the tool list offers no way to run a command or type into a window', () => {
  const names = desktopTools().map((t) => t.name).sort();
  assert.deepEqual(names, [
    'copy_to_clipboard',
    'list_installed_apps',
    'notify',
    'open_file',
    'open_installed_app',
    'read_clipboard',
  ]);
});

test('opening an app reports what opened', async () => {
  const h = desktopHandlers(bridge());
  assert.equal(await h.open_installed_app({ name: 'Spotify' }), 'Opened Spotify.');
});

test('a refused permission comes back as a sentence, not a throw', async () => {
  const h = desktopHandlers(bridge({
    openApp: async () => ({ ok: false, error: 'You did not approve opening Outlook.' }),
  }));
  assert.equal(await h.open_installed_app({ name: 'Outlook' }), 'You did not approve opening Outlook.');
});

test('a bridge that answers with nothing is reported, not ignored', () => {
  assert.match(say(undefined, () => 'nope'), /did not answer/);
});

test('an error with no message still says something useful', () => {
  assert.equal(say({ ok: false }, () => 'nope'), 'That was not allowed.');
});

test('listing apps summarises rather than dumping hundreds', async () => {
  const many = Array.from({ length: 200 }, (_, i) => `App ${i}`);
  const h = desktopHandlers(bridge({ listApps: async () => many }));
  const out = await h.list_installed_apps();
  assert.match(out, /^200 installed:/);
  assert.ok(out.split(', ').length <= 60);
});

test('an empty clipboard reads as empty, not as a failure', async () => {
  const h = desktopHandlers(bridge({ readClipboard: async () => ({ ok: true, text: '' }) }));
  assert.equal(await h.read_clipboard(), 'The clipboard is empty.');
});

test('copying tells the user what to do next', async () => {
  const h = desktopHandlers(bridge());
  assert.match(await h.copy_to_clipboard({ text: 'hello' }), /Paste it/);
});
