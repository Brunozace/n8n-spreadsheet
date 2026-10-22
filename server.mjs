import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from './lib/config.mjs';
import { verifyPassword, constantTimeEqual } from './lib/auth.mjs';
import { extractSales, createReports, blankTemplate, sampleWorkbook } from './lib/spreadsheets.mjs';
import { extractQuotationWorkbook } from './lib/quotation-reader.mjs';
import { validateQuotationResult, createQuotationReports, quotationSample } from './lib/quotation-results.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const COOKIE = 'pilot_session';
const RATE_WINDOW_MS = 15 * 60 * 1000;
const newToken = () => randomBytes(32).toString('hex');
const integer = n => Number.isSafeInteger(n) && n >= 0;

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function failure(status, code, message) { return new HttpError(status, code, message); }

function headers(res, config) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (config.secureCookie) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

function sendFile(res, bytes, filename) {
  res.writeHead(200, {
    'Content-Type': XLSX_TYPE,
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': bytes.length,
  });
  res.end(bytes);
}

async function readBody(req, maxBytes) {
  const declared = req.headers['content-length'];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    throw failure(413, 'FILE_TOO_LARGE', 'El archivo o solicitud supera el tamaño permitido.');
  }
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', aborted);
    };
    const data = part => {
      size += part.length;
      if (size > maxBytes) {
        // Pause instead of destroying the socket, so the client receives a useful 413.
        req.pause(); cleanup();
        reject(failure(413, 'FILE_TOO_LARGE', 'El archivo o solicitud supera el tamaño permitido.'));
      } else parts.push(part);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(parts, size)); };
    const error = cause => { cleanup(); reject(cause); };
    const aborted = () => error(failure(400, 'UPLOAD_INTERRUPTED', 'La carga se interrumpió. Vuelve a seleccionar el archivo.'));
    req.on('data', data); req.once('end', end); req.once('error', error); req.once('aborted', aborted);
  });
}

async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw failure(415, 'CONTENT_TYPE', 'La solicitud debe usar JSON.');
  }
  const raw = await readBody(req, 8192);
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw failure(400, 'INVALID_JSON', 'La solicitud no contiene JSON válido.'); }
}

// This checks the completion contract, not business rules. The n8n workflow runs core.mjs.
export function validateCompletion(payload, requestId, inputCount) {
  const result = payload?.result;
  const summary = result?.summary;
  const invalid = () => { throw failure(502, 'INVALID_BACKEND_RESULT', 'El procesamiento no devolvió resultados completos. Intenta nuevamente; no se generaron informes.'); };
  if (payload?.requestId !== requestId || !result || !Array.isArray(result.valid) || !Array.isArray(result.review) || !summary) invalid();
  if (summary.input_records !== inputCount || summary.valid_records !== result.valid.length || summary.review_records !== result.review.length ||
      result.valid.length + result.review.length !== inputCount || !integer(summary.valid_sales_total_clp) || summary.currency !== 'CLP' ||
      summary.status !== (result.review.length ? 'INCOMPLETE: review rows excluded from total' : 'COMPLETE') || typeof summary.calculation !== 'string') invalid();
  const seen = new Set();
  let sum = 0;
  const ordinal = row => {
    if (!row || !Number.isSafeInteger(row.input_record) || row.input_record < 1 || row.input_record > inputCount || seen.has(row.input_record)) invalid();
    seen.add(row.input_record);
  };
  for (const row of result.valid) {
    ordinal(row);
    if (typeof row.transaction_id !== 'string' || !row.transaction_id || typeof row.product !== 'string' || !row.product ||
        !integer(row.quantity) || row.quantity === 0 || !integer(row.unit_price_clp) || !integer(row.line_total_clp) ||
        row.line_total_clp !== row.quantity * row.unit_price_clp) invalid();
    sum += row.line_total_clp;
    if (!integer(sum)) invalid();
  }
  for (const row of result.review) {
    ordinal(row);
    if (typeof row.transaction_id !== 'string' || typeof row.issues !== 'string' || !row.issues || typeof row.original_row_json !== 'string') invalid();
    try {
      const original = JSON.parse(row.original_row_json);
      if (!original || Array.isArray(original) || typeof original !== 'object') invalid();
    } catch { invalid(); }
  }
  if (sum !== summary.valid_sales_total_clp) invalid();
  return result;
}

export function createServer(overrides = {}) {
  const config = readConfig(process.env, overrides);
  const sessions = new Map();
  const rateLimits = new Map();
  const jobs = new Map();
  const activeControllers = new Set();
  let storedBytes = 0;
  let activeUploads = 0;
  let activeLogins = 0;
  let stopped = false;
  let template;
  let sample;
  let quoteSample;

  function deleteJob(id) {
    const job = jobs.get(id);
    if (!job) return;
    storedBytes -= job.bytes;
    sessions.get(job.sessionId)?.jobs.delete(id);
    jobs.delete(id);
  }
  function deleteSession(id) {
    const session = sessions.get(id);
    if (!session) return;
    for (const jobId of session.jobs) deleteJob(jobId);
    sessions.delete(id);
  }
  function cleanup() {
    const now = Date.now();
    for (const [id, job] of jobs) if (job.expiresAt <= now) deleteJob(id);
    for (const [id, session] of sessions) if (session.expiresAt <= now) deleteSession(id);
    for (const [key, entry] of rateLimits) if (entry.expiresAt <= now) rateLimits.delete(key);
  }
  const cleanupTimer = setInterval(cleanup, Math.min(config.resultTtlMs, 60000));
  cleanupTimer.unref();

  function rateLimit(key, limit) {
    cleanup();
    let entry = rateLimits.get(key);
    if (!entry) {
      if (rateLimits.size >= 10000) throw failure(503, 'BUSY', 'El servicio está ocupado. Intenta más tarde.');
      entry = { count: 0, expiresAt: Date.now() + RATE_WINDOW_MS };
      rateLimits.set(key, entry);
    }
    entry.count++;
    if (entry.count > limit) throw failure(429, 'RATE_LIMIT', 'Demasiados intentos. Espera 15 minutos antes de volver a intentar.');
  }
  function sessionCookie(res, token, expired = false) {
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${expired ? 0 : Math.floor(config.sessionTtlMs / 1000)}${config.secureCookie ? '; Secure' : ''}`);
  }
  function findSession(req) {
    const cookie = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(`${COOKIE}=`));
    const id = cookie?.slice(COOKIE.length + 1);
    const session = id && sessions.get(id);
    if (session && session.expiresAt > Date.now()) return session;
    if (session) deleteSession(id);
    return null;
  }
  function requireSession(req) {
    const session = findSession(req);
    if (!session) throw failure(401, 'AUTH_REQUIRED', 'Tu sesión terminó. Inicia sesión para continuar.');
    return session;
  }
  function requireOrigin(req) {
    if (req.headers.origin !== config.appOrigin) throw failure(403, 'ORIGIN', 'No se permite esta solicitud desde otro sitio.');
    if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) {
      throw failure(403, 'ORIGIN', 'No se permite esta solicitud desde otro sitio.');
    }
  }
  function requireCsrf(req, session) {
    requireOrigin(req);
    if (!constantTimeEqual(req.headers['x-csrf-token'], session.csrfToken)) {
      throw failure(403, 'CSRF', 'La sesión cambió. Recarga la página e intenta nuevamente.');
    }
  }
  function sessionView(session) {
    return {
      authenticated: Boolean(session),
      ...(session ? { username: session.username, csrfToken: session.csrfToken } : {}),
      maxUploadBytes: config.maxUploadBytes,
      resultTtlMinutes: config.resultTtlMs / 60000,
    };
  }
  function jobView(job) {
    const base = `/api/results/${job.id}/files/`;
    if(job.kind === 'quotation') return {
      id: job.id, kind: job.kind, ...job.result,
      expiresAt: new Date(job.expiresAt).toISOString(),
      downloads: {parts:`${base}repuestos.xlsx`,review:`${base}revision.xlsx`,summary:`${base}resumen.xlsx`,original:`${base}original.xlsx`},
    };
    return {
      id: job.id,
      summary: job.summary,
      review: job.review,
      expiresAt: new Date(job.expiresAt).toISOString(),
      downloads: { valid: `${base}valid.xlsx`, review: `${base}review.xlsx`, summary: `${base}summary.xlsx`, original: `${base}original.xlsx` },
    };
  }
  function findJob(id, session) {
    const job = jobs.get(id);
    if (!job || job.sessionId !== session.id || job.expiresAt <= Date.now()) {
      if (job?.expiresAt <= Date.now()) deleteJob(id);
      throw failure(404, 'RESULT_EXPIRED', 'El resultado no está disponible o ya venció. Vuelve a cargar el archivo.');
    }
    return job;
  }

  async function callN8n(rows, requestId, res, kind = 'sales') {
    const controller = new AbortController();
    activeControllers.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, config.n8nTimeoutMs);
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnected);
    try {
      const response = await fetch(kind === 'quotation' ? config.n8nQuotationWebhookUrl : config.n8nWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Pilot-Key': config.n8nWebhookSecret },
        body: JSON.stringify(kind === 'quotation' ? {requestId,kind,workbook:rows} : { requestId, rows }),
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) throw failure(502, 'PROCESSING_FAILED', 'No se pudo completar el procesamiento. Intenta nuevamente; no se generaron informes.');
      const declared = response.headers.get('content-length');
      if (declared && Number(declared) > config.maxN8nResponseBytes) throw failure(502, 'BACKEND_SIZE', 'El resultado excede el límite del servicio.');
      const parts = [];
      let size = 0;
      for await (const part of response.body) {
        size += part.length;
        if (size > config.maxN8nResponseBytes) { controller.abort(); throw failure(502, 'BACKEND_SIZE', 'El resultado excede el límite del servicio.'); }
        parts.push(Buffer.from(part));
      }
      let payload;
      try { payload = JSON.parse(Buffer.concat(parts).toString('utf8')); }
      catch { throw failure(502, 'INVALID_BACKEND_RESULT', 'El procesamiento no devolvió resultados completos. Intenta nuevamente; no se generaron informes.'); }
      if(kind === 'quotation') {
        if(payload?.requestId === requestId && payload?.kind === 'quotation' && payload?.error?.code === 'INVALID_QUOTATION' && typeof payload.error.message === 'string' && payload.error.message.length <= 500) {
          throw failure(400,'INVALID_QUOTATION',payload.error.message);
        }
        try { return validateQuotationResult(payload, requestId, rows); }
        catch { throw failure(502,'INVALID_BACKEND_RESULT','El procesamiento no devolvió una revisión completa de la cotización. No se generaron informes.'); }
      }
      return validateCompletion(payload, requestId, rows.length);
    } catch (error) {
      if (timedOut) throw failure(504, 'PROCESSING_TIMEOUT', 'El procesamiento tardó demasiado. No se confirmó la finalización. Espera un momento y vuelve a cargar el archivo.');
      if (error instanceof HttpError) throw error;
      throw failure(502, 'PROCESSING_FAILED', 'No se pudo conectar con el servicio de procesamiento. Intenta nuevamente.');
    } finally {
      clearTimeout(timer);
      // Also release an unread error/oversized response body and its socket.
      controller.abort();
      activeControllers.delete(controller);
      res.off('close', disconnected);
    }
  }

  async function upload(req, res, session, kind = 'sales') {
    requireCsrf(req, session);
    rateLimit(`upload:${session.username}`, config.uploadLimit);
    cleanup();
    if (session.busy || activeUploads >= config.maxConcurrentUploads) {
      throw failure(429, 'PROCESSING_BUSY', 'Ya hay un archivo en proceso o el servicio está ocupado. Espera e intenta nuevamente.');
    }
    if (session.jobs.size >= config.maxJobsPerSession || storedBytes + config.maxUploadBytes > config.maxStoredBytes) {
      throw failure(429, 'RESULT_CAPACITY', 'Se alcanzó el límite de resultados temporales. Descarga y elimina los resultados anteriores, o espera a que venzan.');
    }
    if (req.headers['content-type']?.split(';')[0] !== XLSX_TYPE) {
      throw failure(415, 'FILE_TYPE', 'Selecciona un archivo Excel con extensión .xlsx.');
    }
    let filename;
    try { filename = decodeURIComponent(req.headers['x-filename'] || ''); }
    catch { throw failure(400, 'FILENAME', 'El nombre del archivo no es válido.'); }
    if (!filename || filename.length > 255 || /[\\/\x00-\x1f\x7f]/.test(filename) || !/\.xlsx$/i.test(filename)) {
      throw failure(400, 'FILE_TYPE', 'Selecciona un archivo Excel con extensión .xlsx y un nombre válido.');
    }
    session.busy = true;
    activeUploads++;
    try {
      const original = await readBody(req, config.maxUploadBytes);
      let rows;
      try { rows = await (kind === 'quotation' ? extractQuotationWorkbook : extractSales)(original, filename, { maxBytes: config.maxUploadBytes }); }
      catch (error) { throw failure(error.status === 413 ? 413 : 400, 'INVALID_SPREADSHEET', error.message || 'No se pudo leer el archivo Excel.'); }
      if (kind === 'sales' && (!Array.isArray(rows) || rows.length === 0 || rows.length > 10000)) {
        throw failure(400, 'INVALID_SPREADSHEET', 'El archivo debe contener entre 1 y 10.000 registros de ventas.');
      }
      const result = await callN8n(rows, randomUUID(), res, kind);
      const reports = await (kind === 'quotation' ? createQuotationReports : createReports)(result);
      if (stopped || res.destroyed || sessions.get(session.id) !== session || session.expiresAt <= Date.now()) {
        throw failure(401, 'AUTH_REQUIRED', 'Tu sesión terminó. Inicia sesión y vuelve a cargar el archivo.');
      }
      for (const filename of (kind === 'quotation' ? ['repuestos.xlsx','revision.xlsx','resumen.xlsx'] : ['valid.xlsx', 'review.xlsx', 'summary.xlsx'])) {
        if (!Buffer.isBuffer(reports[filename]) || !reports[filename].length) throw new Error('Report generation failed');
      }
      const viewBytes = Buffer.byteLength(JSON.stringify(kind === 'quotation' ? result : { summary: result.summary, review: result.review }));
      const bytes = original.length + Object.values(reports).reduce((sum, file) => sum + file.length, 0) + viewBytes;
      cleanup();
      if (bytes + storedBytes > config.maxStoredBytes) {
        throw failure(503, 'RESULT_CAPACITY', 'No hay espacio temporal para este resultado. Intenta más tarde; no se guardó ningún informe.');
      }
      const job = {
        id: newToken(), sessionId: session.id, expiresAt: Math.min(Date.now() + config.resultTtlMs, session.expiresAt),
        ...(kind === 'quotation' ? {kind,result} : {summary: result.summary, review: result.review}), files: { ...reports, 'original.xlsx': original }, bytes,
      };
      jobs.set(job.id, job);
      session.jobs.add(job.id);
      storedBytes += bytes;
      json(res, 200, jobView(job));
    } finally {
      session.busy = false;
      activeUploads--;
    }
  }

  async function handler(req, res) {
    headers(res, config);
    const url = new URL(req.url, config.appOrigin);
    const pathname = url.pathname;
    if (req.method === 'GET' && pathname === '/healthz') return json(res, 200, { ok: true });
    if (req.method === 'GET' && pathname === '/api/session') return json(res, 200, sessionView(findSession(req)));
    if (req.method === 'POST' && pathname === '/api/login') {
      requireOrigin(req);
      rateLimit(`login:${req.socket.remoteAddress}`, config.loginLimit);
      const input = await readJson(req);
      if (typeof input?.username !== 'string' || input.username.length > 64 || typeof input?.password !== 'string' || input.password.length > 1024) {
        throw failure(400, 'LOGIN_INPUT', 'Ingresa tu usuario y contraseña.');
      }
      const username = input.username.trim();
      // Reserve only after reading the body, with no await between check and
      // increment. Slow concurrent requests cannot bypass the hashing limit.
      if (activeLogins >= 4) throw failure(429, 'LOGIN_BUSY', 'Espera un momento y vuelve a intentar.');
      activeLogins++;
      let valid;
      try { valid = await verifyPassword(input.password, Object.hasOwn(config.users, username) ? config.users[username] : null); }
      finally { activeLogins--; }
      if (!valid) throw failure(401, 'INVALID_CREDENTIALS', 'Usuario o contraseña incorrectos.');
      const previous = findSession(req);
      if (previous) deleteSession(previous.id);
      cleanup();
      if (sessions.size >= config.maxSessions) throw failure(503, 'SESSION_CAPACITY', 'El servicio está ocupado. Intenta más tarde.');
      const session = { id: newToken(), username, csrfToken: newToken(), expiresAt: Date.now() + config.sessionTtlMs, jobs: new Set(), busy: false };
      sessions.set(session.id, session);
      sessionCookie(res, session.id);
      return json(res, 200, sessionView(session));
    }
    if (req.method === 'POST' && pathname === '/api/logout') {
      const session = requireSession(req);
      requireCsrf(req, session);
      deleteSession(session.id);
      sessionCookie(res, '', true);
      return json(res, 200, { authenticated: false });
    }
    if (req.method === 'POST' && pathname === '/api/upload') return upload(req, res, requireSession(req));
    if (req.method === 'POST' && pathname === '/api/quotation/upload') return upload(req, res, requireSession(req), 'quotation');
    if (req.method === 'GET' && pathname === '/downloads/quotation-sample.xlsx') {
      requireSession(req);
      quoteSample ||= quotationSample();
      return sendFile(res, await quoteSample, 'ejemplo-cotizacion.xlsx');
    }
    if (req.method === 'GET' && (pathname === '/downloads/template.xlsx' || pathname === '/downloads/sample.xlsx')) {
      requireSession(req);
      if (pathname.endsWith('/template.xlsx')) {
        template ||= blankTemplate();
        return sendFile(res, await template, 'plantilla-ventas.xlsx');
      }
      sample ||= sampleWorkbook();
      return sendFile(res, await sample, 'ejemplo-ventas.xlsx');
    }
    const resultRoute = pathname.match(/^\/api\/results\/([a-f0-9]{64})(?:\/files\/(valid\.xlsx|review\.xlsx|summary\.xlsx|original\.xlsx|repuestos\.xlsx|revision\.xlsx|resumen\.xlsx))?$/);
    if (resultRoute) {
      const session = requireSession(req);
      const job = findJob(resultRoute[1], session);
      if (req.method === 'GET') {
        if (resultRoute[2]) {
          if (!job.files[resultRoute[2]]) throw failure(404,'NOT_FOUND','Este informe no pertenece a esta revisión.');
          return sendFile(res, job.files[resultRoute[2]], resultRoute[2]);
        }
        return json(res, 200, jobView(job));
      }
      if (req.method === 'DELETE' && !resultRoute[2]) {
        requireCsrf(req, session);
        deleteJob(job.id);
        return json(res, 200, { deleted: true });
      }
    }
    if (req.method === 'GET' && !pathname.startsWith('/api/') && !pathname.startsWith('/downloads/')) {
      let requested;
      try { requested = decodeURIComponent(pathname); } catch { throw failure(404, 'NOT_FOUND', 'Página no encontrada.'); }
      const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
      const publicDir = path.resolve(config.publicDir || path.join(ROOT, 'public'));
      const target = path.resolve(publicDir, relative);
      const type = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }[path.extname(target)];
      if (target.startsWith(publicDir + path.sep) && !relative.split(/[\\/]/).some(segment => segment.startsWith('.')) && type) {
        try {
          const bytes = await readFile(target);
          res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length });
          return res.end(bytes);
        } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'EISDIR') throw error; }
      }
    }
    throw failure(404, 'NOT_FOUND', 'Página o recurso no encontrado.');
  }

  const server = http.createServer((req, res) => {
    handler(req, res).catch(error => {
      if (res.destroyed || res.writableEnded) return;
      const status = error instanceof HttpError ? error.status : 500;
      // Do not log filenames, credentials, rows, response bodies, or exception strings.
      if (status >= 500 && !config.quiet) console.error(`Request failed (${status}, ${error.code || 'INTERNAL'}).`);
      if (status === 429) res.setHeader('Retry-After', '60');
      if (!req.complete) {
        // Discard a bounded remainder without buffering it. Closing immediately
        // while a browser is still sending can reset the socket before its 413
        // arrives (notably on Windows). A deadline also bounds stalled clients.
        let discarded = 0;
        const socket = req.socket;
        const timer = setTimeout(() => socket.destroy(), 5000);
        timer.unref();
        req.on('data', chunk => {
          discarded += chunk.length;
          if (discarded > config.maxUploadBytes + 1024 * 1024) socket.destroy();
        });
        req.once('end', () => clearTimeout(timer));
        req.once('close', () => clearTimeout(timer));
        req.resume();
      }
      json(res, status, { error: error instanceof HttpError ? error.message : 'Ocurrió un error al preparar los informes. Intenta nuevamente.', code: error instanceof HttpError ? error.code : 'INTERNAL' });
    });
  });
  server.requestTimeout = 90000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  server.on('close', () => {
    stopped = true;
    clearInterval(cleanupTimer);
    for (const controller of activeControllers) controller.abort();
    sessions.clear(); jobs.clear(); rateLimits.clear(); storedBytes = 0;
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = readConfig();
    const server = createServer(config);
    server.listen(config.port, config.host, () => console.log(`Spreadsheet pilot listening on ${config.appOrigin}`));
    const shutdown = () => {
      server.close();
      setTimeout(() => { server.closeAllConnections(); }, 5000).unref();
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (error) {
    console.error(`Startup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
