/**
 * These are the tests that matter most in this package: they are the reason to
 * believe "nothing happens without you approving it" is true on every path,
 * rather than true on the paths someone remembered to check by hand.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as perms from '../src/permissions.js';

test('nothing is granted by default', () => {
  const g = perms.createGrants();
  for (const capability of Object.keys(perms.CAPABILITIES)) {
    assert.equal(perms.isGranted(g, capability, 'anything'), false, capability);
  }
});

test('approving one app does not approve another', () => {
  let g = perms.createGrants();
  g = perms.grant(g, 'apps.open', 'Spotify', 'allowed');
  assert.equal(perms.isGranted(g, 'apps.open', 'Spotify'), true);
  assert.equal(perms.isGranted(g, 'apps.open', 'Outlook'), false);
});

test('a per-target capability is never granted without a target', () => {
  let g = perms.grant(perms.createGrants(), 'apps.open', 'Spotify', 'allowed');
  assert.equal(perms.isGranted(g, 'apps.open', null), false);
  assert.equal(perms.isGranted(g, 'apps.open'), false);
});

test('target matching ignores case but not identity', () => {
  const g = perms.grant(perms.createGrants(), 'apps.open', 'Spotify', 'allowed');
  assert.equal(perms.isGranted(g, 'apps.open', 'spotify'), true);
  assert.equal(perms.isGranted(g, 'apps.open', 'Spotify Web Player'), false);
});

test('a capability-wide denial beats an earlier per-target allow', () => {
  let g = perms.grant(perms.createGrants(), 'apps.open', 'Spotify', 'allowed');
  g = perms.grant(g, 'apps.open', null, 'denied');
  assert.equal(perms.isGranted(g, 'apps.open', 'Spotify'), false);
});

test('answering "just this once" stores nothing', () => {
  const g = perms.grant(perms.createGrants(), 'clipboard.read', null, 'allowed', false);
  assert.deepEqual(g, perms.createGrants());
  assert.equal(perms.isGranted(g, 'clipboard.read'), false);
});

test('a denial is remembered too, so it is not asked again', () => {
  const g = perms.grant(perms.createGrants(), 'notify', null, 'denied');
  assert.equal(perms.isGranted(g, 'notify'), false);
  assert.equal(g.capabilities.notify, 'denied');
});

test('an unknown capability can never be granted', () => {
  const g = perms.grant(perms.createGrants(), 'shell.exec', null, 'allowed');
  assert.deepEqual(g, perms.createGrants());
  assert.equal(perms.isGranted(g, 'shell.exec', 'anything'), false);
});

test('revoking one app leaves the others alone', () => {
  let g = perms.createGrants();
  g = perms.grant(g, 'apps.open', 'Spotify', 'allowed');
  g = perms.grant(g, 'apps.open', 'Discord', 'allowed');
  g = perms.revoke(g, 'apps.open', 'Spotify');
  assert.equal(perms.isGranted(g, 'apps.open', 'Spotify'), false);
  assert.equal(perms.isGranted(g, 'apps.open', 'Discord'), true);
});

test('revoking a capability clears every target under it', () => {
  let g = perms.createGrants();
  g = perms.grant(g, 'apps.open', 'Spotify', 'allowed');
  g = perms.grant(g, 'apps.open', 'Discord', 'allowed');
  g = perms.revoke(g, 'apps.open');
  assert.equal(perms.listGrants(g).length, 0);
});

test('revoke all clears everything', () => {
  let g = perms.createGrants();
  g = perms.grant(g, 'apps.open', 'Spotify', 'allowed');
  g = perms.grant(g, 'clipboard.read', null, 'allowed');
  assert.deepEqual(perms.revoke(g, null), perms.createGrants());
});

test('the dialog names the specific thing, not the category', () => {
  const r = perms.describeRequest('apps.open', 'Spotify');
  assert.ok(r.message.includes('Spotify'));
  assert.equal(perms.describeRequest('shell.exec', 'x'), null);
});

test('a tampered permissions file cannot invent a capability', () => {
  const g = perms.normalise({
    capabilities: { 'shell.exec': 'allowed', 'apps.open': 'allowed', 'notify': 'maybe' },
    targets: { 'screen.record::all': 'allowed', 'apps.open::Spotify': 'allowed' },
  });
  assert.equal(perms.isGranted(g, 'shell.exec', 'x'), false);
  assert.equal(g.capabilities.notify, undefined);
  assert.equal(perms.isGranted(g, 'apps.open', 'Spotify'), true);
  assert.equal(Object.keys(g.targets).length, 1);
});

test('normalise survives junk', () => {
  assert.deepEqual(perms.normalise(null), perms.createGrants());
  assert.deepEqual(perms.normalise('nope'), perms.createGrants());
  assert.deepEqual(perms.normalise({ capabilities: 'x', targets: 5 }), perms.createGrants());
});

test('there is no capability that runs a command or drives input', () => {
  // If one is ever added, this should be a deliberate decision, not a slip.
  assert.deepEqual(Object.keys(perms.CAPABILITIES).sort(), [
    'apps.open',
    'clipboard.read',
    'clipboard.write',
    'files.open',
    'notify',
  ]);
});
