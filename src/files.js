// src/files.js — file metadata + upload orchestration (R2 key scheme design/06 §5)
import { sha256, nowIso, klDateStr } from './util.js';
import { keys } from './storage.js';
export { keys };

export async function storeFile(ctx, { kind, buffer, mime, entityType = null, entityId = null, keyOverride = null, filename = 'file.bin' }) {
  const digest = sha256(buffer);
  const key = keyOverride ?? `${kind}/${klDateStr()}/${digest.slice(0, 12)}/${filename}`;
  await ctx.storage.put(key, buffer, mime);
  const [id] = await ctx.db('files').insert({
    kind, r2_key: key, mime, size_bytes: buffer.length, sha256: digest,
    entity_type: entityType, entity_id: entityId, uploaded_at: nowIso(), deleted_at: null, deleted_by: null,
  }).returning('id');
  return { id: typeof id === 'object' ? id.id : id, key, sha256: digest, size: buffer.length };
}

export async function getFileBuffer(ctx, fileId) {
  const row = await ctx.db('files').where({ id: Number(fileId) }).first();
  if (!row || row.deleted_at) return null;
  const buf = await ctx.storage.get(row.r2_key);
  return { row, buf };
}

// Owner retention policy (manager decision): manual selective deletion after final approval
export async function deleteFile(ctx, fileId, actorId) {
  const row = await ctx.db('files').where({ id: Number(fileId) }).first();
  if (!row) return false;
  await ctx.storage.delete(row.r2_key);
  await ctx.db('files').where({ id: row.id }).update({ deleted_at: nowIso(), deleted_by: actorId });
  const { log, EV } = await import('../logging.js');
  log.info(EV.FILE_DELETED, { meta: { fileId, key: row.r2_key } });
  return true;
}
