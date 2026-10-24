// src/services/alerts.js — alert thresholds (ops §D) + owner notifications + cleanup jobs
import { nowIso, klDateStr, b, jsonOf } from '../util.js';
import { log, EV } from '../logging.js';

export async function notifyOwner(ctx, msgKey, vars = {}) {
  const { tg } = await import('../telegram/i18n.js');
  const text = tg(msgKey, vars);
  const owner = await ctx.db('users').where({ role: 'owner', is_active: true }).orderBy('id').first();
  if (owner?.telegram_id) {
    await ctx.transport.sendMessage(owner.telegram_id, text).catch((e) => log.warn('alert.send_fail', { status: 'error', error: e.message }));
  }
  log.warn('alert.owner_notified', { meta: { msgKey, ...vars } });
  return text;
}

const ALERT_STATE_KEY = 'alert_state';
async function shouldAlert(ctx, key, day) {
  const state = jsonOf(await ctx.settings.getSetting(ALERT_STATE_KEY, {})) ?? {};
  if (state[key] === day) return false;
  state[key] = day;
  await ctx.settings.setSetting(ALERT_STATE_KEY, state);
  return true;
}

export async function checkStorageUsage(ctx) {
  const files = await ctx.db('files').whereNull('deleted_at').sum({ total: 'size_bytes' });
  const used = Number(files[0]?.total ?? 0);
  const LIMIT = 10 * 1024 ** 3, WARN = 8 * 1024 ** 3; // 80% of 10GB
  log.info('storage.usage', { meta: { usedBytes: used, pct: Math.round((used / LIMIT) * 100) } });
  if (used >= WARN && await shouldAlert(ctx, 'r2_80', klDateStr())) {
    await notifyOwner(ctx, { en: `R2 storage at ${(used / LIMIT * 100).toFixed(1)}% (≥80%) — review retention/deletion.`, ar: `تخزين R2 عند ${(used / LIMIT * 100).toFixed(1)}% (≥80%) — راجع سياسة الحذف.` });
  }
  return used;
}

export async function checkDbStorage(ctx) {
  let bytes = 0;
  if (ctx.target.client === 'pg') {
    const r = await ctx.db.raw('SELECT pg_database_size(current_database()) AS size');
    bytes = Number(r.rows[0].size);
  } else {
    const r = await ctx.db.raw('PRAGMA page_count() AS pages, page_size() AS ps');
    const row = Array.isArray(r) ? r[0] : r.rows?.[0];
    bytes = Number(row.pages) * Number(row.ps);
  }
  const LIMIT = 1024 ** 3, WARN = 800 * 1024 ** 2; // 80% of 1GB
  log.info('db.usage', { meta: { usedBytes: bytes, pct: Math.round((bytes / LIMIT) * 100) } });
  if (bytes >= WARN && await shouldAlert(ctx, 'neon_80', klDateStr())) {
    await notifyOwner(ctx, { en: `DB storage at ${(bytes / LIMIT * 100).toFixed(1)}% (≥80% of 1GB).`, ar: `تخزين قاعدة البيانات عند ${(bytes / LIMIT * 100).toFixed(1)}% (≥80% من 1GB).` });
  }
  return bytes;
}

export async function aiUsageSummary(ctx) {
  const { queueStats } = await import('../queue.js');
  const day = new Date().toISOString().slice(0, 10);
  const [{ c: calls } = { c: 0 }] = await ctx.db('ai_call_logs').where('created_at', '>=', `${day}T00:00:00.000Z`).count({ c: 'id' });
  const stats = await queueStats(ctx.db);
  const cap = ctx.config.ai.dailyGlobalCap;
  const pct = Math.round((Number(calls) / cap) * 100);
  log.info('ai.daily_summary', { meta: { calls: Number(calls), cap, pct, queue: stats } });
  if (pct >= (ctx.config.ai.warnPct ?? 80) && await shouldAlert(ctx, 'ai_80', klDateStr())) {
    await notifyOwner(ctx, { en: `AI usage at ${pct}% of daily cap (${calls}/${cap}). Queue: ${stats.failed} failed, ${stats.dead_letter} dead.`, ar: `استخدام AI عند ${pct}% من السقف اليومي (${calls}/${cap}).` });
  }
  return { calls: Number(calls), cap, pct, stats };
}

export async function cuHoursReminder(ctx) {
  // CU-hours are not readable programmatically on Neon free — monthly manual review reminder (ops §A)
  await notifyOwner(ctx, { en: 'Monthly reminder: review Neon compute-hours in the Neon dashboard (Design ops §A).', ar: 'تذكير شهري: راجع ساعات الحوسبة في لوحة Neon.' });
}

export async function cleanupExpired(ctx) {
  const now = nowIso();
  const expiredLinks = await ctx.db('report_links').where('expires_at', '<', now).whereNull('revoked_at').update({ revoked_at: now });
  const oldReports = await ctx.db('files').where({ kind: 'report' }).whereNull('deleted_at').where('uploaded_at', '<', new Date(Date.now() - 3600_000).toISOString());
  for (const f of oldReports) {
    await ctx.storage.delete(f.r2_key);
    await ctx.db('files').where({ id: f.id }).update({ deleted_at: now });
  }
  // close stale silent sessions
  const ttl = (ctx.config.raw.silent_session_ttl_min ?? 30) * 60_000;
  const stale = await ctx.db('draft_sessions').where({ status: 'open' }).where('last_activity_at', '<', new Date(Date.now() - ttl).toISOString()).update({ status: 'closed' });
  return { expiredLinks, removedReports: oldReports.length, closedSessions: stale };
}
