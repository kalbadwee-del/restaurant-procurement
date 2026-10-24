// src/services/products.js — CRUD, unify (human decision), match candidates, quality notes (§7.1/§10.2)
import { nowIso, jsonOf } from '../util.js';
import { audit, updateWithVersion } from '../audit.js';

export async function createProduct(ctx, data, actor) {
  const ts = nowIso();
  const [id] = await ctx.db('products').insert({
    name_en: data.name_en, name_local: data.name_local ?? null,
    aliases: JSON.stringify(data.aliases ?? []), brand_id: data.brand_id ?? null, unit_id: data.unit_id ?? null,
    size_text: data.size_text ?? null, weight: data.weight ?? null, category_id: data.category_id ?? null,
    quality_status: 'active', is_active: true, version: 0, created_at: ts, updated_at: ts,
  }).returning('id');
  const pid = typeof id === 'object' ? id.id : id;
  await audit(ctx.db, { eventType: 'product.created', actorType: 'user', actorId: actor.id, entityType: 'product', entityId: pid, action: 'create', after: data });
  return pid;
}

export async function updateProduct(ctx, productId, expectedVersion, patch, actor) {
  const res = await updateWithVersion(ctx.db, 'products', productId, expectedVersion, patch, { eventType: 'product.updated', actorType: 'user', actorId: actor.id });
  return { ok: res.ok, reason: res.ok ? null : 'conflict' };
}

export async function searchProducts(db, q) {
  const term = String(q ?? '').toLowerCase().trim();
  let query = db('products as p')
    .leftJoin('brands as b', 'b.id', 'p.brand_id')
    .leftJoin('units as u', 'u.id', 'p.unit_id')
    .leftJoin('expense_categories as c', 'c.id', 'p.category_id')
    .where({ 'p.is_active': true })
    .select('p.*', 'b.name as brand_name', 'u.short_name as unit_short', 'c.name_en as category_name');
  if (term) {
    query = query.andWhere((w) =>
      w.whereRaw('lower(p.name_en) like ?', [`%${term}%`])
        .orWhereRaw('lower(coalesce(p.name_local,\'\')) like ?', [`%${term}%`])
        .orWhereRaw('lower(coalesce(p.aliases,\'\')) like ?', [`%${term}%`]));
  }
  const rows = await query.orderBy('p.name_en').limit(200);
  return rows.map((r) => ({ ...r, aliases: jsonOf(r.aliases) ?? [] }));
}

export async function matchCandidates(db) {
  // products whose names are near-duplicates (fuzzy) → human unify decision (§10.2)
  const { loadCatalog, matchInCatalog } = await import('./matching.js');
  const catalog = await loadCatalog(db);
  const pairs = [];
  for (const p of catalog) {
    const m = matchInCatalog(catalog.filter((x) => x.id !== p.id), { nameOriginal: p.nameLocal ?? '', nameNormalized: p.nameEn });
    if ((m.match === 'fuzzy' || m.match === 'ambiguous') && m.candidates.length) {
      for (const c of m.candidates) {
        const pairKey = [p.id, c.id].sort((a, b) => a - b).join(':');
        if (!pairs.some((x) => x.key === pairKey)) pairs.push({ key: pairKey, a: p.id, b: c.id, score: c.score });
      }
    }
  }
  const full = [];
  for (const pr of pairs) {
    const [a, b] = await Promise.all([catalog.find((x) => x.id === pr.a), catalog.find((x) => x.id === pr.b)]);
    full.push({ ...pr, aName: a?.nameEn, bName: b?.nameEn });
  }
  return full;
}

export async function unifyProducts(ctx, { keepId, mergeIds, actor }) {
  const db = ctx.db;
  return db.transaction(async (trx) => {
    const keep = await trx('products').where({ id: keepId }).first();
    if (!keep) throw new Error('keep product not found');
    const keepAliases = jsonOf(keep.aliases) ?? [];
    for (const mergeId of mergeIds) {
      if (mergeId === keepId) continue;
      const other = await trx('products').where({ id: mergeId }).first();
      if (!other) continue;
      const otherAliases = jsonOf(other.aliases) ?? [];
      const merged = [...new Set([other.name_en, other.name_local, ...otherAliases, ...keepAliases].filter(Boolean))];
      const ku = await trx('products').where({ id: keepId, version: keep.version }).update({ aliases: JSON.stringify(merged), version: keep.version + 1, updated_at: nowIso() });
      if (ku === 0) throw Object.assign(new Error('conflict'), { conflict: true });
      // move references then deactivate duplicate — never delete financial rows
      await trx('invoice_items').where({ product_id: mergeId }).update({ product_id: keepId });
      await trx('request_items').where({ product_id: mergeId }).update({ product_id: keepId });
      await trx('approved_purchases').where({ product_id: mergeId }).update({ product_id: keepId });
      await trx('observed_prices').where({ product_id: mergeId }).update({ product_id: keepId });
      await trx('product_quality_notes').where({ product_id: mergeId }).update({ product_id: keepId });
      await trx('products').where({ id: mergeId }).update({ is_active: false, updated_at: nowIso() });
      await audit(trx, { eventType: 'product.unified', actorType: 'user', actorId: actor.id, entityType: 'product', entityId: keepId, action: 'unify', meta: { mergedId: mergeId } });
    }
    return { ok: true };
  });
}

export async function addQualityNote(ctx, { productId, note, noteDate, actor }) {
  const [id] = await ctx.db('product_quality_notes').insert({
    product_id: productId, note, note_date: noteDate ?? new Date().toISOString().slice(0, 10), created_by: actor.id, created_at: nowIso(),
  }).returning('id');
  return typeof id === 'object' ? id.id : id;
}

export async function setExcluded(ctx, { productId, excluded, actor }) {
  const p = await ctx.db('products').where({ id: productId }).first();
  const res = await updateWithVersion(ctx.db, 'products', productId, p.version, { quality_status: excluded ? 'excluded' : 'active' }, { eventType: 'product.quality_status', actorType: 'user', actorId: actor.id });
  return { ok: res.ok };
}
