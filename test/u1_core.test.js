// test/u1_core.test.js — U1+U2+U3 core: health (C2), money, settings crypto, permissions, sessions, schema
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from './helpers.js';
import { toSen, fromSen, computeLineTotalSen, formatRM, normalizeName, diceSimilarity } from '../src/util.js';
import { deriveMasterKey, encryptSecret, decryptSecret } from '../src/settings.js';
import { signSession, verifySession, hashPassword, verifyPassword } from '../src/auth.js';
import { permissionCheck, ACTIONS } from '../src/permissions.js';

describe('U1: server core', () => {
  test('/health returns exactly {"status":"ok"} (C2)', async () => {
    const { app, ctx } = await makeTestApp();
    try {
      const t0 = process.hrtime.bigint();
      const r = await app.inject({ method: 'GET', url: '/health' });
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      assert.equal(r.statusCode, 200);
      assert.deepEqual(r.json(), { status: 'ok' });
      assert.ok(ms < 50, `health took ${ms}ms (budget <50ms incl. framework overhead; handler itself is static)`);
      assert.equal(r.body, '{"status":"ok"}'); // no system info (§13)
    } finally { await app.close(); await ctx.db.destroy(); }
  });
});

describe('U1: money (integer sen — D7/D-S13)', () => {
  test('toSen/fromSen exactness', () => {
    assert.equal(toSen('341.00'), 34100);
    assert.equal(toSen('0.45'), 45);
    assert.equal(toSen(196.1), 19610);
    assert.equal(toSen('12.345'), 1235); // rounds half-up at 3rd decimal
    assert.equal(fromSen(34100), 341);
  });
  test('line totals: qty×price−discount+tax, integer only', () => {
    assert.equal(computeLineTotalSen(30, 45), 1350);
    assert.equal(computeLineTotalSen(2, 2800, 0, 0), 5600);
    assert.equal(computeLineTotalSen(2, 6200, 400, 0), 12000);
    assert.throws(() => computeLineTotalSen(1, 10.5)); // rejects non-integer money
  });
  test('formatRM', () => { assert.equal(formatRM(34100), 'RM 341.00'); });
});

describe('U1: string normalization + fuzzy (D-S2)', () => {
  test('normalizeName strips diacritics/punct/case', () => {
    assert.equal(normalizeName('  Láda Hítam! '), 'lada hitam');
  });
  test('diceSimilarity detects near-duplicates', () => {
    assert.ok(diceSimilarity('black pepper', 'black peppers') > 0.85);
    assert.ok(diceSimilarity('chicken eggs', 'fresh chicken') < 0.6);
  });
});

describe('U1: settings crypto (D-S1)', () => {
  test('AES-256-GCM roundtrip + HKDF key derivation', () => {
    const key = deriveMasterKey('postgresql://u:p@host/db?sslmode=require');
    assert.equal(key.length, 32);
    const enc = encryptSecret(key, 'gemini-secret-key-123');
    assert.notEqual(enc, 'gemini-secret-key-123');
    assert.equal(decryptSecret(key, enc), 'gemini-secret-key-123');
    const otherKey = deriveMasterKey('different-url');
    assert.throws(() => decryptSecret(otherKey, enc));
    // ciphertext differs per encryption (random IV)
    assert.notEqual(enc, encryptSecret(key, 'gemini-secret-key-123'));
  });
});

describe('U3: passwords (argon2id — D-S14) + sessions', () => {
  test('argon2 hash/verify', async () => {
    const h = await hashPassword('password123');
    assert.ok(h.startsWith('$argon2'));
    assert.equal(await verifyPassword(h, 'password123'), true);
    assert.equal(await verifyPassword(h, 'wrong'), false);
  });
  test('session sign/verify + expiry', () => {
    const s = signSession('secret', { uid: 7, role: 'owner', ttlHours: 1 });
    assert.equal(verifySession('secret', s).uid, 7);
    assert.equal(verifySession('other', s), null);
    const expired = signSession('secret', { uid: 7, role: 'owner', ttlHours: -1 });
    assert.equal(verifySession('secret', expired), null);
  });
});

describe('U3: permission matrix (§06 §2)', () => {
  const u = (role, branch_id = null, overrides = null) => ({ role, branch_id, is_active: true, permissions_override: overrides });
  test('employee cannot view reports / approve invoices', () => {
    assert.equal(permissionCheck(u('employee'), ACTIONS.VIEW_REPORTS).ok, false);
    assert.equal(permissionCheck(u('employee'), ACTIONS.APPROVE_INVOICE).ok, false);
    assert.equal(permissionCheck(u('employee'), ACTIONS.SUBMIT_REQUEST).ok, true);
  });
  test('branch_manager scoped to own branch', () => {
    assert.equal(permissionCheck(u('branch_manager', 1), ACTIONS.APPROVE_INVOICE, { branchId: 1 }).ok, true);
    assert.equal(permissionCheck(u('branch_manager', 1), ACTIONS.APPROVE_INVOICE, { branchId: 2 }).ok, false);
  });
  test('amendment restricted to accountant/owner (Q2)', () => {
    assert.equal(permissionCheck(u('owner'), ACTIONS.AMEND_APPROVED).ok, true);
    assert.equal(permissionCheck(u('accountant'), ACTIONS.AMEND_APPROVED).ok, true);
    assert.equal(permissionCheck(u('operations_manager'), ACTIONS.AMEND_APPROVED).ok, false);
  });
  test('permissions_override allow/deny', () => {
    assert.equal(permissionCheck(u('employee'), ACTIONS.RECORD_OBSERVED_PRICE, { }).ok, false);
    assert.equal(permissionCheck(u('employee', null, { 'prices.observed': true }), ACTIONS.RECORD_OBSERVED_PRICE).ok, true);
  });
  test('inactive user denied always', () => {
    assert.equal(permissionCheck({ role: 'owner', is_active: false }, ACTIONS.VIEW_REPORTS).ok, false);
  });
});
