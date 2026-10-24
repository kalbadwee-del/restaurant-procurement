// src/ai.js — AI abstraction (§14.4): zod schemas, mock provider (D-S7), Gemini REST provider,
// rate limiter (C3: global daily + per-user daily + burst + 80% warn + model fallback chain), factory.
import { z } from 'zod';
import { nowIso, sha256 } from './util.js';
import { log, EV } from './logging.js';

// ---------- Schemas (§14.2, §2.4) ----------
export const InvoiceExtractionSchema = z.object({
  detected_language: z.enum(['en', 'ms', 'zh', 'ta', 'mixed']),
  supplier_name: z.string().nullable().optional(),
  invoice_number: z.string().nullable().optional(),
  invoice_date: z.string().nullable().optional(),
  invoice_total: z.number().nullable().optional(),
  items: z.array(z.object({
    name_original: z.string().min(1),
    name_normalized: z.string().min(1),
    brand: z.string().nullable().optional(),
    quantity: z.number().nonnegative(),
    unit: z.string().nullable().optional(),
    unit_price: z.number().nonnegative(),
    discount: z.number().nonnegative().nullable().optional(),
    tax: z.number().nonnegative().nullable().optional(),
    line_total: z.number().nonnegative(),
    confidence: z.enum(['high', 'medium', 'low']),
  })).min(1),
  totals_match: z.boolean(),
});
export const TranscriptionSchema = z.object({ text: z.string().min(1), language: z.string().default('en') });
export const CorrectionParsingSchema = z.object({
  symbol: z.string().min(1).max(2).nullable(),
  field: z.enum(['quantity', 'unit_price', 'name', 'unit', 'discount', 'tax', 'category']).nullable(),
  value: z.string().nullable(),
  intent: z.enum(['correction', 'unclear']),
});

// ---------- Prompt (multi-language, §2.4) ----------
export function extractionPrompt() {
  return `You are an invoice data extraction engine for Malaysian restaurant procurement.
Detect the invoice language (English, Malay, Chinese, Tamil, or mixed).
Extract every line item EXACTLY as written (name_original) — do NOT translate.
Also provide name_normalized: a normalized English product name for matching.
Units: keep as written; prices in MYR. Set totals_match=true only if line sums equal the invoice total.
Set confidence per item: high (clear print), medium (readable but unusual), low (uncertain).
Return ONLY valid JSON matching: {"detected_language","supplier_name","invoice_number","invoice_date","invoice_total","items":[{"name_original","name_normalized","brand","quantity","unit","unit_price","discount","tax","line_total","confidence"}],"totals_match"}`;
}
export function correctionPrompt(contextText) {
  return `You parse free-text corrections for an invoice under review.
Available item symbols: ${contextText}. Parse the user's message and return ONLY JSON:
{"symbol":"A|B|...|null","field":"quantity|unit_price|name|unit|discount|tax|category|null","value":"new value or null","intent":"correction|unclear"}`;
}

// ---------- Rate limiter (C3) ----------
export class RateLimiter {
  constructor(cfg) {
    this.globalCap = cfg.dailyGlobalCap; this.userCap = cfg.dailyPerUserCap;
    this.burst = cfg.burstPerMin; this.warnPct = cfg.warnPct;
    this.burstWindow = []; // timestamps
    this.warned = new Set();
  }
  resetDayIfNeeded() { this.warned.clear(); }
  async check({ db, userId }) {
    const day = new Date().toISOString().slice(0, 10);
    const now = Date.now();
    this.burstWindow = this.burstWindow.filter((t) => now - t < 60_000);
    if (this.burstWindow.length >= this.burst) return { ok: false, reason: 'burst' };
    const [{ c: globalCount } = { c: 0 }] = await db('ai_call_logs')
      .where('created_at', '>=', `${day}T00:00:00.000Z`).andWhere('status', 'success').count({ c: 'id' });
    if (Number(globalCount) >= this.globalCap) return { ok: false, reason: 'global_cap' };
    if (userId) {
      const [{ c: userCount } = { c: 0 }] = await db('ai_call_logs')
        .where('created_at', '>=', `${day}T00:00:00.000Z`).andWhere('status', 'success').andWhere('user_id', userId).count({ c: 'id' });
      if (Number(userCount) >= this.userCap) return { ok: false, reason: 'user_cap' };
    }
    const pct = Math.round((Number(globalCount) / this.globalCap) * 100);
    if (pct >= this.warnPct && !this.warned.has(day)) { this.warned.add(day); log.warn('ai.threshold_warn', { meta: { pct, cap: this.globalCap } }); }
    return { ok: true, used: Number(globalCount), cap: this.globalCap, pct };
  }
  markBurst() { this.burstWindow.push(Date.now()); }
}

// ---------- Providers ----------
export class MockAIProvider {
  constructor() { this.name = 'mock'; }
  async extractInvoice(imageBuffer, _mime, meta = {}) {
    // deterministic synthetic extraction keyed by content hash (3 canned variants)
    const h = sha256(imageBuffer || Buffer.from(String(meta.hint ?? 'x')));
    const variant = Number.parseInt(h[0], 16) % 3;
    if (variant === 0) {
      return {
        detected_language: 'zh', supplier_name: 'Tekka Fresh Market', invoice_number: 'TFM-2041', invoice_date: '2026-10-20',
        invoice_total: 342.10,
        items: [
          { name_original: '鸡蛋', name_normalized: 'Chicken Eggs', brand: null, quantity: 30, unit: 'pcs', unit_price: 0.45, discount: 0, tax: 0, line_total: 13.50, confidence: 'low' },
          { name_original: 'Lada Hitam', name_normalized: 'Black Pepper', brand: 'Baba', quantity: 2, unit: 'kg', unit_price: 28.0, discount: 0, tax: 0, line_total: 56.0, confidence: 'high' },
          { name_original: 'Sabun Cuci', name_normalized: 'Dishwashing Soap', brand: null, quantity: 3, unit: 'btl', unit_price: 4.2, discount: 0, tax: 0, line_total: 12.6, confidence: 'medium' },
        ],
        totals_match: false,
      };
    }
    if (variant === 1) {
      return {
        detected_language: 'ms', supplier_name: 'Giant Hypermarket', invoice_number: 'GI-88123', invoice_date: '2026-10-21',
        invoice_total: 196.10,
        items: [
          { name_original: 'Beras Cap Rambutan 10kg', name_normalized: 'Rice Rambutan 10kg', brand: 'Cap Rambutan', quantity: 2, unit: 'pack', unit_price: 62.0, discount: 4.0, tax: 0, line_total: 120.0, confidence: 'high' },
          { name_original: 'Minyak Masak 5kg', name_normalized: 'Cooking Oil 5kg', brand: 'Seri', quantity: 1, unit: 'btl', unit_price: 38.5, discount: 0, tax: 0, line_total: 38.5, confidence: 'high' },
          { name_original: 'Ayam Segar', name_normalized: 'Fresh Chicken', brand: null, quantity: 5, unit: 'kg', unit_price: 7.52, discount: 0, tax: 0, line_total: 37.6, confidence: 'medium' },
        ],
        totals_match: true,
      };
    }
    return {
      detected_language: 'en', supplier_name: 'Wisma Vegetable Sdn Bhd', invoice_number: 'INV-70717', invoice_date: '2026-10-22',
      invoice_total: 964.18,
      items: [
        { name_original: 'Tomato Grade A', name_normalized: 'Tomato', brand: null, quantity: 20, unit: 'kg', unit_price: 6.2, discount: 0, tax: 0, line_total: 124.0, confidence: 'high' },
        { name_original: 'Onion Big', name_normalized: 'Onion', brand: null, quantity: 30, unit: 'kg', unit_price: 4.15, discount: 12.0, tax: 0, line_total: 112.5, confidence: 'high' },
        { name_original: 'Mozzarella Cheese 2kg', name_normalized: 'Mozzarella Cheese 2kg', brand: 'Fonterra', quantity: 6, unit: 'pack', unit_price: 58.0, discount: 0, tax: 0, line_total: 348.0, confidence: 'high' },
        { name_original: 'Paper Napkin 200s', name_normalized: 'Paper Napkin 200s', brand: 'Klinika', quantity: 8, unit: 'pack', unit_price: 3.2, discount: 0, tax: 0, line_total: 25.6, confidence: 'high' },
        { name_original: 'Electric Mixer', name_normalized: 'Electric Mixer', brand: 'Panasonic', quantity: 1, unit: 'pcs', unit_price: 354.08, discount: 0, tax: 0, line_total: 354.08, confidence: 'medium' },
      ],
      totals_match: true,
    };
  }
  async transcribeAudio(_audio, _mime, meta = {}) {
    return { text: meta.fallbackText ?? 'Recalculated: add 2 kg of Black Pepper and reduce tomatoes to 15 kg', language: 'en' };
  }
  async parseCorrection(text, _ctx) {
    // deterministic-ish: try patterns, else unclear
    const m = text.match(/^\(?([A-Z])\)?\s*[:\-]?\s*(quantity|qty|price|unit_price|name)?\s*(=|:|to|is)?\s*(.+)$/i);
    if (m) {
      const fieldMap = { quantity: 'quantity', qty: 'quantity', price: 'unit_price', unit_price: 'unit_price', name: 'name', unit: 'unit' };
      const field = fieldMap[(m[2] || '').toLowerCase()] ?? (isNaN(Number(m[4])) ? 'name' : 'quantity');
      return { symbol: m[1].toUpperCase(), field, value: m[4].trim(), intent: 'correction' };
    }
    return { symbol: null, field: null, value: null, intent: 'unclear' };
  }
}

export class GeminiProvider {
  constructor({ apiKey, modelPrimary, modelFallbacks }) {
    this.name = 'gemini'; this.apiKey = apiKey;
    this.chain = [modelPrimary, ...modelFallbacks];
  }
  async #call(model, parts, schemaName) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) { const err = new Error(`gemini ${model} HTTP ${res.status}`); err.status = res.status; throw err; }
    const body = await res.json();
    const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('empty response');
    return { text, usage: body.usageMetadata ?? {} };
  }
  async #callWithFallback(parts, schema, schemaName) {
    let lastErr;
    for (const model of this.chain) {
      try {
        const { text, usage } = await this.#call(model, parts, schemaName);
        const parsed = schema.parse(JSON.parse(text));
        return { parsed, model, usage };
      } catch (e) { lastErr = e; if (e.status === 429) continue; if (e instanceof z.ZodError) continue; if (e.status >= 500) continue; throw e; }
    }
    throw lastErr;
  }
  async extractInvoice(imageBuffer, mime, meta = {}) {
    const { parsed, model, usage } = await this.#callWithFallback(
      [{ text: extractionPrompt() }, { text: meta.hint ?? '', inlineData: { mimeType: mime ?? 'image/png', data: (imageBuffer ?? Buffer.from('')).toString('base64') } }],
      InvoiceExtractionSchema, 'invoice',
    );
    return Object.assign(parsed, { _model: model, _usage: usage });
  }
  async transcribeAudio(audio, mime, meta = {}) {
    const { parsed, model } = await this.#callWithFallback(
      [{ text: 'Transcribe this audio verbatim.' }, { text: meta.hint ?? '', inlineData: { mimeType: mime ?? 'audio/ogg', data: (audio ?? Buffer.from('')).toString('base64') } }],
      TranscriptionSchema, 'transcription',
    );
    return Object.assign(parsed, { _model: model });
  }
  async parseCorrection(text, ctxText) {
    const { parsed, model } = await this.#callWithFallback(
      [{ text: correctionPrompt(ctxText) }, { text }],
      CorrectionParsingSchema, 'correction',
    );
    return Object.assign(parsed, { _model: model });
  }
}

export function makeAI(cfg) {
  const provider = cfg.ai.provider === 'gemini' && cfg.ai.apiKey
    ? new GeminiProvider({ apiKey: cfg.ai.apiKey, modelPrimary: cfg.ai.modelPrimary, modelFallbacks: cfg.ai.modelFallbacks })
    : new MockAIProvider();
  const limiter = new RateLimiter(cfg.ai);
  return { provider, limiter };
}

// ---------- call wrapper with logging + limiter (every call goes through this — §14.5) ----------
export async function aiCall(ctx, { kind, userId, invoiceId, taskId, fn }) {
  const { ai } = ctx;
  const gate = await ai.limiter.check({ db: ctx.db, userId });
  if (!gate.ok) {
    log.info(EV.AI_RATE_LIMITED, { user_id: userId ? String(userId) : null, invoice_id: invoiceId, meta: { reason: gate.reason } });
    throw Object.assign(new Error(`rate_limited:${gate.reason}`), { rateLimited: true, reason: gate.reason });
  }
  ai.limiter.markBurst();
  const t0 = Date.now();
  try {
    const result = await fn(ai.provider);
    await ctx.db('ai_call_logs').insert({
      provider: ai.provider.name, model: result._model ?? ai.provider.name,
      user_id: userId ?? null, task_id: taskId ?? null, invoice_id: invoiceId ?? null,
      tokens_in: result._usage?.promptTokenCount ?? 0, tokens_out: result._usage?.candidatesTokenCount ?? 0,
      duration_ms: Date.now() - t0, status: 'success', error: null, created_at: nowIso(),
    });
    log.info(EV.AI_CALL, { user_id: userId ? String(userId) : null, invoice_id: invoiceId, task_id: taskId, duration_ms: Date.now() - t0, status: 'success', meta: { kind, model: result._model ?? 'mock' } });
    return result;
  } catch (e) {
    await ctx.db('ai_call_logs').insert({
      provider: ai.provider.name, model: ai.provider.name, user_id: userId ?? null, task_id: taskId ?? null, invoice_id: invoiceId ?? null,
      tokens_in: 0, tokens_out: 0, duration_ms: Date.now() - t0, status: 'fail', error: String(e.message).slice(0, 400), created_at: nowIso(),
    });
    log.info(EV.AI_CALL, { user_id: userId ? String(userId) : null, invoice_id: invoiceId, task_id: taskId, duration_ms: Date.now() - t0, status: 'fail', error: e.message, meta: { kind } });
    throw e;
  }
}
