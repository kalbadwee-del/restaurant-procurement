// src/db/knex.js — dual-dialect Knex factory (D-S3): better-sqlite3 (tests/local) | pg (Neon production)
import knexLib from 'knex';

export function resolveDbTarget(env = process.env) {
  if (env.DATABASE_URL) return { client: 'pg', connection: env.DATABASE_URL, source: 'env:DATABASE_URL' };
  if (env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL is required in production (the single bootstrap anchor — see DECISIONS.md D-S1).');
  }
  return { client: 'sqlite', connection: { filename: env.DB_FILENAME || 'data/app.db' }, source: 'dev-default:sqlite' };
}

export function createDb(target) {
  if (target.client === 'pg') {
    return knexLib({
      client: 'pg',
      connection: target.connection,
      pool: { min: 0, max: 5, acquireTimeoutMillis: 15000 },
      migrations: { directory: new URL('./migrations/', import.meta.url).pathname },
    });
  }
  return knexLib({
    client: 'better-sqlite3',
    connection: target.connection,
    useNullAsDefault: true,
    pool: { min: 1, max: 1, afterCreate: (conn, done) => { conn.pragma('journal_mode = WAL'); conn.pragma('foreign_keys = ON'); done(); } },
    migrations: { directory: new URL('./migrations/', import.meta.url).pathname },
  });
}

export async function migrateLatest(db) {
  await db.migrate.latest();
}

// App-level id generator is NOT used — identity PKs per design. Helper for tests only.
export async function destroyDb(db) { await db.destroy(); }
