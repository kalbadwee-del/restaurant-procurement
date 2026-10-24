// src/queue.js — pending_ai_tasks queue processor (§2.3): retry backoff 0/5/30s in-task,
// then queue-level re-attempts every 2 min, dead_letter at max_attempts (5), never discard.
import { nowIso } from './util.js';
import { log, EV } from './logging.js';

export async function enqueue(ctx, { taskType, payload, invoiceId = null, createdBy = null }) {
  const [id] = await ctx.db('pending_ai_tasks').insert({
    task_type: taskType, payload: JSON.stringify(payload), status: 'pending',
    attempts: 0, max_attempts: 5, next_attempt_at: nowIso(),
    invoice_id: invoiceId, created_by: createdBy,
    last_error: null, created_at: nowIso(), updated_at: nowIso(),
  }).returning('id');
  const rowId = typeof id === 'object' ? id.id : id;
  log.info(EV.QUEUE_ENQUEUED, { invoice_id: invoiceId, task_id: rowId, meta: { taskType } });
  setImmediate(() => drainQueue(ctx).catch(() => {}));
  return rowId;
}

// claim one due task atomically: pending|failed → processing
async function claimTask(db) {
  const candidate = await db('pending_ai_tasks')
    .whereIn('status', ['pending', 'failed'])
    .andWhere('next_attempt_at', '<=', nowIso())
    .orderBy('next_attempt_at').first();
  if (!candidate) return null;
  const claimed = await db('pending_ai_tasks')
    .where({ id: candidate.id }).whereIn('status', ['pending', 'failed'])
    .update({ status: 'processing', updated_at: nowIso() });
  return claimed === 1 ? candidate : null;
}

async function handleTask(ctx, task) {
  const payload = typeof task.payload === 'string' ? JSON.parse(task.payload) : task.payload;
  const { storage } = ctx;
  if (task.task_type === 'invoice_extract') {
    const { processInvoiceExtraction } = await import('./services/invoice-pipeline.js');
    await processInvoiceExtraction(ctx, task, payload);
    return;
  }
  if (task.task_type === 'audio_transcribe') {
    const buf = await storage.get(payload.file_key);
    const result = await aiTranscribe(ctx, buf, payload.mime, task, payload);
    const { applyTranscription } = await import('./telegram/handlers.js');
    await applyTranscription(ctx, payload, result.text);
    return;
  }
  if (task.task_type === 'correction_parse') {
    const { runCorrectionTask } = await import('./services/invoice-pipeline.js');
    await runCorrectionTask(ctx, task, payload);
    return;
  }
  throw new Error(`unknown task_type ${task.task_type}`);
}

async function aiTranscribe(ctx, buf, mime, task, payload) {
  const { aiCall } = await import('./ai.js');
  return aiCall(ctx, {
    kind: 'transcribe', userId: task.created_by, invoiceId: task.invoice_id, taskId: task.id,
    fn: (provider) => provider.transcribeAudio(buf, mime, payload),
  });
}

const BACKOFF_MS = [0, 5000, 30000]; // §2.3: attempt1 immediate, 2 after 5s, 3 after 30s (in-task handled by caller for live path)

export async function drainQueue(ctx) {
  let processed = 0;
  for (let i = 0; i < 10; i++) {
    const task = await claimTask(ctx.db);
    if (!task) break;
    processed++;
    try {
      await handleTask(ctx, task);
      await ctx.db('pending_ai_tasks').where({ id: task.id }).update({ status: 'pending', attempts: task.attempts + 1, last_error: null, updated_at: nowIso(), next_attempt_at: nowIso() });
      // completed state: remove from queue semantics — keep as 'done'
      await ctx.db('pending_ai_tasks').where({ id: task.id }).update({ status: 'done' });
      log.info(EV.QUEUE_COMPLETED, { invoice_id: task.invoice_id, task_id: task.id, status: 'success' });
    } catch (e) {
      const attempts = task.attempts + 1;
      const dead = attempts >= task.max_attempts;
      await ctx.db('pending_ai_tasks').where({ id: task.id }).update({
        status: dead ? 'dead_letter' : 'failed',
        attempts, last_error: String(e.message).slice(0, 400),
        next_attempt_at: new Date(Date.now() + 120_000).toISOString(),
        updated_at: nowIso(),
      });
      log.warn(dead ? EV.QUEUE_DEAD : EV.QUEUE_RETRIED, { invoice_id: task.invoice_id, task_id: task.id, status: 'error', error: e.message, meta: { attempts } });
      if (dead) {
        const { notifyOwner } = await import('./services/alerts.js');
        await notifyOwner(ctx, 'manager_notify_dead', { id: task.id, n: attempts });
      }
    }
  }
  return processed;
}

export async function retryTask(ctx, taskId) {
  await ctx.db('pending_ai_tasks').where({ id: taskId }).update({ status: 'pending', next_attempt_at: nowIso(), updated_at: nowIso() });
  setImmediate(() => drainQueue(ctx).catch(() => {}));
}

export async function queueStats(db) {
  const rows = await db('pending_ai_tasks').groupBy('status').count({ c: 'id' }).select('status');
  const out = { pending: 0, processing: 0, failed: 0, dead_letter: 0, done: 0 };
  for (const r of rows) out[r.status] = Number(r.c);
  return out;
}
