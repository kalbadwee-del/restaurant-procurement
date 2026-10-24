// src/audit.js — append-only audit log (§5.5, §13) + conflict event helper
import { nowIso } from './util.js';
import { log, EV } from './logging.js';

export async function audit(db, { eventType, actorType = 'system', actorId = null, entityType, entityId = null, action, before = null, after = null, meta = null }) {
  await db('audit_log').insert({
    event_type: eventType, actor_type: actorType, actor_id: actorId,
    entity_type: entityType, entity_id: entityId, action,
    before: before ? JSON.stringify(before) : null,
    after: after ? JSON.stringify(after) : null,
    meta: meta ? JSON.stringify(meta) : null,
    created_at: nowIso(),
  });
}

// Optimistic locking helper (design §02 §7): single uniform pattern.
// Returns {ok:true, row} or {ok:false, conflict:true}.
export async function updateWithVersion(db, table, id, expectedVersion, patch, { eventType = null, actorType = 'user', actorId = null, entityLabel = null } = {}) {
  const full = { ...patch, version: expectedVersion + 1, updated_at: nowIso() };
  const updated = await db(table).where({ id: Number(id), version: Number(expectedVersion) }).update(full);
  if (updated === 0) {
    log.warn(EV.CONFLICT, { meta: { table, id } });
    if (eventType) {
      await audit(db, { eventType, actorType, actorId, entityType: entityLabel || table, entityId: id, action: 'conflict', meta: { expectedVersion } });
    }
    return { ok: false, conflict: true };
  }
  return { ok: true };
}

export async function queryAudit(db, { entityType, entityId, from, to, limit = 100 }) {
  let q = db('audit_log').orderBy('id', 'desc').limit(Math.min(limit, 500));
  if (entityType) q = q.where({ entity_type: entityType });
  if (entityId) q = q.where({ entity_id: Number(entityId) });
  if (from) q = q.where('created_at', '>=', from);
  if (to) q = q.where('created_at', '<=', to);
  return q;
}
