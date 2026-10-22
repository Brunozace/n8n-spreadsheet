import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const PARAMETERS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const HASH_PATTERN = /^scrypt\$16384\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{64})$/;

export function isPasswordHash(value) {
  return typeof value === 'string' && HASH_PATTERN.test(value);
}

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) {
    throw new Error('Use a password with 12 to 1024 characters.');
  }
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 32, PARAMETERS);
  return `scrypt$16384$8$1$${salt}$${derived.toString('hex')}`;
}

export async function verifyPassword(password, encoded) {
  const match = typeof encoded === 'string' && encoded.match(HASH_PATTERN);
  // Unknown usernames do the same expensive operation as known usernames.
  const salt = match ? match[1] : '00000000000000000000000000000000';
  const expected = match ? Buffer.from(match[2], 'hex') : Buffer.alloc(32);
  const derived = await scrypt(password, salt, 32, PARAMETERS);
  return Boolean(match) && timingSafeEqual(expected, derived);
}

export function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
