// src/telegram/handlers.js — bot behaviors: pairing, private commands, invoice group silent mode (F2),
// review report messages (§5.3), corrections (F5), transcription application, callbacks.
import { tg, t, MESSAGES } from './i18n.js';
import { nowIso, formatRM, klDateTimeStr, b } from '../util.js';
import { log, EV } from '../logging.js';

export async function tryPair(ctx, info) {
  const code = info.text.trim().split(/\s+/)[1];
  const { db } = ctx;
  const pending = await db('app_settings').where({ key: `pair_${code}` }).first();
  if (!pending) return ctx.transport.sendMessage(info.chatId, tg('pair_code_invalid'));
  const target = JSON.parse(pending.value);
  await db('users').where({ id: target.user_id }).update({ telegram_id: info.fromId, updated_at: nowIso() });
  await db('app_settings').where({ key: `pair_${code}` }).del();
  const u = await db('users').where({ id: target.user_id }).first();
  return ctx.transport.sendMessage(info.chatId, tg('pair_ok', { name: u.full_name }));
}

export async function handlePrivateCommand(ctx, info, user, lang) {
  const text = (info.text ?? '').trim();
  if (text.startsWith('/start')) return ctx.transport.sendMessage(info.chatId, t('started', lang));
  if (text.startsWith('/help')) return ctx.transport.sendMessage(info.chatId, t('help', lang));
  if (text.startsWith('/requests')) {
    const { aggregatedShoppingList, lateRequests } = await import('../services/requests.js');
    const agg = await aggregatedShoppingList(ctx.db);
    const late = await lateRequests(ctx.db);
    const lines = agg.map((a) => `• ${a.product_name}: ${a.total_remaining}${a.late ? ' ⚠' : ''} (${a.branches.map((b) => `${b.branch_name}:${b.remaining}`).join(', ')})`);
    const msg = [lang === 'ar' ? 'الطلبات المفتوحة:' : 'Open requests:', ...lines.length ? lines : ['—']].join('\n') + (late.length ? `\n⚠ ${late.length} late` : '');
    return ctx.transport.sendMessage(info.chatId, msg);
  }
  if (text.startsWith('/list')) {
    const invs = await ctx.db('invoices as i').join('branches as b', 'b.id', 'i.branch_id').whereNot({ 'i.status': 'draft' }).orderBy('i.id', 'desc').limit(10)
      .select('i.id', 'i.status', 'i.invoice_total', 'i.invoice_date', 'b.name_en as branch');
    const lines = invs.map((i) => `#${i.id} ${i.branch} ${i.status}${i.invoice_total ? ` ${formatRM(Math.round(Number(i.invoice_total) * 100))}` : ''} ${i.invoice_date ?? ''}`);
    return ctx.transport.sendMessage(info.chatId, [lang === 'ar' ? 'آخر الفواتير:' : 'Latest invoices:', ...lines].join('\n'));
  }
  return ctx.transport.sendMessage(info.chatId, t('help', lang));
}

// ---------- invoice group (F2) ----------
export async function handleInvoiceGroupMessage(ctx, info, user, group, lang) {
  const branch = group.branch_id ? await ctx.db('branches').where({ id: group.branch_id }).first() : null;
  if (!branch) return ctx.transport.sendMessage(info.chatId, tg('not_invoice_group'));

  if (info.kind === 'text') {
    const text = info.text.trim();
    if (/^\/ready$/i.test(text) || /^(ready|جاهز)$/i.test(text)) {
      const { finishSession } = await import('../services/invoices.js');
      const r = await finishSession(ctx, info.chatId, user);
      if (!r) return ctx.transport.sendMessage(info.chatId, tg('invoice_ready'));
      if (r.empty) return ctx.transport.sendMessage(info.chatId, tg('invoice_ready'));
      const { enqueue } = await import('../queue.js');
      return ctx.transport.sendMessage(info.chatId, tg('ai_busy'));
    }
    // correction targeting a review symbol? (D-S17 deterministic first)
    if (/^\(?[A-Z]\)?\s*[:\-]/i.test(text)) {
      const { applyCorrectionFromText } = await import('./corrections.js');
      return applyCorrectionFromText(ctx, info, user, lang, text);
    }
  }

  let buffer = null, mime = null;
  const toBuf = (v) => (v == null ? null : Buffer.isBuffer(v) ? v : Buffer.from(v.data ?? []));
  if (info.kind === 'photo' || info.kind === 'voice' || info.kind === 'audio') {
    if (ctx.transport.mode === 'real') {
      const tgFile = await ctx.transport.bot.api.getFile(info.kind === 'photo' ? info.photoFileId : info.voiceFileId);
      const res = await fetch(`https://api.telegram.org/file/bot${ctx.config.telegram.token}/${tgFile.file_path}`);
      buffer = Buffer.from(await res.arrayBuffer());
      mime = info.mime ?? (info.kind === 'photo' ? 'image/jpeg' : 'audio/ogg');
    } else {
      // mock mode: caller supplied payload via /dev/mock-telegram (info._mockBuffer) or synthetic bytes
      buffer = toBuf(info._mockBuffer) ?? Buffer.from(`mock-${info.kind}-${Date.now()}`);
      mime = info._mockMime ?? (info.kind === 'photo' ? 'image/png' : 'audio/ogg');
    }
  }
  const { receiveInvoiceInput } = await import('../services/invoices.js');
  const r = await receiveInvoiceInput(ctx, {
    chatId: info.chatId, user, branch, kind: info.kind, buffer, mime,
    text: info.kind === 'text' ? info.text : null, messageId: info.messageId,
  });
  return ctx.transport.sendMessage(info.chatId, tg(r.isNew ? 'invoice_received' : 'invoice_more'));
}

export async function applyTranscription(ctx, payload, text) {
  // voice transcribed → treat as text input into the same invoice draft
  const user = await ctx.db('users').where({ id: payload.user_id }).first();
  if (!user) return;
  const session = await ctx.db('draft_sessions').where({ invoice_id: payload.invoice_id, status: 'open' }).first();
  const chatId = payload.chat_id;
  if (!session) {
    await ctx.transport.sendMessage(chatId, tg('session_closed_idle'));
    return;
  }
  const { applyCorrectionFromText } = await import('./corrections.js');
  if (/^\(?[A-Z]\)?\s*[:\-]/i.test(text)) return applyCorrectionFromText(ctx, { chatId, text, messageId: null, fromId: user.telegram_id }, user, user.language, text);
  const { receiveInvoiceInput } = await import('../services/invoices.js');
  const branch = session.chat_id ? await ctx.db('telegram_groups').where({ chat_id: session.chat_id }).first() : null;
  await receiveInvoiceInput(ctx, { chatId, user, branch: branch?.branch_id ? await ctx.db('branches').where({ id: branch.branch_id }).first() : null, kind: 'text', buffer: null, mime: null, text, messageId: null });
}

// ---------- review report message (§5.3) — sent after extraction ----------
export async function sendReviewReport(ctx, invoiceId) {
  const { buildReviewData } = await import('../services/invoices.js');
  const data = await buildReviewData(ctx.db, invoiceId);
  const inv = data.invoice;
  const lang = 'en';
  const lines = [];
  lines.push(`🧾 Invoice #${inv.id} — ${inv.supplier_name ?? '—'} ${inv.invoice_date ? `(${inv.invoice_date})` : ''} [${inv.detected_language ?? '—'}]`);
  for (const it of data.items) {
    const sym = it.review_symbol && it.needs_review ? ` (${it.review_symbol})` : '';
    const flag = it.needs_review ? '⚠' : '✔';
    lines.push(`${flag}${sym} ${it.name_original}${it.name_normalized !== it.name_original ? ` → ${it.name_normalized}` : ''} | ${it.quantity} ${it.unit_text ?? ''} @ ${formatRM(Math.round(Number(it.unit_price) * 100))} = ${formatRM(Math.round(Number(it.line_total) * 100))} [${it.confidence}]${it.is_excess ? ' • excess' : ''}`);
  }
  if (data.matched.length) lines.push(`↔ ${lang === 'ar' ? 'مطابق لطلبات' : 'Matches requests'}: ${data.matched.map((m) => `#${m.line_no}`).join(', ')}`);
  const unfulfilled = await ctx.db('v_open_requests').where('branch_id', inv.branch_id).count({ c: 'request_item_id' }).first();
  if (Number(unfulfilled?.c ?? 0) > 0) lines.push(`⏳ ${lang === 'ar' ? 'طلبات غير مكتملة' : 'Unfulfilled requests remaining'}: ${unfulfilled.c}`);
  if (data.newProducts.length) lines.push(`🆕 ${lang === 'ar' ? 'منتجات جديدة' : 'New products'}: ${data.newProducts.map((n) => n.name_original).join(', ')}`);
  if (b(inv.duplicate_flag)) lines.push(`⚠ ${lang === 'ar' ? 'تكرار محتمل — راجع قبل الاعتماد' : 'Potential DUPLICATE — review before approval'}`);
  if (b(inv.discrepancy_flag)) lines.push(`⚠ ${lang === 'ar' ? 'فرق بين مجموع البنود والإجمالي' : 'Line sums vs invoice total discrepancy'}`);
  lines.push(lang === 'ar' ? 'أرسل التصحيحات بصيغة: A: quantity 12' : 'Send corrections as: A: quantity 12');
  const text = lines.join('\n');
  const session = await ctx.db('draft_sessions').where({ invoice_id: invoiceId }).orderBy('id', 'desc').first();
  const chatId = session?.chat_id;
  if (chatId) await ctx.transport.sendMessage(chatId, text);
  return text;
}

export async function handleCallback(ctx, info, user) {
  return ctx.transport.sendMessage(info.chatId, t('denied', user.language));
}
