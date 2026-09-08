import { randomBytes, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const token = (prefix = '') => prefix + randomBytes(32).toString('base64url');
export function httpError(statusCode, code) {
  return Object.assign(new Error(code), { statusCode, code });
}
export async function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  const result = await derive(password, salt, 64);
  return `${salt}:${result.toString('hex')}`;
}
export async function verifyPassword(password, stored) {
  const [salt, expected] = stored.split(':');
  const actual = await derive(password, salt, 64);
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}
export function sessionCookie(value, maxAge, secure = true) {
  return `gateway_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
export function readSession(cookie = '') {
  return cookie.split(';').map((x) => x.trim()).find((x) => x.startsWith('gateway_session='))?.slice(16);
}
// Bounded, expiring counters. The gateway deliberately runs as a single process.
export class RateLimiter {
  buckets = new Map();
  take(key, limit, windowMs = 60_000) {
    const now = Date.now();
    for (const [id, value] of this.buckets) if (value.until <= now) this.buckets.delete(id);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= 10_000) throw httpError(429, 'rate_limit_capacity');
      bucket = { count: 0, until: now + windowMs };
      this.buckets.set(key, bucket);
    }
    if (++bucket.count > limit) throw httpError(429, 'rate_limited');
  }
}
