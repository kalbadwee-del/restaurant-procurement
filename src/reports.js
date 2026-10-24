// src/reports.js — report datasets (§11.1) + HTML templates (AR-RTL / EN, RM, KL dates — §11.3)
import { toSen, fromSen, formatRM, klDateTimeStr, b } from './util.js';

export const REPORT_TYPES = ['expenses_by_branch', 'expenses_by_category', 'price_history', 'excess_purchases', 'open_requests', 'quality_notes'];

export async function buildReportData(ctx, { type, filters = {} }) {
  const db = ctx.db;
  const from = filters.from ?? '2000-01-01';
  const to = filters.to ?? '2999-12-31';
  if (type === 'expenses_by_branch' || type === 'expenses_by_category') {
    const rows = await db('approved_purchases as ap')
      .join('invoice_items as ii', 'ii.id', 'ap.invoice_item_id')
      .leftJoin('expense_categories as c', 'c.id', 'ii.category_id')
      .leftJoin('branches as br', 'br.id', 'ap.branch_id')
      .where('ap.purchased_at', '>=', from).where('ap.purchased_at', '<=', `${to}T23:59:59Z`)
      .where('ap.is_reversal', false)
      .modify((q) => { if (filters.branch_id) q.where('ap.branch_id', filters.branch_id); })
      .select(type === 'expenses_by_branch' ? 'br.name_en as group_name' : db.raw('coalesce(c.name_en, \'Uncategorized\') as group_name'))
      .sum({ total: 'ap.line_total' }).count({ items: 'ap.id' }).groupBy('group_name');
    return { type, rows: rows.map((r) => ({ ...r, total_sen: toSen(r.total) ?? 0 })) };
  }
  if (type === 'price_history') {
    const { priceHistory } = await import('./services/prices.js');
    const productId = filters.product_id;
    const hist = await priceHistory(db, { productId, storeId: filters.store_id ?? null, days: Number(filters.days ?? 90) });
    return { type, rows: hist.rows, stats: { last: hist.last?.price, avg: hist.avg, min: hist.min, max: hist.max } };
  }
  if (type === 'excess_purchases') {
    const rows = await db('approved_purchases as ap').join('products as p', 'p.id', 'ap.product_id')
      .join('branches as br', 'br.id', 'ap.branch_id')
      .where({ 'ap.is_excess': true, 'ap.is_reversal': false })
      .where('ap.purchased_at', '>=', from).where('ap.purchased_at', '<=', `${to}T23:59:59Z`)
      .select('ap.*', 'p.name_en as product_name', 'br.name_en as branch_name');
    return { type, rows: rows.map((r) => ({ ...r, total_sen: toSen(r.line_total) ?? 0 })) };
  }
  if (type === 'open_requests') {
    const { aggregatedShoppingList } = await import('./services/requests.js');
    return { type, rows: await aggregatedShoppingList(db) };
  }
  if (type === 'quality_notes') {
    const rows = await db('product_quality_notes as q').join('products as p', 'p.id', 'q.product_id')
      .select('q.*', 'p.name_en as product_name').orderBy('q.note_date', 'desc');
    return { type, rows };
  }
  throw new Error(`unknown report type ${type}`);
}

function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

export function renderReportHtml({ type, data, lang = 'en', meta = {} }) {
  const rtl = lang === 'ar';
  const dir = rtl ? 'rtl' : 'ltr';
  const L = rtl
    ? { title: 'تقرير المشتريات', generated: 'تاريخ الإنشاء', branches: 'الفروع', period: 'الفترة', total: 'الإجمالي', items: 'عدد البنود', group: 'المجموعة', product: 'المنتج', branch: 'الفرع', qty: 'الكمية', price: 'السعر', date: 'التاريخ', store: 'المتجر', type: 'النوع' }
    : { title: 'Procurement Report', generated: 'Generated at', branches: 'Branches', period: 'Period', total: 'Total', items: 'Items', group: 'Group', product: 'Product', branch: 'Branch', qty: 'Qty', price: 'Price', date: 'Date', store: 'Store', type: 'Type' };
  let body = '';
  if (data.type === 'expenses_by_branch' || data.type === 'expenses_by_category') {
    const grand = data.rows.reduce((a, r) => a + r.total_sen, 0);
    body = `<table><tr><th>${L.group}</th><th>${L.items}</th><th>${L.total}</th></tr>` +
      data.rows.map((r) => `<tr><td>${esc(r.group_name)}</td><td>${r.items}</td><td>${formatRM(r.total_sen)}</td></tr>`).join('') +
      `<tr class="total"><td>${L.total}</td><td>${data.rows.reduce((a, r) => a + Number(r.items), 0)}</td><td>${formatRM(grand)}</td></tr></table>`;
  } else if (data.type === 'price_history') {
    body = `<table><tr><th>${L.date}</th><th>${L.type}</th><th>${L.price}</th></tr>` +
      data.rows.map((r) => `<tr><td>${esc(String(r.price_at).slice(0, 10))}</td><td>${r.record_type}</td><td>${formatRM(toSen(r.price))}</td></tr>`).join('') + '</table>' +
      (data.stats ? `<p>Avg: ${data.stats.avg ? formatRM(toSen(data.stats.avg)) : '—'} | Min: ${data.stats.min ? formatRM(toSen(data.stats.min)) : '—'} | Max: ${data.stats.max ? formatRM(toSen(data.stats.max)) : '—'}</p>` : '');
  } else if (data.type === 'excess_purchases') {
    body = `<table><tr><th>${L.date}</th><th>${L.branch}</th><th>${L.product}</th><th>${L.qty}</th><th>${L.total}</th></tr>` +
      data.rows.map((r) => `<tr><td>${esc(String(r.purchased_at).slice(0, 10))}</td><td>${esc(r.branch_name)}</td><td>${esc(r.product_name)}</td><td>${r.quantity}</td><td>${formatRM(r.total_sen)}</td></tr>`).join('') + '</table>';
  } else if (data.type === 'open_requests') {
    body = `<table><tr><th>${L.product}</th><th>${L.qty}</th><th>${L.branch}</th></tr>` +
      data.rows.map((r) => `<tr><td>${esc(r.product_name)}</td><td>${r.total_remaining}</td><td>${esc(r.branches.map((b2) => `${b2.branch_name}:${b2.remaining}`).join(', '))}</td></tr>`).join('') + '</table>';
  } else if (data.type === 'quality_notes') {
    body = `<table><tr><th>${L.date}</th><th>${L.product}</th><th>Note</th></tr>` +
      data.rows.map((r) => `<tr><td>${esc(r.note_date)}</td><td>${esc(r.product_name)}</td><td>${esc(r.note)}</td></tr>`).join('') + '</table>';
  }
  return `<!doctype html><html dir="${dir}"><head><meta charset="utf-8"><title>${esc(meta.title ?? L.title)}</title>
<style>
  @page { size: A4; margin: 18mm; }
  body { font-family: 'Noto Naskh Arabic','Amiri','Noto Sans','DejaVu Sans',sans-serif; font-size: 12px; color: #111; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .meta { color: #555; font-size: 11px; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { border: 1px solid #bbb; padding: 5px 7px; text-align: ${rtl ? 'right' : 'left'}; }
  th { background: #f0f0f0; }
  tr.total td { font-weight: bold; background: #fafafa; }
</style></head><body>
<h1>${esc(meta.title ?? L.title)}</h1>
<div class="meta">${L.generated}: ${klDateTimeStr()} | ${L.period}: ${esc(meta.period ?? '—')} | ${L.branches}: ${esc(meta.branches ?? 'All')} | MYR</div>
${body}</body></html>`;
}
