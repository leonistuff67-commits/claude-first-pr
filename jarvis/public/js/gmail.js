/**
 * Real Gmail access, using your own Google OAuth client.
 *
 * This is the genuine article: with a client ID you create (free, in Google
 * Cloud), JARVIS can read, search and summarise your actual inbox. It uses the
 * browser OAuth implicit flow, so the token lives in this tab and never touches
 * a server — there is no backend to leak it.
 *
 * Scopes are deliberately narrow:
 *   gmail.readonly  — read and search mail
 *   gmail.compose   — create drafts (never send)
 * Sending is NOT requested. JARVIS can draft; you press send.
 *
 * Token handling and message parsing are pure functions where possible so they
 * can be tested without a Google account.
 */
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
].join(' ');

/** Build the consent URL for the implicit flow. */
export function buildAuthUrl({ clientId, redirectUri, state }) {
  if (!clientId) throw new Error('No Google client ID.');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'token',
    scope: GMAIL_SCOPES,
    include_granted_scopes: 'true',
    prompt: 'consent',
    state,
  });
  return `${AUTH_ENDPOINT}?${params}`;
}

/**
 * Pull the token out of the URL fragment Google redirects back with, checking
 * the state matches so another page can't hand us a token.
 */
export function parseAuthRedirect(hash, expectedState) {
  const frag = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  if (frag.get('error')) return { error: frag.get('error') };
  const token = frag.get('access_token');
  if (!token) return null;
  if (expectedState && frag.get('state') !== expectedState) {
    return { error: 'state mismatch — ignoring this token' };
  }
  const expiresIn = Number(frag.get('expires_in') || 3600);
  return { token, expiresAt: Date.now() + expiresIn * 1000 };
}

export function tokenValid(session) {
  return Boolean(session?.token && session.expiresAt && session.expiresAt > Date.now() + 30_000);
}

/** Decode Gmail's URL-safe base64 body. */
export function decodeBody(data) {
  if (!data) return '';
  try {
    const normalised = String(data).replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalised);
    // Bodies are UTF-8; go through bytes so accents survive.
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}

/** Flatten a Gmail message into something worth putting in a prompt. */
export function summariseMessage(message) {
  const headers = message?.payload?.headers || [];
  const header = (name) =>
    headers.find((h) => h.name?.toLowerCase() === name)?.value || '';

  // Prefer the plain-text part; fall back to the top-level body.
  const parts = [];
  const walk = (part) => {
    if (!part) return;
    if (part.parts) part.parts.forEach(walk);
    else if (part.mimeType === 'text/plain' && part.body?.data) parts.push(decodeBody(part.body.data));
  };
  walk(message?.payload);
  const body = parts.join('\n') || decodeBody(message?.payload?.body?.data) || message?.snippet || '';

  return {
    id: message?.id,
    from: header('from'),
    to: header('to'),
    subject: header('subject'),
    date: header('date'),
    unread: (message?.labelIds || []).includes('UNREAD'),
    snippet: message?.snippet || '',
    body: body.slice(0, 2000),
  };
}

/** A compact digest for the model — full bodies would blow the context. */
export function formatInbox(messages) {
  if (!messages.length) return 'No matching mail.';
  return messages
    .map((m, i) => `${i + 1}. ${m.unread ? '[unread] ' : ''}From: ${m.from}\n   Subject: ${m.subject}\n   ${m.snippet}`)
    .join('\n');
}

/** RFC 2822 message, base64url encoded, which is what Gmail drafts expect. */
export function encodeDraft({ to = '', subject = '', body = '' }) {
  const lines = [
    to && `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body,
  ].filter((l) => l !== false && l !== undefined && l !== null);
  const raw = lines.join('\r\n');
  const bytes = new TextEncoder().encode(raw);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class Gmail {
  /** @param {{getSettings: () => object, onSession: (s) => void}} opts */
  constructor({ getSettings, onSession }) {
    this.getSettings = getSettings;
    this.onSession = onSession || (() => {});
    this.session = null;
  }

  get connected() {
    return tokenValid(this.session);
  }

  /** Where Google should send the user back to. */
  redirectUri() {
    return `${window.location.origin}${window.location.pathname}`;
  }

  /** Kick off consent. Returns false if there's no client ID configured yet. */
  connect() {
    const clientId = this.getSettings().googleClientId;
    if (!clientId) return false;
    const state = Math.random().toString(36).slice(2);
    sessionStorage.setItem('jarvis.gmail.state', state);
    window.location.assign(buildAuthUrl({
      clientId,
      redirectUri: this.redirectUri(),
      state,
    }));
    return true;
  }

  /** Call once on load: picks up a token Google just handed back. */
  adoptRedirect() {
    if (!window.location.hash.includes('access_token')) return null;
    const expected = sessionStorage.getItem('jarvis.gmail.state');
    const result = parseAuthRedirect(window.location.hash, expected);
    // Clear the fragment either way so the token isn't left in the URL bar.
    history.replaceState(null, '', window.location.pathname + window.location.search);
    sessionStorage.removeItem('jarvis.gmail.state');
    if (!result || result.error) return result;
    this.session = result;
    this.onSession(result);
    return result;
  }

  disconnect() {
    this.session = null;
    this.onSession(null);
  }

  async #call(pathAndQuery, init = {}) {
    if (!this.connected) throw new Error('Gmail is not connected. Open the Connectors page to sign in.');
    const res = await fetch(`${API}${pathAndQuery}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.session.token}`,
        'content-type': 'application/json',
        ...(init.headers || {}),
      },
    });
    if (res.status === 401) {
      this.disconnect();
      throw new Error('Gmail session expired — sign in again from the Connectors page.');
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Gmail error ${res.status}: ${detail.slice(0, 160)}`);
    }
    return res.json();
  }

  /** Search the mailbox. `query` uses Gmail's own search syntax. */
  async search(query = 'in:inbox', max = 8) {
    const list = await this.#call(
      `/messages?q=${encodeURIComponent(query)}&maxResults=${Math.min(20, Math.max(1, max))}`,
    );
    const ids = (list.messages || []).map((m) => m.id);
    const full = await Promise.all(
      ids.map((id) => this.#call(`/messages/${id}?format=full`).catch(() => null)),
    );
    return full.filter(Boolean).map(summariseMessage);
  }

  async createDraft({ to, subject, body }) {
    const draft = await this.#call('/drafts', {
      method: 'POST',
      body: JSON.stringify({ message: { raw: encodeDraft({ to, subject, body }) } }),
    });
    return draft?.id || '';
  }

  async profile() {
    const me = await this.#call('/profile');
    return me?.emailAddress || '';
  }
}
