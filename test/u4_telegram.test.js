// test/u4_telegram.test.js — U4: idempotency (T19), secret check (T-S1), unverified senders, pairing, requests (cases 7 + §4.4)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, createOwnerAndLogin, seedWorld, pushUpdate, outbox, tgText } from './helpers.js';

describe('U4: telegram intake & idempotency', () => {
  let app, ctx, world, owner;
  before(async () => {
    ({ app, ctx } = await makeTestApp());
    owner = await createOwnerAndLogin(app);
    world = await seedWorld(ctx, owner);
  });
  after(async () => { await app.close(); await ctx.db.destroy(); });

  test('webhook rejects bad secret token (T-S1)', async () => {
    ctx.config.telegram.mode = 'real'; ctx.transport.mode = 'real'; // exercise secret check path
    const r = await app.inject({ method: 'POST', url: '/telegram-webhook', payload: { update_id: 1 }, headers: { 'x-telegram-bot-api-secret-token': 'WRONG' } });
    assert.equal(r.statusCode, 401);
    ctx.config.telegram.mode = 'mock'; ctx.transport.mode = 'mock';
  });

  test('unverified sender rejected — never guessed (§4.2)', async () => {
    await pushUpdate(app, tgText(world.klRequestChat, 99999, '5 kg flour', 101));
    const items = await outbox(app);
    assert.ok(items.at(-1).text.includes('verify'), 'asks unverified user to register');
  });

  test('duplicate update_id processed exactly once (T19 idempotency)', async () => {
    const upd = tgText(world.klRequestChat, world.tgEmployeeId, '5 kg Black Pepper', 202);
    const r1 = await pushUpdate(app, upd);
    assert.equal(r1.json().ok, true);
    const count1 = await countRequestItems(ctx.db);
    const r2 = await pushUpdate(app, upd); // same update redelivered
    assert.equal(r2.json().ok, true);
    const count2 = await countRequestItems(ctx.db);
    assert.equal(count2, count1, 'no duplicate records on retry');
    const skipped = await ctx.db('processed_updates').where({ update_id: 202 }).first();
    assert.ok(skipped);
  });

  test('employee request recorded via request group (case 7 base)', async () => {
    await resetRequests(ctx);
    await pushUpdate(app, tgText(world.klRequestChat, world.tgEmployeeId, '3 kg Black Pepper', 203));
    const items = await ctx.db('request_items').where({ product_id: world.productIds['Black Pepper'] });
    assert.equal(items.length, 1);
    assert.equal(Number(items[0].quantity), 3);
  });

  test('"add 2 kg" increments existing request (case 7, §4.4) with full history', async () => {
    await resetRequests(ctx);
    await pushUpdate(app, tgText(world.klRequestChat, world.tgEmployeeId, '5 kg Black Pepper', 204));
    await pushUpdate(app, tgText(world.klRequestChat, world.tgEmployeeId, 'add 2 kg Black Pepper', 205));
    const item = await ctx.db('request_items').where({ product_id: world.productIds['Black Pepper'] }).first();
    assert.equal(Number(item.quantity), 7); // 5 + 2 (doc example §4.4)
    const mods = await ctx.db('request_modifications').where({ request_item_id: item.id });
    assert.ok(mods.some((m) => m.change_type === 'increment'));
  });

  test('ambiguous modification asks for clarification (§4.4)', async () => {
    await pushUpdate(app, tgText(world.klRequestChat, world.tgEmployeeId, 'add some of that thing', 250));
    const items = await outbox(app);
    assert.ok(items.at(-1).text.length > 0); // clarification message sent, no record created
    const before = await countRequestItems(ctx.db);
    const r = await pushUpdate(app, tgText(world.klRequestChat, world.tgEmployeeId, '???', 251));
    assert.equal(r.json().ok, true);
  });

  test('cancel request item works (§4.4)', async () => {
    await resetRequests(ctx);
    await pushUpdate(app, tgText(world.klRequestChat, world.tgEmployeeId, '5 kg Black Pepper', 207));
    await pushUpdate(app, tgText(world.klRequestChat, world.tgEmployeeId, 'cancel Black Pepper', 208));
    const item = await ctx.db('request_items').where({ product_id: world.productIds['Black Pepper'] }).first();
    assert.equal(item.status, 'cancelled');
    const mods = await ctx.db('request_modifications').where({ request_item_id: item.id });
    assert.ok(mods.some((m) => m.change_type === 'cancel'));
  });

  test('pairing code binds telegram identity (§3.2)', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/users', payload: { full_name: 'New Manager', role: 'branch_manager', branch_id: world.branchId }, cookies: [{ name: 'session', value: owner.cookie }] });
    const users = await ctx.db('users').where({ full_name: 'New Manager' }).first();
    const r = await app.inject({ method: 'POST', url: `/api/v1/users/${users.id}/pair-code`, cookies: [{ name: 'session', value: owner.cookie }] });
    const code = r.json().code;
    await pushUpdate(app, tgText(555, 424242, `PAIR ${code}`, 301));
    const bound = await ctx.db('users').where({ id: users.id }).first();
    assert.equal(bound.telegram_id, 424242);
  });
});

async function countRequestItems(db) {
  const r = await db('request_items').count({ c: 'id' }).first();
  return Number(r.c);
}

async function resetRequests(ctx) {
  await ctx.db('request_modifications').del();
  await ctx.db('request_items').del();
  await ctx.db('requests').del();
}
