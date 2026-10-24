// src/services/prices.js — observed prices (§7.3), history (§7.2/7.4), cross-store comparison with trip cost (§8.4)
import { toSen, senToDb, fromSen, nowIso, jsonOf } from '../util.js';
import { audit } from '../audit.js';

export async function recordObservedPrice(ctx, { productId, storeId, price, unitId = null, observedDate, source = 'manual', actorId }) {
  const priceSen = toSen(price);
  if (priceSen === null || priceSen <= 0) return { ok: false, reason: 'bad_price' };
  const [id] = await ctx.db('observed_prices').insert({
    product_id: productId, store_id: storeId, price: Number(senToDb(priceSen)),
    unit_id: unitId, observed_date: observedDate, source, created_by: actorId,
    version: 0, created_at: nowIso(), updated_at: nowIso(),
  }).returning('id');
  await audit(ctx.db, { eventType: 'price.observed', actorType: 'user', actorId, entityType: 'observed_price', entityId: typeof id === 'object' ? id.id : id, action: 'create', after: { price, productId, storeId } });
  return { ok: true, id: typeof id === 'object' ? id.id : id };
}

export async function priceHistory(db, { productId, storeId = null, days = 90 }) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  let q = db('v_price_history').where({ product_id: productId }).where('price_at', '>=', since.slice(0, 10));
  if (storeId) q = q.andWhere({ store_id: storeId });
  const rows = await q.orderBy('price_at', 'desc').limit(500);
  const prices = rows.map((r) => ({ ...r, price_sen: toSen(r.price), type: r.record_type }));
  if (prices.length === 0) return { rows: prices, last: null, avg: null, min: null, max: null };
  const sen = prices.map((p) => p.price_sen);
  return {
    rows: prices,
    last: prices[0],
    avg: fromSen(Math.round(sen.reduce((a, b2) => a + b2, 0) / sen.length)),
    min: fromSen(Math.min(...sen)),
    max: fromSen(Math.max(...sen)),
  };
}

// §8.4: savings AFTER trip cost, fully auditable (every price with date + source)
export async function compareStores(ctx, { productIds, storeIds }) {
  const db = ctx.db;
  const stores = await db('stores').whereIn('id', storeIds);
  const lines = [];
  for (const productId of productIds) {
    const product = await db('products').where({ id: productId }).first();
    const perStore = [];
    for (const store of stores) {
      const hist = await priceHistory(db, { productId, storeId: store.id, days: 60 });
      perStore.push({ storeId: store.id, storeName: store.name, last: hist.last, avg: hist.avg });
    }
    const withPrices = perStore.filter((s) => s.last);
    if (withPrices.length < 2) continue;
    const cheapest = withPrices.reduce((a, b2) => (toSen(b2.last.price) < toSen(a.last.price) ? b2 : a));
    const dearest = withPrices.reduce((a, b2) => (toSen(b2.last.price) > toSen(a.last.price) ? b2 : a));
    lines.push({
      product: { id: product.id, name: product.name_en },
      cheapest: { ...cheapest, priceDate: cheapest.last.price_at, source: cheapest.last.record_type },
      dearest: { ...dearest, priceDate: dearest.last.price_at, source: dearest.last.record_type },
      unitSavingSen: toSen(dearest.last.price) - toSen(cheapest.last.price),
    });
  }
  // net savings = Σ(unit diff × assumed qty=1 per product here) − trip cost difference
  const sumDiffSen = lines.reduce((a, l) => a + l.unitSavingSen, 0);
  const tripCosts = stores.map((s) => ({ storeId: s.id, name: s.name, tripCostSen: toSen(s.trip_cost) ?? 0, thresholdSen: toSen(s.min_savings_threshold) ?? 0 }));
  const maxTrip = Math.max(...tripCosts.map((t) => t.tripCostSen), 0);
  const minTrip = Math.min(...tripCosts.map((t) => t.tripCostSen), 0);
  const netSavingSen = sumDiffSen - (maxTrip - minTrip);
  const recommendation = netSavingSen >= 0
    ? { split: true, message: 'Savings exceed trip cost — splitting the list is beneficial.' }
    : { split: false, message: 'Savings do not exceed trip cost — consolidate in one store.' };
  return { lines, sumDiffSen, netSavingSen, tripCosts, recommendation }; // every line carries price date + source (§8.4 auditable)
}

export async function setTripSettings(ctx, { storeId, tripCost, minSavingsThreshold, actor }) {
  const store = await ctx.db('stores').where({ id: storeId }).first();
  if (!store) return { ok: false, reason: 'not_found' };
  const { updateWithVersion } = await import('../audit.js');
  const res = await updateWithVersion(ctx.db, 'stores', storeId, store.version, {
    trip_cost: Number(senToDb(toSen(tripCost) ?? 0)), min_savings_threshold: Number(senToDb(toSen(minSavingsThreshold) ?? 0)),
  }, { eventType: 'store.trip_settings', actorType: 'user', actorId: actor.id });
  return { ok: res.ok, reason: res.ok ? null : 'conflict' };
}
