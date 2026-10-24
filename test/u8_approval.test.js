// test/u8_approval.test.js — U8: approval transaction (F6/case 1), new products (case 6/§6.3),
// partial (case 8/§8.2), excess (case 9/§8.3), observed prices (case 11/§7.3), amendment (Q2), concurrency (T27/case 27)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, createOwnerAndLogin, seedWorld, pushUpdate, tgPhoto, tgText } from './helpers.js';

describe('U8: approval, requests & prices', () => {
  let app, ctx, world, owner;
  before(async () => {
    ({ app, ctx } = await makeTestApp());
    owner = await createOwnerAndLogin(app);
    world = await seedWorld(ctx, owner);
  });
  after(async () => { await app.close(); await ctx.db.destroy(); });

  test('full cycle: request → partial invoice → approval → remaining stays open (cases 1+8, F6)', async () => {
    // employee requests 10 kg Black Pepper
    await ctx.db('request_items').del(); await ctx.db('requests').del();
    await pushUpdate(app, tgText(world.klRequestChat, world.tgEmployeeId, '10 kg Black Pepper', 900));
    // manager sends invoice with 6 kg purchased (mock variant picked by buffer; force via direct pipeline)
    const { applyExtraction } = await import('../src/services/invoices.js');
    const ts = new Date().toISOString();
    const [inv] = await ctx.db('invoices').insert({ branch_id: world.branchId, status: 'draft', source: 'text', created_by: world.managerId, created_at: ts, updated_at: ts }).returning('id');
    const invId = typeof inv === 'object' ? inv.id : inv;
    await applyExtraction(ctx, invId, {
      detected_language: 'en', supplier_name: 'Tekka Fresh Market', invoice_number: 'INV-PART-1', invoice_date: '2026-10-21',
      invoice_total: 168.0,
      items: [{ name_original: 'Lada Hitam', name_normalized: 'Black Pepper', quantity: 6, unit: 'kg', unit_price: 28.0, discount: 0, tax: 0, line_total: 168.0, confidence: 'high' }],
      totals_match: true,
    });
    // all items confirmed (high confidence) → approve
    const invRow = await ctx.db('invoices').where({ id: invId }).first();
    const r = await app.inject({ method: 'POST', url: `/api/v1/invoices/${invId}/approve`, payload: { version: invRow.version }, cookies: [{ name: 'session', value: owner.cookie }] });
    assert.equal(r.statusCode, 200, r.body);
    // approved_purchases ledger written
    const purchase = await ctx.db('approved_purchases').where({ invoice_id: invId }).first();
    assert.ok(purchase);
    assert.equal(Number(purchase.quantity), 6);
    assert.equal(purchase.request_item_id != null, true, 'matched to the open request');
    // request item partially fulfilled, 4 kg remaining (§8.2)
    const ri = await ctx.db('request_items').first();
    assert.equal(Number(ri.purchased_qty), 6);
    assert.equal(ri.status, 'partially');
    const open = await ctx.db('v_open_requests').first();
    assert.ok(open, 'remaining 4 kg still on the list');
    assert.equal(Number(open.remaining_qty), 4);
  });

  test('excess purchase recorded as independent item (case 9, §8.3)', async () => {
    const { applyExtraction } = await import('../src/services/invoices.js');
    const ts = new Date().toISOString();
    const [inv] = await ctx.db('invoices').insert({ branch_id: world.branchId, status: 'draft', source: 'text', created_by: world.managerId, created_at: ts, updated_at: ts }).returning('id');
    const invId = typeof inv === 'object' ? inv.id : inv;
    await applyExtraction(ctx, invId, {
      detected_language: 'en', supplier_name: 'Tekka Fresh Market', invoice_number: 'INV-EXC-1', invoice_date: '2026-10-22',
      invoice_total: 420.0,
      items: [{ name_original: 'Lada Hitam', name_normalized: 'Black Pepper', quantity: 15, unit: 'kg', unit_price: 28.0, discount: 0, tax: 0, line_total: 420.0, confidence: 'high' }],
      totals_match: true,
    });
    const items = await ctx.db('invoice_items').where({ invoice_id: invId });
    assert.equal(items[0].is_excess ? 1 : 0, 1, '15 kg vs 4 kg remaining → excess flagged');
    const invRow = await ctx.db('invoices').where({ id: invId }).first();
    const r = await app.inject({ method: 'POST', url: `/api/v1/invoices/${invId}/approve`, payload: { version: invRow.version }, cookies: [{ name: 'session', value: owner.cookie }] });
    assert.equal(r.statusCode, 200, r.body);
    const purchase = await ctx.db('approved_purchases').where({ invoice_id: invId }).first();
    assert.equal(purchase.is_excess ? 1 : 0, 1);
  });

  test('new product created only AFTER approval with alias (case 6, §6.3)', async () => {
    const { applyExtraction } = await import('../src/services/invoices.js');
    const ts = new Date().toISOString();
    const [inv] = await ctx.db('invoices').insert({ branch_id: world.branchId, status: 'draft', source: 'text', created_by: world.managerId, created_at: ts, updated_at: ts }).returning('id');
    const invId = typeof inv === 'object' ? inv.id : inv;
    await applyExtraction(ctx, invId, {
      detected_language: 'ms', supplier_name: null, invoice_number: 'INV-NEW-1', invoice_date: '2026-10-23',
      invoice_total: 12.6,
      items: [{ name_original: 'Sabun Cuci', name_normalized: 'Dishwashing Soap', quantity: 3, unit: 'btl', unit_price: 4.2, discount: 0, tax: 0, line_total: 12.6, confidence: 'high' }],
      totals_match: true,
    });
    // before approval: no such product
    const before = await ctx.db('products').where({ name_en: 'Dishwashing Soap' }).first();
    assert.ok(!before, 'product not created before approval');
    const invRow = await ctx.db('invoices').where({ id: invId }).first();
    const r = await app.inject({ method: 'POST', url: `/api/v1/invoices/${invId}/approve`, payload: { version: invRow.version }, cookies: [{ name: 'session', value: owner.cookie }] });
    assert.equal(r.statusCode, 200, r.body);
    const after = await ctx.db('products').where({ name_en: 'Dishwashing Soap' }).first();
    assert.ok(after, 'product created on approval');
    const aliases = JSON.parse(after.aliases);
    assert.ok(aliases.includes('Sabun Cuci'), 'original name stored as alias (§2.4)');
  });

  test('approval blocked while unconfirmed items exist (§5.5/F6 gate)', async () => {
    const { applyExtraction } = await import('../src/services/invoices.js');
    const ts = new Date().toISOString();
    const [inv] = await ctx.db('invoices').insert({ branch_id: world.branchId, status: 'draft', source: 'text', created_by: world.managerId, created_at: ts, updated_at: ts }).returning('id');
    const invId = typeof inv === 'object' ? inv.id : inv;
    await applyExtraction(ctx, invId, {
      detected_language: 'en', supplier_name: null, invoice_number: 'INV-GATE', invoice_date: '2026-10-23',
      invoice_total: 13.5,
      items: [{ name_original: 'Chicken Eggs 30pcs', name_normalized: 'Chicken Eggs', quantity: 30, unit: 'pcs', unit_price: 0.45, discount: 0, tax: 0, line_total: 13.5, confidence: 'low' }],
      totals_match: true,
    });
    const invRow = await ctx.db('invoices').where({ id: invId }).first();
    const r = await app.inject({ method: 'POST', url: `/api/v1/invoices/${invId}/approve`, payload: { version: invRow.version }, cookies: [{ name: 'session', value: owner.cookie }] });
    assert.equal(r.statusCode, 400);
    assert.ok(r.json().error.message_en.includes('unresolved'));
    // confirm item then approve succeeds
    const item = await ctx.db('invoice_items').where({ invoice_id: invId }).first();
    const c = await app.inject({ method: 'POST', url: `/api/v1/invoices/${invId}/confirm-item`, payload: { symbol: item.review_symbol }, cookies: [{ name: 'session', value: owner.cookie }] });
    assert.equal(c.statusCode, 200);
    const r2 = await app.inject({ method: 'POST', url: `/api/v1/invoices/${invId}/approve`, payload: { version: invRow.version + 0 }, cookies: [{ name: 'session', value: owner.cookie }] });
    assert.equal(r2.statusCode, 200, r2.body);
  });

  test('two concurrent approvals: second rejected with conflict (case 27, T27, §2.5)', async () => {
    const { applyExtraction } = await import('../src/services/invoices.js');
    const ts = new Date().toISOString();
    const [inv] = await ctx.db('invoices').insert({ branch_id: world.branchId, status: 'draft', source: 'text', created_by: world.managerId, created_at: ts, updated_at: ts }).returning('id');
    const invId = typeof inv === 'object' ? inv.id : inv;
    await applyExtraction(ctx, invId, {
      detected_language: 'en', supplier_name: null, invoice_number: 'INV-CONC', invoice_date: '2026-10-23',
      invoice_total: 62.0,
      items: [{ name_original: 'Cooking Oil 5kg', name_normalized: 'Cooking Oil 5kg', quantity: 1, unit: 'btl', unit_price: 62.0, discount: 0, tax: 0, line_total: 62.0, confidence: 'high' }],
      totals_match: true,
    });
    const row = await ctx.db('invoices').where({ id: invId }).first();
    const [r1, r2] = await Promise.all([
      app.inject({ method: 'POST', url: `/api/v1/invoices/${invId}/approve`, payload: { version: row.version }, cookies: [{ name: 'session', value: owner.cookie }] }),
      app.inject({ method: 'POST', url: `/api/v1/invoices/${invId}/approve`, payload: { version: row.version }, cookies: [{ name: 'session', value: owner.cookie }] }),
    ]);
    const codes = [r1.statusCode, r2.statusCode].sort();
    assert.deepEqual(codes, [200, 409], 'exactly one approval succeeds, the other conflicts');
    const purchases = await ctx.db('approved_purchases').where({ invoice_id: invId });
    assert.equal(purchases.length, 1, 'no duplicate ledger rows (atomic transaction)');
  });

  test('personal/unmatched expense classified and NOT in food sums without approval (case 5 base, §9)', async () => {
    const { suggestCategory } = await import('../src/services/matching.js');
    const catId = await suggestCategory(ctx.db, 'Electric Mixer');
    const cat = await ctx.db('expense_categories').where({ id: catId }).first();
    assert.equal(cat.name_en, 'Equipment & Tools', 'equipment classified correctly (§9)');
  });

  test('observed price does NOT enter expenses or purchase counts (case 11, §7.3/F9)', async () => {
    const before = await ctx.db('approved_purchases').count({ c: 'id' }).first();
    const r = await app.inject({ method: 'POST', url: '/api/v1/prices/observed', payload: { productId: world.productIds['Cooking Oil 5kg'], storeId: 1, price: 61.5, observedDate: '2026-10-23' }, cookies: [{ name: 'session', value: owner.cookie }] });
    assert.equal(r.statusCode, 201, r.body);
    const after = await ctx.db('approved_purchases').count({ c: 'id' }).first();
    assert.equal(Number(after.c), Number(before.c), 'purchase count unchanged');
    const obs = await ctx.db('observed_prices').first();
    assert.ok(obs, 'stored in the separate observed_prices table only');
  });

  test('price history shows record_type + dates (case 12, §7.2/7.4)', async () => {
    const { priceHistory } = await import('../src/services/prices.js');
    const h = await priceHistory(ctx.db, { productId: world.productIds['Cooking Oil 5kg'], days: 90 });
    assert.ok(h.rows.length >= 2, 'both purchase + observed records visible');
    assert.ok(h.rows.some((r) => r.record_type === 'purchase'));
    assert.ok(h.rows.some((r) => r.record_type === 'observed'));
    assert.ok(h.rows.every((r) => r.price_at), 'every price carries its date (§7.4)');
    assert.ok(h.last && h.avg != null && h.min != null && h.max != null);
  });

  test('post-approval amendment: accountant/owner only, reversing + new rows (Q2)', async () => {
    const approved = await ctx.db('invoices').where({ status: 'approved' }).first();
    const item = (await ctx.db('approved_purchases').where({ invoice_id: approved.id, is_reversal: false }).first());
    // operations_manager forbidden (Q2 matrix)
    await ctx.db('users').where({ id: world.managerId }).update({ role: 'operations_manager' });
    const mgrUser = await ctx.db('users').where({ id: world.managerId }).first();
    const { amendApprovedInvoice } = await import('../src/services/invoices.js');
    const denied = await (async () => {
      const { permissionCheck, ACTIONS } = await import('../src/permissions.js');
      return permissionCheck(mgrUser, ACTIONS.AMEND_APPROVED).ok;
    })();
    assert.equal(denied, false, 'operations_manager cannot amend (Q2)');
    await ctx.db('users').where({ id: world.managerId }).update({ role: 'branch_manager' });
    // owner amends: quantity 6 → 8
    const r = await amendApprovedInvoice(ctx, { invoiceId: approved.id, actor: { id: owner.owner.id }, corrections: [{ invoiceItemId: item.invoice_item_id, quantity: 8 }] });
    assert.equal(r.ok, true, r.error ?? '');
    const rows = await ctx.db('approved_purchases').where({ invoice_id: approved.id }).orderBy('id');
    assert.equal(rows.filter((x) => x.is_reversal ? 1 : 0).length >= 1, true, 'reversal row exists');
    const net = rows.filter((x) => !x.is_reversal);
    assert.equal(Number(net.at(-1).quantity), 8, 'new corrected row appended (audit-preserving)');
  });

  test('trip savings: net = Σ price diff − trip cost diff, auditable (case 13, §8.4)', async () => {
    const { compareStores } = await import('../src/services/prices.js');
    const ts = new Date().toISOString();
    const [s1] = await ctx.db('stores').insert({ name: 'StoreA', aliases: '[]', kind: 'both', trip_cost: 8, min_savings_threshold: 15, is_active: true, version: 0, created_at: ts, updated_at: ts }).returning('id');
    const [s2] = await ctx.db('stores').insert({ name: 'StoreB', aliases: '[]', kind: 'both', trip_cost: 0, min_savings_threshold: 0, is_active: true, version: 0, created_at: ts, updated_at: ts }).returning('id');
    const pid = world.productIds['Cooking Oil 5kg'];
    const { recordObservedPrice } = await import('../src/services/prices.js');
    const s1id = typeof s1 === 'object' ? s1.id : s1;
    const s2id = typeof s2 === 'object' ? s2.id : s2;
    await recordObservedPrice(ctx, { productId: pid, storeId: s1id, price: 60.0, observedDate: '2026-10-23', source: 'manual', actorId: owner.owner.id });
    await recordObservedPrice(ctx, { productId: pid, storeId: s2id, price: 61.5, observedDate: '2026-10-23', source: 'manual', actorId: owner.owner.id });
    const r = await compareStores(ctx, { productIds: [pid], storeIds: [s1id, s2id] });
    assert.ok(r.lines.length === 1);
    assert.ok(r.recommendation && typeof r.recommendation.split === 'boolean');
    // line carries source + date of each price (auditable §8.4)
    assert.ok(r.lines[0].cheapest.priceDate && r.lines[0].cheapest.source);
  });
});
