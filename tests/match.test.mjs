// Shopping-list matching for the family hub (POST /api/v1/match). Starts a throwaway server on a temp folder.
//   node --test tests/match.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'test-lookup-token-0123456789';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricebook-test-'));
let server;
let cookie = '';

async function call(method, url, body, headers = {}) {
  const response = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'pricebook', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return { status: response.status, body: await response.json() };
}
const match = (items, token = TOKEN) => call('POST', '/api/v1/match', { items }, { Authorization: `Bearer ${token}` });

before(async () => {
  server = spawn(process.execPath, ['app/server.js'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, LOOKUP_API_TOKEN: TOKEN, COOKIE_SECURE: 'false', OLLAMA_URL: '' },
    stdio: 'ignore'
  });
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal((await call('POST', '/api/register', { username: 'tester', password: 'correct horse battery' })).status, 200);
  const store = (await call('POST', '/api/stores', { chain: 'Coles', suburb: 'Exampleton', state: 'NSW' })).body.store;
  const store2 = (await call('POST', '/api/stores', { chain: 'ALDI', suburb: 'Sampleford', state: 'NSW' })).body.store;
  const product = (barcode, name, brand, size) => call('PUT', `/api/products/${barcode}`, { name, brand, size });
  await product('9300000000011', 'Coles Beef Mince 3 Star', 'Coles', '500g');
  await product('9300000000028', 'Lamb Mince', 'Coles', '500g');
  await product('9300000000035', 'Washed Potatoes', 'Coles', '2kg');
  await product('9300000000042', 'Premium Beef Mince Extra Lean Organic', 'Organic Co', '500g');
  const price = (barcode, storeId, price) => call('POST', '/api/prices', { barcode, storeId, price, observedOn: new Date().toISOString().slice(0, 10) });
  await price('9300000000011', store.id, '7.00');
  await price('9300000000011', store2.id, '6.50');
  await price('9300000000035', store.id, '4.20');
});
after(() => { server?.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('needs the lookup token', async () => {
  assert.equal((await match([{ name: 'beef mince' }], 'wrong-token-0123456789-xx')).status, 401);
  assert.equal((await call('POST', '/api/v1/match', { items: [] })).status, 401);
});

test('by barcode: exact product, typical price and the cheapest store', async () => {
  const { status, body } = await match([{ barcode: '9300000000011', name: 'anything' }]);
  assert.equal(status, 200);
  const m = body.matches[0];
  assert.equal(m.matchedBy, 'barcode');
  assert.equal(m.product.name, 'Coles Beef Mince 3 Star');
  assert.equal(m.cheapest.chain, 'ALDI');
  assert.equal(m.cheapest.priceCents, 650);
  assert.equal(m.typical.priceCents, 675);
  assert.equal(m.typical.stores, 2);
  assert.equal(m.cheapest.userId, undefined);
});

test('by name: every word must be there; a product with prices wins', async () => {
  const { body } = await match([{ name: 'Beef mince' }, { name: 'Potatoes' }, { name: 'Lamb mince' }, { name: 'Dragon fruit' }, { name: '' }]);
  const [beef, potatoes, lamb, none, empty] = body.matches;
  assert.equal(beef.matchedBy, 'name');
  assert.equal(beef.product.barcode, '9300000000011');   // priced, beats the unpriced organic one
  assert.equal(potatoes.product.name, 'Washed Potatoes');
  assert.equal(potatoes.cheapest.priceCents, 420);
  assert.equal(lamb.product.name, 'Lamb Mince');          // known product, no prices yet
  assert.equal(lamb.typical, null);
  assert.equal(lamb.cheapest, null);
  assert.equal(none, null);
  assert.equal(empty, null);
});

test('an unknown barcode falls back to the name', async () => {
  const { body } = await match([{ barcode: '9399999999999', name: 'beef mince' }]);
  assert.equal(body.matches[0].matchedBy, 'name');
});

test('at most 100 items per call', async () => {
  const { body } = await match(Array.from({ length: 150 }, () => ({ name: 'potatoes' })));
  assert.equal(body.matches.length, 100);
});
