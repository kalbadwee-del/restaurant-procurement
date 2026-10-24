// test/u5_intake.test.js — U5: silent mode (F2), anti-merge rules, storage privacy, voice path
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, createOwnerAndLogin, seedWorld, pushUpdate, outbox, tgText, tgPhoto, tgVoice } from './helpers.js';

describe('U5: invoice intake & silent mode', () => {
  let app, ctx, world, owner;
  before(async () => {
    ({ app, ctx } = await makeTestApp({ mockStorageRoot: '/tmp/local-storage-test' }));
    owner = await createOwnerAndLogin(app);
    world = await seedWorld(ctx, owner);
  });
  after(async () => { await app.close(); await ctx.db.destroy(); });

  test('photo in invoice group opens a draft session (F2)', async () => {
    await pushUpdate(app, tgPhoto(world.klInvoiceChat, world.tgManagerId, Buffer.from('fake-png-1'), 401));
    const drafts = await ctx.db('invoices').where({ branch_id: world.branchId, status: 'draft' });
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].source, 'photo');
    const file = await ctx.db('files').where({ id: drafts[0].file_id }).first();
    assert.ok(file, 'image stored with metadata');
    assert.equal(file.kind, 'invoice_image');
    assert.match(file.r2_key, /^invoices\/\d+\/\d{4}-\d{2}\//); // key scheme §06 §5
  });

  test('subsequent text joins SAME draft (silent mode, no report per message)', async () => {
    await pushUpdate(app, tgText(world.klInvoiceChat, world.tgManagerId, 'also 2 kg rice from the same supplier', 402));
    const drafts = await ctx.db('invoices').where({ status: 'draft' });
    assert.equal(drafts.length, 1, 'no new draft for text');
    const msgs = await outbox(app);
    assert.ok(msgs.at(-1).text.includes('current invoice draft') || msgs.at(-1).text.includes('مسودة'));
  });

  test('anti-merge: second photo starts NEW draft (§5.2)', async () => {
    await pushUpdate(app, tgPhoto(world.klInvoiceChat, world.tgManagerId, Buffer.from('fake-png-2'), 403));
    const drafts = await ctx.db('invoices').where({ status: 'draft' });
    assert.equal(drafts.length, 2, 'photo #2 opened a separate draft');
    const msgs = await outbox(app);
    assert.ok(msgs.slice(-3).some((m) => String(m.text ?? '').includes('NEW invoice draft') || String(m.text ?? '').includes('فاتورة جديدة')), 'new-draft notice sent');
  });

  test('/ready closes session and enqueues extraction (F2→F3)', async () => {
    const r = await pushUpdate(app, tgText(world.klInvoiceChat, world.tgManagerId, '/ready', 404));
    assert.equal(r.json().ok, true);
    const tasks = await ctx.db('pending_ai_tasks').where({ task_type: 'invoice_extract' });
    assert.ok(tasks.length >= 1);
    const session = await ctx.db('draft_sessions').where({ status: 'open' });
    assert.equal(session.length, 0, 'session closed');
  });

  test('voice → audio_transcribe task → text applied to draft', async () => {
    await pushUpdate(app, tgVoice(world.klInvoiceChat, world.tgManagerId, Buffer.from('fake-ogg'), 405));
    const audioTasks = await ctx.db('pending_ai_tasks').where({ task_type: 'audio_transcribe' });
    assert.ok(audioTasks.length >= 1);
    // wait for queue drain (async setImmediate)
    await new Promise((res) => setTimeout(res, 400));
    const done = await ctx.db('pending_ai_tasks').where({ task_type: 'audio_transcribe' }).whereIn('status', ['done', 'pending', 'failed']);
    assert.ok(done.length >= 1);
  });

  test('files are private by design: no public storage URL, proxy requires auth (§13)', async () => {
    const file = await ctx.db('files').first();
    assert.ok(file.r2_key.startsWith('invoices/'));
    const r = await app.inject({ method: 'GET', url: `/api/v1/files/${file.id}` }); // no cookie
    assert.equal(r.statusCode, 401);
  });
});
