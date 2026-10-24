// test/u12_golive.test.js — GO-LIVE GATE (§16 Phase 3 / test plan §5): the critical path end-to-end.
// يُشغَّل أخيرًا: دورة حياة كاملة عبر البوت والداشبورد بلا أي تدخل يدوي.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, createOwnerAndLogin, seedWorld, pushUpdate, outbox, tgPhoto, tgText } from './helpers.js';

describe('U12: go-live gate — full critical path', () => {
  let app, ctx, world, owner;
  before(async () => {
    ({ app, ctx } = await makeTestApp({ mockStorageRoot: '/tmp/local-storage-golive' }));
    owner = await createOwnerAndLogin(app);
    world = await seedWorld(ctx, owner);
  });
  after(async () => { await app.close(); await ctx.db.destroy(); });

  test('request → invoice → review → correct → approve → request reconciled → report → backup', async () => {
    // 1) employee requests 10 kg
    await pushUpdate(app, tgText(world.klRequestChat, world.tgEmployeeId, '10 kg Black Pepper', 1201));
    assert.equal(Number((await ctx.db('request_items').first()).quantity), 10);

    // 2) manager sends invoice photo + /ready → extraction (mock variant deterministic by hash)
    const buf = Buffer.from('golive-invoice');
    await pushUpdate(app, tgPhoto(world.klInvoiceChat, world.tgManagerId, buf, 1202));
    await pushUpdate(app, tgText(world.klInvoiceChat, world.tgManagerId, '/ready', 1203));
    await new Promise((res) => setTimeout(res, 700));
    const inv = await ctx.db('invoices').where({ status: 'in_review' }).first();
    assert.ok(inv, 'invoice in review');

    // 3) resolve every flagged item via API, then approve
    const flagged = await ctx.db('invoice_items').where({ invoice_id: inv.id }).whereNotNull('review_symbol');
    for (const it of flagged) {
      const c = await app.inject({ method: 'POST', url: `/api/v1/invoices/${inv.id}/confirm-item`, payload: { symbol: it.review_symbol }, cookies: [{ name: 'session', value: owner.cookie }] });
      assert.equal(c.statusCode, 200);
    }
    const row = await ctx.db('invoices').where({ id: inv.id }).first();
    const approveBody = { version: row.version };
    if (row.discrepancy_flag) approveBody.discrepancy_note = 'supplier rounding — verified with receipt';
    const ap = await app.inject({ method: 'POST', url: `/api/v1/invoices/${inv.id}/approve`, payload: approveBody, cookies: [{ name: 'session', value: owner.cookie }] });
    assert.equal(ap.statusCode, 200, ap.body);

    // 4) ledger + request reconciliation + audit exist
    const purchases = await ctx.db('approved_purchases').where({ invoice_id: inv.id });
    assert.ok(purchases.length >= 1);
    const mods = await ctx.db('request_modifications').count({ c: '*' }).first();
    assert.ok(Number(mods.c) >= 1);
    const audits = await ctx.db('audit_log').where({ entity_type: 'invoice', entity_id: inv.id }).count({ c: '*' }).first();
    assert.ok(Number(audits.c) >= 1, 'approval audited (§5.5)');

    // 5) report export link works (PDF via C1 queue)
    const exp = await app.inject({ method: 'POST', url: '/api/v1/reports/export', payload: { type: 'expenses_by_branch', format: 'pdf', lang: 'ar', filters: {} }, cookies: [{ name: 'session', value: owner.cookie }] });
    assert.equal(exp.statusCode, 200, exp.body);
    const link = exp.json().link;
    const file = await app.inject({ method: 'GET', url: link, cookies: [{ name: 'session', value: owner.cookie }] });
    assert.equal(file.statusCode, 200);
    const pdfBytes = Buffer.from(file.rawPayload ?? file.body ?? '');
    assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-');

    // 6) daily backup created + verifiable
    const bk = await app.inject({ method: 'POST', url: '/api/v1/backups', cookies: [{ name: 'session', value: owner.cookie }] });
    assert.equal(bk.statusCode, 201);
    const item = await ctx.db('backups').orderBy('id', 'desc').first();
    const stored = await ctx.storage.get(item.r2_key);
    assert.ok(!stored.toString('utf8').includes('Black Pepper'), 'encrypted at rest');

    // 7) summary reflects approved spend
    const sum = await app.inject({ method: 'GET', url: '/api/v1/summary', cookies: [{ name: 'session', value: owner.cookie }] });
    assert.equal(sum.statusCode, 200);
    assert.ok(sum.json().approved_total > 0, 'approved expenses visible in summary');
  });

  test('gate assertions: C1/C2/C3 wired in the running app', async () => {
    // C2: health exact body (verified again inside the full app)
    const h = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(h.body, '{"status":"ok"}');
    // C1: pdf module exposes serial renderer
    const pdf = await import('../src/pdf.js');
    assert.equal(typeof pdf.renderPdf, 'function');
    // C3: rate limiter active with configured caps
    assert.ok(ctx.ai.limiter.globalCap > 0 && ctx.ai.limiter.userCap > 0 && ctx.ai.limiter.burst > 0);
    // AI provider is mock until owner switches it (D-S7)
    assert.equal(ctx.ai.provider.name, 'mock');
  });
});
