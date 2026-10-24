// src/services/requests.js — request intake/modifications (§4.4), aggregation (§8.1), partial/excess (§8.2/8.3)
import { nowIso, jsonOf, b } from '../util.js';
import { audit, updateWithVersion } from '../audit.js';
import { log } from '../logging.js';

// deterministic request text parser: "5 kg flour" | "flour 5 kg" | "add 2 kg flour" | "cancel flour"
export function parseRequestText(text) {
  const t = String(text).trim();
  let m = t.match(/^add\s+(\d+(?:\.\d+)?)\s*([a-zA-Z\u0600-\u06FF]*)?\s*(?:of\s+)?(.+)$/i) || t.match(/^أضف?\s*(\d+(?:\.\d+)?)\s*(\S+)?\s*(?:من\s+)?(.+)$/);
  if (m) return { intent: 'add', qty: Number(m[1]), unit: m[2] || null, product: m[3].trim() };
  m = t.match(/^cancel\s+(.+)$/i) || t.match(/^إلغاء\s+(.+)$/);
  if (m) return { intent: 'cancel', product: m[1].trim() };
  m = t.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z\u0600-\u06FF]*)\s*(?:of\s+|من\s+)?(.+)$/);
  if (m) return { intent: 'new', qty: Number(m[1]), unit: m[2] || null, product: m[3].trim() };
  m = t.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s*([a-zA-Z\u0600-\u06FF]+)$/);
  if (m) return { intent: 'new', qty: Number(m[2]), unit: m[3], product: m[1].trim() };
  return { intent: 'unclear', product: t };
}

async function resolveUnit(db, unitText) {
  if (!unitText) return null;
  const u = await db('units').whereRaw('lower(short_name) = lower(?)', [unitText]).first()
    || await db('units').whereRaw('lower(name) = lower(?)', [unitText]).first();
  return u?.id ?? null;
}

export async function handleRequestMessage(ctx, { chatId, user, branch, text, messageId }) {
  const db = ctx.db;
  const parsed = parseRequestText(text);
  if (parsed.intent === 'unclear') return { ok: false, reason: 'ambiguous' };

  const { matchProduct } = await import('./matching.js');
  const m = await matchProduct(db, { nameOriginal: parsed.product, nameNormalized: parsed.product });
  if (m.isNew) return { ok: false, reason: 'product_unknown' };
  if (m.match === 'ambiguous') return { ok: false, reason: 'product_ambiguous', candidates: m.candidates };
  const product = await db('products').where({ id: m.productId }).first();

  // find an open request for this user+branch (latest)
  let request = await db('requests').where({ branch_id: branch.id, requested_by: user.id }).whereIn('status', ['open', 'partially_fulfilled']).orderBy('id', 'desc').first();
  if (!request) {
    const ts = nowIso();
    const [rid] = await db('requests').insert({ branch_id: branch.id, requested_by: user.id, status: 'open', needed_by: null, version: 0, created_at: ts, updated_at: ts }).returning('id');
    request = { id: typeof rid === 'object' ? rid.id : rid };
  }

  const openItems = await db('request_items as ri').join('products as p', 'p.id', 'ri.product_id')
    .where({ 'ri.request_id': request.id, 'ri.product_id': m.productId }).whereIn('ri.status', ['open', 'partially'])
    .select('ri.*').first();

  if (parsed.intent === 'cancel') {
    if (!openItems) return { ok: false, reason: 'nothing_to_cancel' };
    const res = await updateWithVersion(db, 'request_items', openItems.id, openItems.version, { status: 'cancelled' }, { eventType: 'request.item_cancelled', actorType: 'user', actorId: user.id });
    await addModification(db, openItems.id, 'cancel', { status: openItems.status }, { status: 'cancelled' }, text, messageId, user.id);
    return res.ok ? { ok: true, action: 'cancelled', product } : { ok: false, reason: 'conflict' };
  }

  if (openItems && parsed.intent === 'add') {
    const newQty = Number(openItems.quantity) + parsed.qty;
    const res = await updateWithVersion(db, 'request_items', openItems.id, openItems.version, { quantity: newQty }, { eventType: 'request.item_modified', actorType: 'user', actorId: user.id });
    await addModification(db, openItems.id, 'increment', { quantity: openItems.quantity }, { quantity: newQty }, text, messageId, user.id);
    return res.ok ? { ok: true, action: 'increment', product, oldQty: openItems.quantity, newQty } : { ok: false, reason: 'conflict' };
  }

  // new item
  const ts = nowIso();
  const [riid] = await db('request_items').insert({
    request_id: request.id, product_id: m.productId, quantity: parsed.qty,
    unit_id: await resolveUnit(db, parsed.unit), status: 'open', purchased_qty: 0,
    version: 0, created_at: ts, updated_at: ts,
  }).returning('id');
  const itemId = typeof riid === 'object' ? riid.id : riid;
  await addModification(db, itemId, 'create', null, { quantity: parsed.qty }, text, messageId, user.id);
  return { ok: true, action: 'created', product, qty: parsed.qty };
}

async function addModification(db, requestItemId, changeType, oldValue, newValue, rawMessage, telegramMessageId, userId) {
  await db('request_modifications').insert({
    request_item_id: requestItemId, change_type: changeType,
    old_value: oldValue ? JSON.stringify(oldValue) : null, new_value: newValue ? JSON.stringify(newValue) : null,
    raw_message: rawMessage ?? null, telegram_message_id: telegramMessageId ?? null,
    created_by: userId, created_at: nowIso(),
  });
}

// Shopping list aggregation (§8.1): preserve per-branch distribution
export async function aggregatedShoppingList(db) {
  const rows = await db('v_open_requests')
    .join('products as p', 'p.id', 'v_open_requests.product_id')
    .join('branches as br', 'br.id', 'v_open_requests.branch_id')
    .select('v_open_requests.*', 'p.name_en as product_name', 'br.name_en as branch_name', 'br.name_ar as branch_name_ar')
    .orderBy('v_open_requests.product_id');
  const byProduct = new Map();
  for (const r of rows) {
    const key = r.product_id;
    if (!byProduct.has(key)) byProduct.set(key, { product_id: key, product_name: r.product_name, total_remaining: 0, branches: [], late: false });
    const entry = byProduct.get(key);
    entry.total_remaining += Number(r.remaining_qty);
    entry.branches.push({ branch_id: r.branch_id, branch_name: r.branch_name, branch_name_ar: r.branch_name_ar, remaining: Number(r.remaining_qty), needed_by: r.needed_by });
    if (r.needed_by && r.needed_by < new Date().toISOString().slice(0, 10)) entry.late = true;
  }
  return [...byProduct.values()];
}

// Apply post-approval request reconciliation is handled inside approveInvoice transaction (F6).

export async function requestModificationHistory(db, requestItemId) {
  const rows = await db('request_modifications').where({ request_item_id: requestItemId }).orderBy('id');
  return rows.map((r) => ({ ...r, old_value: jsonOf(r.old_value), new_value: jsonOf(r.new_value) }));
}

export async function setRequestStatus(ctx, { requestId, status, actor }) {
  const r = await ctx.db('requests').where({ id: requestId }).first();
  if (!r) return { ok: false, reason: 'not_found' };
  const res = await updateWithVersion(ctx.db, 'requests', requestId, r.version, { status }, { eventType: 'request.status_changed', actorType: 'user', actorId: actor.id });
  if (status === 'cancelled' && res.ok) {
    await ctx.db('request_items').where({ request_id: requestId }).whereIn('status', ['open', 'partially']).update({ status: 'cancelled', updated_at: nowIso() });
  }
  return { ok: res.ok, reason: res.ok ? null : 'conflict' };
}

export async function lateRequests(db) {
  const today = new Date().toISOString().slice(0, 10);
  return db('v_open_requests').join('products as p', 'p.id', 'v_open_requests.product_id')
    .whereNotNull('needed_by').where('needed_by', '<', today).select('v_open_requests.*', 'p.name_en as product_name');
}
