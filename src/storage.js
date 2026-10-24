// src/storage.js — Storage adapter interface: mock (filesystem /tmp/local-storage, D-S7) | r2 (aws4fetch, D-S8)
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { log, EV } from './logging.js';

export function makeStorage(cfg) {
  if (cfg.storage.mode === 'r2') return new R2Storage(cfg.storage);
  return new MockStorage(cfg.storage);
}

export class MockStorage {
  constructor({ mockRoot = '/tmp/local-storage' }) { this.root = mockRoot; mkdirSync(this.root, { recursive: true }); }
  #path(key) { const p = path.join(this.root, key); mkdirSync(path.dirname(p), { recursive: true }); return p; }
  async put(key, buffer, _mime) { writeFileSync(this.#path(key), buffer); return { key }; }
  async get(key) { if (!existsSync(this.#path(key))) throw new Error(`not found: ${key}`); return readFileSync(this.#path(key)); }
  async delete(key) { try { unlinkSync(this.#path(key)); } catch { /* already gone — delete idempotent */ } }
  async usageBytes() {
    let total = 0;
    const walk = (dir) => {
      let entries = []; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else { try { total += statSync(p).size; } catch { /* raced */ } }
      }
    };
    walk(this.root);
    return total;
  }
  get mode() { return 'mock'; }
}

export class R2Storage {
  constructor({ accountId, accessKeyId, secretAccessKey, bucket }) {
    this.endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
    this.bucket = bucket;
    this.clientPromise = import('aws4fetch').then(({ AwsClient }) => new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' }));
  }
  url(key) { return `${this.endpoint}/${this.bucket}/${key}`; }
  async put(key, buffer, mime = 'application/octet-stream') {
    const client = await this.clientPromise;
    const res = await client.fetch(this.url(key), { method: 'PUT', body: buffer, headers: { 'content-type': mime } });
    if (!res.ok) { log.error('storage.put_fail', { status: 'error', meta: { key, http: res.status } }); throw new Error(`R2 PUT ${res.status}`); }
    return { key };
  }
  async get(key) {
    const client = await this.clientPromise;
    const res = await client.fetch(this.url(key), { method: 'GET' });
    if (!res.ok) throw new Error(`R2 GET ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  async delete(key) {
    const client = await this.clientPromise;
    await client.fetch(this.url(key), { method: 'DELETE' }); // delete is free + idempotent
  }
  async usageBytes() { return null; } // R2 usage metering is dashboard-side; alerts use DB-side estimates
  get mode() { return 'r2'; }
}

// Canonical key scheme (design/06 §5)
export const keys = {
  invoiceImage: (branchId, ym, invoiceId, filename) => `invoices/${branchId}/${ym}/${invoiceId}/${filename}`,
  audio: (branchId, ym, invoiceId, filename) => `audio/${branchId}/${ym}/${invoiceId}/${filename}`,
  report: (token, filename) => `reports/${ym()}/${token}/${filename}`,
  backup: (dateStr) => `backups/${dateStr}.dump.enc`,
  manifest: (dateStr) => `backups/${dateStr}.manifest.json`,
  logFile: (dateStr) => `logs/${dateStr}.jsonl`,
};
function ym() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit' }).format(new Date()); }
