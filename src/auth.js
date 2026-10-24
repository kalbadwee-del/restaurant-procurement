// src/auth.js — passwords (argon2id, §13) + stateless HMAC session cookies + rate limiting
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { nowIso, b } from './util.js';
import { log, EV } from './logging.js';

const ARGON_OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 }; // OWASP m=19MiB,t=2,p=1

export async function hashPassword(plain) { return argonHash(plain, ARGON_OPTS); }
export async function verifyPassword(hashStr, plain) {
  try { return await argonVerify(hashStr, plain); } catch { return false; }
}

// ---- session token: base64url(payload).hmac  (jwt_secret from encrypted settings) ----
function b64u(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64url'); }
export function signSession(jwtSecret, { uid, role, ttlHours = 8 }) {
  const payload = { uid, role, exp: Date.now() + ttlHours * 3600_000 };
  const body = b64u(payload);
  const sig = createHmac('sha256', jwtSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}
export function verifySession(jwtSecret, token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expect = createHmac('sha256', jwtSecret).update(body).digest('base64url');
  const a = Buffer.from(sig), eb = Buffer.from(expect);
  if (a.length !== eb.length || !timingSafeEqual(a, eb)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

// ---- login with per-IP rate limiting (5/min) ----
const attemptsByIp = new Map(); // ip -> [{ts}]
export function loginRateLimited(ip, now = Date.now()) {
  const list = (attemptsByIp.get(ip) || []).filter((t) => now - t < 60_000);
  attemptsByIp.set(ip, list);
  return list.length >= 5;
}
export function recordLoginAttempt(ip, now = Date.now()) { attemptsByIp.get(ip)?.push(now); }

export async function findUserByCredentials(db, username, password) {
  const row = await db('users').where({ username, is_active: true }).first();
  if (!row || !row.password_hash) return null;
  const ok = await verifyPassword(row.password_hash, password);
  return ok ? row : null;
}

export async function loadActiveUser(db, uid) {
  const row = await db('users').where({ id: uid }).first();
  return row && b(row.is_active) ? row : null; // immediate revocation (§13)
}

export async function createOwner(db, { username, password, full_name }) {
  const existing = await db('users').where({ role: 'owner', is_active: true }).count({ c: 'id' }).first();
  if (Number(existing?.c ?? 0) > 0) throw new Error('owner already exists');
  const ts = nowIso();
  const [id] = await db('users').insert({
    username, password_hash: await hashPassword(password), full_name,
    role: 'owner', language: 'en', is_active: true, version: 0, created_at: ts, updated_at: ts,
  }).returning('id');
  log.info(EV.AUTH_LOGIN_OK, { user_id: String(id?.id ?? id), meta: { action: 'owner.created' } });
  return typeof id === 'object' ? id.id : id;
}
