#!/usr/bin/env node
// src/server.js — composition root: config → db → migrations → settings/runtime → fastify → jobs.
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';

import { resolveDbTarget, createDb, migrateLatest } from './db/knex.js';
import { deriveMasterKey, Settings, buildRuntimeConfig } from './settings.js';
import { log, EV } from './logging.js';
import { TZ } from './util.js';
import { startJobs, stopJobs } from './jobs.js';
import { registerApi } from './api/index.js';
import { makeOutbox } from './telegram/outbox.js';

process.env.TZ = TZ;

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export async function buildApp(opts = {}) {
  const target = opts.dbTarget ?? resolveDbTarget(process.env);
  mkdirSync(path.join(ROOT, '..', 'data'), { recursive: true });
  const db = opts.db ?? createDb(target);
  if (!opts.db) await migrateLatest(db);

  const bootstrapSecret = target.client === 'pg' ? target.connection : (target.connection.filename || 'dev-sqlite');
  const masterKey = opts.masterKey ?? deriveMasterKey(bootstrapSecret);
  const settings = new Settings(db, masterKey);
  const config = await buildRuntimeConfig(settings, db);
  const outbox = makeOutbox();

  const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 15 * 1024 * 1024 });
  await app.register(cookie);

  const ctx = { db, settings, config, outbox, jobs: [], target, bootstrapSecret, transport: null, storage: null };

  // providers (D-S7): storage always; telegram transport (mock captures to outbox)
  const { makeStorage } = await import('./storage.js');
  ctx.storage = makeStorage(config);
  const { makeTransport } = await import('./telegram/transport.js');
  ctx.transport = makeTransport(config, outbox);
  const { makeAI } = await import('./ai.js');
  ctx.ai = makeAI(config);

  // C2: /health — static JSON, <1ms, zero DB/AI/IO, no system info (§2.1/§13)
  app.get('/health', (_req, reply) => reply.code(200).send({ status: 'ok' }));

  await registerApi(app, ctx);

  if (!opts.skipStatic) {
    const { registerDashboard } = await import('./api/dashboard.js');
    await registerDashboard(app);
  }

  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message_en: 'Not found', message_ar: 'غير موجود' } }));
  app.setErrorHandler((err, req, reply) => {
    if (err.statusCode && err.statusCode < 500) {
      reply.code(err.statusCode).send({ error: { code: err.code || 'VALIDATION', message_en: err.message, message_ar: err.message } });
    } else {
      log.error('server.error', { status: 'error', error: err.message, meta: { url: req.url } });
      reply.code(500).send({ error: { code: 'INTERNAL', message_en: 'Internal error', message_ar: 'خطأ داخلي' } });
    }
  });

  ctx.startJobs = () => startJobs(ctx);
  ctx.stopJobs = stopJobs;
  if (!opts.skipJobs) await startJobs(ctx);

  return { app, ctx };
}

export async function main() {
  const { app, ctx } = await buildApp();
  const port = Number(process.env.PORT || 8080);
  await app.listen({ port, host: '0.0.0.0' });
  log.info('server.started', { meta: { port, db: ctx.target.source, configured: ctx.config.configured } });
  const shutdown = async (sig) => {
    log.info('server.stopping', { meta: { sig } });
    ctx.stopJobs();
    await app.close();
    await ctx.db.destroy();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => { log.error('server.fatal', { status: 'error', error: e.message }); process.exit(1); });
}
