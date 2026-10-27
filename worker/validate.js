// Pure helpers for the PlateO beta sign-up Worker.
// No Cloudflare-only imports here, so `node worker/test.mjs` can test them directly.

export const ALLOWED_ORIGINS = Object.freeze([
  'https://plateo.fit',
  'https://www.plateo.fit',
  'https://leeproline.github.io',
]);

export const MAX_BODY_BYTES = 4096;

export const LIMITS = Object.freeze({
  name: 80,
  email: 254,
  emailLocal: 64,
  note: 500,
});

export const IPHONE_OPTIONS = Object.freeze({
  'iphone-17': 'iPhone 17 series',
  'iphone-16': 'iPhone 16 series',
  'iphone-15': 'iPhone 15 series',
  'older': 'Older',
  'not-sure': 'Not sure',
});

export const TRAINING_OPTIONS = Object.freeze({
  'gym-weights': 'Gym weights',
  'crossfit-style': 'CrossFit-style',
  'hyrox': 'HYROX',
  'home': 'Home workouts',
  'mixed': 'Mixed',
});

export const CONSENT_TEXT =
  "I'm happy for PlateO to email me about the beta (see the privacy policy)";

// C0 and C1 controls, DEL, Unicode line/paragraph separators, zero-width and bidi controls.
const CONTROLS_ALL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
// Same, but keeps \n (0x0A) and \t (0x09) for multi-line free text.
const CONTROLS_KEEP_NL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

// dot-atom local part @ hostname with a 2+ letter TLD. Deliberately strict: no quotes,
// spaces, angle brackets, commas or semicolons, so it can never break out of a header.
const EMAIL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

/** Number of Unicode code points (what a person thinks of as characters, near enough). */
export function charLength(s) {
  return [...s].length;
}

/** For values that end up in an email header (name, email): no control characters or newlines at all. */
export function headerSafe(value) {
  return String(value)
    .replace(CONTROLS_ALL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** For the free-text note (body only): keeps newlines and tabs, drops other controls. */
export function bodySafe(value) {
  return String(value)
    .replace(/\r\n?/g, '\n')
    .replace(CONTROLS_KEEP_NL, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function isValidEmail(value) {
  if (typeof value !== 'string') return false;
  if (value.length > LIMITS.email) return false;
  const at = value.lastIndexOf('@');
  if (at < 1 || at > LIMITS.emailLocal) return false;
  return EMAIL_RE.test(value);
}

export function isAllowedOrigin(origin) {
  return typeof origin === 'string' && ALLOWED_ORIGINS.includes(origin);
}

/** Accepts only a declared byte length within the limit (or no declared length). */
export function contentLengthOk(header) {
  if (header === null || header === undefined || header === '') return true;
  if (!/^\d+$/.test(String(header))) return false;
  return Number(header) <= MAX_BODY_BYTES;
}

/**
 * Validates a parsed JSON body.
 * Returns { ok: true, spam: false, value } or { ok: true, spam: true } (honeypot filled)
 * or { ok: false, errors: { field: code } }.
 */
export function validateSignup(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: { body: 'invalid' } };
  }

  // Honeypot: real people never see this field.
  if (input.website !== undefined && input.website !== null && input.website !== '') {
    return { ok: true, spam: true };
  }

  const errors = {};
  const isStr = (v) => typeof v === 'string';
  const optStr = (v) => v === undefined || v === null || typeof v === 'string';

  // Name (required, header-bound)
  let name = '';
  if (!isStr(input.name)) errors.name = 'required';
  else {
    name = headerSafe(input.name);
    if (!name) errors.name = 'required';
    else if (charLength(name) > LIMITS.name) errors.name = 'too_long';
  }

  // Email (required, header-bound: used for Reply-To)
  let email = '';
  if (!isStr(input.email)) errors.email = 'required';
  else {
    const raw = input.email.trim();
    if (!raw) errors.email = 'required';
    else if (raw.length > LIMITS.email) errors.email = 'too_long';
    // Reject (do not repair) anything with controls or newlines in it.
    else if (raw !== headerSafe(raw) || !isValidEmail(raw)) errors.email = 'invalid';
    else email = raw;
  }

  // Optional selects: must be one of the known values
  let iphone = '';
  if (!optStr(input.iphone)) errors.iphone = 'invalid';
  else if (input.iphone) {
    if (Object.prototype.hasOwnProperty.call(IPHONE_OPTIONS, input.iphone)) iphone = input.iphone;
    else errors.iphone = 'invalid';
  }

  let training = '';
  if (!optStr(input.training)) errors.training = 'invalid';
  else if (input.training) {
    if (Object.prototype.hasOwnProperty.call(TRAINING_OPTIONS, input.training)) training = input.training;
    else errors.training = 'invalid';
  }

  // Optional note (body only)
  let note = '';
  if (!optStr(input.note)) errors.note = 'invalid';
  else if (input.note) {
    note = bodySafe(input.note);
    if (charLength(note) > LIMITS.note) errors.note = 'too_long';
  }

  // Consent: must be exactly true
  if (input.consent !== true) errors.consent = 'required';

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, spam: false, value: { name, email, iphone, training, note, consent: true } };
}

// ---------- Email (RFC 5322 / RFC 2045 / RFC 2047) ----------

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** Encodes a header value. Plain ASCII stays readable; anything else becomes RFC 2047 encoded-words. */
export function encodeHeaderValue(value) {
  const clean = headerSafe(value);
  if (/^[\x20-\x7E]*$/.test(clean)) return clean;
  // Split into chunks of at most 30 UTF-8 bytes without breaking a character,
  // so each encoded-word stays well under the 75 character limit.
  const words = [];
  let chunk = '';
  let chunkBytes = 0;
  for (const ch of clean) {
    const n = new TextEncoder().encode(ch).length;
    if (chunkBytes + n > 30) {
      words.push(chunk);
      chunk = '';
      chunkBytes = 0;
    }
    chunk += ch;
    chunkBytes += n;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${utf8ToBase64(w)}?=`).join('\r\n ');
}

/** RFC 5322 date, always in UTC: "Tue, 27 Oct 2026 22:15:00 +0000". */
export function rfc5322Date(date) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  return `${days[date.getUTCDay()]}, ${p(date.getUTCDate())} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ` +
    `${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())} +0000`;
}

export function emailBodyText(signup, meta) {
  const lines = [
    'New PlateO beta sign-up',
    '',
    `Name: ${signup.name}`,
    `Email: ${signup.email}`,
    `iPhone: ${IPHONE_OPTIONS[signup.iphone] || 'Not given'}`,
    `Mainly trains: ${TRAINING_OPTIONS[signup.training] || 'Not given'}`,
    `Consent to beta emails: yes, at ${meta.receivedAt}`,
    '',
    'Anything they would like it to do:',
    signup.note || '(nothing)',
    '',
    '--',
    `Stored in KV as ${meta.key}. It expires automatically after 180 days.`,
    'Please delete this email within 180 days too (see the privacy policy).',
  ];
  return lines.join('\n');
}

/**
 * Builds the full RFC 5322 message as a string with CRLF line endings.
 * Every header value goes through headerSafe/encodeHeaderValue, and the body is base64,
 * so user input can never add or change a header.
 */
export function buildRawEmail({ from, to, signup, meta, messageId, date }) {
  if (!isValidEmail(from) || !isValidEmail(to)) throw new Error('bad from/to address');
  if (!isValidEmail(signup.email)) throw new Error('bad reply-to address');
  const subject = encodeHeaderValue(`PlateO beta sign-up: ${headerSafe(signup.name)}`);
  const body = utf8ToBase64(emailBodyText(signup, meta).replace(/\r?\n/g, '\r\n'));
  const wrapped = body.match(/.{1,76}/g)?.join('\r\n') ?? '';
  const headers = [
    `From: PlateO beta <${from}>`,
    `To: <${to}>`,
    `Reply-To: <${signup.email}>`,
    `Subject: ${subject}`,
    `Date: ${rfc5322Date(date)}`,
    `Message-ID: <${messageId}@${from.split('@')[1]}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
  ];
  return headers.join('\r\n') + '\r\n\r\n' + wrapped + '\r\n';
}
