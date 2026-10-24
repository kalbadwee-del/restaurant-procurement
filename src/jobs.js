// src/jobs.js — internal cron scheduler (D-S12): 30s tick, Asia/Kuala_Lumpur day-keyed,
// catch-up-on-startup for critical jobs (design D12).
import { klMinutesOfDay, klDayOfMonth } from './util.js';
import { log } from './logging.js';

const jobs = [];
let timer = null;
const lastRun = new Map(); // runKey -> KL date 'YYYY-MM-DD'

function klDay(d = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur' }).format(d); }

function register(ctx, { name, kind, atMinutes = 0, monthlyDay = null, run, critical = false }) {
  jobs.push({ name, kind, atMinutes, monthlyDay, run, critical, ctx });
}

function runKeyFor(j, now) {
  const day = klDay(now);
  if (j.kind === 'hourly') return `${j.name}@${day}h${Math.floor(klMinutesOfDay(now) / 60)}`;
  return `${j.name}@${day}`;
}

function isDue(j, now) {
  const key = runKeyFor(j, now);
  if (lastRun.get(key) === klDay(now)) return false;
  if (j.monthlyDay !== null && klDayOfMonth(now) !== j.monthlyDay) return false;
  if (j.kind === 'hourly') return klMinutesOfDay(now) % 60 === 0 || klMinutesOfDay(now) % 60 >= 59; // top-of-hour window
  return klMinutesOfDay(now) >= j.atMinutes; // daily/monthly: once KL time passed target
}

async function runJob(j, reason) {
  const now = new Date();
  lastRun.set(runKeyFor(j, now), klDay(now));
  log.info('job.run', { meta: { job: j.name, reason } });
  await j.run(j.ctx);
}

export async function startJobs(ctx) {
  if (timer) return;

  register(ctx, { name: 'backup_daily', kind: 'daily', atMinutes: 3 * 60, critical: true, run: async (c) => { const m = await import('./backup.js'); await m.runBackupJob(c); } });
  register(ctx, { name: 'r2_usage_check', kind: 'daily', atMinutes: 3 * 60 + 20, run: async (c) => { const m = await import('./services/alerts.js'); await m.checkStorageUsage(c); } });
  register(ctx, { name: 'neon_storage_check', kind: 'daily', atMinutes: 3 * 60 + 25, run: async (c) => { const m = await import('./services/alerts.js'); await m.checkDbStorage(c); } });
  register(ctx, { name: 'log_upload_daily', kind: 'daily', atMinutes: 6 * 60, run: async (c) => { const m = await import('./services/logupload.js'); await m.uploadYesterdayLogs(c); } });
  register(ctx, { name: 'ai_usage_summary', kind: 'daily', atMinutes: 21 * 60, run: async (c) => { const m = await import('./services/alerts.js'); await m.aiUsageSummary(c); } });
  register(ctx, { name: 'cu_hours_reminder', kind: 'monthly', atMinutes: 9 * 60, monthlyDay: 1, run: async (c) => { const m = await import('./services/alerts.js'); await m.cuHoursReminder(c); } });
  register(ctx, { name: 'temp_cleanup', kind: 'hourly', run: async (c) => { const m = await import('./services/alerts.js'); await m.cleanupExpired(c); } });

  const { drainQueue } = await import('./queue.js');
  ctx.queueTimer = setInterval(() => { drainQueue(ctx).catch((e) => log.error('queue.drain_error', { status: 'error', error: e.message })); }, 120_000);

  for (const j of jobs) {
    if (j.critical && isDue(j, new Date())) await runJob(j, 'startup-catchup');
  }
  timer = setInterval(() => {
    const now = new Date();
    for (const j of jobs) {
      if (isDue(j, now)) runJob(j, 'scheduled').catch((e) => log.error('job.error', { status: 'error', error: e.message, meta: { job: j.name } }));
    }
  }, 30_000);
  log.info('jobs.started', { meta: { count: jobs.length } });
}

export function stopJobs(ctx) {
  if (timer) { clearInterval(timer); timer = null; }
  if (ctx?.queueTimer) { clearInterval(ctx.queueTimer); ctx.queueTimer = null; }
}
