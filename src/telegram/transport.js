// src/telegram/transport.js — BotTransport: real (grammY webhook) | mock (captured outbox, D-S15)
import { Bot } from 'grammy';

export function makeTransport(cfg, outbox) {
  if (cfg.telegram.mode === 'real' && cfg.telegram.token) return new RealTransport(cfg, outbox);
  return new MockTransport(outbox);
}

export class MockTransport {
  constructor(outbox) { this.outbox = outbox; this.mode = 'mock'; }
  async sendMessage(chatId, text, extra = {}) { this.outbox.push({ kind: 'message', chatId, text, extra }); return { message_id: this.outbox.all().length }; }
  async sendPhoto(chatId, _source, caption) { this.outbox.push({ kind: 'photo', chatId, caption }); return {}; }
  async answerCallbackQuery(_id, text) { this.outbox.push({ kind: 'callback_answer', text }); return {}; }
  async setWebhookCommands() { return true; }
}

export class RealTransport {
  constructor(cfg, outbox) {
    this.bot = new Bot(cfg.telegram.token);
    this.outbox = outbox;
    this.webhookSecret = cfg.telegram.webhookSecret;
    this.mode = 'real';
  }
  async sendMessage(chatId, text, extra = {}) {
    const r = await this.bot.api.sendMessage(chatId, text, extra);
    this.outbox.push({ kind: 'message', chatId, text, extra });
    return r;
  }
  async answerCallbackQuery(id, text) { await this.bot.api.answerCallbackQuery(id, { text }).catch(() => {}); }
}

// Startup recovery (F14 + §2.2 + D-S10): real mode only.
export async function recoverMissedUpdates(ctx, processUpdate) {
  if (ctx.transport.mode !== 'real') return { recovered: 0 };
  const { db } = ctx;
  const last = await db('processed_updates').orderBy('update_id', 'desc').first();
  let offset = (last?.update_id ?? 0) + 1;
  await ctx.transport.bot.api.deleteWebhook({ drop_pending_updates: false });
  let recovered = 0, expired = 0;
  for (;;) {
    const updates = await ctx.transport.bot.api.getUpdates({ offset, timeout: 0, limit: 100 });
    if (!updates.length) break;
    for (const u of updates) {
      const ageH = (Date.now() - u.message?.date * 1000) / 3600_000;
      if (ageH <= 24) { await processUpdate(u, { recovered: true }); recovered++; }
      else expired++;
      await db('processed_updates').insert({ update_id: u.update_id, processed_at: new Date().toISOString(), status: 'ok' }).onConflict('update_id').ignore();
    }
    offset = updates[updates.length - 1].update_id + 1;
    if (updates.length < 100) break;
  }
  const base = process.env.BASE_URL || '';
  if (base) await ctx.transport.bot.api.setWebhook(`${base}/telegram-webhook`, { secret_token: ctx.config.telegram.webhookSecret });
  const { EV } = await import('../logging.js');
  if (recovered || expired) ctx.log?.info?.(EV.TG_UPDATE_RECOVERED, { meta: { recovered, expired } });
  return { recovered, expired };
}
