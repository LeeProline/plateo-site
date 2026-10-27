// Tests for the PlateO beta sign-up Worker. Runs under plain Node 22.15+ with no installs:
//   node worker/test.mjs
// Part 1 tests the helpers in validate.js. Part 2 runs the real Worker fetch handler
// against an in-memory KV and a fake email binding (cloudflare:email is stubbed).
// All names and addresses below are made up.

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import {
  validateSignup, isValidEmail, isAllowedOrigin, contentLengthOk, headerSafe, bodySafe,
  encodeHeaderValue, buildRawEmail, rfc5322Date, MAX_BODY_BYTES,
} from './validate.js';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}\n       ${err && err.message}`);
  }
}

const good = {
  name: 'Sam Tester',
  email: 'sam.tester@example.com',
  iphone: 'iphone-16',
  training: 'hyrox',
  note: 'Rowing intervals, please.',
  consent: true,
  website: '',
};

function decodeEncodedWords(s) {
  return s.replace(/=\?UTF-8\?B\?([^?]+)\?=(\r\n )?/g, (_, b64) =>
    new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
}

function headersOf(raw) {
  const head = raw.split('\r\n\r\n')[0];
  // unfold continuation lines, then split
  return head.replace(/\r\n /g, ' ').split('\r\n');
}

console.log('validate.js');

await test('accepts a full, valid sign-up', () => {
  const r = validateSignup(good);
  assert.equal(r.ok, true);
  assert.equal(r.spam, false);
  assert.deepEqual(r.value, {
    name: 'Sam Tester', email: 'sam.tester@example.com', iphone: 'iphone-16',
    training: 'hyrox', note: 'Rowing intervals, please.', consent: true,
  });
});

await test('accepts the minimum (name, email, consent)', () => {
  const r = validateSignup({ name: 'Al', email: 'al@example.co.uk', consent: true });
  assert.equal(r.ok, true);
  assert.equal(r.value.iphone, '');
});

await test('requires name, email and consent', () => {
  const r = validateSignup({});
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, { name: 'required', email: 'required', consent: 'required' });
});

await test('consent must be exactly true (not "true", 1 or false)', () => {
  for (const c of ['true', 1, false, null, 'on']) {
    const r = validateSignup({ ...good, consent: c });
    assert.equal(r.errors?.consent, 'required', `consent=${JSON.stringify(c)}`);
  }
});

await test('rejects bad email addresses', () => {
  const bad = ['plainaddress', 'a@b', 'a b@example.com', '<a@example.com>', 'a@example.com,b@example.com',
    'a@example.com;b@example.com', '"q"@example.com', 'a@-example.com', 'a@exa_mple.com',
    `${'x'.repeat(65)}@example.com`, `a@${'d'.repeat(250)}.com`];
  for (const e of bad) {
    assert.equal(isValidEmail(e), false, e);
    assert.equal(validateSignup({ ...good, email: e }).ok, false, e);
  }
  assert.equal(isValidEmail('first.last+beta@sub.example.org'), true);
});

await test('header injection: CR/LF in email is rejected, not repaired', () => {
  for (const e of ['sam@example.com\r\nBcc: victim@example.net', 'sam@example.com\nBcc: x@example.net', 'sam@example.com\u2028x']) {
    const r = validateSignup({ ...good, email: e });
    assert.equal(r.ok, false);
    assert.equal(r.errors.email, 'invalid');
  }
});

await test('header injection: CR/LF and controls are stripped from the name', () => {
  const r = validateSignup({ ...good, name: 'Eve\r\nBcc: victim@example.net\r\n\r\nInjected body\u0000\u202E' });
  assert.equal(r.ok, true);
  assert.ok(!/[\r\n\u0000\u202E]/.test(r.value.name));
  assert.equal(r.value.name, 'Eve Bcc: victim@example.net Injected body');
});

await test('header injection: built email has exactly the expected headers', () => {
  const signup = validateSignup({ ...good, name: 'Eve\r\nBcc: victim@example.net' }).value;
  const raw = buildRawEmail({
    from: 'beta@plateo.fit', to: 'owner@example.com', signup,
    meta: { key: 'signup:1:abc', receivedAt: '2026-10-27T22:00:00.000Z' },
    messageId: 'test', date: new Date(Date.UTC(2026, 9, 27, 22, 0, 0)),
  });
  const hs = headersOf(raw);
  const names = hs.map((h) => h.split(':')[0]);
  assert.deepEqual(names, ['From', 'To', 'Reply-To', 'Subject', 'Date', 'Message-ID', 'MIME-Version',
    'Content-Type', 'Content-Transfer-Encoding', 'Auto-Submitted']);
  assert.ok(!/^Bcc:/mi.test(raw.split('\r\n\r\n')[0].replace(/^Subject:.*$/m, '')));
  assert.equal(hs[3], 'Subject: PlateO beta sign-up: Eve Bcc: victim@example.net');
  assert.equal(hs[4], 'Date: Tue, 27 Oct 2026 22:00:00 +0000');
  // Every line is CRLF terminated and no bare LF exists anywhere.
  assert.ok(!/[^\r]\n/.test(raw));
  // Body is base64 and decodes to the plain text fields.
  const body = new TextDecoder().decode(Uint8Array.from(atob(raw.split('\r\n\r\n')[1].replace(/\r\n/g, '')), (c) => c.charCodeAt(0)));
  assert.match(body, /Email: sam\.tester@example\.com/);
  assert.match(body, /iPhone: iPhone 16 series/);
  assert.match(body, /Mainly trains: HYROX/);
});

await test('non-ASCII names are RFC 2047 encoded and round-trip', () => {
  const name = 'Zoë Ångström-Łukasz 💪 '.repeat(3).trim();
  const enc = encodeHeaderValue(`PlateO beta sign-up: ${name}`);
  assert.ok(/^[\x20-\x7E\r\n]*$/.test(enc), 'header must be ASCII');
  for (const word of enc.split('\r\n ')) assert.ok(word.length <= 75, `encoded-word too long: ${word.length}`);
  assert.equal(decodeEncodedWords(enc), `PlateO beta sign-up: ${name}`);
});

await test('name and note length limits', () => {
  assert.equal(validateSignup({ ...good, name: 'n'.repeat(80) }).ok, true);
  assert.equal(validateSignup({ ...good, name: 'n'.repeat(81) }).errors.name, 'too_long');
  assert.equal(validateSignup({ ...good, note: 'x'.repeat(500) }).ok, true);
  assert.equal(validateSignup({ ...good, note: 'x'.repeat(501) }).errors.note, 'too_long');
  assert.equal(validateSignup({ ...good, note: '💪'.repeat(500) }).ok, true, '500 emoji are 500 characters');
  assert.equal(validateSignup({ ...good, name: '   ' }).errors.name, 'required');
});

await test('note keeps line breaks but drops other control characters', () => {
  assert.equal(bodySafe('one\r\ntwo\rthree\u0007\n\n\n\nfour\u202E'), 'one\ntwo\nthree\n\nfour');
  assert.equal(headerSafe('a\tb\r\nc\u0085d'), 'a b c d');
});

await test('selects only take known values; wrong types are rejected', () => {
  assert.equal(validateSignup({ ...good, iphone: 'iphone-99' }).errors.iphone, 'invalid');
  assert.equal(validateSignup({ ...good, training: '__proto__' }).errors.training, 'invalid');
  assert.equal(validateSignup({ ...good, training: 'constructor' }).errors.training, 'invalid');
  assert.equal(validateSignup({ ...good, name: ['Sam'] }).errors.name, 'required');
  assert.equal(validateSignup({ ...good, note: { x: 1 } }).errors.note, 'invalid');
  for (const body of [null, [], 'string', 42]) assert.equal(validateSignup(body).ok, false);
});

await test('honeypot filled is flagged as spam', () => {
  const r = validateSignup({ ...good, website: 'http://spam.example' });
  assert.equal(r.ok, true);
  assert.equal(r.spam, true);
  assert.equal(r.value, undefined);
});

await test('origin allow-list is exact', () => {
  for (const o of ['https://plateo.fit', 'https://www.plateo.fit', 'https://leeproline.github.io']) assert.ok(isAllowedOrigin(o), o);
  for (const o of ['http://plateo.fit', 'https://plateo.fit.evil.example', 'https://evil.example', 'null', '', null, undefined]) {
    assert.ok(!isAllowedOrigin(o), String(o));
  }
});

await test('declared body size: 4096 bytes is fine, 4097 or junk is not', () => {
  assert.equal(MAX_BODY_BYTES, 4096);
  assert.equal(contentLengthOk('4096'), true);
  assert.equal(contentLengthOk(null), true);
  assert.equal(contentLengthOk('4097'), false);
  assert.equal(contentLengthOk('-1'), false);
  assert.equal(contentLengthOk('12abc'), false);
});

await test('RFC 5322 date pads single digits', () => {
  assert.equal(rfc5322Date(new Date(Date.UTC(2027, 0, 3, 4, 5, 6))), 'Sun, 03 Jan 2027 04:05:06 +0000');
});

// ---------- Part 2: the Worker itself ----------

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:email') {
      const src = 'export class EmailMessage { constructor(from, to, raw) { this.from = from; this.to = to; this.raw = raw; } }';
      return { url: 'data:text/javascript,' + encodeURIComponent(src), shortCircuit: true };
    }
    return next(specifier, context);
  },
});
const worker = (await import('./index.js')).default;

function makeEnv({ emailFails = false } = {}) {
  const store = new Map();
  const sent = [];
  return {
    store,
    sent,
    SIGNUPS_KV: {
      async get(k) { return store.has(k) ? store.get(k).value : null; },
      async put(k, value, opts) { store.set(k, { value, opts }); },
    },
    SEND_EMAIL: {
      async send(msg) { if (emailFails) throw new Error('boom owner@example.com'); sent.push(msg); },
    },
    OWNER_EMAIL: 'owner@example.com',
    IP_SALT: 'test-salt',
  };
}

let ipCounter = 0;
function req(body, { origin = 'https://plateo.fit', method = 'POST', path = '/signup', type = 'application/json', ip, headers = {} } = {}) {
  const h = { 'CF-Connecting-IP': ip || `203.0.113.${++ipCounter}`, ...headers };
  if (origin) h.Origin = origin;
  if (type) h['Content-Type'] = type;
  const init = { method, headers: h };
  if (body !== undefined && method !== 'GET' && method !== 'OPTIONS') init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request(`https://beta.plateo.fit${path}`, init);
}

const signupKeys = (env) => [...env.store.keys()].filter((k) => k.startsWith('signup:'));

// Capture logs so we can prove no personal data is written to them.
const logs = [];
const origError = console.error;
const origWarn = console.warn;
console.error = (...a) => logs.push(a.join(' '));
console.warn = (...a) => logs.push(a.join(' '));

console.log('index.js (Worker)');

await test('valid sign-up: 200, stored in KV for 180 days, owner emailed', async () => {
  const env = makeEnv();
  const res = await worker.fetch(req(good), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://plateo.fit');
  const keys = signupKeys(env);
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^signup:\d{13}:[0-9a-f]{12}$/);
  const { value, opts } = env.store.get(keys[0]);
  assert.equal(opts.expirationTtl, 180 * 24 * 60 * 60);
  const rec = JSON.parse(value);
  assert.equal(rec.email, good.email);
  assert.equal(rec.consent.given, true);
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0].from, 'beta@plateo.fit');
  assert.equal(env.sent[0].to, 'owner@example.com');
  assert.match(env.sent[0].raw, /\r\nSubject: PlateO beta sign-up: Sam Tester\r\n/);
});

await test('preflight: allowed origin gets 204 with CORS headers; others 403', async () => {
  const env = makeEnv();
  const ok = await worker.fetch(req(undefined, { method: 'OPTIONS', origin: 'https://www.plateo.fit' }), env);
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), 'https://www.plateo.fit');
  assert.match(ok.headers.get('Access-Control-Allow-Methods'), /POST/);
  const no = await worker.fetch(req(undefined, { method: 'OPTIONS', origin: 'https://evil.example' }), env);
  assert.equal(no.status, 403);
  assert.equal(no.headers.get('Access-Control-Allow-Origin'), null);
});

await test('wrong origin, no origin, method, path and content type are refused', async () => {
  const env = makeEnv();
  assert.equal((await worker.fetch(req(good, { origin: 'https://evil.example' }), env)).status, 403);
  assert.equal((await worker.fetch(req(good, { origin: null }), env)).status, 403);
  assert.equal((await worker.fetch(req(undefined, { method: 'GET' }), env)).status, 405);
  assert.equal((await worker.fetch(req(good, { path: '/other' }), env)).status, 404);
  assert.equal((await worker.fetch(req('name=x', { type: 'application/x-www-form-urlencoded' }), env)).status, 415);
  assert.equal(signupKeys(env).length, 0);
});

await test('oversized bodies get 413 (declared and undeclared length)', async () => {
  const env = makeEnv();
  const big = { ...good, note: 'x'.repeat(5000) };
  const declared = await worker.fetch(req(big, { headers: { 'Content-Length': '5100' } }), env);
  assert.equal(declared.status, 413);
  const streamed = await worker.fetch(req(big), env); // no Content-Length header: counted while reading
  assert.equal(streamed.status, 413);
  assert.deepEqual(await streamed.json(), { ok: false, error: 'too_large' });
  assert.equal(signupKeys(env).length, 0);
});

await test('invalid JSON and invalid fields get 400 with field codes', async () => {
  const env = makeEnv();
  assert.equal((await worker.fetch(req('{not json'), env)).status, 400);
  const res = await worker.fetch(req({ ...good, email: 'x@y.com\r\nBcc: z@example.net', consent: false }), env);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { ok: false, error: 'invalid', fields: { email: 'invalid', consent: 'required' } });
  assert.equal(signupKeys(env).length, 0);
  assert.equal(env.sent.length, 0);
});

await test('honeypot: 200 ok but nothing stored or sent', async () => {
  const env = makeEnv();
  const res = await worker.fetch(req({ ...good, website: 'spam' }), env);
  assert.equal(res.status, 200);
  assert.equal(signupKeys(env).length, 0);
  assert.equal(env.sent.length, 0);
});

await test('rate limit: the 6th submission from one IP in an hour gets 429', async () => {
  const env = makeEnv();
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await worker.fetch(req(good, { ip: '198.51.100.7' }), env)).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
  // A different IP is unaffected.
  assert.equal((await worker.fetch(req(good, { ip: '198.51.100.8' }), env)).status, 200);
  // The IP itself is never stored, only a hash.
  for (const k of env.store.keys()) assert.ok(!k.includes('198.51.100'), k);
  const rl = [...env.store.entries()].filter(([k]) => k.startsWith('rl:'));
  assert.ok(rl.every(([, v]) => v.opts.expirationTtl === 7200));
});

await test('email failure still returns ok because the sign-up is stored', async () => {
  const env = makeEnv({ emailFails: true });
  const res = await worker.fetch(req(good), env);
  assert.equal(res.status, 200);
  assert.equal(signupKeys(env).length, 1);
});

await test('logs never contain personal data', () => {
  const joined = logs.join('\n');
  for (const s of ['Sam', 'sam.tester', 'example.com', '198.51.100', '203.0.113', 'Rowing']) {
    assert.ok(!joined.includes(s), `log contains "${s}"`);
  }
});

console.error = origError;
console.warn = origWarn;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
