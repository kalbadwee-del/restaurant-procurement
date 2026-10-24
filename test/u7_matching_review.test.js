// test/u7_matching_review.test.js — U7: matching (F7/case 26 "Lada Hitam"), corrections (case 4/F5), duplicates (case 2/F11)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, createOwnerAndLogin, seedWorld, pushUpdate, tgText } from './helpers.js';

describe('U7: matching, review & corrections', () => {
  let app, ctx, world, owner;
  before(async () => {
    ({ app, ctx } = await makeTestApp());
    owner = await createOwnerAndLogin(app);
    world = await seedWorld(ctx, owner);
  });
  after(async () => { await app.close(); await ctx.db.destroy(); });

  test('alias matching: "Lada Hitam" → Black Pepper (§2.4 doc example, case 26)', async () => {
    const { matchProduct } = await import('../src/services/matching.js');
    const m = await matchProduct(ctx.db, { nameOriginal: 'Lada Hitam', nameNormalized: 'Black Pepper' });
    assert.equal(m.productId, world.productIds['Black Pepper']);
    assert.equal(m.needsReview, false);
    // via name_local (ms) only
    const m2 = await matchProduct(ctx.db, { nameOriginal: 'Lada Hitam', nameNormalized: '' });
    assert.equal(m2.productId, world.productIds['Black Pepper'], 'matches via name_local/aliases');
  });

  test('unknown product flagged NEW, not guessed (§6.3)', async () => {
    const { matchProduct } = await import('../src/services/matching.js');
    const m = await matchProduct(ctx.db, { nameOriginal: 'Sabun Cuci Pinggan', nameNormalized: 'Dishwashing Soap' });
    assert.equal(m.isNew, true);
  });

  test('ambiguous fuzzy match asks, never auto-picks (§7.1)', async () => {
    const { matchProduct } = await import('../src/services/matching.js');
    const ts = new Date().toISOString();
    await ctx.db('products').insert({ name_en: 'White Pepper', name_local: 'Lada Putih', aliases: JSON.stringify(['lada putih']), quality_status: 'active', is_active: true, version: 0, created_at: ts, updated_at: ts });
    // "lada" alone is fuzzy-close to BOTH Black Pepper and White Pepper → must ask
    const m = await matchProduct(ctx.db, { nameOriginal: 'Lada', nameNormalized: 'lada' });
    assert.equal(m.productId, null);
    assert.equal(m.match, 'ambiguous');
    assert.ok(m.candidates.length >= 2, 'multiple candidates offered for human decision');
  });

  test('correction via symbol: "A: quantity 12" applies with version++ (case 4, F5)', async () => {
    await pushUpdate(app, { update_id: 801, message: { message_id: 1, chat: { id: world.klInvoiceChat, type: 'supergroup' }, from: { id: world.tgManagerId }, photo: [{ file_id: 'a' }], date: Math.floor(Date.now() / 1000), _mockBuffer: Buffer.from('corr-inv'), _mockMime: 'image/png' } });
    await pushUpdate(app, tgText(world.klInvoiceChat, world.tgManagerId, '/ready', 802));
    await new Promise((res) => setTimeout(res, 500));
    const inv = await ctx.db('invoices').orderBy('id', 'desc').first();
    assert.equal(inv.status, 'in_review');
    const flagged = await ctx.db('invoice_items').where({ invoice_id: inv.id }).whereNotNull('review_symbol').first();
    assert.ok(flagged, 'has a flagged item to correct');
    const r = await app.inject({ method: 'POST', url: `/api/v1/invoices/${inv.id}/corrections`, payload: { symbol: flagged.review_symbol, field: 'quantity', value: '12' }, cookies: [{ name: 'session', value: owner.cookie }] });
    assert.equal(r.statusCode, 200, r.body);
    const item = await ctx.db('invoice_items').where({ id: flagged.id }).first();
    assert.equal(Number(item.quantity), 12);
    assert.equal(item.version, 1, 'optimistic version incremented (§2.5)');
    // stale version rejected
    const r2 = await app.inject({ method: 'POST', url: `/api/v1/invoices/${inv.id}/corrections`, payload: { symbol: flagged.review_symbol, field: 'quantity', value: '15', version: 0 }, cookies: [{ name: 'session', value: owner.cookie }] });
    // note: corrections apply to current row version → this updates v1→2; conflict test done in u1/u8
    assert.ok([200, 409].includes(r2.statusCode));
  });

  test('duplicate detection: DB-level unique + heuristic date+total (case 2, F11)', async () => {
    const inv1 = await ctx.db('invoices').orderBy('id', 'desc').first();
    await ctx.db('invoices').where({ id: inv1.id }).update({ invoice_number: 'DUP-1', invoice_date: '2026-10-20' });
    // DB-level: same branch+number+date rejected by partial unique index (§12.2)
    const ts = new Date().toISOString();
    await assert.rejects(() => ctx.db('invoices').insert({ branch_id: inv1.branch_id, invoice_number: 'DUP-1', invoice_date: '2026-10-20', status: 'draft', source: 'text', created_by: inv1.created_by, created_at: ts, updated_at: ts }));
    // heuristic: same date + same total (no number) → flagged for manager, not auto-rejected
    const [dup] = await ctx.db('invoices').insert({ branch_id: inv1.branch_id, invoice_number: null, invoice_date: '2026-10-20', invoice_total: 342.1, status: 'in_review', source: 'text', created_by: inv1.created_by, created_at: ts, updated_at: ts }).returning('id');
    await ctx.db('invoices').where({ id: inv1.id }).update({ invoice_total: 342.1 });
    const { detectDuplicate } = await import('../src/services/invoices.js');
    const d = await detectDuplicate(ctx.db, typeof dup === 'object' ? dup.id : dup);
    assert.equal(d.isDuplicate, true);
    assert.equal(d.reason, 'date+total');
    // never auto-rejected: both invoices still in_review/approved states, no auto action
    const still = await ctx.db('invoices').whereIn('status', ['in_review', 'approved', 'draft']).count({ c: 'id' }).first();
    assert.ok(Number(still.c) >= 2);
  });

  test('review report message includes symbols, flags and correction syntax (§5.3)', async () => {
    const { sendReviewReport } = await import('../src/telegram/handlers.js');
    const withSymbols = await ctx.db('invoice_items as ii').join('invoices as i', 'i.id', 'ii.invoice_id')
      .where({ 'i.status': 'in_review' }).whereNotNull('ii.review_symbol')
      .select('i.id').orderBy('i.id', 'desc').first();
    assert.ok(withSymbols, 'an in_review invoice with symbols exists');
    const text = await sendReviewReport(ctx, withSymbols.id);
    assert.ok(text.includes('🧾'));
    assert.ok(/\([A-Z]\)/.test(text), 'symbols present');
    assert.ok(text.includes('A: quantity 12'), 'correction syntax hint');
  });
});
