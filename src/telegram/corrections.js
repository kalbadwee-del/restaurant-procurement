// src/telegram/corrections.js — deterministic-first correction parsing (D-S17), AI fallback via queue
import { t } from './i18n.js';
import { log } from '../logging.js';

export async function applyCorrectionFromText(ctx, info, user, lang, text) {
  const { parseCorrectionDeterministic, applyCorrection } = await import('../services/invoices.js');
  const parsed = parseCorrectionDeterministic(text);
  if (!parsed) {
    // ambiguous → ask (never guess, §5.4). AI fallback creates a queue task for richer parsing.
    const { enqueue } = await import('../queue.js');
    const open = await ctx.db('draft_sessions').where({ status: 'open', user_id: user.id }).orderBy('id', 'desc').first();
    const invoiceId = open?.invoice_id ?? null;
    if (invoiceId) {
      await enqueue(ctx, { taskType: 'correction_parse', payload: { text, invoice_id: invoiceId, chat_id: info.chatId, user_id: user.id }, invoiceId, createdBy: user.id });
      return ctx.transport.sendMessage(info.chatId, t('correction_ambiguous', lang));
    }
    return ctx.transport.sendMessage(info.chatId, t('correction_ambiguous', lang));
  }
  // target: latest in_review invoice in this chat
  const session = await ctx.db('draft_sessions').where({ chat_id: info.chatId, user_id: user.id }).orderBy('id', 'desc').first();
  let invoiceId = session?.invoice_id ?? null;
  if (!invoiceId) {
    const inv = await ctx.db('invoices as i').join('telegram_groups as g', function () { this.on('g.branch_id', 'i.branch_id'); })
      .where({ 'g.chat_id': info.chatId, 'i.status': 'in_review' }).orderBy('i.id', 'desc').first();
    invoiceId = inv?.id ?? null;
  }
  if (!invoiceId) return ctx.transport.sendMessage(info.chatId, t('correction_ambiguous', lang));
  const r = await applyCorrection(ctx, invoiceId, parsed, user);
  if (r.ok) {
    return ctx.transport.sendMessage(info.chatId, t('correction_applied', lang, { symbol: parsed.symbol, field: parsed.field, value: parsed.value }));
  }
  log.warn('correction.failed', { invoice_id: invoiceId, user_id: String(user.id), meta: { reason: r.reason } });
  return ctx.transport.sendMessage(info.chatId, t('correction_ambiguous', lang));
}
