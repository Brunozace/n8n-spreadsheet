import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../server.mjs';
import { hashPassword } from '../lib/auth.mjs';
import { readConfig } from '../lib/config.mjs';
import { sampleWorkbook } from '../lib/spreadsheets.mjs';
import { processSales } from '../core.mjs';

const password = 'temporary test password only';
const hash = await hashPassword(password);
const sample = await sampleWorkbook();
const origin = 'http://localhost:3000';
const type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

test('configuration rejects example secrets and requires secure production settings', () => {
  const base = { users: { alpha: hash }, n8nWebhookSecret: 'a'.repeat(64) };
  assert.throws(() => readConfig({}, { ...base, n8nWebhookSecret: 'REPLACE_WITH_RANDOM_WEBHOOK_SECRET' }), /example placeholder/);
  assert.throws(() => readConfig({}, { ...base, production: true }), /Production requires/);
  assert.throws(() => readConfig({}, { ...base, production: true, appOrigin: 'https://pilot.example.com', secureCookie: false }), /Production requires/);
  assert.throws(() => readConfig({}, { ...base, users: { alpha: 'plaintext-password' } }), /scrypt hash/);
  assert.equal(readConfig({}, { ...base, production: true, appOrigin: 'https://pilot.example.com', secureCookie: true }).secureCookie, true);
});

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  const closed = once(server, 'close');
  server.close();
  server.closeAllConnections();
  await closed;
}
async function fixture(t, overrides = {}) {
  let behavior = 'complete', calls = 0;
  const backend = http.createServer(async (req, res) => {
    calls++;
    assert.equal(req.headers['x-pilot-key'], 'a'.repeat(64));
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks));
    if (behavior === 'timeout') return;
    if (behavior === 'failure') { res.writeHead(500); return res.end('private diagnostic'); }
    if (behavior === 'malformed') return res.end('not JSON');
    if (behavior === 'oversized') return res.end('x'.repeat(30000));
    if (behavior === 'receipt') return res.end(JSON.stringify({ message: 'Workflow was started' }));
    const payload = { requestId: input.requestId, result: processSales(input.rows) };
    if (behavior === 'wrong-request') payload.requestId = 'different-request';
    if (behavior === 'wrong-total') payload.result.summary.valid_sales_total_clp++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(payload));
  });
  const backendUrl = await listen(backend);
  const server = createServer({
    appOrigin: origin, production: false, secureCookie: false,
    users: { alpha: hash, beta: hash }, n8nWebhookSecret: 'a'.repeat(64),
    n8nWebhookUrl: backendUrl, n8nTimeoutMs: 1000, quiet: true,
    loginLimit: 100, uploadLimit: 100, ...overrides,
  });
  const url = await listen(server);
  t.after(async () => { await close(server); await close(backend); });
  async function login(username = 'alpha') {
    const response = await fetch(url + '/api/login', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    return { Cookie: response.headers.get('set-cookie').split(';')[0], Origin: origin, 'X-CSRF-Token': body.csrfToken };
  }
  async function upload(headers, body = sample) {
    return fetch(url + '/api/upload', {
      method: 'POST', headers: { ...headers, 'Content-Type': type, 'X-Filename': 'sales.xlsx' }, body,
    });
  }
  return { url, login, upload, behavior: value => { behavior = value; }, calls: () => calls };
}

test('pilot requests require authentication, same origin and CSRF protection', async t => {
  const f = await fixture(t);
  assert.equal((await f.upload({ Origin: origin })).status, 401);
  assert.equal((await fetch(f.url + '/downloads/template.xlsx')).status, 401);
  const alpha = await f.login();
  assert.equal((await f.upload({ ...alpha, Origin: 'https://other.example' })).status, 403);
  assert.equal((await f.upload({ ...alpha, 'X-CSRF-Token': 'incorrect' })).status, 403);
  assert.equal((await f.upload({ ...alpha, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal(f.calls(), 0, 'rejected requests must never reach n8n');
  const response = await fetch(f.url + '/api/login', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'unknown', password }),
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'INVALID_CREDENTIALS');
});

test('result files and metadata are isolated by session and are removed on delete/logout', async t => {
  const f = await fixture(t);
  const alpha = await f.login('alpha'), beta = await f.login('beta'), secondAlpha = await f.login('alpha');
  const result = await (await f.upload(alpha)).json();
  assert.equal(result.summary.valid_sales_total_clp, 53000);
  const path = `/api/results/${result.id}`;
  for (const headers of [beta, secondAlpha]) {
    assert.equal((await fetch(f.url + path, { headers })).status, 404);
    assert.equal((await fetch(f.url + result.downloads.valid, { headers })).status, 404);
  }
  const original = await fetch(f.url + result.downloads.original, { headers: alpha });
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), sample, 'original upload must be unchanged');
  assert.equal((await fetch(f.url + path, { method: 'DELETE', headers: alpha })).status, 200);
  assert.equal((await fetch(f.url + result.downloads.valid, { headers: alpha })).status, 404);
  const second = await (await f.upload(alpha)).json();
  assert.equal((await fetch(f.url + '/api/logout', { method: 'POST', headers: alpha })).status, 200);
  assert.equal((await fetch(f.url + second.downloads.valid, { headers: alpha })).status, 401);
  const fresh = await f.login('alpha');
  assert.equal((await fetch(f.url + second.downloads.valid, { headers: fresh })).status, 404);
});

test('results expire and cannot outlive the session', async t => {
  const f = await fixture(t, { resultTtlMs: 100, sessionTtlMs: 60000 });
  const alpha = await f.login();
  const result = await (await f.upload(alpha)).json();
  assert.ok(result.id);
  await delay(150);
  assert.equal((await fetch(f.url + result.downloads.valid, { headers: alpha })).status, 404);
  const g = await fixture(t, { resultTtlMs: 60000, sessionTtlMs: 5000 });
  const other = await g.login();
  const loggedIn = Date.now();
  const limited = await (await g.upload(other)).json();
  assert.ok(Date.parse(limited.expiresAt) <= loggedIn + 5000, 'download expiry must reflect the session deadline');
});

test('incomplete, incorrect, failed and oversized backend responses never become results', async t => {
  const f = await fixture(t, { maxN8nResponseBytes: 20000 });
  const alpha = await f.login();
  for (const behavior of ['receipt', 'malformed', 'wrong-request', 'wrong-total', 'failure', 'oversized']) {
    f.behavior(behavior);
    const response = await f.upload(alpha);
    assert.equal(response.status, 502, behavior);
    const error = await response.json();
    assert.equal(error.downloads, undefined, behavior);
    assert.equal(error.summary, undefined, behavior);
    assert.ok(error.code, behavior);
    assert.ok(!JSON.stringify(error).includes('private diagnostic'));
  }
  f.behavior('complete');
  assert.equal((await f.upload(alpha)).status, 200, 'a failed attempt must release the upload slot');
});

test('backend timeouts return an explicit failure and release the upload slot', async t => {
  const f = await fixture(t, { n8nTimeoutMs: 500 });
  const alpha = await f.login();
  f.behavior('timeout');
  const response = await f.upload(alpha);
  assert.equal(response.status, 504);
  const error = await response.json();
  assert.equal(error.code, 'PROCESSING_TIMEOUT');
  assert.equal(error.downloads, undefined);
  f.behavior('complete');
  assert.equal((await f.upload(alpha)).status, 200);
});

test('server rejects unsupported upload type and oversized bodies before n8n', async t => {
  const f = await fixture(t, { maxUploadBytes: sample.length - 1 });
  const alpha = await f.login();
  const oversized = await f.upload(alpha);
  assert.equal(oversized.status, 413);
  const wrongType = await fetch(f.url + '/api/upload', {
    method: 'POST', headers: { ...alpha, 'Content-Type': 'text/csv', 'X-Filename': 'sales.csv' }, body: 'id,price',
  });
  assert.equal(wrongType.status, 415);
  assert.equal(f.calls(), 0);
});
