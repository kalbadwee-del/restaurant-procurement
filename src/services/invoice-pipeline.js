// src/services/invoice-pipeline.js — queue task glue: extraction → review message; correction parse via AI.
import { log } from '../logging.js';

export async function processInvoiceExtraction(ctx, task, payload) {
  const { processInvoiceExtraction: extract } = await import('./invoices.js');
  const r = await extract(ctx, task, payload);
  const { sendReviewReport } = await import('../telegram/handlers.js');
  await sendReviewReport(ctx, payload.invoice_id);
  return r;
}

export async function runCorrectionTask(ctx, task, payload) {
  // deterministic parser failed upstream → use AI parse (still suggestion-only, §14.1)
  const { aiCall } = await import('../ai.js');
  const parsed = await aiCall(ctx, {
    kind: 'correction', userId: task.created_by, invoiceId: task.invoice_id, taskId: task.id,
    fn: (provider) => provider.parseCorrection(payload.text, 'A,B,C…'),
  });
  if (parsed.intent !== 'correction' || !parsed.symbol || !parsed.field) {
    const { t } = await import('../telegram/i18n.js');
    const user = await ctx.db('users').where({ id: payload.user_id }).first();
    await ctx.transport.sendMessage(payload.chat_id, t('correction_ambiguous', user?.language ?? 'en'));
    return { applied: false };
  }
  const { applyCorrection } = await import('./invoices.js');
  const actor = await ctx.db('users').where({ id: payload.user_id }).first();
  const r = await applyCorrection(ctx, payload.invoice_id, { symbol: parsed.symbol, field: parsed.field, value: parsed.value }, actor);
  const { t } = await import('../telegram/i18n.js');
  await ctx.transport.sendMessage(payload.chat_id, r.ok
    ? t('correction_applied', actor?.language ?? 'en', { symbol: parsed.symbol, field: parsed.field, value: parsed.value })
    : t('correction_ambiguous', actor?.language ?? 'en'));
  return { applied: r.ok };
}
