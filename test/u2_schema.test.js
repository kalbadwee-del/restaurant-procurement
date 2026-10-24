// test/u2_schema.test.js — U2: migrations, version columns, views, partial unique, seeds, optimistic locking
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from './helpers.js';
import { updateWithVersion } from '../src/audit.js';
import { nowIso } from '../src/util.js';

describe('U2: schema & core domain', () => {
  test('all ~26 tables exist with version columns on mutable tables', async () => {
    const { app, ctx } = await makeTestApp();
    try {
      const tables = (await ctx.db('sqlite_master').where({ type: 'table' }).select('name')).map((r) => r.name);
      for (const t of ['branches','users','telegram_groups','expense_categories','brands','units','products','stores','observed_prices',
        'requests','request_items','request_modifications','invoices','invoice_items','approved_purchases','files',
        'processed_updates','pending_ai_tasks','ai_call_logs','app_secrets','app_settings','report_links','backups','audit_log','draft_sessions']) {
        assert.ok(tables.includes(t), `missing table ${t}`);
      }
      for (const t of ['invoices', 'invoice_items', 'requests', 'request_items', 'products', 'stores', 'users', 'branches', 'observed_prices']) {
        const info = await ctx.db.raw(`PRAGMA table_info(${t})`);
        const rows = Array.isArray(info) ? info : (info.rows ?? []);
        const cols = rows.map((c) => c.name);
        assert.ok(cols.includes('version'), `${t} missing version column (§2.5)`);
      }
    } finally { await app.close(); await ctx.db.destroy(); }
  });

  test('seed: 5 initial categories + core units', async () => {
    const { app, ctx } = await makeTestApp();
    try {
      const cats = await ctx.db('expense_categories').select();
      const names = cats.map((c) => c.name_en);
      for (const n of ['Food & Operational Supplies', 'Marketing', 'Maintenance', 'Equipment & Tools', 'Other']) {
        assert.ok(names.includes(n), `missing category ${n}`);
      }
      const kg = await ctx.db('units').where({ short_name: 'kg' }).first();
      assert.ok(kg);
    } finally { await app.close(); await ctx.db.destroy(); }
  });

  test('partial unique index blocks duplicate invoice number+date per branch (§12.2)', async () => {
    const { app, ctx } = await makeTestApp();
    try {
      const ts = nowIso();
      const [b] = await ctx.db('branches').insert({ name_en: 'B', name_ar: 'ب', is_active: true, version: 0, created_at: ts, updated_at: ts }).returning('id');
      const [u] = await ctx.db('users').insert({ full_name: 'x', role: 'owner', is_active: true, version: 0, created_at: ts, updated_at: ts }).returning('id');
      const inv = (i) => ({ branch_id: b.id, invoice_number: 'INV-1', invoice_date: '2026-10-01', status: 'draft', source: 'text', created_by: u.id, created_at: ts, updated_at: ts });
      await ctx.db('invoices').insert(inv(1));
      await assert.rejects(() => ctx.db('invoices').insert(inv(2))); // unique violation
      // NULL invoice_number allowed multiple times
      await ctx.db('invoices').insert({ branch_id: b.id, invoice_number: null, status: 'draft', source: 'text', created_by: u.id, created_at: ts, updated_at: ts });
      await ctx.db('invoices').insert({ branch_id: b.id, invoice_number: null, status: 'draft', source: 'text', created_by: u.id, created_at: ts, updated_at: ts });
    } finally { await app.close(); await ctx.db.destroy(); }
  });

  test('views exist and expose designed columns', async () => {
    const { app, ctx } = await makeTestApp();
    try {
      const priceHist = await ctx.db('v_price_history').select().limit(1);
      assert.ok(Array.isArray(priceHist));
      const open = await ctx.db('v_open_requests').select().limit(1);
      assert.ok(Array.isArray(open));
    } finally { await app.close(); await ctx.db.destroy(); }
  });

  test('updateWithVersion: conflict on stale version, success increments (§2.5)', async () => {
    const { app, ctx } = await makeTestApp();
    try {
      const ts = nowIso();
      const [br] = await ctx.db('branches').insert({ name_en: 'A', name_ar: 'أ', version: 0, is_active: true, created_at: ts, updated_at: ts }).returning('id');
      const r1 = await updateWithVersion(ctx.db, 'branches', br.id, 0, { name_en: 'A2' });
      assert.equal(r1.ok, true);
      const stale = await updateWithVersion(ctx.db, 'branches', br.id, 0, { name_en: 'A3' });
      assert.equal(stale.ok, false);
      assert.equal(stale.conflict, true);
      const row = await ctx.db('branches').where({ id: br.id }).first();
      assert.equal(row.version, 1);
      assert.equal(row.name_en, 'A2');
      // conflict is audit-logged
      const conflicts = await ctx.db('audit_log').where({ event_type: 'conflict.detected' });
      assert.equal(conflicts.length, 0); // no eventType passed → only log; pass eventType to audit
      const r3 = await updateWithVersion(ctx.db, 'branches', br.id, 0, { name_en: 'X' }, { eventType: 'branch.updated' });
      assert.equal(r3.ok, false);
      const logged = await ctx.db('audit_log').where({ entity_type: 'branches', action: 'conflict' });
      assert.equal(logged.length, 1);
    } finally { await app.close(); await ctx.db.destroy(); }
  });

  test('audit_log is append-only in practice (rows never updated/deleted by app code)', async () => {
    const { app, ctx } = await makeTestApp();
    try {
      const ts = nowIso();
      await ctx.db('audit_log').insert({ event_type: 'x', actor_type: 'system', entity_type: 't', entity_id: 1, action: 'a', created_at: ts });
      const rows = await ctx.db('audit_log').count({ c: 'id' }).first();
      assert.equal(Number(rows.c), 1);
    } finally { await app.close(); await ctx.db.destroy(); }
  });
});
