// src/services/invoices.js — invoice lifecycle (§5): intake, silent mode (F2), review (F3),
// corrections (F5), final approval transaction (F6), reject, post-approval amendment (Q2).
import { nowIso, toSen, computeLineTotalSen, senToDb, klDateStr, jsonOf, b } from '../util.js';
import { log, EV } from '../logging.js';
import { audit, updateWithVersion } from '../audit.js';

const UNITS_FALLBACK = null; // unit resolved by unit_text match later

async function getUnitId(db, unitText) {
  if (!unitText) return null;
  const u = await db('units').whereRaw('lower(short_name) = ?', [String(unitText).toLowerCase().trim()]).first()
    || await db('units').whereRaw('lower(name) = ?', [String(unitText).toLowerCase().trim()]).first();
  return u?.id ?? null;
}

// ---------- intake (F2) ----------
export async function openDraft(ctx, { chatId, user, branchId, source, messageId }) {
  const ts = nowIso();
  const [inv] = await ctx.db('invoices').insert({
    branch_id: branchId, status: 'draft', source, telegram_message_id: messageId ?? null,
    currency: 'MYR', created_by: user.id, created_at: ts, updated_at: ts,
  }).returning('id');
  const invoiceId = typeof inv === 'object' ? inv.id : inv;
  await ctx.db('draft_sessions').insert({
    chat_id: chatId, user_id: user.id, invoice_id: invoiceId, status: 'open', opened_at: ts, last_activity_at: ts,
  });
  log.info(EV.INVOICE_RECEIVED, { user_id: String(user.id), branch_id: branchId, invoice_id: invoiceId, meta: { source } });
  return invoiceId;
}

export async function currentSession(ctx, chatId, userId) {
  const s = await ctx.db('draft_sessions')
    .where({ chat_id: chatId, user_id: userId, status: 'open' }).orderBy('id', 'desc').first();
  if (!s) return null;
  const idleMin = (Date.now() - new Date(s.last_activity_at).getTime()) / 60_000;
  const ttl = ctx.config.raw.silent_session_ttl_min ?? 30;
  if (idleMin > ttl) {
    await ctx.db('draft_sessions').where({ id: s.id }).update({ status: 'closed', last_activity_at: nowIso() });
    return { expired: true, session: s };
  }
  return { expired: false, session: s };
}

export async function receiveInvoiceInput(ctx, { chatId, user, branch, kind, buffer, mime, text, messageId }) {
  const cur = await currentSession(ctx, chatId, user.id);
  if (cur?.expired) {
    const { tg } = await import('../telegram/i18n.js');
    await ctx.transport.sendMessage(chatId, tg('session_closed_idle'));
  }
  let session = cur && !cur.expired ? cur.session : null;

  // Anti-merge rules (§5.2): a photo or a different invoice number starts a NEW draft
  if (session && (kind === 'photo')) {
    await ctx.db('draft_sessions').where({ id: session.id }).update({ status: 'closed', last_activity_at: nowIso() });
    const { tg } = await import('../telegram/i18n.js');
    await ctx.transport.sendMessage(chatId, tg({ en: 'New file detected — started a NEW invoice draft (previous one kept separate).', ar: 'اكتُشف ملف جديد — بدأت مسودة فاتورة جديدة (السابقة بقيت منفصلة).' }));
    session = null;
  }
  if (!session) {
    const invoiceId = await openDraft(ctx, { chatId, user, branchId: branch.id, source: kind === 'photo' ? 'photo' : kind === 'voice' ? 'audio' : 'text', messageId });
    session = await ctx.db('draft_sessions').where({ invoice_id: invoiceId }).first();
  } else {
    await ctx.db('draft_sessions').where({ id: session.id }).update({ last_activity_at: nowIso() });
  }

  if (kind === 'photo') {
    const { storeFile, keys } = await import('../files.js');
    const ym = klDateStr().slice(0, 7);
    const stored = await storeFile(ctx, {
      kind: 'invoice_image', buffer, mime: mime ?? 'image/jpeg', entityType: 'invoice', entityId: session.invoice_id,
      keyOverride: keys.invoiceImage(branch.id, ym, session.invoice_id, `${session.invoice_id}.jpg`),
    });
    await ctx.db('invoices').where({ id: session.invoice_id }).update({ file_id: stored.id, updated_at: nowIso() });
    await ctx.db('files').where({ id: stored.id }).update({ entity_id: session.invoice_id });
  } else if (kind === 'voice') {
    const { storeFile, keys } = await import('../files.js');
    const ym = klDateStr().slice(0, 7);
    const stored = await storeFile(ctx, {
      kind: 'audio', buffer, mime: mime ?? 'audio/ogg', entityType: 'invoice', entityId: session.invoice_id,
      keyOverride: keys.audio(branch.id, ym, session.invoice_id, `${session.invoice_id}.ogg`),
    });
    const { enqueue } = await import('../queue.js');
    await enqueue(ctx, { taskType: 'audio_transcribe', payload: { file_key: stored.key, mime: stored.mime, chat_id: chatId, user_id: user.id, invoice_id: session.invoice_id, fallbackText: text ?? null }, invoiceId: session.invoice_id, createdBy: user.id });
  }
  if (text) {
    await ctx.db('invoices').where({ id: session.invoice_id }).update({ updated_at: nowIso() });
    // text inputs in silent mode accumulate into a raw transcript note on the invoice (used as extraction hint)
    const inv = await ctx.db('invoices').where({ id: session.invoice_id }).first();
    const note = jsonOf(await ctx.settings.getSetting(`draft_note_${session.invoice_id}`, null)) ?? [];
    note.push(text);
    await ctx.settings.setSetting(`draft_note_${session.invoice_id}`, note);
    await ctx.db('invoices').where({ id: inv.id }).update({ updated_at: nowIso() });
  }
  return { invoiceId: session.invoice_id, isNew: Boolean(cur?.expired) || !cur };
}

export async function finishSession(ctx, chatId, user) {
  const cur = await currentSession(ctx, chatId, user.id);
  if (!cur || cur.expired) return null;
  const invoiceId = cur.session.invoice_id;
  await ctx.db('draft_sessions').where({ id: cur.session.id }).update({ status: 'closed', last_activity_at: nowIso() });
  const itemsCount = await ctx.db('invoice_items').where({ invoice_id: invoiceId }).count({ c: 'id' }).first();
  const note = await ctx.settings.getSetting(`draft_note_${invoiceId}`, null);
  const hasFile = await ctx.db('invoices').where({ id: invoiceId }).whereNotNull('file_id').first();
  if (Number(itemsCount?.c ?? 0) === 0 && !hasFile && (!note || note.length === 0)) {
    await ctx.db('invoices').where({ id: invoiceId }).update({ status: 'rejected', updated_at: nowIso() });
    return { invoiceId, empty: true };
  }
  const { enqueue } = await import('../queue.js');
  await enqueue(ctx, {
    taskType: 'invoice_extract',
    payload: { invoice_id: invoiceId, hint: Array.isArray(note) ? note.join('\n') : (note ?? '') },
    invoiceId, createdBy: user.id,
  });
  return { invoiceId, empty: false };
}

// ---------- extraction pipeline (called by queue) — F3 ----------
export async function processInvoiceExtraction(ctx, task, payload) {
  const invoiceId = payload.invoice_id;
  const inv = await ctx.db('invoices').where({ id: invoiceId }).first();
  if (!inv) throw new Error(`invoice ${invoiceId} not found`);
  let imageBuffer = null, mime = null;
  if (inv.file_id) {
    const { getFileBuffer } = await import('../files.js');
    const f = await getFileBuffer(ctx, inv.file_id);
    if (f) { imageBuffer = f.buf; mime = f.row.mime; }
  }
  const { aiCall } = await import('../ai.js');
  const result = await aiCall(ctx, {
    kind: 'extract', userId: task.created_by, invoiceId, taskId: task.id,
    fn: (provider) => provider.extractInvoice(imageBuffer, mime, { hint: payload.hint ?? '' }),
  });
  await applyExtraction(ctx, invoiceId, result);
}

export async function applyExtraction(ctx, invoiceId, result) {
  const db = ctx.db;
  const inv = await db('invoices').where({ id: invoiceId }).first();
  // deterministic validation already done by zod + totals in sen (D-S13)
  let sumSen = 0;
  const rows = [];
  let line = 0;
  const { matchProduct, suggestCategory } = await import('./matching.js');
  for (const it of result.items) {
    line++;
    const unitPriceSen = toSen(it.unit_price) ?? 0;
    const discountSen = toSen(it.discount ?? 0) ?? 0;
    const taxSen = toSen(it.tax ?? 0) ?? 0;
    const totalSen = computeLineTotalSen(it.quantity, unitPriceSen, discountSen, taxSen);
    sumSen += totalSen;
    const m = await matchProduct(db, { nameOriginal: it.name_original, nameNormalized: it.name_normalized });
    rows.push({
      invoice_id: invoiceId, line_no: line,
      product_id: m.needsReview ? null : m.productId,
      name_original: it.name_original, name_normalized: it.name_normalized,
      brand_text: it.brand ?? null,
      quantity: it.quantity, unit_id: await getUnitId(db, it.unit), unit_text: it.unit ?? null,
      unit_price: Number(senToDb(unitPriceSen)), discount: Number(senToDb(discountSen)), tax: Number(senToDb(taxSen)),
      line_total: Number(senToDb(totalSen)),
      category_id: await suggestCategory(db, it.name_normalized),
      confidence: it.confidence,
      needs_review: it.confidence !== 'high' || (m.needsReview && !m.isNew),
      is_new_product: m.isNew,
      created_at: nowIso(), updated_at: nowIso(),
      _match: m,
    });
  }
  // replace previous items (extraction may re-run after retry)
  await db('invoice_items').where({ invoice_id: invoiceId }).del();
  for (const r of rows) {
    const match = r._match; delete r._match;
    const [id] = await db('invoice_items').insert(r).returning('id');
    r.id = typeof id === 'object' ? id.id : id;
    // link to open request item (same branch, same product, remaining > 0)
    if (r.product_id) {
      const ri = await db('request_items as ri').join('requests as rq', 'rq.id', 'ri.request_id')
        .where({ 'rq.branch_id': inv.branch_id, 'ri.product_id': r.product_id })
        .whereIn('ri.status', ['open', 'partially'])
        .whereRaw('(ri.quantity - ri.purchased_qty) > 0')
        .select('ri.*')
        .orderBy('rq.created_at').first();
      if (ri) {
        const remaining = Number(ri.quantity) - Number(ri.purchased_qty);
        const isExcess = Number(r.quantity) > remaining;
        await db('invoice_items').where({ id: r.id }).update({ matched_request_item_id: ri.id, is_excess: isExcess });
      }
    }
  }
  // assign review symbols (A)(B)(C) for this round (§5.3)
  const round = inv.review_round + 1;
  const flagged = rows.filter((r) => r.needs_review);
  for (let i = 0; i < flagged.length; i++) {
    await db('invoice_items').where({ id: flagged[i].id }).update({ review_symbol: String.fromCharCode(65 + i) });
  }
  // discrepancy check (§6.2) in sen
  const invoiceTotalSen = result.invoice_total != null ? toSen(result.invoice_total) : null;
  const discrepancy = invoiceTotalSen !== null && Math.abs(invoiceTotalSen - sumSen) > 1; // ±0.01 RM
  // duplicate detection (§6.1, F11)
  const dup = await detectDuplicate(db, invoiceId);
  await db('invoices').where({ id: invoiceId }).update({
    supplier_id: await resolveSupplier(db, result.supplier_name),
    invoice_number: result.invoice_number ?? null,
    invoice_date: result.invoice_date ?? null,
    invoice_total: result.invoice_total != null ? Number(senToDb(invoiceTotalSen)) : null,
    detected_language: result.detected_language,
    status: 'in_review', review_round: round,
    discrepancy_flag: discrepancy, duplicate_flag: dup.isDuplicate,
    updated_at: nowIso(),
  });
  log.info(EV.INVOICE_STATE, { invoice_id: invoiceId, meta: { from: 'draft', to: 'in_review', round, discrepancy } });
  if (dup.isDuplicate) log.warn(EV.INVOICE_DUPLICATE, { invoice_id: invoiceId, meta: { of: dup.of } });
  if (discrepancy) log.warn(EV.INVOICE_DISCREPANCY, { invoice_id: invoiceId, meta: { invoiceTotal: result.invoice_total, sum: sumSen / 100 } });
  await audit(db, { eventType: 'invoice.extracted', actorType: 'ai', entityType: 'invoice', entityId: invoiceId, action: 'extract', meta: { items: rows.length, round, model: result._model ?? 'mock' } });
  return { invoiceId, flagged: flagged.length, discrepancy, dup };
}

async function resolveSupplier(db, supplierName) {
  if (!supplierName) return null;
  const s = await db('stores').whereRaw('lower(name) = lower(?)', [supplierName]).first();
  if (s) return s.id;
  const ts = nowIso();
  const [id] = await db('stores').insert({ name: supplierName, kind: 'both', aliases: '[]', trip_cost: 0, min_savings_threshold: 0, is_active: true, version: 0, created_at: ts, updated_at: ts }).returning('id');
  return typeof id === 'object' ? id.id : id;
}

export async function detectDuplicate(db, invoiceId) {
  const inv = await db('invoices').where({ id: invoiceId }).first();
  if (inv.invoice_number && inv.invoice_date) {
    const same = await db('invoices').where({ branch_id: inv.branch_id, invoice_number: inv.invoice_number, invoice_date: inv.invoice_date }).whereNot({ id: invoiceId }).first();
    if (same) return { isDuplicate: true, of: same.id, reason: 'number+date' };
  }
  if (inv.file_id) {
    const file = await db('files').where({ id: inv.file_id }).first();
    if (file) {
      const sameHash = await db('files as f').join('invoices as i', 'i.file_id', 'f.id')
        .where({ 'f.sha256': file.sha256 }).whereNot({ 'i.id': invoiceId }).first();
      if (sameHash) return { isDuplicate: true, of: sameHash.id, reason: 'image_hash' };
    }
  }
  if (inv.invoice_total != null && inv.invoice_date) {
    const similar = await db('invoices').where({ branch_id: inv.branch_id, invoice_date: inv.invoice_date, invoice_total: inv.invoice_total })
      .whereNot({ id: invoiceId }).whereNotNull('invoice_total').first();
    if (similar) return { isDuplicate: true, of: similar.id, reason: 'date+total' };
  }
  return { isDuplicate: false, of: null };
}

// ---------- review report rendering (§5.3) ----------
export async function buildReviewData(db, invoiceId) {
  const inv = await db('invoices as i')
    .leftJoin('stores as s', 's.id', 'i.supplier_id')
    .leftJoin('branches as br', 'br.id', 'i.branch_id')
    .where('i.id', invoiceId)
    .first('i.*', 's.name as supplier_name', 'br.name_en as branch_name');
  const items = await db('invoice_items').where({ invoice_id: invoiceId }).orderBy('line_no');
  const out = { invoice: inv, items, flagged: [], matched: [], excess: [], newProducts: [] };
  for (const it of items) {
    if (it.review_symbol && b(it.needs_review)) out.flagged.push(it);
    if (it.is_excess) out.excess.push(it);
    if (b(it.is_new_product) && !it.product_id) out.newProducts.push(it);
    if (it.matched_request_item_id) out.matched.push(it);
  }
  return out;
}

// ---------- corrections (F5, §5.4, D-S17) ----------
const FIELD_ALIASES = { qty: 'quantity', quantity: 'quantity', price: 'unit_price', unit_price: 'unit_price', name: 'name', unit: 'unit', discount: 'discount', tax: 'tax', category: 'category' };

export function parseCorrectionDeterministic(text) {
  const m = String(text).trim().match(/^\(?([A-Za-z])\)?\s*[:\-]\s*(\w+)\s*(?:=|:|is|to|→)?\s*(.+)$/);
  if (!m) return null;
  const field = FIELD_ALIASES[m[2].toLowerCase()];
  if (!field) return null;
  return { symbol: m[1].toUpperCase(), field, value: m[3].trim(), intent: 'correction' };
}

export async function applyCorrection(ctx, invoiceId, { symbol, field, value }, actor) {
  const db = ctx.db;
  const inv = await db('invoices').where({ id: invoiceId }).first();
  const item = await db('invoice_items').where({ invoice_id: invoiceId, review_symbol: String(symbol).toUpperCase() }).first();
  if (!item) return { ok: false, reason: 'symbol_not_found' };
  if (inv.status !== 'in_review') return { ok: false, reason: 'not_editable' };
  const patch = {};
  if (field === 'quantity') patch.quantity = Number(value);
  else if (field === 'unit_price') { const sen = toSen(value); if (sen === null) return { ok: false, reason: 'bad_value' }; patch.unit_price = Number(senToDb(sen)); patch.line_total = Number(senToDb(computeLineTotalSen(Number(item.quantity), sen, toSen(item.discount) ?? 0, toSen(item.tax) ?? 0))); }
  else if (field === 'name') { patch.name_original = value; patch.name_normalized = value; const m = await (await import('./matching.js')).matchProduct(db, { nameOriginal: value, nameNormalized: value }); if (!m.needsReview && !m.isNew) patch.product_id = m.productId; }
  else if (field === 'unit') patch.unit_text = value;
  else if (field === 'discount') { const sen = toSen(value); if (sen === null) return { ok: false, reason: 'bad_value' }; patch.discount = Number(senToDb(sen)); patch.line_total = Number(senToDb(computeLineTotalSen(Number(item.quantity), toSen(item.unit_price) ?? 0, sen, toSen(item.tax) ?? 0))); }
  else if (field === 'tax') { const sen = toSen(value); if (sen === null) return { ok: false, reason: 'bad_value' }; patch.tax = Number(senToDb(sen)); patch.line_total = Number(senToDb(computeLineTotalSen(Number(item.quantity), toSen(item.unit_price) ?? 0, toSen(item.discount) ?? 0, sen))); }
  else if (field === 'category') { const cat = await db('expense_categories').whereRaw('lower(name_en) = lower(?)', [value]).first(); if (!cat) return { ok: false, reason: 'bad_category' }; patch.category_id = cat.id; }
  const res = await updateWithVersion(db, 'invoice_items', item.id, item.version, patch, { eventType: 'invoice.item_corrected', actorType: 'user', actorId: actor.id });
  if (!res.ok) return { ok: false, reason: 'conflict' };
  if (field === 'quantity') { const sen = toSen(item.unit_price) ?? 0; await db('invoice_items').where({ id: item.id }).update({ line_total: Number(senToDb(computeLineTotalSen(Number(value), sen, toSen(item.discount) ?? 0, toSen(item.tax) ?? 0))) }); }
  await audit(db, { eventType: 'invoice.item_corrected', actorType: 'user', actorId: actor.id, entityType: 'invoice_item', entityId: item.id, action: 'correct', before: { [field]: item[field] }, after: { [field]: value } });
  return { ok: true, item: await db('invoice_items').where({ id: item.id }).first() };
}

export async function confirmItem(ctx, invoiceId, symbol, actor) {
  const db = ctx.db;
  const item = await db('invoice_items').where({ invoice_id: invoiceId, review_symbol: String(symbol).toUpperCase() }).first();
  if (!item) return { ok: false, reason: 'symbol_not_found' };
  const res = await updateWithVersion(db, 'invoice_items', item.id, item.version, { needs_review: false }, { eventType: 'invoice.item_confirmed', actorType: 'user', actorId: actor.id });
  return res.ok ? { ok: true } : { ok: false, reason: 'conflict' };
}

// ---------- approval transaction (F6, §5.5, §2.5) ----------
export async function approveInvoice(ctx, { invoiceId, actor, expectedVersion, note = null }) {
  const db = ctx.db;
  const inv = await db('invoices').where({ id: invoiceId }).first();
  if (!inv) return { ok: false, reason: 'not_found' };
  if (inv.status === 'approved') return { ok: false, reason: 'conflict' }; // already approved by a concurrent actor
  if (inv.status !== 'in_review') return { ok: false, reason: `bad_status:${inv.status}` };
  const unresolved = await db('invoice_items').where({ invoice_id: invoiceId, needs_review: true }).count({ c: 'id' }).first();
  if (Number(unresolved?.c ?? 0) > 0) return { ok: false, reason: 'unresolved_items' };
  if (b(inv.discrepancy_flag) && !note && !inv.discrepancy_note) return { ok: false, reason: 'discrepancy_unexplained' };

  const result = await db.transaction(async (trx) => {
    const upd = await trx('invoices').where({ id: invoiceId, version: inv.version })
      .update({ status: 'approved', approved_by: actor.id, approved_at: nowIso(), discrepancy_note: note ?? inv.discrepancy_note, version: inv.version + 1, updated_at: nowIso() });
    if (upd === 0) throw Object.assign(new Error('conflict'), { conflict: true, handled: true });
    const items = await trx('invoice_items').where({ invoice_id: invoiceId });
    for (const it of items) {
      let productId = it.product_id;
      if (!productId) {
        // new product approved (§6.3): create with original name as first alias
        const ts = nowIso();
        const [pid] = await trx('products').insert({
          name_en: it.name_normalized, name_local: it.name_original, aliases: JSON.stringify([it.name_original]),
          category_id: it.category_id, quality_status: 'active', is_active: true, version: 0, created_at: ts, updated_at: ts,
        }).returning('id');
        productId = typeof pid === 'object' ? pid.id : pid;
        await trx('invoice_items').where({ id: it.id }).update({ product_id: productId });
      }
      await trx('approved_purchases').insert({
        invoice_id: invoiceId, invoice_item_id: it.id, branch_id: inv.branch_id, product_id: productId,
        store_id: inv.supplier_id, quantity: it.quantity, unit_id: it.unit_id,
        unit_price: it.unit_price, line_total: it.line_total,
        request_item_id: it.matched_request_item_id, is_excess: b(it.is_excess),
        is_reversal: false, purchased_at: nowIso(),
      });
      // update requests: partial/fulfilled (§8.2/8.3)
      if (it.matched_request_item_id) {
        const ri = await trx('request_items').where({ id: it.matched_request_item_id }).first();
        const newPurchased = Number(ri.purchased_qty) + Number(it.quantity);
        const newStatus = newPurchased >= Number(ri.quantity) ? 'purchased' : 'partially';
        const ru = await trx('request_items').where({ id: ri.id, version: ri.version })
          .update({ purchased_qty: newPurchased, status: newStatus, version: ri.version + 1, updated_at: nowIso() });
        if (ru === 0) throw Object.assign(new Error('request conflict'), { conflict: true });
        if (newStatus === 'purchased') {
          await trx('requests').where({ id: ri.request_id }).whereNotIn('status', ['cancelled', 'deferred']).update({ status: 'partially_fulfilled', updated_at: nowIso() });
          const openLeft = await trx('request_items').where({ request_id: ri.request_id }).whereIn('status', ['open', 'partially']).count({ c: 'id' }).first();
          if (Number(openLeft?.c ?? 0) === 0) await trx('requests').where({ id: ri.request_id }).update({ status: 'fulfilled', updated_at: nowIso() });
        }
      }
    }
    await audit(trx, { eventType: EV.INVOICE_APPROVED, actorType: 'user', actorId: actor.id, entityType: 'invoice', entityId: invoiceId, action: 'approve', before: { status: 'in_review', version: inv.version }, after: { status: 'approved', version: inv.version + 1 } });
    return { approved: items.length };
  }).catch((e) => {
    if (e?.conflict) return { conflict: true };
    throw e;
  });
  if (result.conflict) return { ok: false, reason: 'conflict' };
  log.info(EV.INVOICE_APPROVED, { invoice_id: invoiceId, user_id: String(actor.id), status: 'success', meta: result });
  return { ok: true, ...result };
}

export async function rejectInvoice(ctx, { invoiceId, actor, reason }) {
  const db = ctx.db;
  const inv = await db('invoices').where({ id: invoiceId }).first();
  if (!inv || inv.status !== 'in_review') return { ok: false, reason: 'bad_status' };
  const res = await updateWithVersion(db, 'invoices', invoiceId, inv.version, { status: 'rejected' }, { eventType: EV.INVOICE_REJECTED, actorType: 'user', actorId: actor.id });
  if (res.ok) await audit(db, { eventType: EV.INVOICE_REJECTED, actorType: 'user', actorId: actor.id, entityType: 'invoice', entityId: invoiceId, action: 'reject', meta: { reason } });
  return { ok: res.ok, reason: res.ok ? null : 'conflict' };
}

// ---------- post-approval amendment (Q2: accountant/owner only — reversing + new rows) ----------
export async function amendApprovedInvoice(ctx, { invoiceId, actor, corrections }) {
  const db = ctx.db;
  const inv = await db('invoices').where({ id: invoiceId }).first();
  if (!inv || inv.status !== 'approved') return { ok: false, reason: 'bad_status' };
  const res = await db.transaction(async (trx) => {
    for (const c of corrections) {
      const orig = await trx('approved_purchases').where({ invoice_item_id: c.invoiceItemId, is_reversal: false }).first();
      if (!orig) throw new Error(`approved purchase for item ${c.invoiceItemId} not found`);
      await trx('approved_purchases').insert({
        invoice_id: orig.invoice_id, invoice_item_id: orig.invoice_item_id, branch_id: orig.branch_id, product_id: orig.product_id,
        store_id: orig.store_id, quantity: orig.quantity, unit_id: orig.unit_id, unit_price: orig.unit_price,
        line_total: orig.line_total, request_item_id: orig.request_item_id, is_excess: orig.is_excess,
        is_reversal: true, purchased_at: nowIso(),
      });
      const newQty = c.quantity ?? Number(orig.quantity);
      const newPriceSen = c.unitPrice != null ? toSen(c.unitPrice) : toSen(orig.unit_price);
      const totalSen = computeLineTotalSen(newQty, newPriceSen, 0, 0);
      await trx('approved_purchases').insert({
        invoice_id: invoiceId, invoice_item_id: c.invoiceItemId, branch_id: orig.branch_id, product_id: orig.product_id,
        store_id: orig.store_id, quantity: newQty, unit_id: orig.unit_id, unit_price: Number(senToDb(newPriceSen)),
        line_total: Number(senToDb(totalSen)), request_item_id: orig.request_item_id, is_excess: orig.is_excess,
        is_reversal: false, purchased_at: nowIso(),
      });
    }
    await audit(trx, { eventType: 'invoice.amended', actorType: 'user', actorId: actor.id, entityType: 'invoice', entityId: invoiceId, action: 'amend', meta: { corrections } });
    return { ok: true };
  });
  return res;
}
