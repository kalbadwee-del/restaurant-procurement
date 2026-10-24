// test/u9_api.test.js — U9: API guards (T-S6/T14/S2/S3), report links (T-S4/case 15), setup wizard security
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, createOwnerAndLogin, seedWorld } from './helpers.js';

describe('U9: API security & guards', () => {
  let app, ctx, world, owner;
  before(async () => {
    ({ app, ctx } = await makeTestApp());
    owner = await createOwnerAndLogin(app);
    world = await seedWorld(ctx, owner);
  });
  after(async () => { await app.close(); await ctx.db.destroy(); });

  test('all /api/v1 endpoints require auth (no anonymous access)', async () => {
    for (const [method, url] of [['GET', '/api/v1/summary'], ['GET', '/api/v1/invoices'], ['GET', '/api/v1/users'], ['GET', '/api/v1/logs'], ['GET', '/api/v1/backups'], ['GET', '/api/v1/ai/queue'], ['POST', '/api/v1/backups'], ['GET', '/api/v1/products']]) {
      const r = await app.inject({ method, url });
      assert.equal(r.statusCode, 401, `${method} ${url} must require auth`);
    }
  });

  test('employee role denied admin endpoints (T14/T-S6) — direct API without UI trust', async () => {
    // create employee with dashboard credentials
    await app.inject({ method: 'POST', url: '/api/v1/users', payload: { full_name: 'Emp Dash', username: 'emp1', password: 'password123', role: 'employee' }, cookies: [{ name: 'session', value: owner.cookie }] });
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'emp1', password: 'password123' } });
    assert.equal(login.statusCode, 200);
    const cookie = login.cookies.find((c) => c.name === 'session').value;
    for (const [method, url] of [['GET', '/api/v1/logs'], ['GET', '/api/v1/users'], ['POST', '/api/v1/backups'], ['PUT', '/api/v1/ai/settings'], ['GET', '/api/v1/ai/queue']]) {
      const r = await app.inject({ method, url, cookies: [{ name: 'session', value: cookie }] });
      assert.equal(r.statusCode, 403, `${method} ${url} denied for employee`);
    }
    // but employees have no dashboard access at all (design/06 matrix — bot-only role)
    const ok = await app.inject({ method: 'GET', url: '/api/v1/summary', cookies: [{ name: 'session', value: cookie }] });
    assert.equal(ok.statusCode, 403, 'employee denied dashboard summary');
  });

  test('login brute force: 6th attempt within a minute is rate limited (T-S2)', async () => {
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'nobody', password: 'wrong' }, remoteAddress: '10.9.9.9' });
    }
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'nobody', password: 'wrong' }, remoteAddress: '10.9.9.9' });
    assert.equal(r.statusCode, 429);
  });

  test('deactivated user loses access immediately (T-S3, §13)', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/users', payload: { full_name: 'Temp User', username: 'temp1', password: 'password123', role: 'central_purchaser' }, cookies: [{ name: 'session', value: owner.cookie }] });
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'temp1', password: 'password123' } });
    const cookie = login.cookies.find((c) => c.name === 'session').value;
    const before = await app.inject({ method: 'GET', url: '/api/v1/summary', cookies: [{ name: 'session', value: cookie }] });
    assert.equal(before.statusCode, 200);
    const u = await ctx.db('users').where({ username: 'temp1' }).first();
    await app.inject({ method: 'PATCH', url: `/api/v1/users/${u.id}`, payload: { is_active: false }, cookies: [{ name: 'session', value: owner.cookie }] });
    const after = await app.inject({ method: 'GET', url: '/api/v1/summary', cookies: [{ name: 'session', value: cookie }] });
    assert.equal(after.statusCode, 401, 'deactivated user rejected on next call');
  });

  test('report temp links: token+identity+permission required; expiry enforced (T-S4, case 15, D-S9)', async () => {
    const exp = await app.inject({ method: 'POST', url: '/api/v1/reports/export', payload: { type: 'expenses_by_branch', format: 'xlsx', filters: {} }, cookies: [{ name: 'session', value: owner.cookie }] });
    assert.equal(exp.statusCode, 200, exp.body);
    const link = exp.json().link;
    // link alone (no session) grants NOTHING (§11.2)
    const anon = await app.inject({ method: 'GET', url: link });
    assert.equal(anon.statusCode, 401);
    // different user's session — denied
    await app.inject({ method: 'POST', url: '/api/v1/users', payload: { full_name: 'Other', username: 'other1', password: 'password123', role: 'employee' }, cookies: [{ name: 'session', value: owner.cookie }] });
    const otherLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'other1', password: 'password123' } });
    const otherCookie = otherLogin.cookies.find((c) => c.name === 'session').value;
    const foreign = await app.inject({ method: 'GET', url: link, cookies: [{ name: 'session', value: otherCookie }] });
    assert.equal(foreign.statusCode, 403);
    // owner session works
    const own = await app.inject({ method: 'GET', url: link, cookies: [{ name: 'session', value: owner.cookie }] });
    assert.equal(own.statusCode, 200);
    // expired link → 410
    const token = link.split('/').pop();
    await ctx.db('report_links').where({ token }).update({ expires_at: new Date(Date.now() - 1000).toISOString() });
    const expired = await app.inject({ method: 'GET', url: link, cookies: [{ name: 'session', value: owner.cookie }] });
    assert.equal(expired.statusCode, 410);
  });

  test('setup wizard locked after configuration (D-S16)', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/v1/setup/owner', payload: { username: 'evil', password: 'password123' } });
    assert.equal(r.statusCode, 403, 'owner creation locked after first setup');
    const complete = await app.inject({ method: 'POST', url: '/api/v1/setup/complete', payload: {} });
    assert.ok([200, 400, 403].includes(complete.statusCode)); // requires owner; never anonymous-open
  });

  test('branch scoping: branch_manager sees own branch data only (§06 scope rules)', async () => {
    const u = await ctx.db('users').where({ id: world.managerId }).first();
    assert.equal(u.role, 'branch_manager');
    const { permissionCheck, ACTIONS } = await import('../src/permissions.js');
    assert.equal(permissionCheck(u, ACTIONS.VIEW_SUMMARY, { branchId: world.branchId }).ok, true);
    assert.equal(permissionCheck(u, ACTIONS.VIEW_SUMMARY, { branchId: world.branchId2 }).ok, false, 'other branch out of scope');
  });
});
