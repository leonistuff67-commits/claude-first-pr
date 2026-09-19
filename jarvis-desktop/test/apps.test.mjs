/**
 * The model never supplies a path — it supplies a name, which is resolved
 * against what is actually installed. These check that resolution is strict:
 * an unknown name opens nothing, and an ambiguous one opens nothing either.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { rank, match, resolve, discover, startMenuDirs } from '../src/apps.js';

const APPS = [
  { name: 'Spotify', path: 'C:\\a\\Spotify.lnk' },
  { name: 'Spotify Web Player', path: 'C:\\a\\SpotifyWeb.lnk' },
  { name: 'Discord', path: 'C:\\a\\Discord.lnk' },
  { name: 'Visual Studio Code', path: 'C:\\a\\Code.lnk' },
  { name: 'Word', path: 'C:\\a\\Word.lnk' },
];

test('an exact name wins over a longer one containing it', () => {
  assert.equal(resolve(APPS, 'Spotify').app.name, 'Spotify');
});

test('matching ignores case and punctuation', () => {
  assert.equal(resolve(APPS, 'visual-studio code').app.name, 'Visual Studio Code');
  assert.equal(resolve(APPS, 'DISCORD').app.name, 'Discord');
});

test('a prefix resolves when it is unambiguous', () => {
  assert.equal(resolve(APPS, 'disc').app.name, 'Discord');
});

test('an unknown program opens nothing and says so', () => {
  const r = resolve(APPS, 'Photoshop');
  assert.equal(r.ok, false);
  assert.match(r.reason, /Nothing called "Photoshop"/);
});

test('an empty request opens nothing', () => {
  assert.equal(resolve(APPS, '').ok, false);
  assert.equal(resolve(APPS, '   ').ok, false);
});

test('an ambiguous request asks rather than guessing', () => {
  const twins = [
    { name: 'Edge Dev', path: 'a' },
    { name: 'Edge Beta', path: 'b' },
  ];
  const r = resolve(twins, 'Edge');
  assert.equal(r.ok, false);
  assert.match(r.reason, /Several match/);
  assert.match(r.reason, /Edge Beta/);
});

test('ranking is stable, so the same request resolves the same way twice', () => {
  const first = rank(APPS, 'spot').map((h) => h.app.name);
  const second = rank([...APPS].reverse(), 'spot').map((h) => h.app.name);
  assert.deepEqual(first, second);
});

test('match returns every candidate for the list_installed_apps case', () => {
  assert.deepEqual(match(APPS, 'spotify'), [APPS[0], APPS[1]]);
});

test('discovery finds shortcuts, skips other files, and de-duplicates', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-apps-'));
  const nested = path.join(dir, 'Games', 'Launchers');
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(dir, 'Spotify.lnk'), '');
  await fs.writeFile(path.join(dir, 'notes.txt'), 'not an app');
  await fs.writeFile(path.join(dir, 'installer.exe'), 'not a shortcut either');
  await fs.writeFile(path.join(nested, 'Steam.lnk'), '');
  await fs.writeFile(path.join(nested, 'Docs.url'), '');

  const found = await discover([dir, dir]); // twice: must not double up
  assert.deepEqual(found.map((a) => a.name), ['Docs', 'Spotify', 'Steam']);
});

test('a missing directory is not an error', async () => {
  assert.deepEqual(await discover(['/definitely/not/here']), []);
});

test('start menu locations are Windows-only', () => {
  assert.deepEqual(startMenuDirs({}, 'linux'), []);
  const dirs = startMenuDirs({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming', ProgramData: 'C:\\ProgramData' }, 'win32');
  assert.equal(dirs.length, 2);
  assert.ok(dirs.every((d) => d.includes('Start Menu')));
});
