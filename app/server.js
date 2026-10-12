'use strict';
// SPDX-License-Identifier: AGPL-3.0-or-later
// Pricebook: a small crowd-sourced grocery price book for Australia.
// Products come from Open Food Facts by barcode; people enter the price they saw
// and can attach a receipt photo afterwards so an admin can confirm the entries.
// No dependencies beyond Node itself (node:http + node:sqlite).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3020);
const TZ = process.env.TZ || 'Australia/Brisbane';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const RECEIPT_DIR = path.join(DATA_DIR, 'receipts');
const PUBLIC_DIR = path.join(__dirname, 'public');
// The Android app, if one has been built and copied into the data folder. It holds no secrets.
const APK_FILE = path.join(DATA_DIR, 'pricebook.apk');
const SESSION_DAYS = 30;
const MAX_JSON = 64 * 1024;
const MAX_IMAGE = 12 * 1024 * 1024;
const OFF_UA = process.env.OFF_USER_AGENT || 'Pricebook/0.1 (self-hosted family price book)';
const LOOKUP_API_TOKEN = process.env.LOOKUP_API_TOKEN || '';
// Where people can get this service's source code (the AGPL asks that users of a hosted copy can find it).
const SOURCE_URL = /^https:\/\//.test(process.env.SOURCE_URL || '') ? process.env.SOURCE_URL : 'https://github.com/Arcau/pricebook';
const SECURE_COOKIE = process.env.COOKIE_SECURE !== 'false';
const COOKIE = 'pb_session';
const CHAINS = ['Coles', 'Woolworths', 'ALDI', 'IGA', 'Other'];
// A new price may be at most this far above the product's usual (non-special) price
// before it is held back until a receipt backs it up.
const MAX_OVER_PERCENT = Math.max(0, Number(process.env.MAX_OVER_USUAL_PERCENT || 50));
// ...and at most this far below it. Exactly half price is accepted, because half-price specials are common.
const MAX_UNDER_PERCENT = Math.min(100, Math.max(0, Number(process.env.MAX_UNDER_USUAL_PERCENT || 50)));
// Optional: a vision model that reads shelf price tag photos. Off unless OLLAMA_URL is set.
const OLLAMA_URL = String(process.env.OLLAMA_URL || '').replace(/\/+$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5vl:7b';
// Price statuses: accepted (within the rule, or the first price for a product), held (too far
// above the usual price, needs a receipt), receipt / held_receipt (a receipt is attached and
// waiting for an admin), verified (an admin confirmed it against the receipt).
const COUNTED = `('accepted', 'receipt', 'verified')`;
const STATES = ['QLD', 'NSW', 'VIC', 'SA', 'WA', 'TAS', 'NT', 'ACT'];

fs.mkdirSync(RECEIPT_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'pricebook.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
    pass_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS invites (
    code TEXT PRIMARY KEY, created_by INTEGER NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, used_by INTEGER REFERENCES users(id), used_at INTEGER);
  CREATE TABLE IF NOT EXISTS products (
    barcode TEXT PRIMARY KEY, name TEXT NOT NULL, brand TEXT NOT NULL DEFAULT '', size TEXT NOT NULL DEFAULT '',
    image_url TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, created_by INTEGER REFERENCES users(id),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS off_misses (barcode TEXT PRIMARY KEY, checked_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS stores (
    id INTEGER PRIMARY KEY, chain TEXT NOT NULL, suburb TEXT NOT NULL, state TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id), created_at INTEGER NOT NULL, UNIQUE (chain, suburb, state));
  CREATE TABLE IF NOT EXISTS receipts (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), store_id INTEGER NOT NULL REFERENCES stores(id),
    purchased_on TEXT NOT NULL, image_file TEXT NOT NULL, content_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'uploaded',
    verified_by INTEGER REFERENCES users(id), verified_at INTEGER, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS prices (
    id INTEGER PRIMARY KEY, barcode TEXT NOT NULL REFERENCES products(barcode), store_id INTEGER NOT NULL REFERENCES stores(id),
    price_cents INTEGER NOT NULL, was_cents INTEGER, on_special INTEGER NOT NULL DEFAULT 0, observed_on TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id), receipt_id TEXT REFERENCES receipts(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'unverified', created_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS prices_barcode ON prices (barcode, observed_on DESC);
  CREATE INDEX IF NOT EXISTS prices_trip ON prices (user_id, store_id, observed_on);
`);

db.exec(`UPDATE prices SET status = 'accepted' WHERE status = 'unverified'`);
{
  // An admin can switch an account off: it can no longer sign in and its sessions end.
  if (!db.prepare('PRAGMA table_info(users)').all().some((column) => column.name === 'disabled')) db.exec('ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0');
  // Proof photos are either a receipt (covers a whole trip) or a shelf price tag (covers one price).
  const columns = db.prepare('PRAGMA table_info(receipts)').all().map((column) => column.name);
  for (const [name, ddl] of [['kind', "TEXT NOT NULL DEFAULT 'receipt'"], ['ai_price_cents', 'INTEGER'], ['ai_name', 'TEXT'], ['ai_checked_at', 'INTEGER']]) {
    if (!columns.includes(name)) db.exec(`ALTER TABLE receipts ADD COLUMN ${name} ${ddl}`);
  }
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (message, status = 400) => new HttpError(status, message);
const now = () => Date.now();
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const SECURITY_HEADERS = {
  ...(SECURE_COOKIE ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' https://images.openfoodfacts.org data: blob:; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};

function sendJson(res, status, body, extra = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extra });
  res.end(data);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      // Stop buffering but keep the socket open long enough to answer with a 413.
      if (size > limit) { if (!req.tooLarge) { req.tooLarge = true; chunks.length = 0; reject(bad('That upload is too large.', 413)); } return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw bad('Expected JSON.', 415);
  const raw = await readBody(req, MAX_JSON);
  try { const value = JSON.parse(raw.toString('utf8') || '{}'); if (value && typeof value === 'object' && !Array.isArray(value)) return value; } catch { /* fall through */ }
  throw bad('That request was not valid JSON.');
}

// ── passwords, sessions, rate limiting ──────────────────────────────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}
function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}
function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  const isPrivate = /^(::ffff:)?(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|^::1$/.test(remote);
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map((part) => part.trim()).filter(Boolean);
  return isPrivate && forwarded.length ? forwarded[forwarded.length - 1] : remote;
}
const attempts = new Map();
function limited(key, max, windowMs) {
  const entry = attempts.get(key);
  const time = now();
  if (!entry || time - entry.start > windowMs) { attempts.set(key, { start: time, count: 1 }); return false; }
  entry.count += 1;
  return entry.count > max;
}
setInterval(() => { const time = now(); for (const [key, entry] of attempts) if (time - entry.start > 60 * 60 * 1000) attempts.delete(key); }, 10 * 60 * 1000).unref();

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), userId, now(), now() + SESSION_DAYS * 86400000);
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${SECURE_COOKIE ? '; Secure' : ''}`;
}
function sessionToken(req) {
  const match = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`));
  return match ? match[1] : '';
}
function currentUser(req) {
  const token = sessionToken(req);
  if (!token) return null;
  return db.prepare(`SELECT u.id, u.username, u.display_name AS displayName, u.role FROM sessions s JOIN users u ON u.id = s.user_id
                     WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0`).get(sha256(token), now()) || null;
}

// ── validation ──────────────────────────────────────────────────────────────
function barcodeOf(value) {
  const code = String(value || '').replace(/\D/g, '');
  if (code.length < 8 || code.length > 14) throw bad('A barcode has 8 to 14 digits.');
  return code;
}
function centsOf(value, label) {
  const number = Number(String(value).replace(',', '.').replace('$', ''));
  if (!Number.isFinite(number) || number <= 0 || number > 9999.99) throw bad(`${label} must be between $0.01 and $9,999.99.`);
  return Math.round(number * 100);
}
function dateOf(value) {
  const date = String(value || today());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw bad('Dates look like 2026-10-12.');
  if (date > today()) throw bad('That date is in the future.');
  if (Date.parse(today()) - Date.parse(date) > 366 * 86400000) throw bad('That date is more than a year ago.');
  return date;
}
function storeOf(id) {
  const store = db.prepare('SELECT id, chain, suburb, state FROM stores WHERE id = ?').get(Number(id) || 0);
  if (!store) throw bad('Choose a store first.');
  return store;
}

// ── products (Open Food Facts + local cache) ────────────────────────────────
async function lookupProduct(barcode) {
  const known = db.prepare('SELECT barcode, name, brand, size, image_url AS imageUrl, source FROM products WHERE barcode = ?').get(barcode);
  if (known) return known;
  const miss = db.prepare('SELECT checked_at FROM off_misses WHERE barcode = ?').get(barcode);
  if (miss && now() - miss.checked_at < 7 * 86400000) return null;
  try {
    const response = await fetch(`https://world.openfoodfacts.org/api/v2/product/${barcode}.json?fields=product_name,brands,quantity,image_front_small_url`,
      { headers: { Accept: 'application/json', 'User-Agent': OFF_UA }, signal: AbortSignal.timeout(8000) });
    const body = await response.json().catch(() => null);
    const name = clean(body?.product?.product_name, 120);
    if (body?.status === 1 && name) {
      const image = String(body.product.image_front_small_url || '');
      db.prepare(`INSERT OR IGNORE INTO products (barcode, name, brand, size, image_url, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'off', ?, ?)`)
        .run(barcode, name, clean(String(body.product.brands || '').split(',')[0], 80), clean(body.product.quantity, 40),
          image.startsWith('https://images.openfoodfacts.org/') ? image.slice(0, 300) : '', now(), now());
      return db.prepare('SELECT barcode, name, brand, size, image_url AS imageUrl, source FROM products WHERE barcode = ?').get(barcode);
    }
    if (response.ok) db.prepare('INSERT OR REPLACE INTO off_misses (barcode, checked_at) VALUES (?, ?)').run(barcode, now());
  } catch { /* Open Food Facts unreachable: treat as unknown for now, do not cache the miss */ }
  return null;
}

const PRICE_COLUMNS = `p.id, p.barcode, p.price_cents AS priceCents, p.was_cents AS wasCents, p.on_special AS onSpecial, p.observed_on AS observedOn,
  p.status, p.receipt_id AS receiptId, p.user_id AS userId, s.id AS storeId, s.chain, s.suburb, s.state`;
function pricesFor(barcode) {
  const latest = db.prepare(`SELECT ${PRICE_COLUMNS} FROM prices p JOIN stores s ON s.id = p.store_id
    WHERE p.barcode = ? AND p.id = (SELECT p2.id FROM prices p2 WHERE p2.barcode = p.barcode AND p2.store_id = p.store_id AND p2.status IN ${COUNTED} ORDER BY p2.observed_on DESC, p2.created_at DESC LIMIT 1)
    ORDER BY p.price_cents ASC`).all(barcode);
  const history = db.prepare(`SELECT ${PRICE_COLUMNS} FROM prices p JOIN stores s ON s.id = p.store_id WHERE p.barcode = ? AND p.status IN ${COUNTED} ORDER BY p.observed_on DESC, p.created_at DESC LIMIT 60`).all(barcode);
  return { latest, history, typical: typicalPrice(barcode) };
}
// The typical price of a product: the median of the latest counted, non-special price at each
// store, across every state. A median is used rather than a plain average so one typo or one
// unusually dear store cannot drag it, and so it cannot be ratcheted up one entry at a time.
function typicalPrice(barcode) {
  const cents = db.prepare(`SELECT p.price_cents AS c FROM prices p
    WHERE p.barcode = ? AND p.on_special = 0 AND p.status IN ${COUNTED}
      AND p.id = (SELECT p2.id FROM prices p2 WHERE p2.barcode = p.barcode AND p2.store_id = p.store_id AND p2.on_special = 0 AND p2.status IN ${COUNTED}
                  ORDER BY p2.observed_on DESC, p2.created_at DESC LIMIT 1)
    ORDER BY p.price_cents`).all(barcode).map((row) => row.c);
  if (!cents.length) return null;
  const middle = Math.floor(cents.length / 2);
  return { priceCents: cents.length % 2 ? cents[middle] : Math.round((cents[middle - 1] + cents[middle]) / 2), stores: cents.length };
}

// Ask the vision model to read a shelf price tag. Confirms the price only on an exact match;
// anything else is left for an admin, with the model's reading shown beside the photo.
async function checkTagWithAi(receiptId, image, contentType, priceId, priceCents) {
  if (!OLLAMA_URL || contentType === 'image/heic') return;
  try {
    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120000),
      body: JSON.stringify({ model: OLLAMA_MODEL, stream: false, format: 'json', options: { temperature: 0 }, images: [image.toString('base64')],
        prompt: 'This is a photo of a supermarket shelf price tag. Reply with JSON only, in the form {"price": 0.00, "name": ""}. "price" is the main shelf price in dollars as a number (not the unit price per kg, per litre or per 100 g). "name" is the product name printed on the tag. If no price can be read, use null for "price".' })
    });
    const body = await response.json();
    const parsed = JSON.parse(String(body.response || '{}'));
    const dollars = Number(parsed.price);
    const readCents = parsed.price !== null && Number.isFinite(dollars) && dollars > 0 && dollars < 10000 ? Math.round(dollars * 100) : null;
    db.prepare('UPDATE receipts SET ai_price_cents = ?, ai_name = ?, ai_checked_at = ? WHERE id = ?').run(readCents, clean(parsed.name, 120), now(), receiptId);
    if (readCents !== null && readCents === priceCents) {
      db.prepare(`UPDATE prices SET status = 'verified' WHERE id = ? AND receipt_id = ?`).run(priceId, receiptId);
      db.prepare(`UPDATE receipts SET status = 'verified', verified_at = ? WHERE id = ? AND status <> 'verified'`).run(now(), receiptId);
    }
  } catch (error) { console.error(new Date().toISOString(), 'price tag check failed:', error.message); }
}

function imageKind(buffer) {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return ['jpg', 'image/jpeg'];
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ['png', 'image/png'];
  if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return ['webp', 'image/webp'];
  if (buffer.toString('latin1', 4, 8) === 'ftyp' && /^(heic|heix|heif|mif1|msf1)$/.test(buffer.toString('latin1', 8, 12))) return ['heic', 'image/heic'];
  return null;
}

// ── routes ──────────────────────────────────────────────────────────────────
const routes = [];
const route = (method, pattern, options, handler) => routes.push({ method, pattern, options, handler });

route('GET', /^\/api\/status$/, { open: true }, ({ user }) => ({
  hasUsers: db.prepare('SELECT COUNT(*) AS c FROM users').get().c > 0, user, chains: CHAINS, states: STATES, today: today(), apkAvailable: fs.existsSync(APK_FILE), sourceUrl: SOURCE_URL
}));

route('POST', /^\/api\/register$/, { open: true }, async ({ req, res }) => {
  if (limited(`register|${clientIp(req)}`, 10, 60 * 60 * 1000)) throw bad('Too many attempts. Try again in an hour.', 429);
  const input = await readJson(req);
  const username = String(input.username || '').toLowerCase().trim();
  const password = String(input.password || '');
  const displayName = clean(input.displayName, 40) || username;
  if (!/^[a-z0-9][a-z0-9._-]{2,23}$/.test(username)) throw bad('Usernames are 3 to 24 letters, numbers, dots, dashes or underscores.');
  if (password.length < 10 || password.length > 200) throw bad('Passwords need at least 10 characters.');
  const first = db.prepare('SELECT COUNT(*) AS c FROM users').get().c === 0;
  let invite = null;
  if (!first) {
    invite = db.prepare('SELECT code FROM invites WHERE code = ? AND used_by IS NULL AND expires_at > ?').get(String(input.invite || '').trim().toUpperCase(), now());
    if (!invite) throw bad('That invite code is not valid or has expired.', 403);
  }
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw bad('That username is taken.', 409);
  const id = db.prepare('INSERT INTO users (username, display_name, pass_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(username, displayName, hashPassword(password), first ? 'admin' : 'member', now()).lastInsertRowid;
  if (invite) db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ?').run(id, now(), invite.code);
  res.setHeader('Set-Cookie', startSession(res, id));
  return { user: { id: Number(id), username, displayName, role: first ? 'admin' : 'member' } };
});

route('POST', /^\/api\/login$/, { open: true }, async ({ req, res }) => {
  const input = await readJson(req);
  const username = String(input.username || '').toLowerCase().trim().slice(0, 24);
  const ip = clientIp(req);
  // Lock out one address guessing at one account quickly. The per-account ceiling is kept high on
  // purpose: a low one would let anybody lock a known username out of their own account.
  if (limited(`login-ip|${ip}`, 20, 15 * 60 * 1000) || limited(`login-pair|${ip}|${username}`, 8, 15 * 60 * 1000) || limited(`login-user|${username}`, 100, 15 * 60 * 1000)) {
    throw bad('Too many attempts. Try again in 15 minutes.', 429);
  }
  const row = db.prepare('SELECT id, username, display_name AS displayName, role, pass_hash, disabled FROM users WHERE username = ?').get(username);
  // Always run one scrypt so a missing username takes as long as a wrong password.
  const ok = row ? verifyPassword(String(input.password || ''), row.pass_hash) : (hashPassword('timing-equaliser'), false);
  if (!ok) throw bad('Username or password is incorrect.', 401);
  if (row.disabled) throw bad('This account has been switched off. Ask whoever runs this price book.', 403);
  attempts.delete(`login-pair|${ip}|${username}`);
  res.setHeader('Set-Cookie', startSession(res, row.id));
  return { user: { id: row.id, username: row.username, displayName: row.displayName, role: row.role } };
});

route('POST', /^\/api\/logout$/, { open: true }, ({ req, res }) => {
  const token = sessionToken(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${SECURE_COOKIE ? '; Secure' : ''}`);
  return {};
});

route('GET', /^\/api\/products\/(\d{8,14})$/, {}, async ({ params }) => {
  const barcode = barcodeOf(params[0]);
  const product = await lookupProduct(barcode);
  return { barcode, found: Boolean(product), product, ...pricesFor(barcode) };
});

route('PUT', /^\/api\/products\/(\d{8,14})$/, {}, async ({ req, params, user }) => {
  const barcode = barcodeOf(params[0]);
  const input = await readJson(req);
  const name = clean(input.name, 120);
  if (name.length < 2) throw bad('Give the product a name.');
  const existing = db.prepare('SELECT source FROM products WHERE barcode = ?').get(barcode);
  if (existing && existing.source === 'off' && user.role !== 'admin') throw bad('This product already has details from Open Food Facts.', 409);
  db.prepare(`INSERT INTO products (barcode, name, brand, size, image_url, source, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, '', 'user', ?, ?, ?)
              ON CONFLICT(barcode) DO UPDATE SET name = excluded.name, brand = excluded.brand, size = excluded.size, updated_at = excluded.updated_at`)
    .run(barcode, name, clean(input.brand, 80), clean(input.size, 40), user.id, now(), now());
  db.prepare('DELETE FROM off_misses WHERE barcode = ?').run(barcode);
  return { product: db.prepare('SELECT barcode, name, brand, size, image_url AS imageUrl, source FROM products WHERE barcode = ?').get(barcode) };
});

route('GET', /^\/api\/stores$/, {}, () => ({ stores: db.prepare('SELECT id, chain, suburb, state FROM stores ORDER BY chain, suburb').all() }));

route('POST', /^\/api\/stores$/, {}, async ({ req, user }) => {
  const input = await readJson(req);
  const chain = CHAINS.includes(input.chain) ? input.chain : null;
  const state = STATES.includes(input.state) ? input.state : null;
  const suburb = clean(input.suburb, 60).replace(/\b\w/g, (letter) => letter.toUpperCase());
  if (!chain || !state || suburb.length < 2) throw bad('A store needs a chain, a suburb and a state.');
  db.prepare('INSERT OR IGNORE INTO stores (chain, suburb, state, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(chain, suburb, state, user.id, now());
  return { store: db.prepare('SELECT id, chain, suburb, state FROM stores WHERE chain = ? AND suburb = ? AND state = ?').get(chain, suburb, state) };
});

route('POST', /^\/api\/prices$/, {}, async ({ req, user }) => {
  if (limited(`prices|${user.id}`, 300, 60 * 60 * 1000)) throw bad('That is a lot of prices in one hour. Try again later.', 429);
  const input = await readJson(req);
  const barcode = barcodeOf(input.barcode);
  if (!db.prepare('SELECT 1 FROM products WHERE barcode = ?').get(barcode)) throw bad('Look the product up or name it before adding a price.');
  const store = storeOf(input.storeId);
  const priceCents = centsOf(input.price, 'The price');
  const onSpecial = input.onSpecial ? 1 : 0;
  const wasCents = input.wasPrice === undefined || input.wasPrice === null || input.wasPrice === '' ? null : centsOf(input.wasPrice, 'The usual price');
  if (wasCents !== null && wasCents <= priceCents) throw bad('The usual price should be higher than the special price.');
  const observedOn = dateOf(input.observedOn);
  const usual = typicalPrice(barcode);
  const heldReason = !usual ? null
    : priceCents * 100 > usual.priceCents * (100 + MAX_OVER_PERCENT) ? 'high'
      : priceCents * 100 < usual.priceCents * (100 - MAX_UNDER_PERCENT) ? 'low' : null;
  const held = heldReason !== null;
  const id = db.prepare(`INSERT INTO prices (barcode, store_id, price_cents, was_cents, on_special, observed_on, user_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(barcode, store.id, priceCents, wasCents, onSpecial, observedOn, user.id, held ? 'held' : 'accepted', now()).lastInsertRowid;
  return { id: Number(id), held, heldReason, usual, maxOverPercent: MAX_OVER_PERCENT, maxUnderPercent: MAX_UNDER_PERCENT, ...pricesFor(barcode) };
});

route('GET', /^\/api\/prices$/, {}, ({ url, user }) => {
  const mine = url.searchParams.get('mine') === '1';
  const rows = db.prepare(`SELECT ${PRICE_COLUMNS}, pr.name, pr.brand, pr.size, u.display_name AS addedBy FROM prices p
    JOIN stores s ON s.id = p.store_id JOIN products pr ON pr.barcode = p.barcode JOIN users u ON u.id = p.user_id
    WHERE ${mine ? 'p.user_id = ?' : `(p.status IN ${COUNTED} OR p.user_id = ?)`} ORDER BY p.created_at DESC LIMIT 100`).all(user.id);
  return { prices: rows };
});

route('DELETE', /^\/api\/prices\/(\d+)$/, {}, ({ params, user }) => {
  const row = db.prepare('SELECT user_id, status FROM prices WHERE id = ?').get(Number(params[0]));
  if (!row) throw bad('That price no longer exists.', 404);
  if (user.role !== 'admin' && (row.user_id !== user.id || row.status === 'verified')) throw bad('You can only remove your own unconfirmed prices.', 403);
  db.prepare('DELETE FROM prices WHERE id = ?').run(Number(params[0]));
  return {};
});

route('POST', /^\/api\/receipts$/, { raw: true }, async ({ req, url, user }) => {
  if (limited(`receipts|${user.id}`, 30, 60 * 60 * 1000)) throw bad('Too many receipts in one hour. Try again later.', 429);
  const kind = url.searchParams.get('kind') === 'tag' ? 'tag' : 'receipt';
  let store; let purchasedOn; let price = null;
  if (kind === 'tag') {
    price = db.prepare('SELECT id, user_id, store_id, observed_on, receipt_id, status, price_cents FROM prices WHERE id = ?').get(Number(url.searchParams.get('priceId')) || 0);
    if (!price || price.user_id !== user.id) throw bad('That price was not found.', 404);
    if (price.receipt_id || !['accepted', 'held'].includes(price.status)) throw bad('That price already has a photo attached.', 409);
    store = storeOf(price.store_id); purchasedOn = price.observed_on;
  } else {
    store = storeOf(url.searchParams.get('storeId')); purchasedOn = dateOf(url.searchParams.get('date'));
  }
  const image = await readBody(req, MAX_IMAGE);
  const format = imageKind(image);
  if (!format) throw bad('Upload a photo (JPEG, PNG, WebP or HEIC).', 415);
  const id = crypto.randomBytes(12).toString('hex');
  const file = `${id}.${format[0]}`;
  fs.writeFileSync(path.join(RECEIPT_DIR, file), image, { mode: 0o600 });
  db.prepare('INSERT INTO receipts (id, user_id, store_id, purchased_on, image_file, content_type, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, user.id, store.id, purchasedOn, file, format[1], kind, now());
  const promote = `receipt_id = ?, status = CASE status WHEN 'held' THEN 'held_receipt' ELSE 'receipt' END`;
  const attached = kind === 'tag'
    ? db.prepare(`UPDATE prices SET ${promote} WHERE id = ? AND receipt_id IS NULL`).run(id, price.id).changes
    : db.prepare(`UPDATE prices SET ${promote} WHERE user_id = ? AND store_id = ? AND observed_on = ? AND receipt_id IS NULL AND status IN ('accepted', 'held')`)
      .run(id, user.id, store.id, purchasedOn).changes;
  if (kind === 'tag') checkTagWithAi(id, image, format[1], price.id, price.price_cents);
  return { id, kind, attached: Number(attached), aiCheck: kind === 'tag' && Boolean(OLLAMA_URL) && format[1] !== 'image/heic' };
});

function receiptFor(id, user) {
  const receipt = db.prepare(`SELECT r.id, r.user_id AS userId, r.purchased_on AS purchasedOn, r.status, r.kind, r.ai_price_cents AS aiPriceCents, r.ai_name AS aiName, r.ai_checked_at AS aiCheckedAt, r.image_file AS imageFile, r.content_type AS contentType,
    s.chain, s.suburb, s.state, u.display_name AS uploadedBy FROM receipts r JOIN stores s ON s.id = r.store_id JOIN users u ON u.id = r.user_id WHERE r.id = ?`).get(String(id));
  if (!receipt || (user.role !== 'admin' && receipt.userId !== user.id)) throw bad('That receipt was not found.', 404);
  return receipt;
}

route('GET', /^\/api\/receipts$/, {}, ({ user }) => ({
  receipts: db.prepare(`SELECT r.id, r.kind, r.purchased_on AS purchasedOn, r.status, s.chain, s.suburb, s.state, u.display_name AS uploadedBy,
      (SELECT COUNT(*) FROM prices p WHERE p.receipt_id = r.id) AS priceCount
    FROM receipts r JOIN stores s ON s.id = r.store_id JOIN users u ON u.id = r.user_id
    ${user.role === 'admin' ? '' : 'WHERE r.user_id = ?'} ORDER BY r.created_at DESC LIMIT 100`).all(...(user.role === 'admin' ? [] : [user.id]))
}));

route('GET', /^\/api\/receipts\/([a-f0-9]{24})$/, {}, ({ params, user }) => {
  const { imageFile, contentType, ...receipt } = receiptFor(params[0], user);
  const prices = db.prepare(`SELECT ${PRICE_COLUMNS}, pr.name, pr.brand, pr.size FROM prices p JOIN stores s ON s.id = p.store_id JOIN products pr ON pr.barcode = p.barcode
    WHERE p.receipt_id = ? ORDER BY pr.name`).all(receipt.id);
  return { receipt, prices };
});

route('GET', /^\/api\/receipts\/([a-f0-9]{24})\/image$/, { stream: true }, ({ params, user, res }) => {
  const receipt = receiptFor(params[0], user);
  const file = path.join(RECEIPT_DIR, path.basename(receipt.imageFile));
  if (!fs.existsSync(file)) throw bad('That receipt image is missing.', 404);
  res.writeHead(200, { 'Content-Type': receipt.contentType, 'Cache-Control': 'private, max-age=3600', ...SECURITY_HEADERS });
  fs.createReadStream(file).pipe(res);
});

route('POST', /^\/api\/receipts\/([a-f0-9]{24})\/verify$/, { admin: true }, async ({ req, params, user }) => {
  const receipt = receiptFor(params[0], user);
  const input = await readJson(req);
  const reject = Array.isArray(input.rejectPriceIds) ? input.rejectPriceIds.map(Number).filter(Number.isInteger).slice(0, 500) : [];
  for (const id of reject) db.prepare('DELETE FROM prices WHERE id = ? AND receipt_id = ?').run(id, receipt.id);
  const verified = db.prepare(`UPDATE prices SET status = 'verified' WHERE receipt_id = ?`).run(receipt.id).changes;
  db.prepare(`UPDATE receipts SET status = 'verified', verified_by = ?, verified_at = ? WHERE id = ?`).run(user.id, now(), receipt.id);
  return { verified: Number(verified), rejected: reject.length };
});

route('GET', /^\/api\/invites$/, { admin: true }, () => ({
  invites: db.prepare(`SELECT i.code, i.expires_at AS expiresAt, i.used_at AS usedAt, u.display_name AS usedBy FROM invites i LEFT JOIN users u ON u.id = i.used_by ORDER BY i.created_at DESC LIMIT 50`).all()
}));

route('POST', /^\/api\/invites$/, { admin: true }, ({ user }) => {
  const code = Array.from(crypto.randomBytes(10), (byte) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[byte % 32]).join('');
  db.prepare('INSERT INTO invites (code, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)').run(code, user.id, now(), now() + 14 * 86400000);
  return { code, expiresAt: now() + 14 * 86400000 };
});

route('GET', /^\/api\/users$/, { admin: true }, () => ({
  users: db.prepare(`SELECT u.id, u.username, u.display_name AS displayName, u.role, u.disabled, u.created_at AS createdAt,
    (SELECT COUNT(*) FROM prices p WHERE p.user_id = u.id) AS priceCount FROM users u ORDER BY u.created_at`).all()
}));

route('POST', /^\/api\/users\/(\d+)\/disabled$/, { admin: true }, async ({ req, params, user }) => {
  const input = await readJson(req);
  const id = Number(params[0]);
  if (id === user.id) throw bad('You cannot switch off your own account.');
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) throw bad('That person was not found.', 404);
  db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(input.disabled ? 1 : 0, id);
  if (input.disabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  return { disabled: Boolean(input.disabled) };
});

route('GET', /^\/api\/export\.csv$/, { stream: true }, ({ res }) => {
  const rows = db.prepare(`SELECT p.barcode, pr.name, pr.brand, pr.size, s.chain, s.suburb, s.state, p.price_cents, p.was_cents, p.on_special, p.observed_on, p.status
    FROM prices p JOIN products pr ON pr.barcode = p.barcode JOIN stores s ON s.id = p.store_id WHERE p.status IN ${COUNTED} ORDER BY p.observed_on DESC, p.id DESC`).all();
  // Quote where needed, and neutralise cells a spreadsheet would run as a formula.
  const cell = (value) => { let text = String(value ?? ''); if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };
  const lines = ['barcode,name,brand,size,chain,suburb,state,price,usual_price,on_special,observed_on,status'];
  for (const r of rows) lines.push([r.barcode, r.name, r.brand, r.size, r.chain, r.suburb, r.state, (r.price_cents / 100).toFixed(2), r.was_cents ? (r.was_cents / 100).toFixed(2) : '', r.on_special ? 'yes' : 'no', r.observed_on, r.status].map(cell).join(','));
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="pricebook-${today()}.csv"`, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(lines.join('\n') + '\n');
});

// Machine lookup for other apps (the family hub). Off unless LOOKUP_API_TOKEN is set.
route('GET', /^\/api\/v1\/lookup\/(\d{8,14})$/, { open: true }, ({ req, params }) => {
  const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!LOOKUP_API_TOKEN || supplied.length !== LOOKUP_API_TOKEN.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(LOOKUP_API_TOKEN))) throw bad('Not authorised.', 401);
  const barcode = barcodeOf(params[0]);
  const product = db.prepare('SELECT barcode, name, brand, size FROM products WHERE barcode = ?').get(barcode) || null;
  const prices = pricesFor(barcode);
  return { barcode, product, typical: prices.typical, latest: prices.latest.map(({ userId, receiptId, ...rest }) => rest) };
});

// ── static files ────────────────────────────────────────────────────────────
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'], '/icon.svg': ['icon.svg', 'image/svg+xml'] };
function serveStatic(res, pathname) {
  const entry = STATIC[pathname];
  if (!entry) return false;
  const data = fs.readFileSync(path.join(PUBLIC_DIR, entry[0]));
  res.writeHead(200, { 'Content-Type': entry[1], 'Content-Length': data.length, 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
  res.end(data);
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
    if (req.method === 'GET' && serveStatic(res, url.pathname)) return undefined;
    if (req.method === 'GET' && url.pathname === '/pricebook.apk' && fs.existsSync(APK_FILE)) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': fs.statSync(APK_FILE).size,
        'Content-Disposition': 'attachment; filename="pricebook.apk"', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
      fs.createReadStream(APK_FILE).pipe(res);
      return undefined;
    }
    // A ceiling on API calls per address, so nobody can hammer the service once it is on the internet.
    if (url.pathname.startsWith('/api/') && limited(`api|${clientIp(req)}`, 600, 5 * 60 * 1000)) throw bad('Too many requests. Slow down and try again in a few minutes.', 429);
    for (const entry of routes) {
      const match = entry.method === req.method && url.pathname.match(entry.pattern);
      if (!match) continue;
      // Browsers cannot add this header cross-site without a CORS preflight, which is never granted.
      if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'pricebook') throw bad('Missing request header.', 403);
      const user = currentUser(req);
      if (!entry.options.open && !user) throw bad('Please sign in.', 401);
      if (entry.options.admin && user.role !== 'admin') throw bad('Only an admin can do that.', 403);
      const result = await entry.handler({ req, res, url, params: match.slice(1), user });
      if (!entry.options.stream) sendJson(res, 200, { ok: true, ...result });
      return undefined;
    }
    return sendJson(res, 404, { ok: false, error: 'Not found.' });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) console.error(new Date().toISOString(), req.method, req.url, error);
    if (req.tooLarge) res.once('finish', () => req.destroy());
    if (!res.headersSent) sendJson(res, status, { ok: false, error: status === 500 ? 'Something went wrong on the server.' : error.message }, req.tooLarge ? { Connection: 'close' } : {});
    else res.end();
    return undefined;
  }
});
server.requestTimeout = 60000;
server.headersTimeout = 15000;
server.listen(PORT, '0.0.0.0', () => console.log(`Pricebook is listening on port ${PORT}`));
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now()), 6 * 60 * 60 * 1000).unref();

// One consistent copy of the database per day, kept for 14 days, in data/backups.
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
function backupDatabase() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const file = path.join(BACKUP_DIR, `pricebook-${today()}.sqlite`);
    if (!fs.existsSync(file)) { db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`); console.log(`Backup written: ${path.basename(file)}`); }
    const old = fs.readdirSync(BACKUP_DIR).filter((name) => /^pricebook-\d{4}-\d{2}-\d{2}\.sqlite$/.test(name)).sort().slice(0, -14);
    for (const name of old) fs.rmSync(path.join(BACKUP_DIR, name));
  } catch (error) { console.error(new Date().toISOString(), 'backup failed:', error.message); }
}
setTimeout(backupDatabase, 30 * 1000).unref();
setInterval(backupDatabase, 3 * 60 * 60 * 1000).unref();
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
