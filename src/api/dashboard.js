// src/api/dashboard.js — static SPA serving (D-S4: zero-build vanilla ESM)
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dashboard');

export async function registerDashboard(app) {
  const { default: fastifyStatic } = await import('@fastify/static');
  await app.register(fastifyStatic, { root: ROOT, prefix: '/', index: 'index.html' });
}
