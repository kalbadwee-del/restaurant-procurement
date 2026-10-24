// src/backup.js — daily backup (§12.3): dump → AES-256-GCM encrypt → R2 + manifest → 30d retention;
// restore/verify (§12.4). Dual backend per D-S6: pg_dump (PG) | JSON export (SQLite tests).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { nowIso, sha256, klDateStr } from './util.js';
import { log, EV } from './logging.js';
import { audit } from './audit.js';

const exec = promisify(execFile);

function backupKey(ctx) {
  return Buffer.from(hkdfSync('sha256', Buffer.from(ctx.bootstrapSecret), Buffer.from('procurement-system/v1'), Buffer.from('backup-key'), 32));
}
function encryptBuffer(key, buf) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
function decryptBuffer(key, buf) {
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

const TABLES = ['branches','users','telegram_groups','expense_categories','brands','units','products','product_quality_notes',
  'stores','observed_prices','requests','request_items','request_modifications','invoices','invoice_items','approved_purchases',
  'files','processed_updates','pending_ai_tasks','ai_call_logs','app_secrets','app_settings','report_links','backups','draft_sessions'];

async function dumpPayload(ctx) {
  if (ctx.target.client === 'pg') {
    const tmp = join(tmpdir(), `proc-${Date.now()}.dump`);
    const url = new URL(ctx.target.connection);
    const args = ['--format=custom', '--no-owner', '--file', tmp, url.pathname.slice(1)];
    const env = { ...process.env, PGPASSWORD: decodeURIComponent(url.password ?? '') };
    await exec('pg_dump', ['-h', url.hostname, '-p', url.port || '5432', '-U', decodeURIComponent(url.username), ...args], { env });
    const buf = readFileSync(tmp);
    unlinkSync(tmp);
    return { buf, format: 'pg_dump' };
  }
  const data = {};
  for (const t of TABLES) data[t] = await ctx.db(t).select();
  const json = JSON.stringify({ format: 'json', tables: data, dumped_at: nowIso() });
  return { buf: Buffer.from(json), format: 'json' };
}

export async function createBackup(ctx, actorId = null) {
  const day = klDateStr();
  log.info(EV.BACKUP_STARTED, { meta: { day } });
  try {
    const { buf, format } = await dumpPayload(ctx);
    const enc = encryptBuffer(backupKey(ctx), buf);
    const digest = sha256(enc);
    const r2Key = `backups/${day}.dump.enc`;
    await ctx.storage.put(r2Key, enc, 'application/octet-stream');
    const counts = {};
    for (const t of TABLES) {
      try { counts[t] = Number((await ctx.db(t).count({ c: '*' }).first()).c); } catch { counts[t] = -1; }
    }
    const manifest = {
      created_at: nowIso(), sha256: digest, size_bytes: enc.length, format,
      schema_version: '1', table_counts: counts, retention_days: ctx.config.raw.backup_retention_days ?? 30,
    };
    await ctx.storage.put(`backups/${day}.manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2)), 'application/json');
    const [id] = await ctx.db('backups').insert({
      r2_key: r2Key, size_bytes: enc.length, sha256: digest, schema_version: '1',
      table_counts: JSON.stringify(counts), status: 'ok', created_by: actorId, created_at: nowIso(), restored_at: null,
    }).returning('id');
    // retention: delete >30d (§12.3)
    const cutoff = new Date(Date.now() - (ctx.config.raw.backup_retention_days ?? 30) * 86_400_000).toISOString().slice(0, 10);
    const old = await ctx.db('backups').where('created_at', '<', cutoff);
    for (const o of old) { await ctx.storage.delete(o.r2_key).catch(() => {}); await ctx.db('backups').where({ id: o.id }).del(); }
    log.info(EV.BACKUP_DONE, { status: 'success', meta: { day, size: enc.length, format } });
    await audit(ctx.db, { eventType: 'backup.created', actorType: actorId ? 'user' : 'system', actorId, entityType: 'backup', entityId: typeof id === 'object' ? id.id : id, action: 'create' });
    return { ok: true, day, size: enc.length, sha256: digest, format };
  } catch (e) {
    log.error(EV.BACKUP_FAIL, { status: 'error', error: e.message });
    await audit(ctx.db, { eventType: EV.BACKUP_FAIL, actorType: 'system', entityType: 'backup', action: 'fail', meta: { error: e.message } });
    return { ok: false, error: e.message };
  }
}

export async function runBackupJob(ctx) { return createBackup(ctx, null); }

// Restore verification path (§12.4): decrypt → sha256 → parse → integrity counts. Never touches live tables.
export async function verifyBackup(ctx, { buffer, expectedSha256, expectedCounts = null }) {
  const digest = sha256(buffer);
  if (expectedSha256 && digest !== expectedSha256) return { ok: false, reason: 'sha256_mismatch' };
  let plain;
  try { plain = decryptBuffer(backupKey(ctx), buffer); } catch (e) { return { ok: false, reason: 'decrypt_failed' }; }
  let parsed;
  try { parsed = JSON.parse(plain.toString()); } catch { return { ok: false, reason: 'not_json (pg_dump format requires pg_restore — verify on PG host)' }; }
  if (parsed.format !== 'json') return { ok: false, reason: 'unsupported_format' };
  const integrity = {};
  for (const [table, rows] of Object.entries(parsed.tables)) integrity[table] = Array.isArray(rows) ? rows.length : 0;
  if (expectedCounts) {
    for (const [t, c] of Object.entries(expectedCounts)) {
      if (c >= 0 && integrity[t] !== c) return { ok: false, reason: `count_mismatch:${t}` };
    }
  }
  return { ok: true, format: parsed.format, integrity, dumped_at: parsed.dumped_at };
}

// JSON restore into a *fresh* database (used by tests / scratch DB import)
export async function restoreJsonInto(ctx, targetDb, buffer) {
  const plain = decryptBuffer(backupKey(ctx), buffer);
  const parsed = JSON.parse(plain.toString());
  if (parsed.format !== 'json') throw new Error('unsupported_format');
  const order = ['draft_sessions','backups','report_links','app_settings','app_secrets','ai_call_logs','pending_ai_tasks','processed_updates',
    'approved_purchases','invoice_items','invoices','files','request_modifications','request_items','requests',
    'observed_prices','product_quality_notes','stores','products','brands','units','expense_categories','telegram_groups','users','branches'];
  // fresh-restore semantics: clear existing rows first (target is a scratch DB)
  for (const t of order) await targetDb(t).del();
  const insertOrder = [...order].reverse();
  for (const t of insertOrder) {
    const rows = parsed.tables[t] ?? [];
    for (const r of rows) {
      await targetDb(t).insert({ ...r }); // preserve original ids — dump is FK-consistent
    }
  }
  return { tables: Object.keys(parsed.tables).length };
}

export { decryptBuffer };
