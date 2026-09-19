/**
 * The brain file is the only thing on disk that matters, so losing it or
 * half-writing it would lose everything JARVIS knows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store, defaultPath } from '../src/store.js';
import * as brain from '../src/brain.js';

async function tmpStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-store-'));
  return new Store(path.join(dir, 'nested', 'brain.json'));
}

test('a missing brain file reads as an empty brain, not an error', async () => {
  const store = await tmpStore();
  assert.deepEqual(await store.read(), { facts: [], tasks: [] });
});

test('a corrupt brain file reads as empty rather than refusing to start', async () => {
  const store = await tmpStore();
  await fs.mkdir(path.dirname(store.file), { recursive: true });
  await fs.writeFile(store.file, '{ this is not json', 'utf8');
  assert.deepEqual(await store.read(), { facts: [], tasks: [] });
});

test('writing creates the directory and survives a round trip', async () => {
  const store = await tmpStore();
  const { state } = brain.remember(brain.createState(), 'I take the 8am train');
  await store.write(state);

  const back = await store.read();
  assert.equal(back.facts.length, 1);
  assert.equal(back.facts[0].text, 'I take the 8am train');
});

test('update reads, applies and persists in one go', async () => {
  const store = await tmpStore();
  await store.update((s) => brain.remember(s, 'first'));
  const { fact } = await store.update((s) => brain.remember(s, 'second'));

  assert.equal(fact.text, 'second');
  assert.equal((await store.read()).facts.length, 2);
});

test('no temp file is left behind after a write', async () => {
  const store = await tmpStore();
  await store.update((s) => brain.remember(s, 'something'));
  const files = await fs.readdir(path.dirname(store.file));
  assert.deepEqual(files, ['brain.json']);
});

test('the default location follows the platform, and JARVIS_BRAIN overrides it', () => {
  const previous = process.env.JARVIS_BRAIN;
  try {
    delete process.env.JARVIS_BRAIN;
    const auto = defaultPath();
    assert.ok(path.isAbsolute(auto));
    assert.ok(auto.endsWith(path.join('jarvis', 'brain.json')));

    process.env.JARVIS_BRAIN = path.join(os.tmpdir(), 'elsewhere.json');
    assert.equal(defaultPath(), path.join(os.tmpdir(), 'elsewhere.json'));
  } finally {
    if (previous === undefined) delete process.env.JARVIS_BRAIN;
    else process.env.JARVIS_BRAIN = previous;
  }
});
