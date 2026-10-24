// src/db/migrate.js — CLI: node src/db/migrate.js [--migrate] [--seed]
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDbTarget, createDb, migrateLatest } from './knex.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const doMigrate = args.includes('--migrate') || args.length === 0;

const db = createDb(resolveDbTarget(process.env));
if (doMigrate) {
  mkdirSync(path.join(ROOT, '..', '..', 'data'), { recursive: true });
  await migrateLatest(db);
  console.log('migrations: up to date');
}
await db.destroy();
