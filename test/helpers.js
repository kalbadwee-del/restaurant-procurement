// test/helpers.js — app harness: SQLite temp DB + mock providers (D-S7), seeded via migrations
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server.js';

export async function makeTestApp({ mockStorageRoot = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'proc-test-'));
  const dbTarget = { client: 'sqlite', connection: { filename: join(dir, 'test.db') }, source: 'test:sqlite' };
  const { app, ctx } = await buildApp({
    dbTarget,
    skipJobs: true, // deterministic tests — jobs started explicitly when needed
    skipStatic: true,
    db: undefined,
  });
  // force mock providers for tests
  await ctx.settings.setSetting('telegram_mode', 'mock');
  await ctx.settings.setSetting('ai_provider', 'mock');
  await ctx.settings.setSetting('storage_mode', 'mock');
  if (mockStorageRoot) await ctx.settings.setSetting('mock_storage_root', mockStorageRoot);
  ctx.settings.invalidateCaches();
  const { buildRuntimeConfig } = await import('../src/settings.js');
  ctx.config = await buildRuntimeConfig(ctx.settings, ctx.db);
  const { makeTransport } = await import('../src/telegram/transport.js');
  ctx.transport = makeTransport(ctx.config, ctx.outbox);
  const { makeStorage } = await import('../src/storage.js');
  ctx.storage = makeStorage(ctx.config);
  const { makeAI } = await import('../src/ai.js');
  ctx.ai = makeAI(ctx.config);
  return { app, ctx, dir };
}

export async function createOwnerAndLogin(app) {
  const r1 = await app.inject({ method: 'POST', url: '/api/v1/setup/owner', payload: { username: 'owner1', password: 'password123', full_name: 'Owner' } });
  if (r1.statusCode !== 201) throw new Error(`owner create failed: ${r1.body}`);
  const r2 = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'owner1', password: 'password123' } });
  if (r2.statusCode !== 200) throw new Error(`login failed: ${r2.body}`);
  return { owner: r2.json(), cookie: r2.cookies.find((c) => c.name === 'session').value };
}

export function withCookie(cookie) {
  return { cookies: [{ name: 'session', value: cookie }] };
}

export async function seedWorld(ctx, owner) {
  // branches, groups, users, products, units exist from seeds
  const ts = new Date().toISOString();
  const [kl] = await ctx.db('branches').insert({ name_en: 'KL Branch', name_ar: 'فرع كوالالمبور', is_active: true, version: 0, created_at: ts, updated_at: ts }).returning('id');
  const [jb] = await ctx.db('branches').insert({ name_en: 'JB Branch', name_ar: 'فرع جوهر', is_active: true, version: 0, created_at: ts, updated_at: ts }).returning('id');
  const branchId = typeof kl === 'object' ? kl.id : kl;
  const branchId2 = typeof jb === 'object' ? jb.id : jb;
  await ctx.db('telegram_groups').insert({ chat_id: -1001, kind: 'invoice_group', branch_id: branchId, title: 'KL Invoices', is_active: true, version: 0, created_at: ts, updated_at: ts });
  await ctx.db('telegram_groups').insert({ chat_id: -2002, kind: 'request_group', branch_id: branchId, title: 'KL Requests', is_active: true, version: 0, created_at: ts, updated_at: ts });
  const ts2 = now();
  const [mgr] = await ctx.db('users').insert({ telegram_id: 111, full_name: 'KL Manager', role: 'branch_manager', branch_id: branchId, language: 'en', is_active: true, version: 0, created_at: ts2, updated_at: ts2 }).returning('id');
  const [emp] = await ctx.db('users').insert({ telegram_id: 222, full_name: 'KL Employee', role: 'employee', branch_id: branchId, language: 'en', is_active: true, version: 0, created_at: ts2, updated_at: ts2 }).returning('id');
  const [acc] = await ctx.db('users').insert({ full_name: 'Accountant', username: 'acc1', password_hash: null, role: 'accountant', language: 'en', is_active: true, version: 0, created_at: ts2, updated_at: ts2 }).returning('id');
  // products
  const products = [
    { name_en: 'Black Pepper', name_local: 'Lada Hitam', aliases: ['lada hitam', 'black pepper'] },
    { name_en: 'Chicken Eggs', name_local: '鸡蛋', aliases: ['eggs', 'telur'] },
    { name_en: 'Rice Rambutan 10kg', name_local: null, aliases: ['beras cap rambutan'] },
    { name_en: 'Cooking Oil 5kg', name_local: 'Minyak Masak', aliases: [] },
  ];
  const productIds = {};
  for (const p of products) {
    const [id] = await ctx.db('products').insert({ name_en: p.name_en, name_local: p.name_local, aliases: JSON.stringify(p.aliases), quality_status: 'active', is_active: true, version: 0, created_at: ts2, updated_at: ts2 }).returning('id');
    productIds[p.name_en] = typeof id === 'object' ? id.id : id;
  }
  return {
    branchId, branchId2,
    managerId: typeof mgr === 'object' ? mgr.id : mgr,
    employeeId: typeof emp === 'object' ? emp.id : emp,
    accountantId: typeof acc === 'object' ? acc.id : acc,
    tgManagerId: 111, tgEmployeeId: 222, // telegram_id values used in mock updates
    productIds,
    klInvoiceChat: -1001, klRequestChat: -2002,
  };
}

function now() { return new Date().toISOString(); }

// Telegram update builders (mock transport payloads)
export function tgText(chatId, fromId, text, updateId = Date.now()) {
  return { update_id: updateId, message: { message_id: Math.floor(Math.random() * 1e6), chat: { id: chatId, type: chatId < 0 ? 'supergroup' : 'private' }, from: { id: fromId, first_name: 'Test', language_code: 'en' }, text, date: Math.floor(Date.now() / 1000) } };
}
export function tgPhoto(chatId, fromId, buffer, updateId = Date.now()) {
  return { update_id: updateId, message: { message_id: Math.floor(Math.random() * 1e6), chat: { id: chatId, type: 'supergroup' }, from: { id: fromId, first_name: 'Test' }, photo: [{ file_id: 'x', file_size: 100 }, { file_id: 'x2', file_size: 200 }], date: Math.floor(Date.now() / 1000), _mockBuffer: buffer, _mockMime: 'image/png' } };
}
export function tgVoice(chatId, fromId, buffer, updateId = Date.now()) {
  return { update_id: updateId, message: { message_id: Math.floor(Math.random() * 1e6), chat: { id: chatId, type: 'supergroup' }, from: { id: fromId, first_name: 'Test' }, voice: { file_id: 'v1', mime_type: 'audio/ogg' }, date: Math.floor(Date.now() / 1000), _mockBuffer: buffer, _mockMime: 'audio/ogg' } };
}

export async function pushUpdate(app, update) {
  return app.inject({ method: 'POST', url: '/dev/mock-telegram/update', payload: update });
}
export async function outbox(app) {
  const r = await app.inject({ method: 'GET', url: '/dev/mock-telegram/outbox' });
  return r.json().items;
}
