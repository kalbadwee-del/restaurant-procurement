// src/logging.js — structured JSON logging (design §2.6 / ops §C)
// Whitelist serializer: secrets/passwords/phones/PII can never leak by construction.
import { nowIso } from './util.js';

const REDACT_KEYS = /^(password|password_hash|token|secret|api_?key|authorization|cookie|phone|phone_number|image|image_data|audio|file_data)$/i;

function scrub(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 4) return '[deep]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1));
  if (value instanceof Buffer) return `<buffer ${value.length}B>`;
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (REDACT_KEYS.test(k)) out[k] = '[redacted]';
      else out[k] = scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

let LEVEL = process.env.LOG_LEVEL === 'debug' ? 'debug' : process.env.LOG_LEVEL === 'error' ? 'error' : 'info';
const ORDER = { debug: 10, info: 20, warn: 30, error: 40 };
export function setLogLevel(l) { if (ORDER[l]) LEVEL = l; }

function emit(level, event, fields = {}) {
  if (ORDER[level] < ORDER[LEVEL]) return;
  const line = {
    ts: nowIso(),
    level,
    event,
    user_id: fields.user_id ?? null,
    branch_id: fields.branch_id ?? null,
    invoice_id: fields.invoice_id ?? null,
    task_id: fields.task_id ?? null,
    duration_ms: fields.duration_ms ?? null,
    status: fields.status ?? null,
    ...(fields.error ? { error: String(fields.error).slice(0, 500) } : {}),
    meta: scrub(fields.meta ?? {}),
  };
  // single JSON line to stdout (Koyeb captures 24h); file upload handled by jobs
  process.stdout.write(JSON.stringify(line) + '\n');
}

export const log = {
  debug: (event, fields) => emit('debug', event, fields),
  info: (event, fields) => emit('info', event, fields),
  warn: (event, fields) => emit('warn', event, fields),
  error: (event, fields) => emit('error', event, fields),
};

// Event catalog constants (docs/07 §C.2) — used across the app, grep-able
export const EV = {
  TG_UPDATE_RECEIVED: 'telegram.update.received',
  TG_UPDATE_SKIPPED: 'telegram.update.skipped',
  TG_UPDATE_RECOVERED: 'telegram.update.recovered',
  INVOICE_RECEIVED: 'invoice.received',
  INVOICE_STATE: 'invoice.state_changed',
  INVOICE_APPROVED: 'invoice.approved',
  INVOICE_REJECTED: 'invoice.rejected',
  INVOICE_DUPLICATE: 'invoice.duplicate_suspected',
  INVOICE_DISCREPANCY: 'invoice.discrepancy',
  AI_CALL: 'ai.call',
  AI_RATE_LIMITED: 'ai.rate_limited',
  QUEUE_ENQUEUED: 'queue.enqueued',
  QUEUE_RETRIED: 'queue.retried',
  QUEUE_COMPLETED: 'queue.completed',
  QUEUE_DEAD: 'queue.dead_letter',
  AUTH_LOGIN_OK: 'auth.login.success',
  AUTH_LOGIN_FAIL: 'auth.login.failed',
  AUTH_DENIED: 'auth.permission.denied',
  CONFLICT: 'conflict.detected',
  BACKUP_STARTED: 'backup.started',
  BACKUP_DONE: 'backup.completed',
  BACKUP_FAIL: 'backup.failed',
  FILE_DELETED: 'file.deleted',
  REPORT_GENERATED: 'report.generated',
  REPORT_LINK: 'report.link.created',
  SERVICE_TEST: 'service.test',
};
