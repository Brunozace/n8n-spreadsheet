import { isPasswordHash } from './auth.mjs';

function numberFromEnv(env, name, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const value = env[name] === undefined || env[name] === '' ? fallback : Number(env[name]);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number between ${min} and ${max}.`);
  }
  return value;
}

export function readConfig(env = process.env, overrides = {}) {
  let users;
  try { users = JSON.parse(env.PILOT_USERS_JSON || '{}'); }
  catch { throw new Error('PILOT_USERS_JSON must be a JSON object of usernames and password hashes.'); }
  const config = {
    host: env.HOST || '127.0.0.1',
    port: numberFromEnv(env, 'PORT', 3000, 0, 65535),
    appOrigin: env.APP_ORIGIN || 'http://localhost:3000',
    production: env.NODE_ENV === 'production',
    secureCookie: env.SECURE_COOKIE === undefined ? env.NODE_ENV === 'production' : env.SECURE_COOKIE === 'true',
    users,
    n8nWebhookUrl: env.N8N_WEBHOOK_URL || 'http://127.0.0.1:5678/webhook/sales-web',
    n8nQuotationWebhookUrl: env.N8N_QUOTATION_WEBHOOK_URL || '',
    n8nWebhookSecret: env.N8N_WEBHOOK_SECRET || '',
    maxUploadBytes: numberFromEnv(env, 'MAX_UPLOAD_MB', 5, 1, 100) * 1024 * 1024,
    n8nTimeoutMs: numberFromEnv(env, 'PROCESSING_TIMEOUT_MS', 65000, 1, 300000),
    maxN8nResponseBytes: numberFromEnv(env, 'MAX_N8N_RESPONSE_BYTES', 20 * 1024 * 1024, 1024, 128 * 1024 * 1024),
    resultTtlMs: numberFromEnv(env, 'RESULT_TTL_MINUTES', 15, 1, 1440) * 60000,
    sessionTtlMs: numberFromEnv(env, 'SESSION_TTL_HOURS', 8, 1, 24) * 3600000,
    maxConcurrentUploads: numberFromEnv(env, 'MAX_CONCURRENT_UPLOADS', 2, 1, 10),
    maxJobsPerSession: numberFromEnv(env, 'MAX_JOBS_PER_SESSION', 3, 1, 20),
    maxStoredBytes: numberFromEnv(env, 'MAX_STORED_BYTES', 128 * 1024 * 1024, 1024, 1024 * 1024 * 1024),
    maxSessions: numberFromEnv(env, 'MAX_SESSIONS', 100, 1, 1000),
    loginLimit: numberFromEnv(env, 'LOGIN_ATTEMPTS_PER_15_MINUTES', 10, 1, 100),
    uploadLimit: numberFromEnv(env, 'UPLOADS_PER_15_MINUTES', 20, 1, 100),
    ...overrides,
  };
  let origin, webhook;
  try { origin = new URL(config.appOrigin); webhook = new URL(config.n8nWebhookUrl); }
  catch { throw new Error('APP_ORIGIN and N8N_WEBHOOK_URL must be complete URLs.'); }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== config.appOrigin) {
    throw new Error('APP_ORIGIN must be an HTTP(S) origin without a trailing slash or path.');
  }
  if (!['http:', 'https:'].includes(webhook.protocol) || webhook.username || webhook.password || webhook.hash) {
    throw new Error('N8N_WEBHOOK_URL must be an HTTP(S) URL without credentials or a fragment.');
  }
  config.n8nQuotationWebhookUrl ||= new URL('/webhook/quotation-web', webhook).href;
  const quotationWebhook = new URL(config.n8nQuotationWebhookUrl);
  if (!['http:', 'https:'].includes(quotationWebhook.protocol) || quotationWebhook.username || quotationWebhook.password || quotationWebhook.hash) {
    throw new Error('N8N_QUOTATION_WEBHOOK_URL must be an HTTP(S) URL without credentials or a fragment.');
  }
  if (config.production && (origin.protocol !== 'https:' || !config.secureCookie)) {
    throw new Error('Production requires an HTTPS APP_ORIGIN and SECURE_COOKIE=true.');
  }
  if (!config.users || Array.isArray(config.users) || typeof config.users !== 'object' || !Object.keys(config.users).length) {
    throw new Error('Configure at least one pilot user in PILOT_USERS_JSON. Run npm run password.');
  }
  for (const [name, hash] of Object.entries(config.users)) {
    if (!/^[A-Za-z0-9_.@-]{1,64}$/.test(name) || !isPasswordHash(hash)) {
      throw new Error('Pilot usernames must be 1–64 letters/digits/_.@- and every password must be a generated scrypt hash.');
    }
  }
  if (typeof config.n8nWebhookSecret !== 'string' || config.n8nWebhookSecret.length < 32 || config.n8nWebhookSecret.startsWith('REPLACE_')) {
    throw new Error('N8N_WEBHOOK_SECRET must contain at least 32 random characters, not the example placeholder.');
  }
  return config;
}
