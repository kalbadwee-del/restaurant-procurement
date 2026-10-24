// src/settings.js — bootstrap, encrypted secrets (AES-256-GCM, HKDF key from DATABASE_URL — D-S1),
// plain settings store, runtime config builder, service connectivity tests.
import { hkdfSync, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { nowIso, jsonOf } from './util.js';
import { log, EV } from './logging.js';

// ---------- crypto ----------
export function deriveMasterKey(bootstrapSecret) {
  return Buffer.from(hkdfSync('sha256', Buffer.from(bootstrapSecret), Buffer.from('procurement-system/v1'), Buffer.from('settings-master-key'), 32));
}
export function encryptSecret(masterKey, plaintext) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', masterKey, iv);
  const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}
export function decryptSecret(masterKey, encB64) {
  const raw = Buffer.from(String(encB64), 'base64');
  const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), ct = raw.subarray(28);
  const d = createDecipheriv('aes-256-gcm', masterKey, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

// ---------- store ----------
export class Settings {
  constructor(db, masterKey) {
    this.db = db;
    this.masterKey = masterKey;
    this._cache = new Map();
    this._secretCache = new Map();
  }
  async getSetting(key, dflt = undefined) {
    if (this._cache.has(key)) return this._cache.get(key);
    const row = await this.db('app_settings').where({ key }).first();
    const v = row ? jsonOf(row.value) : dflt;
    this._cache.set(key, v);
    return v;
  }
  async setSetting(key, value) {
    await this.db('app_settings')
      .insert({ key, value: JSON.stringify(value ?? null), updated_at: nowIso() })
      .onConflict('key').merge();
    this._cache.set(key, value);
  }
  async allSettings() {
    const rows = await this.db('app_settings').select();
    const out = {};
    for (const r of rows) out[r.key] = jsonOf(r.value);
    return out;
  }
  async getSecret(key) {
    if (this._secretCache.has(key)) return this._secretCache.get(key);
    const row = await this.db('app_secrets').where({ key }).first();
    const v = row ? decryptSecret(this.masterKey, row.value_enc) : null;
    this._secretCache.set(key, v);
    return v;
  }
  async setSecret(key, plaintext) {
    await this.db('app_secrets')
      .insert({ key, value_enc: encryptSecret(this.masterKey, plaintext ?? ''), updated_at: nowIso() })
      .onConflict('key').merge();
    this._secretCache.set(key, plaintext ?? null);
  }
  async deleteSecret(key) { await this.db('app_secrets').where({ key }).del(); this._secretCache.delete(key); }
  invalidateCaches() { this._cache.clear(); this._secretCache.clear(); }
}

// ---------- runtime config ----------
// Modes: telegram: mock|real — ai: mock|gemini — storage: mock|r2 (D-S7)
export const DEFAULT_SETTINGS = {
  telegram_mode: 'mock',
  ai_provider: 'mock',
  ai_model_primary: 'gemini-3.8-flash',
  ai_model_fallbacks: ['gemini-3.6-flash', 'gemini-3.5-flash-lite'],
  ai_daily_global_cap: 120,
  ai_daily_per_user_cap: 20,
  ai_burst_per_min: 10,
  ai_warn_threshold_pct: 80,
  storage_mode: 'mock',
  mock_storage_root: '/tmp/local-storage',
  report_link_ttl_min: 15,
  silent_session_ttl_min: 30,
  backup_retention_days: 30,
};

export async function buildRuntimeConfig(settings, db) {
  const s = DEFAULT_SETTINGS;
  for (const k of Object.keys(s)) s[k] = await settings.getSetting(k, s[k]);
  const [configured, hasOwner] = await Promise.all([
    settings.getSetting('configured', false),
    db('users').where({ role: 'owner', is_active: true }).count({ c: 'id' }).first(),
  ]);
  const cfg = {
    configured: Boolean(configured) && Number(hasOwner?.c ?? 0) > 0,
    telegram: {
      mode: s.telegram_mode,
      token: await settings.getSecret('telegram_bot_token'),
      webhookSecret: await settings.getSecret('telegram_webhook_secret'),
    },
    ai: {
      provider: s.ai_provider,
      apiKey: await settings.getSecret('gemini_api_key'),
      modelPrimary: s.ai_model_primary,
      modelFallbacks: s.ai_model_fallbacks,
      dailyGlobalCap: s.ai_daily_global_cap,
      dailyPerUserCap: s.ai_daily_per_user_cap,
      burstPerMin: s.ai_burst_per_min,
      warnPct: s.ai_warn_threshold_pct,
    },
    storage: {
      mode: s.storage_mode,
      accountId: await settings.getSecret('r2_account_id'),
      accessKeyId: await settings.getSecret('r2_access_key_id'),
      secretAccessKey: await settings.getSecret('r2_secret_access_key'),
      bucket: await settings.getSecret('r2_bucket'),
      mockRoot: s.mock_storage_root,
    },
    raw: s,
  };
  return cfg;
}

// ---------- connectivity tests (Test Connection buttons) ----------
export async function testTelegram(token) {
  if (!token) throw new Error('missing token');
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(8000) });
  const body = await res.json();
  if (!body.ok) throw new Error(body.description || 'getMe failed');
  return { ok: true, bot: body.result.username };
}
export async function testGemini(apiKey) {
  if (!apiKey) throw new Error('missing api key');
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models`, {
    headers: { 'x-goog-api-key': apiKey }, signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  const body = await res.json();
  return { ok: true, models: Array.isArray(body.models) ? body.models.length : 0 };
}
export async function testR2({ accountId, accessKeyId, secretAccessKey, bucket }) {
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) throw new Error('missing R2 credentials');
  const { AwsClient } = await import('aws4fetch');
  const client = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' });
  const url = `https://${accountId}.r2.cloudflarestorage.com/${bucket}?list-type=2&max-keys=1`;
  const res = await client.fetch(url, { method: 'GET', signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`R2 HTTP ${res.status}`);
  return { ok: true };
}
export async function testNeon(connectionString) {
  if (!connectionString) throw new Error('missing connection string');
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10000 });
  await client.connect();
  const r = await client.query('SELECT 1 AS ok');
  await client.end();
  return { ok: r.rows[0].ok === 1 };
}

export function logServiceTest(service, ok, error, userId) {
  log.info(EV.SERVICE_TEST, { user_id: userId ?? 'system', status: ok ? 'success' : 'error', error: ok ? undefined : error, meta: { service } });
}
