// src/api/index.js — all HTTP routes. Auth guard on every sensitive call (§13); optimistic locking via version.
import { signSession, verifySession, loginRateLimited, recordLoginAttempt, findUserByCredentials, loadActiveUser, createOwner } from '../auth.js';
import { permissionCheck, ACTIONS, branchScope, effectivePermissions } from '../permissions.js';
import { log, EV } from '../logging.js';
import { nowIso, randomToken, jsonOf, b, clampInt } from '../util.js';
import { audit } from '../audit.js';
import { testTelegram, testGemini, testR2, testNeon, logServiceTest } from '../settings.js';
import { DEFAULT_SETTINGS } from '../settings.js';

async function currentUser(ctx, req) {
  const token = req.cookies?.session;
  if (!token) return null;
  const payload = verifySession(ctx.sessionSecret, token);
  if (!payload) return null;
  return loadActiveUser(ctx.db, payload.uid);
}

function deny(reply, req, action, user) {
  log.warn(EV.AUTH_DENIED, { user_id: user ? String(user.id) : null, meta: { action, url: req.url } });
  return reply.code(403).send({ error: { code: 'FORBIDDEN', message_en: 'Not allowed', message_ar: 'غير مسموح' } });
}

export function guard(action, { allowUnconfigured = false } = {}) {
  return async function (req, reply) {
    const user = await currentUser(this.ctx, req); // bound in route registration
    if (!user) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message_en: 'Login required', message_ar: 'يلزم تسجيل الدخول' } });
    const branchId = req.body?.branch_id ?? null;
    const check = permissionCheck(user, action, { branchId: branchId ? Number(branchId) : null });
    if (!check.ok) return deny(reply, req, action, user);
    req.user = user;
  };
}

async function requireUser(ctx, req) {
  const user = await currentUser(ctx, req);
  if (!user) { const e = new Error('unauthenticated'); e.statusCode = 401; e.code = 'UNAUTHENTICATED'; throw e; }
  return user;
}

export async function registerApi(app, ctx) {
  ctx.sessionSecret = await ctx.settings.getSecret('jwt_secret') ?? 'dev-session-secret-unconfigured';
  app.decorate('ctx', ctx);

  // ---------- telegram webhook (F1) ----------
  app.post('/telegram-webhook', async (req, reply) => {
    const secret = req.headers['x-telegram-bot-api-secret-token'];
    if (ctx.transport.mode !== 'real') return reply.code(200).send({ ok: false, reason: 'mock mode' });
    if (!secret || secret !== ctx.config.telegram.webhookSecret) {
      log.warn('telegram.bad_secret', { status: 'error' });
      return reply.code(401).send({ ok: false });
    }
    try {
      const { processUpdate } = await import('../telegram/intake.js');
      await processUpdate(ctx, req.body);
    } catch {
      // non-200 lets Telegram retry — but duplicate protection makes retries safe (F1)
      return reply.code(500).send({ ok: false });
    }
    return reply.code(200).send({ ok: true });
  });

  // ---------- dev mock telegram intake (D-S15; mock mode only) ----------
  app.post('/dev/mock-telegram/update', async (req, reply) => {
    if (ctx.transport.mode === 'real') return reply.code(404).send({ error: { code: 'NOT_FOUND', message_en: 'not in mock mode' } });
    const { processUpdate } = await import('../telegram/intake.js');
    await processUpdate(ctx, req.body);
    return reply.code(200).send({ ok: true });
  });
  app.get('/dev/mock-telegram/outbox', async (req, reply) => {
    if (ctx.transport.mode === 'real') return reply.code(404).send({});
    return reply.code(200).send({ items: ctx.outbox.all() });
  });

  // ---------- setup wizard (D-S16) ----------
  app.get('/api/v1/setup/status', async (_req, reply) => reply.code(200).send({
    configured: ctx.config.configured,
    modes: { telegram: ctx.config.telegram.mode, ai: ctx.config.ai.provider, storage: ctx.config.storage.mode },
    steps: {
      owner: (await ctx.db('users').where({ role: 'owner', is_active: true }).count({ c: 'id' }).first()).c > 0,
      telegram: ctx.config.telegram.mode === 'real' ? Boolean(ctx.config.telegram.token) : true,
    },
  }));

  app.post('/api/v1/setup/owner', async (req, reply) => {
    const owners = await ctx.db('users').where({ role: 'owner', is_active: true }).count({ c: 'id' }).first();
    if (Number(owners.c) > 0) return reply.code(403).send({ error: { code: 'FORBIDDEN', message_en: 'Owner already exists', message_ar: 'المالك موجود مسبقاً' } });
    const { username, password, full_name } = req.body ?? {};
    if (!username || !password || String(password).length < 8) return reply.code(400).send({ error: { code: 'VALIDATION', message_en: 'username + password(8+) required', message_ar: 'اسم المستخدم وكلمة مرور (8+) مطلوبة' } });
    const id = await createOwner(ctx.db, { username, password, full_name: full_name ?? username });
    return reply.code(201).send({ id });
  });

  app.post('/api/v1/setup/test/:service', async (req, reply) => {
    const { service } = req.params;
    const body = req.body ?? {};
    try {
      let r;
      if (service === 'telegram') r = await testTelegram(body.token);
      else if (service === 'gemini') r = await testGemini(body.apiKey);
      else if (service === 'r2') r = await testR2(body);
      else if (service === 'neon') r = await testNeon(body.connectionString);
      else return reply.code(404).send({ error: { code: 'NOT_FOUND', message_en: 'unknown service' } });
      logServiceTest(service, true, null, null);
      return reply.code(200).send(r);
    } catch (e) {
      logServiceTest(service, false, e.message, null);
      return reply.code(400).send({ error: { code: 'TEST_FAILED', message_en: e.message, message_ar: e.message } });
    }
  });

  app.post('/api/v1/setup/complete', async (req, reply) => {
    const owners = await ctx.db('users').where({ role: 'owner', is_active: true }).count({ c: 'id' }).first();
    if (Number(owners.c) === 0) return reply.code(403).send({ error: { code: 'FORBIDDEN', message_en: 'Create owner first', message_ar: 'أنشئ حساب المالك أولاً' } });
    const b2 = req.body ?? {};
    const s = { ...DEFAULT_SETTINGS };
    for (const k of Object.keys(s)) if (b2.settings?.[k] !== undefined) s[k] = b2.settings[k];
    for (const k of Object.keys(s)) await ctx.settings.setSetting(k, s[k]);
    const secrets = b2.secrets ?? {};
    if (secrets.telegram_bot_token) await ctx.settings.setSecret('telegram_bot_token', secrets.telegram_bot_token);
    await ctx.settings.setSecret('telegram_webhook_secret', secrets.telegram_webhook_secret ?? randomToken(24));
    if (secrets.gemini_api_key) await ctx.settings.setSecret('gemini_api_key', secrets.gemini_api_key);
    if (secrets.r2_account_id) await ctx.settings.setSecret('r2_account_id', secrets.r2_account_id);
    if (secrets.r2_access_key_id) await ctx.settings.setSecret('r2_access_key_id', secrets.r2_access_key_id);
    if (secrets.r2_secret_access_key) await ctx.settings.setSecret('r2_secret_access_key', secrets.r2_secret_access_key);
    if (secrets.r2_bucket) await ctx.settings.setSecret('r2_bucket', secrets.r2_bucket);
    if (!(await ctx.settings.getSecret('jwt_secret'))) await ctx.settings.setSecret('jwt_secret', randomToken(32));
    if (!(await ctx.settings.getSecret('backup_encryption_key'))) await ctx.settings.setSecret('backup_encryption_key', randomToken(32));
    await ctx.settings.setSetting('configured', true);
    ctx.settings.invalidateCaches();
    // rebind runtime
    const { buildRuntimeConfig } = await import('../settings.js');
    ctx.config = await buildRuntimeConfig(ctx.settings, ctx.db);
    ctx.sessionSecret = await ctx.settings.getSecret('jwt_secret');
    const { makeTransport } = await import('../telegram/transport.js');
    ctx.transport = makeTransport(ctx.config, ctx.outbox);
    const { makeStorage } = await import('../storage.js');
    ctx.storage = makeStorage(ctx.config);
    const { makeAI } = await import('../ai.js');
    ctx.ai = makeAI(ctx.config);
    const { registerWebhookIfReal } = await import('../telegram/intake.js');
    await registerWebhookIfReal(ctx);
    await audit(ctx.db, { eventType: 'setup.completed', actorType: 'user', entityType: 'settings', action: 'configure', meta: { modes: { telegram: ctx.config.telegram.mode, ai: ctx.config.ai.provider, storage: ctx.config.storage.mode } } });
    return reply.code(200).send({ ok: true });
  });

  // ---------- auth ----------
  app.post('/api/v1/auth/login', {
    config: { rateLimit: false },
  }, async (req, reply) => {
    const ip = req.ip;
    if (loginRateLimited(ip)) return reply.code(429).send({ error: { code: 'RATE_LIMITED', message_en: 'Too many attempts', message_ar: 'محاولات كثيرة' } });
    recordLoginAttempt(ip);
    const { username, password } = req.body ?? {};
    const user = await findUserByCredentials(ctx.db, username ?? '', password ?? '');
    if (!user) {
      log.warn(EV.AUTH_LOGIN_FAIL, { meta: { username: username ?? '', ip } });
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message_en: 'Invalid credentials', message_ar: 'بيانات دخول خاطئة' } });
    }
    const token = signSession(ctx.sessionSecret, { uid: user.id, role: user.role });
    reply.setCookie('session', token, { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: '/' });
    log.info(EV.AUTH_LOGIN_OK, { user_id: String(user.id) });
    return reply.code(200).send({ id: user.id, full_name: user.full_name, role: user.role, language: user.language });
  });

  app.post('/api/v1/auth/logout', async (req, reply) => { reply.clearCookie('session', { path: '/' }); return reply.code(200).send({ ok: true }); });

  app.get('/api/v1/auth/me', async (req, reply) => {
    try {
      const user = await requireUser(ctx, req);
      return reply.code(200).send({ id: user.id, username: user.username, full_name: user.full_name, role: user.role, branch_id: user.branch_id, language: user.language, permissions: [...effectivePermissions(user)], scope: branchScope(user) });
    } catch (e) { return reply.code(e.statusCode ?? 500).send({ error: { code: e.code ?? 'INTERNAL', message_en: e.message } }); }
  });

  // ---------- summary ----------
  app.get('/api/v1/summary', { preHandler: guard(ACTIONS.VIEW_SUMMARY) }, async (req, reply) => {
    const from = req.query.from ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const to = req.query.to ?? new Date().toISOString().slice(0, 10);
    const scope = branchScope(req.user);
    const base = ctx.db('approved_purchases as ap').where('ap.is_reversal', false).where('ap.purchased_at', '>=', from).where('ap.purchased_at', '<=', `${to}T23:59:59Z`);
    if (scope) base.whereIn('ap.branch_id', scope);
    const [{ total } = { total: 0 }] = await base.clone().sum({ total: 'ap.line_total' });
    const byBranch = await base.clone().join('branches as br', 'br.id', 'ap.branch_id').groupBy('br.name_en').select('br.name_en as name').sum({ total: 'ap.line_total' });
    const openReq = await ctx.db('v_open_requests').modify((q) => { if (scope) q.whereIn('branch_id', scope); }).count({ c: 'request_item_id' }).first();
    const pendingInv = await ctx.db('invoices').whereIn('status', ['draft', 'in_review']).modify((q) => { if (scope) q.whereIn('branch_id', scope); }).count({ c: 'id' }).first();
    const { queueStats } = await import('../queue.js');
    const queue = await queueStats(ctx.db);
    return reply.code(200).send({
      period: { from, to },
      approved_total: Number(total ?? 0),
      by_branch: byBranch.map((r) => ({ name: r.name, total: Number(r.total ?? 0) })),
      open_requests: Number(openReq?.c ?? 0),
      invoices_pending: Number(pendingInv?.c ?? 0),
      ai_queue: queue,
    });
  });

  // ---------- branches / users / categories / stores (MGMT actions) ----------
  app.get('/api/v1/branches', { preHandler: guard(ACTIONS.MANAGE_BRANCHES) }, async (req, reply) => reply.code(200).send({ items: await ctx.db('branches').orderBy('id') }));
  app.post('/api/v1/branches', { preHandler: guard(ACTIONS.MANAGE_BRANCHES) }, async (req, reply) => {
    const { name_en, name_ar } = req.body ?? {};
    const ts = nowIso();
    const [id] = await ctx.db('branches').insert({ name_en, name_ar, is_active: true, version: 0, created_at: ts, updated_at: ts }).returning('id');
    await audit(ctx.db, { eventType: 'branch.created', actorType: 'user', actorId: req.user.id, entityType: 'branch', entityId: typeof id === 'object' ? id.id : id, action: 'create' });
    return reply.code(201).send({ id: typeof id === 'object' ? id.id : id });
  });
  app.patch('/api/v1/branches/:id', { preHandler: guard(ACTIONS.MANAGE_BRANCHES) }, async (req, reply) => {
    const row = await ctx.db('branches').where({ id: Number(req.params.id) }).first();
    if (!row) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    const { updateWithVersion } = await import('../audit.js');
    const r = await updateWithVersion(ctx.db, 'branches', row.id, row.version, { ...req.body, version: undefined }, { eventType: 'branch.updated', actorType: 'user', actorId: req.user.id });
    if (!r.ok) return reply.code(409).send({ error: { code: 'CONFLICT', message_en: 'Modified by another user — refresh and retry', message_ar: 'عدّلها مستخدم آخر — حدّث وأعد المحاولة' } });
    return reply.code(200).send({ ok: true });
  });

  app.get('/api/v1/users', { preHandler: guard(ACTIONS.MANAGE_USERS) }, async (req, reply) => {
    const rows = await ctx.db('users').select('id', 'username', 'full_name', 'role', 'branch_id', 'telegram_id', 'language', 'is_active', 'version');
    return reply.code(200).send({ items: rows.map((r) => ({ ...r, is_active: b(r.is_active) })) });
  });
  app.post('/api/v1/users', { preHandler: guard(ACTIONS.MANAGE_USERS) }, async (req, reply) => {
    const { username, password, full_name, role, branch_id, language } = req.body ?? {};
    const { hashPassword } = await import('../auth.js');
    const ts = nowIso();
    const [id] = await ctx.db('users').insert({
      username: username ?? null, password_hash: password ? await hashPassword(password) : null,
      full_name, role, branch_id: branch_id ?? null, language: language ?? 'en',
      is_active: true, version: 0, created_at: ts, updated_at: ts,
    }).returning('id');
    await audit(ctx.db, { eventType: 'user.created', actorType: 'user', actorId: req.user.id, entityType: 'user', entityId: typeof id === 'object' ? id.id : id, action: 'create', meta: { role } });
    return reply.code(201).send({ id: typeof id === 'object' ? id.id : id });
  });
  app.patch('/api/v1/users/:id', { preHandler: guard(ACTIONS.MANAGE_USERS) }, async (req, reply) => {
    const row = await ctx.db('users').where({ id: Number(req.params.id) }).first();
    if (!row) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    const patch = { ...req.body };
    delete patch.password_hash;
    if (patch.password) { const { hashPassword } = await import('../auth.js'); patch.password_hash = await hashPassword(patch.password); delete patch.password; }
    const { updateWithVersion } = await import('../audit.js');
    const r = await updateWithVersion(ctx.db, 'users', row.id, row.version, patch, { eventType: 'user.updated', actorType: 'user', actorId: req.user.id });
    if (!r.ok) return reply.code(409).send({ error: { code: 'CONFLICT' } });
    return reply.code(200).send({ ok: true });
  });
  app.post('/api/v1/users/:id/pair-code', { preHandler: guard(ACTIONS.MANAGE_USERS) }, async (req, reply) => {
    const code = randomToken(6).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase();
    await ctx.settings.setSetting(`pair_${code}`, { user_id: Number(req.params.id), created_at: nowIso() });
    return reply.code(200).send({ code, instructions: 'User sends: PAIR <code> to the bot in private chat' });
  });

  app.get('/api/v1/expense-categories', { preHandler: guard(ACTIONS.MANAGE_PRODUCTS) }, async (req, reply) => reply.code(200).send({ items: await ctx.db('expense_categories') }));
  app.post('/api/v1/expense-categories', { preHandler: guard(ACTIONS.MANAGE_PRODUCTS) }, async (req, reply) => {
    const ts = nowIso();
    const [id] = await ctx.db('expense_categories').insert({ name_en: req.body.name_en, name_ar: req.body.name_ar, is_active: true, version: 0, created_at: ts, updated_at: ts }).returning('id');
    return reply.code(201).send({ id: typeof id === 'object' ? id.id : id });
  });

  app.get('/api/v1/stores', { preHandler: guard(ACTIONS.VIEW_REPORTS) }, async (req, reply) => reply.code(200).send({ items: await ctx.db('stores').where({ is_active: true }) }));
  app.post('/api/v1/stores', { preHandler: guard(ACTIONS.MANAGE_PRODUCTS) }, async (req, reply) => {
    const ts = nowIso();
    const [id] = await ctx.db('stores').insert({ name: req.body.name, kind: req.body.kind ?? 'both', aliases: '[]', trip_cost: req.body.trip_cost ?? 0, min_savings_threshold: req.body.min_savings_threshold ?? 0, is_active: true, version: 0, created_at: ts, updated_at: ts }).returning('id');
    return reply.code(201).send({ id: typeof id === 'object' ? id.id : id });
  });
  app.put('/api/v1/stores/:id/trip-settings', { preHandler: guard(ACTIONS.MANAGE_TRIPS) }, async (req, reply) => {
    const { setTripSettings } = await import('../services/prices.js');
    const r = await setTripSettings(ctx, { storeId: Number(req.params.id), tripCost: req.body.trip_cost, minSavingsThreshold: req.body.min_savings_threshold, actor: req.user });
    return r.ok ? reply.code(200).send({ ok: true }) : reply.code(409).send({ error: { code: 'CONFLICT' } });
  });

  // ---------- products ----------
  app.get('/api/v1/products', { preHandler: guard(ACTIONS.VIEW_SUMMARY) }, async (req, reply) => {
    const { searchProducts } = await import('../services/products.js');
    return reply.code(200).send({ items: await searchProducts(ctx.db, req.query.q) });
  });
  app.post('/api/v1/products', { preHandler: guard(ACTIONS.MANAGE_PRODUCTS) }, async (req, reply) => {
    const { createProduct } = await import('../services/products.js');
    const id = await createProduct(ctx, req.body ?? {}, req.user);
    return reply.code(201).send({ id });
  });
  app.patch('/api/v1/products/:id', { preHandler: guard(ACTIONS.MANAGE_PRODUCTS) }, async (req, reply) => {
    const { updateProduct } = await import('../services/products.js');
    const r = await updateProduct(ctx, Number(req.params.id), Number(req.body?.version ?? 0), { ...req.body, version: undefined }, req.user);
    return r.ok ? reply.code(200).send({ ok: true }) : reply.code(409).send({ error: { code: 'CONFLICT' } });
  });
  app.post('/api/v1/products/unify', { preHandler: guard(ACTIONS.MANAGE_PRODUCTS) }, async (req, reply) => {
    const { unifyProducts } = await import('../services/products.js');
    const r = await unifyProducts(ctx, { keepId: Number(req.body.keep_id), mergeIds: (req.body.merge_ids ?? []).map(Number), actor: req.user });
    return r.ok ? reply.code(200).send({ ok: true }) : reply.code(500).send({ error: { code: 'INTERNAL' } });
  });
  app.get('/api/v1/products/match-candidates', { preHandler: guard(ACTIONS.MANAGE_PRODUCTS) }, async (req, reply) => {
    const { matchCandidates } = await import('../services/products.js');
    return reply.code(200).send({ items: await matchCandidates(ctx.db) });
  });
  app.post('/api/v1/products/:id/quality-notes', { preHandler: guard(ACTIONS.MANAGE_PRODUCTS) }, async (req, reply) => {
    const { addQualityNote, setExcluded } = await import('../services/products.js');
    if (req.body.excluded !== undefined) await setExcluded(ctx, { productId: Number(req.params.id), excluded: b(req.body.excluded), actor: req.user });
    const id = await addQualityNote(ctx, { productId: Number(req.params.id), note: req.body.note, noteDate: req.body.note_date, actor: req.user });
    return reply.code(201).send({ id });
  });

  // ---------- requests ----------
  app.get('/api/v1/requests', { preHandler: guard(ACTIONS.VIEW_SUMMARY) }, async (req, reply) => {
    const scope = branchScope(req.user);
    let q = ctx.db('v_open_requests').join('products as p', 'p.id', 'v_open_requests.product_id').select('v_open_requests.*', 'p.name_en as product_name');
    if (scope) q = q.whereIn('branch_id', scope);
    if (req.query.late === 'true' && req.query.late !== undefined) { const { lateRequests } = await import('../services/requests.js'); return reply.code(200).send({ items: await lateRequests(ctx.db) }); }
    return reply.code(200).send({ items: await q });
  });
  app.patch('/api/v1/requests/:id', { preHandler: guard(ACTIONS.CORRECT_INVOICE) }, async (req, reply) => {
    const { setRequestStatus } = await import('../services/requests.js');
    const r = await setRequestStatus(ctx, { requestId: Number(req.params.id), status: req.body.status, actor: req.user });
    return r.ok ? reply.code(200).send({ ok: true }) : reply.code(409).send({ error: { code: 'CONFLICT' } });
  });
  app.get('/api/v1/requests/:itemId/modifications', { preHandler: guard(ACTIONS.VIEW_SUMMARY) }, async (req, reply) => {
    const { requestModificationHistory } = await import('../services/requests.js');
    return reply.code(200).send({ items: await requestModificationHistory(ctx.db, Number(req.params.itemId)) });
  });

  // ---------- invoices ----------
  app.get('/api/v1/invoices', { preHandler: guard(ACTIONS.VIEW_SUMMARY) }, async (req, reply) => {
    const scope = branchScope(req.user);
    let q = ctx.db('invoices as i').join('branches as b', 'b.id', 'i.branch_id')
      .select('i.id', 'i.status', 'i.invoice_number', 'i.invoice_date', 'i.invoice_total', 'i.detected_language', 'i.duplicate_flag', 'i.discrepancy_flag', 'i.created_at', 'b.name_en as branch_name');
    if (scope) q = q.whereIn('i.branch_id', scope);
    if (req.query.status) q = q.where({ 'i.status': req.query.status });
    if (req.query.flag === 'duplicate') q = q.where({ 'i.duplicate_flag': true });
    if (req.query.flag === 'discrepancy') q = q.where({ 'i.discrepancy_flag': true });
    const items = await q.orderBy('i.id', 'desc').limit(clampInt(req.query.limit, 1, 200, 50));
    return reply.code(200).send({ items: items.map((r) => ({ ...r, duplicate_flag: b(r.duplicate_flag), discrepancy_flag: b(r.discrepancy_flag) })) });
  });
  app.get('/api/v1/invoices/:id', { preHandler: guard(ACTIONS.VIEW_SUMMARY) }, async (req, reply) => {
    const { buildReviewData } = await import('../services/invoices.js');
    const data = await buildReviewData(ctx.db, Number(req.params.id));
    if (!data.invoice) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    const check = permissionCheck(req.user, ACTIONS.VIEW_SUMMARY, { branchId: data.invoice.branch_id });
    if (!check.ok) return deny(reply, req, 'invoice.read', req.user);
    return reply.code(200).send({
      invoice: { ...data.invoice, duplicate_flag: b(data.invoice.duplicate_flag), discrepancy_flag: b(data.invoice.discrepancy_flag) },
      items: data.items.map((i) => ({ ...i, needs_review: b(i.needs_review), is_excess: b(i.is_excess), is_new_product: b(i.is_new_product) })),
    });
  });
  app.post('/api/v1/invoices/:id/corrections', { preHandler: guard(ACTIONS.CORRECT_INVOICE) }, async (req, reply) => {
    const { applyCorrection } = await import('../services/invoices.js');
    const r = await applyCorrection(ctx, Number(req.params.id), req.body, req.user);
    return r.ok ? reply.code(200).send({ ok: true, item: r.item }) : reply.code(r.reason === 'conflict' ? 409 : 400).send({ error: { code: r.reason === 'conflict' ? 'CONFLICT' : 'VALIDATION', message_en: r.reason } });
  });
  app.post('/api/v1/invoices/:id/confirm-item', { preHandler: guard(ACTIONS.CORRECT_INVOICE) }, async (req, reply) => {
    const { confirmItem } = await import('../services/invoices.js');
    const r = await confirmItem(ctx, Number(req.params.id), req.body.symbol, req.user);
    return r.ok ? reply.code(200).send({ ok: true }) : reply.code(400).send({ error: { code: 'VALIDATION', message_en: r.reason } });
  });
  app.post('/api/v1/invoices/:id/approve', { preHandler: guard(ACTIONS.APPROVE_INVOICE) }, async (req, reply) => {
    const { approveInvoice } = await import('../services/invoices.js');
    const r = await approveInvoice(ctx, { invoiceId: Number(req.params.id), actor: req.user, expectedVersion: Number(req.body?.version ?? 0), note: req.body?.discrepancy_note ?? null });
    return r.ok ? reply.code(200).send({ ok: true }) : reply.code(r.reason === 'conflict' ? 409 : 400).send({ error: { code: r.reason === 'conflict' ? 'CONFLICT' : 'VALIDATION', message_en: r.reason, message_ar: 'تعارض أو حالة غير صالحة' } });
  });
  app.post('/api/v1/invoices/:id/reject', { preHandler: guard(ACTIONS.APPROVE_INVOICE) }, async (req, reply) => {
    const { rejectInvoice } = await import('../services/invoices.js');
    const r = await rejectInvoice(ctx, { invoiceId: Number(req.params.id), actor: req.user, reason: req.body?.reason });
    return r.ok ? reply.code(200).send({ ok: true }) : reply.code(400).send({ error: { code: 'VALIDATION', message_en: r.reason } });
  });
  app.post('/api/v1/invoices/:id/amend', { preHandler: guard(ACTIONS.AMEND_APPROVED) }, async (req, reply) => {
    const { amendApprovedInvoice } = await import('../services/invoices.js');
    const r = await amendApprovedInvoice(ctx, { invoiceId: Number(req.params.id), actor: req.user, corrections: req.body?.corrections ?? [] });
    return r.ok ? reply.code(200).send({ ok: true }) : reply.code(400).send({ error: { code: 'VALIDATION', message_en: r.reason ?? 'failed' } });
  });
  app.get('/api/v1/invoices/:id/events', { preHandler: guard(ACTIONS.VIEW_SUMMARY) }, async (req, reply) => {
    const { queryAudit } = await import('../audit.js');
    return reply.code(200).send({ items: await queryAudit(ctx.db, { entityType: 'invoice', entityId: Number(req.params.id), limit: 200 }) });
  });

  // ---------- prices ----------
  app.post('/api/v1/prices/observed', { preHandler: guard(ACTIONS.RECORD_OBSERVED_PRICE) }, async (req, reply) => {
    const { recordObservedPrice } = await import('../services/prices.js');
    const r = await recordObservedPrice(ctx, { ...req.body, actorId: req.user.id });
    return r.ok ? reply.code(201).send({ id: r.id }) : reply.code(400).send({ error: { code: 'VALIDATION', message_en: r.reason } });
  });
  app.get('/api/v1/prices/history', { preHandler: guard(ACTIONS.VIEW_REPORTS) }, async (req, reply) => {
    const { priceHistory } = await import('../services/prices.js');
    if (!req.query.product_id) return reply.code(400).send({ error: { code: 'VALIDATION', message_en: 'product_id required' } });
    return reply.code(200).send(await priceHistory(ctx.db, { productId: Number(req.query.product_id), storeId: req.query.store_id ? Number(req.query.store_id) : null, days: clampInt(req.query.days, 1, 365, 90) }));
  });
  app.get('/api/v1/prices/compare', { preHandler: guard(ACTIONS.MANAGE_TRIPS) }, async (req, reply) => {
    const { compareStores } = await import('../services/prices.js');
    const productIds = String(req.query.products ?? '').split(',').map(Number).filter(Boolean);
    const storeIds = String(req.query.stores ?? '').split(',').map(Number).filter(Boolean);
    return reply.code(200).send(await compareStores(ctx, { productIds, storeIds }));
  });

  // ---------- files (private, proxied — §13) ----------
  app.get('/api/v1/files/:id', { preHandler: guard(ACTIONS.VIEW_SUMMARY) }, async (req, reply) => {
    const { getFileBuffer } = await import('../files.js');
    const f = await getFileBuffer(ctx, req.params.id);
    if (!f) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    return reply.header('content-type', f.row.mime).send(f.buf);
  });

  // ---------- AI queue + settings + usage ----------
  app.get('/api/v1/ai/queue', { preHandler: guard(ACTIONS.MANAGE_AI) }, async (req, reply) => {
    let q = ctx.db('pending_ai_tasks').orderBy('id', 'desc').limit(100);
    if (req.query.status) q = q.where({ status: req.query.status });
    return reply.code(200).send({ items: await q, stats: await (await import('../queue.js')).queueStats(ctx.db) });
  });
  app.post('/api/v1/ai/queue/:id/retry', { preHandler: guard(ACTIONS.MANAGE_AI) }, async (req, reply) => {
    const { retryTask } = await import('../queue.js');
    await retryTask(ctx, Number(req.params.id));
    return reply.code(200).send({ ok: true });
  });
  app.get('/api/v1/ai/usage', { preHandler: guard(ACTIONS.MANAGE_AI) }, async (req, reply) => {
    const day = new Date().toISOString().slice(0, 10);
    const rows = await ctx.db('ai_call_logs').where('created_at', '>=', `${day}T00:00:00.000Z`).select();
    return reply.code(200).send({
      today: rows.length, cap: ctx.config.ai.dailyGlobalCap, pct: Math.round((rows.length / ctx.config.ai.dailyGlobalCap) * 100),
      warnPct: ctx.config.ai.warnPct,
      per_model: Object.entries(rows.reduce((acc, r) => { acc[r.model] = (acc[r.model] ?? 0) + 1; return acc; }, {})).map(([model, count]) => ({ model, count })),
    });
  });
  app.get('/api/v1/ai/settings', { preHandler: guard(ACTIONS.MANAGE_AI) }, async (req, reply) => reply.code(200).send({ settings: ctx.config.raw, provider: ctx.config.ai.provider, hasKey: Boolean(ctx.config.ai.apiKey) }));
  app.put('/api/v1/ai/settings', { preHandler: guard(ACTIONS.MANAGE_AI) }, async (req, reply) => {
    const allowed = ['ai_provider', 'ai_model_primary', 'ai_model_fallbacks', 'ai_daily_global_cap', 'ai_daily_per_user_cap', 'ai_burst_per_min', 'ai_warn_threshold_pct'];
    const patch = req.body ?? {};
    for (const k of allowed) if (patch[k] !== undefined) await ctx.settings.setSetting(k, patch[k]);
    if (patch.gemini_api_key) await ctx.settings.setSecret('gemini_api_key', patch.gemini_api_key);
    ctx.settings.invalidateCaches();
    const { buildRuntimeConfig } = await import('../settings.js');
    ctx.config = await buildRuntimeConfig(ctx.settings, ctx.db);
    ctx.ai = (await import('../ai.js')).makeAI(ctx.config);
    await audit(ctx.db, { eventType: 'ai.settings_changed', actorType: 'user', actorId: req.user.id, entityType: 'settings', action: 'update', meta: { keys: Object.keys(patch) } });
    return reply.code(200).send({ ok: true });
  });

  // ---------- logs ----------
  app.get('/api/v1/logs', { preHandler: guard(ACTIONS.VIEW_LOGS) }, async (req, reply) => {
    let q = ctx.db('audit_log').orderBy('id', 'desc').limit(clampInt(req.query.limit, 1, 500, 100));
    if (req.query.event_type) q = q.where({ event_type: req.query.event_type });
    if (req.query.entity_type) q = q.where({ entity_type: req.query.entity_type });
    if (req.query.entity_id) q = q.where({ entity_id: Number(req.query.entity_id) });
    if (req.query.from) q = q.where('created_at', '>=', req.query.from);
    return reply.code(200).send({ items: await q });
  });

  // ---------- reports + export + temp links ----------
  app.post('/api/v1/reports/preview', { preHandler: guard(ACTIONS.VIEW_REPORTS) }, async (req, reply) => {
    const { buildReportData } = await import('../reports.js');
    return reply.code(200).send(await buildReportData(ctx, req.body ?? {}));
  });
  app.post('/api/v1/reports/export', { preHandler: guard(ACTIONS.EXPORT_REPORTS) }, async (req, reply) => {
    const { buildReportData, renderReportHtml } = await import('../reports.js');
    const { storeFile, keys } = await import('../files.js');
    const body = req.body ?? {};
    const data = await buildReportData(ctx, body);
    const token = randomToken(24);
    const filename = `report-${body.type}-${Date.now()}.${body.format === 'xlsx' ? 'xlsx' : 'pdf'}`;
    if (body.format === 'xlsx') {
      const { exportExcel, datasetToSheet } = await import('../excel.js');
      const rows = Array.isArray(data.rows) ? data.rows : [];
      const mapped = rows.map((r) => ({ ...r, line_total: r.total_sen ?? r.line_total }));
      const buf = exportExcel({ sheets: [{ name: body.type, rows: mapped.length ? mapped : [{ info: 'no data' }] }], lang: body.lang ?? 'en' });
      const stored = await storeFile(ctx, { kind: 'report', buffer: buf, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', keyOverride: keys.report(token, filename), filename });
      await storeFileMeta(ctx, stored.id, req.user.id);
    } else {
      const html = renderReportHtml({ data, lang: body.lang ?? 'en', meta: { title: body.type, period: `${body.filters?.from ?? ''} → ${body.filters?.to ?? ''}` } });
      const { renderPdf } = await import('../pdf.js');
      const buf = await renderPdf(html);
      const stored = await storeFile(ctx, { kind: 'report', buffer: buf, mime: 'application/pdf', keyOverride: keys.report(token, filename), filename });
      await storeFileMeta(ctx, stored.id, req.user.id);
    }
    const ttl = (ctx.config.raw.report_link_ttl_min ?? 15) * 60_000;
    await ctx.db('report_links').insert({ token, user_id: req.user.id, params: JSON.stringify(body), expires_at: new Date(Date.now() + ttl).toISOString(), created_at: nowIso(), revoked_at: null });
    log.info(EV.REPORT_LINK, { user_id: String(req.user.id), meta: { type: body.type, format: body.format } });
    return reply.code(200).send({ link: `/api/v1/reports/file/${token}`, expires_in: ttl / 1000 });
  });
  async function storeFileMeta(ctx2, fileId, userId) {
    await ctx2.db('files').where({ id: fileId }).update({ entity_type: 'report', entity_id: userId });
  }
  // temp link access: token + session identity + permission (D-S9, §11.2)
  app.get('/api/v1/reports/file/:token', async (req, reply) => {
    const user = await currentUser(ctx, req);
    if (!user) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message_en: 'Login required — link alone grants nothing' } });
    const link = await ctx.db('report_links').where({ token: req.params.token }).first();
    if (!link || link.revoked_at || new Date(link.expires_at) < new Date()) return reply.code(410).send({ error: { code: 'GONE', message_en: 'Link expired' } });
    if (Number(link.user_id) !== Number(user.id)) return deny(reply, req, 'report.link', user);
    const check = permissionCheck(user, ACTIONS.EXPORT_REPORTS, {});
    if (!check.ok) return deny(reply, req, 'report.link', user);
    const params = jsonOf(link.params) ?? {};
    const { buildReportData, renderReportHtml } = await import('../reports.js');
    const data = await buildReportData(ctx, params);
    if (params.format === 'xlsx') {
      const { exportExcel } = await import('../excel.js');
      const rows = Array.isArray(data.rows) ? data.rows : [];
      const buf = exportExcel({ sheets: [{ name: params.type, rows: rows.length ? rows : [{ info: 'no data' }] }], lang: params.lang ?? 'en' });
      return reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buf);
    }
    const html = renderReportHtml({ data, lang: params.lang ?? 'en', meta: { title: params.type } });
    const { renderPdf } = await import('../pdf.js');
    const buf = await renderPdf(html);
    return reply.header('content-type', 'application/pdf').send(buf);
  });

  // ---------- backups ----------
  app.post('/api/v1/backups', { preHandler: guard(ACTIONS.BACKUP) }, async (req, reply) => {
    const { createBackup } = await import('../backup.js');
    const r = await createBackup(ctx, req.user.id);
    return r.ok ? reply.code(201).send(r) : reply.code(500).send({ error: { code: 'INTERNAL', message_en: r.error } });
  });
  app.get('/api/v1/backups', { preHandler: guard(ACTIONS.BACKUP) }, async (req, reply) => reply.code(200).send({ items: await ctx.db('backups').orderBy('id', 'desc').limit(60) }));
  app.get('/api/v1/backups/:id/download', { preHandler: guard(ACTIONS.BACKUP) }, async (req, reply) => {
    const row = await ctx.db('backups').where({ id: Number(req.params.id) }).first();
    if (!row) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    const buf = await ctx.storage.get(row.r2_key);
    return reply.header('content-type', 'application/octet-stream').header('content-disposition', `attachment; filename="${row.r2_key.split('/').pop()}"`).send(buf);
  });
  app.post('/api/v1/backups/import', { preHandler: guard(ACTIONS.BACKUP) }, async (req, reply) => {
    const { verifyBackup } = await import('../backup.js');
    const body = req.body ?? {};
    const buf = Buffer.from(body.content_base64 ?? '', 'base64');
    const v = await verifyBackup(ctx, { buffer: buf, expectedSha256: body.sha256 ?? null });
    if (!v.ok) return reply.code(400).send({ error: { code: 'VALIDATION', message_en: v.reason } });
    if (body.confirm !== 'REPLACE') return reply.code(400).send({ error: { code: 'CONFIRMATION_REQUIRED', message_en: 'Send confirm=REPLACE after explicit warning' } });
    await audit(ctx.db, { eventType: 'backup.import_verified', actorType: 'user', actorId: req.user.id, entityType: 'backup', action: 'import_verify', meta: v.integrity });
    return reply.code(200).send({ ok: true, verification: v, note: 'Verified. Restoring replaces the live DB — run restoreJsonInto/pg_restore into a fresh DB then swap DATABASE_URL (docs/MIGRATION-VPS.md).' });
  });

  // ---------- services test (saved config) ----------
  app.post('/api/v1/services/:service/test', { preHandler: guard(ACTIONS.MANAGE_AI) }, async (req, reply) => {
    try {
      let r;
      if (req.params.service === 'telegram') r = await testTelegram(ctx.config.telegram.token);
      else if (req.params.service === 'gemini') r = await testGemini(ctx.config.ai.apiKey);
      else if (req.params.service === 'r2') r = await testR2({ accountId: ctx.config.storage.accountId, accessKeyId: ctx.config.storage.accessKeyId, secretAccessKey: ctx.config.storage.secretAccessKey, bucket: ctx.config.storage.bucket });
      else if (req.params.service === 'neon') r = await testNeon(process.env.DATABASE_URL ?? '');
      else return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
      logServiceTest(req.params.service, true, null, req.user.id);
      return reply.code(200).send(r);
    } catch (e) {
      logServiceTest(req.params.service, false, e.message, req.user.id);
      return reply.code(400).send({ error: { code: 'TEST_FAILED', message_en: e.message } });
    }
  });

  // ---------- language preference ----------
  app.post('/api/v1/auth/language', async (req, reply) => {
    const user = await requireUser(ctx, req);
    await ctx.db('users').where({ id: user.id }).update({ language: req.body?.language === 'ar' ? 'ar' : 'en', updated_at: nowIso() });
    return reply.code(200).send({ ok: true });
  });
}
