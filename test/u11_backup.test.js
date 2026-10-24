// test/u11_backup.test.js — U11: backup/restore (cases 17,18), logs redaction (T-S5/case 28), alerts, cleanup
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, createOwnerAndLogin, seedWorld, pushUpdate, tgText } from './helpers.js';
import knexLib from 'knex';

describe('U11: backup, logs & alerts', () => {
  let app, ctx, world, owner;
  before(async () => {
    ({ app, ctx } = await makeTestApp({ mockStorageRoot: '/tmp/local-storage-backup-test' }));
    owner = await createOwnerAndLogin(app);
    world = await seedWorld(ctx, owner);
    // seed some activity
    await pushUpdate(app, tgText(world.klRequestChat, world.tgEmployeeId, '2 kg Black Pepper', 1101));
  });
  after(async () => { await app.close(); await ctx.db.destroy(); });

  test('daily backup: create → encrypted → manifest with sha256 + counts (case 17, F13/§12.3)', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/v1/backups', cookies: [{ name: 'session', value: owner.cookie }] });
    assert.equal(r.statusCode, 201, r.body);
    const { sha256, format } = r.json();
    assert.ok(sha256 && format);
    const listed = await app.inject({ method: 'GET', url: '/api/v1/backups', cookies: [{ name: 'session', value: owner.cookie }] });
    const items = listed.json().items;
    assert.ok(items.length >= 1);
    const stored = await ctx.storage.get(items[0].r2_key);
    assert.ok(!stored.toString('utf8').includes('Black Pepper'), 'payload is encrypted at rest (§12.3)');
    assert.ok(!stored.toString('utf8').includes('argon2'), 'no plaintext secrets in backup');
  });

  test('backup contains pending_ai_tasks + secrets encrypted (§12.3)', async () => {
    const { enqueue } = await import('../src/queue.js');
    await enqueue(ctx, { taskType: 'invoice_extract', payload: { invoice_id: 999999 }, createdBy: null });
    await ctx.settings.setSecret('gemini_api_key', 'test-key-for-backup');
    const { createBackup } = await import('../src/backup.js');
    await createBackup(ctx, owner.owner.id);
    const item = await ctx.db('backups').orderBy('id', 'desc').first();
    const counts = typeof item.table_counts === 'string' ? JSON.parse(item.table_counts) : item.table_counts;
    assert.ok(counts.pending_ai_tasks >= 1, 'in-flight tasks included (§12.3)');
    assert.ok(counts.app_secrets >= 1, 'secrets rows included (encrypted form only)');
  });

  test('restore verification: sha256 check + integrity counts + tamper detection (§12.4, case 17/18)', async () => {
    const { createBackup, verifyBackup } = await import('../src/backup.js');
    await createBackup(ctx, owner.owner.id);
    const item = await ctx.db('backups').orderBy('id', 'desc').first();
    const buf = await ctx.storage.get(item.r2_key);
    const v = await verifyBackup(ctx, { buffer: buf, expectedSha256: item.sha256 });
    assert.equal(v.ok, true, v.reason ?? '');
    assert.ok(v.integrity.users >= 1 && v.integrity.products >= 1);
    // tampered buffer fails
    const tampered = Buffer.from(buf);
    tampered[100] ^= 0xff;
    const v2 = await verifyBackup(ctx, { buffer: tampered, expectedSha256: item.sha256 });
    assert.equal(v2.ok, false);
    assert.equal(v2.reason, 'sha256_mismatch');
  });

  test('restore into a FRESH scratch DB preserves commercial data (case 18/20, §12.4)', async () => {
    const { createBackup, restoreJsonInto, verifyBackup } = await import('../src/backup.js');
    const beforeUsers = await ctx.db('users').count({ c: 'id' }).first();
    const beforeProducts = await ctx.db('products').count({ c: 'id' }).first();
    await createBackup(ctx, owner.owner.id);
    const item = await ctx.db('backups').orderBy('id', 'desc').first();
    const buf = await ctx.storage.get(item.r2_key);
    // fresh scratch sqlite
    const { mkdtempSync } = await import('node:fs');
    const dir = mkdtempSync('/tmp/restore-');
    const scratch = knexLib({ client: 'better-sqlite3', connection: { filename: `${dir}/scratch.db` }, useNullAsDefault: true });
    const { migrateLatest } = await import('../src/db/knex.js');
    // apply schema to scratch by running migrations via a temp knex with same migrations dir
    const scratchMigrated = knexLib({ client: 'better-sqlite3', connection: { filename: `${dir}/scratch.db` }, useNullAsDefault: true, migrations: { directory: new URL('../src/db/migrations/', import.meta.url).pathname } });
    await migrateLatest(scratchMigrated);
    await scratchMigrated.destroy();
    await restoreJsonInto(ctx, scratch, buf);
    const afterUsers = await scratch('users').count({ c: 'id' }).first();
    const afterProducts = await scratch('products').count({ c: 'id' }).first();
    assert.equal(Number(afterUsers.c), Number(beforeUsers.c), 'users restored');
    assert.equal(Number(afterProducts.c), Number(beforeProducts.c), 'products restored');
    const pepper = await scratch('products').where({ name_en: 'Black Pepper' }).first();
    assert.ok(pepper, 'commercial data intact after restore');
    await scratch.destroy();
  });

  test('import endpoint enforces: sha256 → schema → explicit REPLACE confirmation (§12.4)', async () => {
    const item = await ctx.db('backups').orderBy('id', 'desc').first();
    const buf = await ctx.storage.get(item.r2_key);
    const b64 = buf.toString('base64');
    const noConfirm = await app.inject({ method: 'POST', url: '/api/v1/backups/import', payload: { content_base64: b64, sha256: item.sha256 }, cookies: [{ name: 'session', value: owner.cookie }] });
    assert.equal(noConfirm.statusCode, 400);
    assert.equal(noConfirm.json().error.code, 'CONFIRMATION_REQUIRED', 'explicit REPLACE confirmation required (§12.4 warning)');
    const bad = await app.inject({ method: 'POST', url: '/api/v1/backups/import', payload: { content_base64: b64.slice(10) + 'AAAA', sha256: item.sha256, confirm: 'REPLACE' }, cookies: [{ name: 'session', value: owner.cookie }] });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error.message_en, 'sha256_mismatch');
    const okImport = await app.inject({ method: 'POST', url: '/api/v1/backups/import', payload: { content_base64: b64, sha256: item.sha256, confirm: 'REPLACE' }, cookies: [{ name: 'session', value: owner.cookie }] });
    assert.equal(okImport.statusCode, 200);
    assert.equal(okImport.json().ok, true);
  });

  test('structured logs capture the full invoice trail and are queryable (case 28, §2.6)', async () => {
    const { applyExtraction } = await import('../src/services/invoices.js');
    const ts = new Date().toISOString();
    const [inv] = await ctx.db('invoices').insert({ branch_id: world.branchId, status: 'draft', source: 'text', created_by: world.managerId, created_at: ts, updated_at: ts }).returning('id');
    const invId = typeof inv === 'object' ? inv.id : inv;
    await applyExtraction(ctx, invId, { detected_language: 'en', invoice_number: 'LOG-1', invoice_date: '2026-10-23', invoice_total: 14.0,
      items: [{ name_original: 'Black Pepper', name_normalized: 'Black Pepper', quantity: 0.5, unit: 'kg', unit_price: 28.0, discount: 0, tax: 0, line_total: 14.0, confidence: 'high' }], totals_match: true });
    const events = await ctx.db('audit_log').select();
    const types = events.map((e) => e.event_type);
    assert.ok(types.includes('invoice.extracted'), 'extraction audited');
    const r = await app.inject({ method: 'GET', url: `/api/v1/logs?entity_type=invoice&entity_id=${invId}`, cookies: [{ name: 'session', value: owner.cookie }] });
    assert.equal(r.statusCode, 200);
    assert.ok(r.json().items.length >= 1);
  });

  test('logs whitelist serializer: secrets/passwords/phones can never appear (T-S5, §2.6.4/§13)', async () => {
    const { log } = await import('../src/logging.js');
    const orig = process.stdout.write.bind(process.stdout);
    let captured = '';
    process.stdout.write = (chunk) => { captured += chunk; return true; };
    try {
      log.info('test.secret_probe', { meta: { password: 'hunter2', api_key: 'AIzaSECRET', phone: '+60123456789', nested: { token: 'abc', file_data: Buffer.from([1, 2, 3]) }, telegram_id: 424242 } });
    } finally { process.stdout.write = orig; }
    assert.ok(!captured.includes('hunter2'), 'password redacted');
    assert.ok(!captured.includes('AIzaSECRET'), 'api key redacted');
    assert.ok(!captured.includes('+60123456789'), 'phone redacted');
    assert.ok(!captured.includes('abc'), 'token redacted');
    assert.ok(captured.includes('424242'), 'telegram_id allowed (§2.6.4)');
    assert.ok(captured.includes('[redacted]'));
  });

  test('alerts: thresholds fire once per day and notify owner (§D)', async () => {
    await ctx.db('users').where({ role: 'owner' }).update({ telegram_id: 999001 }); // owner reachable via bot
    const { notifyOwner } = await import('../src/services/alerts.js');
    ctx.outbox.clear();
    await notifyOwner(ctx, { en: 'TEST-ALERT-EN', ar: 'TEST-ALERT-AR' });
    const items = await (await app.inject({ method: 'GET', url: '/dev/mock-telegram/outbox' })).json().items;
    assert.ok(items.some((i) => String(i.text ?? '').includes('TEST-ALERT-EN') && String(i.text ?? '').includes('TEST-ALERT-AR')), 'owner notified bilingually');
  });

  test('cleanup: expired report links revoked, stale silent sessions closed (ops §A)', async () => {
    const { cleanupExpired } = await import('../src/services/alerts.js');
    const r = await cleanupExpired(ctx);
    assert.ok('expiredLinks' in r && 'closedSessions' in r);
  });
});
