// PlateO beta sign-up Worker (Cloudflare Workers, ES module).
// Receives POST /signup from plateo.fit, validates it, rate limits per (hashed) IP,
// stores it in KV for 180 days and emails the owner. Never logs personal data.
//
// Bindings (see wrangler.toml and README.md):
//   SIGNUPS_KV   KV namespace
//   SEND_EMAIL   send_email binding (Email Routing must be on for plateo.fit)
//   OWNER_EMAIL  var: where sign-ups are emailed (a verified Email Routing destination)
//   FROM_EMAIL   var (optional): sender address on plateo.fit, default beta@plateo.fit
//   IP_SALT      secret: random string mixed into the daily IP hash

import { EmailMessage } from 'cloudflare:email';
import {
  MAX_BODY_BYTES,
  CONSENT_TEXT,
  isAllowedOrigin,
  contentLengthOk,
  validateSignup,
  buildRawEmail,
} from './validate.js';

const RATE_LIMIT = 5; // submissions per IP per hour
const SIGNUP_TTL_SECONDS = 180 * 24 * 60 * 60; // 180 days
const RATE_TTL_SECONDS = 2 * 60 * 60; // counter outlives its 1 hour window, then vanishes

function corsHeaders(origin) {
  const h = {
    'Vary': 'Origin',
  };
  if (isAllowedOrigin(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

function json(status, body, origin, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...corsHeaders(origin),
      ...extra,
    },
  });
}

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Reads the body as text, giving up as soon as it passes the byte limit. Returns null if too big. */
async function readLimitedText(request, limit) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      try { await reader.cancel(); } catch { /* ignore */ }
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(all);
}

/** Fixed one hour window per hashed IP. The hash salt changes daily, so hashes can't be linked across days. */
async function rateLimitKey(env, ip, now) {
  const day = new Date(now).toISOString().slice(0, 10);
  const hour = Math.floor(now / 3_600_000);
  const hash = await sha256Hex(`${env.IP_SALT || ''}|${day}|${ip}`);
  return `rl:${hash.slice(0, 32)}:${hour}`;
}

async function handleRequest(request, env) {
  const now = Date.now();
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');

  if (url.pathname !== '/signup') {
    return json(404, { ok: false, error: 'not_found' }, origin);
  }

  if (request.method === 'OPTIONS') {
    if (!isAllowedOrigin(origin)) return new Response(null, { status: 403, headers: { 'Vary': 'Origin' } });
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  if (request.method !== 'POST') {
    return json(405, { ok: false, error: 'method_not_allowed' }, origin, { 'Allow': 'POST, OPTIONS' });
  }

  if (!isAllowedOrigin(origin)) {
    return json(403, { ok: false, error: 'origin_not_allowed' }, origin);
  }

  const type = (request.headers.get('Content-Type') || '').toLowerCase();
  if (!type.startsWith('application/json')) {
    return json(415, { ok: false, error: 'unsupported_media_type' }, origin);
  }

  if (!contentLengthOk(request.headers.get('Content-Length'))) {
    return json(413, { ok: false, error: 'too_large' }, origin);
  }

  // Rate limit before doing any real work.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  let rlKey;
  try {
    rlKey = await rateLimitKey(env, ip, now);
    const count = parseInt((await env.SIGNUPS_KV.get(rlKey)) || '0', 10) || 0;
    if (count >= RATE_LIMIT) {
      return json(429, { ok: false, error: 'rate_limited' }, origin, { 'Retry-After': '3600' });
    }
    await env.SIGNUPS_KV.put(rlKey, String(count + 1), { expirationTtl: RATE_TTL_SECONDS });
  } catch {
    console.error('rate limit store unavailable');
    return json(503, { ok: false, error: 'unavailable' }, origin);
  }

  let text;
  try {
    text = await readLimitedText(request, MAX_BODY_BYTES);
  } catch {
    return json(400, { ok: false, error: 'invalid_body' }, origin);
  }
  if (text === null) return json(413, { ok: false, error: 'too_large' }, origin);

  let input;
  try {
    input = JSON.parse(text);
  } catch {
    return json(400, { ok: false, error: 'invalid_json' }, origin);
  }

  const result = validateSignup(input);
  if (!result.ok) {
    return json(400, { ok: false, error: 'invalid', fields: result.errors }, origin);
  }
  if (result.spam) {
    // Honeypot filled: accept quietly so bots learn nothing, but store and send nothing.
    return json(200, { ok: true }, origin);
  }

  const signup = result.value;
  const receivedAt = new Date(now).toISOString();
  const key = `signup:${now}:${randomHex(6)}`;
  const record = {
    ...signup,
    consent: { given: true, text: CONSENT_TEXT, at: receivedAt },
    receivedAt,
    origin,
  };

  try {
    await env.SIGNUPS_KV.put(key, JSON.stringify(record), { expirationTtl: SIGNUP_TTL_SECONDS });
  } catch {
    console.error('signup store failed');
    return json(500, { ok: false, error: 'store_failed' }, origin);
  }

  // The sign-up is safe in KV now; email is best effort.
  try {
    const from = env.FROM_EMAIL || 'beta@plateo.fit';
    const raw = buildRawEmail({
      from,
      to: env.OWNER_EMAIL,
      signup,
      meta: { key, receivedAt },
      messageId: `${now}.${randomHex(8)}`,
      date: new Date(now),
    });
    await env.SEND_EMAIL.send(new EmailMessage(from, env.OWNER_EMAIL, raw));
  } catch (err) {
    console.error('owner email failed:', err && err.name ? err.name : 'error');
  }

  return json(200, { ok: true }, origin);
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch {
      console.error('unhandled error');
      return json(500, { ok: false, error: 'server_error' }, request.headers.get('Origin'));
    }
  },
};
