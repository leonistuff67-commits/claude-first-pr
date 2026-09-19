/**
 * Gmail OAuth + message handling. The security-relevant parts (state checking,
 * scopes) and the encoding parts are pure, so they're covered here without a
 * Google account.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GMAIL_SCOPES, buildAuthUrl, parseAuthRedirect, tokenValid,
  decodeBody, summariseMessage, formatInbox, encodeDraft,
} from '../public/js/gmail.js';

test('only narrow scopes are requested — never send', () => {
  assert.match(GMAIL_SCOPES, /gmail\.readonly/);
  assert.match(GMAIL_SCOPES, /gmail\.compose/);
  assert.ok(!/gmail\.send/.test(GMAIL_SCOPES), 'sending is deliberately not requested');
  assert.ok(!/mail\.google\.com/.test(GMAIL_SCOPES), 'no full-mailbox scope');
});

test('the consent URL carries the right parameters', () => {
  const url = buildAuthUrl({ clientId: 'abc.apps.googleusercontent.com', redirectUri: 'https://x.dev/app/', state: 's1' });
  const params = new URL(url).searchParams;
  assert.equal(params.get('client_id'), 'abc.apps.googleusercontent.com');
  assert.equal(params.get('response_type'), 'token');
  assert.equal(params.get('redirect_uri'), 'https://x.dev/app/');
  assert.equal(params.get('state'), 's1');
  assert.match(params.get('scope'), /gmail\.readonly/);
});

test('a missing client id fails loudly rather than opening a broken consent page', () => {
  assert.throws(() => buildAuthUrl({ clientId: '', redirectUri: 'x', state: 'y' }), /client ID/);
});

test('a token is only accepted when the state matches', () => {
  const good = parseAuthRedirect('#access_token=tok&expires_in=3600&state=s1', 's1');
  assert.equal(good.token, 'tok');
  assert.ok(good.expiresAt > Date.now());

  const forged = parseAuthRedirect('#access_token=evil&expires_in=3600&state=other', 's1');
  assert.match(forged.error, /state mismatch/, 'a token with the wrong state is rejected');

  assert.equal(parseAuthRedirect('#nothing=here', 's1'), null);
  assert.match(parseAuthRedirect('#error=access_denied', 's1').error, /access_denied/);
});

test('expiry is respected with a safety margin', () => {
  assert.equal(tokenValid({ token: 't', expiresAt: Date.now() + 600_000 }), true);
  assert.equal(tokenValid({ token: 't', expiresAt: Date.now() + 5_000 }), false, 'about to expire counts as invalid');
  assert.equal(tokenValid({ token: 't', expiresAt: Date.now() - 1 }), false);
  assert.equal(tokenValid(null), false);
});

test('bodies decode from url-safe base64, including accents', () => {
  const text = 'Café — déjà vu';
  const b64 = Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  assert.equal(decodeBody(b64), text);
  assert.equal(decodeBody(''), '');
  assert.equal(decodeBody('!!!not base64!!!'), '', 'garbage degrades to empty, not a throw');
});

test('a message flattens to headers plus the plain-text part', () => {
  const raw = {
    id: 'm1',
    snippet: 'Quick note',
    labelIds: ['INBOX', 'UNREAD'],
    payload: {
      headers: [
        { name: 'From', value: 'Sam <sam@example.com>' },
        { name: 'Subject', value: 'Friday' },
        { name: 'Date', value: 'Thu, 18 Sep 2026 10:00:00 +0000' },
      ],
      parts: [
        { mimeType: 'text/html', body: { data: Buffer.from('<b>ignore me</b>').toString('base64') } },
        { mimeType: 'text/plain', body: { data: Buffer.from('Can we move Friday?').toString('base64') } },
      ],
    },
  };
  const m = summariseMessage(raw);
  assert.equal(m.from, 'Sam <sam@example.com>');
  assert.equal(m.subject, 'Friday');
  assert.equal(m.unread, true);
  assert.equal(m.body, 'Can we move Friday?', 'plain text preferred over html');
});

test('the inbox digest stays compact and flags unread', () => {
  const text = formatInbox([
    { from: 'a@x.com', subject: 'One', snippet: 'hi', unread: true },
    { from: 'b@x.com', subject: 'Two', snippet: 'yo', unread: false },
  ]);
  assert.match(text, /\[unread\] From: a@x\.com/);
  assert.ok(!text.includes('[unread] From: b@x.com'));
  assert.equal(formatInbox([]), 'No matching mail.');
});

test('drafts encode as url-safe base64 RFC822', () => {
  const raw = encodeDraft({ to: 'sam@example.com', subject: 'Hi', body: 'Hello there' });
  assert.ok(!/[+/=]/.test(raw), 'url-safe, unpadded');
  const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.match(decoded, /^To: sam@example\.com\r\n/);
  assert.match(decoded, /Subject: Hi\r\n/);
  assert.match(decoded, /\r\n\r\nHello there$/, 'headers and body separated by a blank line');
});
