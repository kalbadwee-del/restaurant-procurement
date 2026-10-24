// src/util.js — core pure utilities (money in integer sen, strings, time, misc)
import { createHash, randomBytes } from 'node:crypto';

// ---------- Money (D7/D-S13): RM stored as NUMERIC(14,2) in PG; ALL JS math in integer sen ----------
export function toSen(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim().replace(/,/g, '');
  if (!/^-?\d+(\.\d{1,})?$/.test(s)) throw new Error(`invalid decimal: ${v}`);
  const neg = s.startsWith('-');
  const [int, frac = ''] = s.replace('-', '').split('.');
  const f2 = (frac + '00').slice(0, 2);
  const roundDigit = frac.length > 2 ? Number(frac[2]) : 0;
  let sen = Number(int) * 100 + Number(f2) + (roundDigit >= 5 ? 1 : 0);
  return neg ? -sen : sen;
}
export function fromSen(sen) { return sen === null ? null : (sen / 100); }
export function senToDb(sen) { return sen === null ? null : fromSen(sen).toFixed(2); }
export function formatRM(sen) {
  if (sen === null) return '—';
  const v = fromSen(sen);
  return `RM ${v.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
export function lineTotalSen({ quantity, unitPrice, discount = 0, tax = 0 }) {
  const q = toSen(quantity); // quantity × 100 as integer-scaled? NO — quantity is not money.
  throw new Error('use computeLineTotal');
}
export function computeLineTotalSen(quantity, unitPriceSen, discountSen = 0, taxSen = 0) {
  if (!Number.isInteger(unitPriceSen) || !Number.isInteger(discountSen) || !Number.isInteger(taxSen)) {
    throw new Error('money args must be integer sen');
  }
  const q = Number(quantity);
  if (!Number.isFinite(q) || q < 0) throw new Error(`invalid quantity: ${quantity}`);
  const gross = Math.round(q * unitPriceSen); // round to nearest sen
  return gross - discountSen + taxSen;
}

// ---------- Strings / matching ----------
export function normalizeName(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
export function bigrams(s) {
  const t = ` ${s} `;
  const out = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
}
// Dice coefficient on bigrams — in-memory fuzzy replacement for pg_trgm (D-S2)
export function diceSimilarity(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (A.length === 0 || B.length === 0) return 0;
  const map = new Map();
  for (const g of A) map.set(g, (map.get(g) || 0) + 1);
  let hits = 0;
  for (const g of B) {
    const c = map.get(g) || 0;
    if (c > 0) { hits++; map.set(g, c - 1); }
  }
  return (2 * hits) / (A.length + B.length);
}

// ---------- Time (Asia/Kuala_Lumpur) ----------
export const TZ = 'Asia/Kuala_Lumpur';
export function nowIso() { return new Date().toISOString(); }
export function klParts(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const p = {};
  for (const part of f.formatToParts(d)) p[part.type] = part.value;
  return p; // {year, month, day, hour(00-23), minute, second}
}
export function klDateStr(d = new Date()) { const p = klParts(d); return `${p.year}-${p.month}-${p.day}`; }
export function klDateTimeStr(d = new Date()) { const p = klParts(d); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} KL`; }
export function klMinutesOfDay(d = new Date()) { const p = klParts(d); return Number(p.hour) * 60 + Number(p.minute); }
export function klDayOfMonth(d = new Date()) { return Number(klParts(d).day); }

// ---------- Misc ----------
export function jsonOf(v) { if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } } return v; }
export function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }
export function randomToken(bytes = 32) { return randomBytes(bytes).toString('base64url'); }
export function b(v) { return Boolean(v && v !== '0'); }
export function slug(s) { return normalizeName(s).replace(/\s+/g, '-').slice(0, 60); }
export function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) return dflt;
  return n;
}
