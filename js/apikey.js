/**
 * API keys, cleaned and checked.
 *
 * A key is copied by hand, and copying by hand goes wrong in ways that are
 * invisible in a password field: a key wrapped across two lines in a terminal
 * or a chat message brings a newline back with it, and one pasted from a
 * password manager often arrives with a space on the end. The result is a 401
 * that looks exactly like a bad key, on a key that is perfectly good
 * everywhere it was pasted cleanly.
 *
 * So keys are stripped of every whitespace character rather than trimmed —
 * no API key contains whitespace, so removing it can only help — and that
 * happens on the way in *and* on the way out, which repairs one already saved.
 */

/** Remove every whitespace character, wherever it is in the string. */
export function cleanKey(value) {
  return String(value ?? '').replace(/\s+/g, '');
}

/** True if cleaning would change it — i.e. the paste picked something up. */
export function keyWasDirty(value) {
  const raw = String(value ?? '');
  return raw.length > 0 && raw !== cleanKey(raw);
}

/**
 * Describe a key without ever showing it. Enough to spot a truncated paste or
 * the wrong kind of key, safe to put on screen or in a log.
 */
export function describeKey(value, expectedPrefix = '') {
  const key = cleanKey(value);
  if (!key) return 'no key set';
  const shape = `${key.length} characters, starts ${key.slice(0, 8)}…, ends …${key.slice(-4)}`;
  if (expectedPrefix && !key.startsWith(expectedPrefix)) {
    return `${shape} — expected it to start with "${expectedPrefix}"`;
  }
  return shape;
}

/**
 * Turn an HTTP status and the provider's own error body into something worth
 * reading. The status alone cannot tell you whether the key is wrong, expired,
 * out of credit or simply not allowed to use the model you picked — the body
 * can, so it is kept rather than thrown away.
 */
export function explainAuthFailure(status, detail, keyDescription) {
  let reason = '';
  try {
    const parsed = JSON.parse(detail);
    reason = parsed?.error?.message || parsed?.error?.type || '';
  } catch {
    reason = String(detail || '').slice(0, 200);
  }

  const said = reason ? ` The API said: ${reason}` : '';
  const key = keyDescription ? ` Your key: ${keyDescription}.` : '';

  if (status === 401) {
    return `The API key was rejected (401).${said}${key} ` +
      'Check it is copied whole, with nothing missing from either end.';
  }
  if (status === 403) {
    return `That key is not allowed to do this (403).${said}${key}`;
  }
  return `Authentication failed (${status}).${said}${key}`;
}
