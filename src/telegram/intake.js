// src/telegram/intake.js — update router (F1): secret check done at HTTP layer; here:
// identity resolution (§4.2/4.3), idempotency via processed_updates (§2.2), group kind routing.
import { nowIso, b } from '../util.js';
import { log, EV } from '../logging.js';
import { tg } from './i18n.js';

export function extractUpdateInfo(update) {
  const msg = update.message ?? update.edited_message ?? update.channel_post ?? null;
  const cb = update.callback_query ?? null;
  if (cb) {
    return { kind: 'callback', updateId: update.update_id, chatId: cb.message?.chat?.id, fromId: cb.from?.id, text: cb.data, messageId: cb.message?.message_id, firstName: cb.from?.first_name, languageCode: cb.from?.language_code };
  }
  if (!msg) return null;
  const kind = msg.photo ? 'photo' : msg.voice ? 'voice' : msg.audio ? 'audio' : 'text';
  const text = msg.text ?? msg.caption ?? null;
  return {
    kind, updateId: update.update_id, chatId: msg.chat.id, chatType: msg.chat.type,
    fromId: msg.from?.id, text, messageId: msg.message_id,
    firstName: msg.from?.first_name ?? null, languageCode: msg.from?.language_code ?? null,
    photoFileId: msg.photo?.[msg.photo.length - 1]?.file_id ?? null,
    voiceFileId: msg.voice?.file_id ?? msg.audio?.file_id ?? null,
    mime: msg.voice?.mime_type ?? msg.audio?.mime_type ?? null,
    _mockBuffer: msg._mockBuffer ?? null,
    _mockMime: msg._mockMime ?? null,
  };
}

export async function resolveUser(db, fromId) {
  if (!fromId) return null;
  const u = await db('users').where({ telegram_id: fromId, is_active: true }).first();
  return u && b(u.is_active) ? u : null; // unverified ⇒ reject/ask (§4.2) — never guess branch
}

export async function resolveGroup(db, chatId) {
  return db('telegram_groups').where({ chat_id: chatId, is_active: true }).first();
}

// processUpdate — the single entry point for both real webhook and mock dev endpoint.
// Idempotency: insert processed_updates INSIDE the same logical step; duplicates are skipped (§2.2).
export async function processUpdate(ctx, update, { recovered = false } = {}) {
  const info = extractUpdateInfo(update);
  if (!info) return { skipped: true };
  const { db } = ctx;

  const dup = await db('processed_updates').where({ update_id: info.updateId }).first();
  if (dup) {
    log.info(EV.TG_UPDATE_SKIPPED, { meta: { update_id: info.updateId, reason: 'duplicate' } });
    return { skipped: true, duplicate: true };
  }

  try {
    await handleUpdate(ctx, info, { recovered });
    await db('processed_updates').insert({ update_id: info.updateId, processed_at: nowIso(), status: 'ok' });
    log.info(EV.TG_UPDATE_RECEIVED, { user_id: info.fromId ? String(info.fromId) : null, meta: { update_id: info.updateId, kind: info.kind, recovered } });
    return { ok: true };
  } catch (e) {
    log.error('telegram.update_error', { status: 'error', error: e.message, meta: { update_id: info.updateId } });
    throw e;
  }
}

async function handleUpdate(ctx, info, opts) {
  const { db } = ctx;
  const user = await resolveUser(db, info.fromId);
  const group = info.chatType && ['group', 'supergroup'].includes(info.chatType) ? await resolveGroup(db, info.chatId) : null;

  if (!user) {
    // pairing code path: "PAIR <code>" in private chat
    if (info.kind === 'text' && info.chatType === 'private' && /^pair\s+\S+/i.test(info.text ?? '')) {
      const { tryPair } = await import('./handlers.js');
      return tryPair(ctx, info);
    }
    await ctx.transport.sendMessage(info.chatId, tg('unverified'));
    return;
  }
  const lang = user.language === 'ar' ? 'ar' : 'en';

  if (info.kind === 'callback') {
    const { handleCallback } = await import('./handlers.js');
    return handleCallback(ctx, info, user);
  }

  if (info.chatType === 'private') {
    const { handlePrivateCommand } = await import('./handlers.js');
    return handlePrivateCommand(ctx, info, user, lang);
  }

  if (!group) {
    await ctx.transport.sendMessage(info.chatId, tg('unverified'));
    return;
  }
  if (group.kind === 'invoice_group') {
    const { handleInvoiceGroupMessage } = await import('./handlers.js');
    return handleInvoiceGroupMessage(ctx, info, user, group, lang);
  }
  if (group.kind === 'request_group') {
    if (info.kind !== 'text') return;
    const { handleRequestMessage } = await import('../services/requests.js');
    const branch = group.branch_id ? await db('branches').where({ id: group.branch_id }).first() : null;
    if (!branch) { await ctx.transport.sendMessage(info.chatId, tg('not_invoice_group')); return; }
    const r = await handleRequestMessage(ctx, { chatId: info.chatId, user, branch, text: info.text, messageId: info.messageId });
    const { t } = await import('./i18n.js');
    if (r.ok && r.action === 'created') await ctx.transport.sendMessage(info.chatId, t('request_recorded', lang, { product: r.product.name_en, qty: r.qty, unit: r.unit ?? '' }));
    else if (r.ok && r.action === 'increment') await ctx.transport.sendMessage(info.chatId, t('request_modified', lang, { product: r.product.name_en, qty: r.newQty, unit: '', old: r.oldQty }));
    else if (!r.ok && r.reason === 'ambiguous') await ctx.transport.sendMessage(info.chatId, t('request_ambiguous', lang));
    else if (!r.ok && r.reason === 'product_unknown') await ctx.transport.sendMessage(info.chatId, t('request_ambiguous', lang));
    else if (!r.ok) await ctx.transport.sendMessage(info.chatId, t('denied', lang));
    return;
  }
}

export async function registerWebhookIfReal(ctx) {
  if (ctx.transport.mode !== 'real') return;
  const base = process.env.BASE_URL;
  if (!base) { log.warn('telegram.no_base_url', { meta: { hint: 'set BASE_URL to register webhook' } }); return; }
  await ctx.transport.bot.api.setWebhook(`${base}/telegram-webhook`, { secret_token: ctx.config.telegram.webhookSecret });
  log.info('telegram.webhook_registered', { meta: { base } });
}
