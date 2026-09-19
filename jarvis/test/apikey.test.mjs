/**
 * A key that works in one place and not another is almost always a copying
 * accident, and a password field shows you nothing. These cover the cleaning
 * that prevents it and the reporting that explains it when it still happens.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanKey, keyWasDirty, describeKey, explainAuthFailure } from '../public/js/apikey.js';

test('whitespace on the ends is removed', () => {
  assert.equal(cleanKey('  sk-ant-abc  '), 'sk-ant-abc');
  assert.equal(cleanKey('sk-ant-abc\n'), 'sk-ant-abc');
});

test('a line break through the middle is removed too', () => {
  // What you get copying a key out of a wrapped terminal or chat message.
  assert.equal(cleanKey('sk-ant-api03-AAAA\nBBBB'), 'sk-ant-api03-AAAABBBB');
  assert.equal(cleanKey('sk-ant-api03-AAAA BBBB'), 'sk-ant-api03-AAAABBBB');
  assert.equal(cleanKey('sk-ant\r\n-api03\t-AAAA'), 'sk-ant-api03-AAAA');
});

test('a clean key is left exactly as it is', () => {
  const key = 'sk-ant-api03-abcdef0123456789';
  assert.equal(cleanKey(key), key);
});

test('cleaning copes with nothing', () => {
  assert.equal(cleanKey(undefined), '');
  assert.equal(cleanKey(null), '');
  assert.equal(cleanKey(''), '');
});

test('a dirty paste is detectable, so the user can be told', () => {
  assert.equal(keyWasDirty('sk-ant-AAAA\nBBBB'), true);
  assert.equal(keyWasDirty('sk-ant-AAAA '), true);
  assert.equal(keyWasDirty('sk-ant-AAAA'), false);
  assert.equal(keyWasDirty(''), false);
});

test('a key is described without ever being shown', () => {
  const key = 'sk-ant-api03-SECRETSECRETSECRET1234';
  const described = describeKey(key, 'sk-ant-');
  assert.ok(!described.includes('SECRETSECRETSECRET'));
  assert.match(described, /35 characters/);
  assert.match(described, /1234/); // last four, to spot a truncated paste
});

test('the wrong kind of key is called out', () => {
  assert.match(describeKey('sk-proj-abcdefghijkl', 'sk-ant-'), /expected it to start with "sk-ant-"/);
  assert.equal(describeKey('', 'sk-ant-'), 'no key set');
});

test('a 401 keeps what the API actually said', () => {
  const body = JSON.stringify({ error: { type: 'authentication_error', message: 'invalid x-api-key' } });
  const out = explainAuthFailure(401, body, '108 characters');
  assert.match(out, /401/);
  assert.match(out, /invalid x-api-key/);
  assert.match(out, /108 characters/);
});

test('a 403 is not reported as a bad key', () => {
  const out = explainAuthFailure(403, JSON.stringify({ error: { message: 'not permitted' } }), '');
  assert.match(out, /not allowed/);
  assert.ok(!out.includes('copied whole'));
});

test('a non-JSON error body still reaches the user', () => {
  assert.match(explainAuthFailure(401, 'upstream exploded', ''), /upstream exploded/);
});

test('an empty error body does not produce a dangling sentence', () => {
  const out = explainAuthFailure(401, '', '');
  assert.ok(!out.includes('The API said:'));
  assert.match(out, /401/);
});
