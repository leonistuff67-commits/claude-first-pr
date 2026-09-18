/**
 * JARVIS dev server.
 *
 * Two jobs:
 *   1. Serve ./public as a static site.
 *   2. Proxy POST /api/chat to the Anthropic Messages API, streaming the SSE
 *      response straight back to the browser so the API key never leaves this
 *      process.
 *
 * Run with:  ANTHROPIC_API_KEY=sk-ant-... npm start
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 8787);
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
// Override to point at a compatible endpoint (or a mock) during development.
const API_URL = process.env.ANTHROPIC_BASE_URL
  ? `${process.env.ANTHROPIC_BASE_URL.replace(/\/$/, '')}/v1/messages`
  : 'https://api.anthropic.com/v1/messages';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'cache-control': 'no-store', ...headers });
  res.end(body);
}

async function readBody(req, limitBytes = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Stream the upstream Messages API response back to the browser verbatim. */
async function handleChat(req, res) {
  if (!API_KEY) {
    return send(res, 501, JSON.stringify({
      error: 'No ANTHROPIC_API_KEY on the server. Start the server with one, or ' +
             'paste a key into the JARVIS settings panel to call the API directly.',
    }), { 'content-type': MIME['.json'] });
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (err) {
    return send(res, 400, JSON.stringify({ error: `Bad request body: ${err.message}` }),
      { 'content-type': MIME['.json'] });
  }

  const headers = {
    'content-type': 'application/json',
    'x-api-key': API_KEY,
    'anthropic-version': '2023-06-01',
  };

  let upstream;
  try {
    upstream = await fetch(API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...payload, stream: true }),
    });
  } catch (err) {
    console.error('upstream fetch failed:', err, err.cause);
    // fetch() hides the useful part (ECONNREFUSED, DNS, TLS) in `cause`.
    const inner = err.cause?.errors?.[0] || err.cause;
    const cause = inner?.message ? ` (${inner.message})` : '';
    return send(res, 502, JSON.stringify({ error: `Upstream request failed: ${err.message}${cause}` }),
      { 'content-type': MIME['.json'] });
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    return send(res, upstream.status, detail || JSON.stringify({ error: 'Upstream error' }),
      { 'content-type': upstream.headers.get('content-type') || MIME['.json'] });
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const reader = upstream.body.getReader();
  req.on('close', () => reader.cancel().catch(() => {}));
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch {
    // Client hung up or the upstream stream broke; nothing useful left to say.
  }
  res.end();
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));

  // Keep path traversal out of the static handler.
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    return send(res, 404, 'Not found');
  }

  res.writeHead(200, {
    'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/chat') return await handleChat(req, res);
    if (req.method === 'GET' && req.url === '/api/config') {
      return send(res, 200, JSON.stringify({ proxy: Boolean(API_KEY) }),
        { 'content-type': MIME['.json'] });
    }
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res);
    send(res, 405, 'Method not allowed');
  } catch (err) {
    send(res, 500, JSON.stringify({ error: err.message }), { 'content-type': MIME['.json'] });
  }
});

server.listen(PORT, () => {
  console.log(`\n  JARVIS online  ->  http://localhost:${PORT}`);
  console.log(`  API key on server: ${API_KEY ? 'yes (proxy mode)' : 'no (browser must supply one)'}\n`);
});
