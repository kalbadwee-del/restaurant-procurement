// src/excel.js — SheetJS export (§11.3): structured, filterable, RTL views for Arabic
import * as XLSX from 'xlsx';

export function exportExcel({ sheets, lang = 'en' }) {
  const wb = XLSX.utils.book_new();
  for (const { name, rows } of sheets) {
    const ws = XLSX.utils.json_to_sheet(rows);
    // RTL view for Arabic sheets (§11.3)
    ws['!views'] = [{ RTL: lang === 'ar' }];
    XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

export function datasetToSheet(rows, columns) {
  // columns: [{key, label}] — ordered, labeled
  return rows.map((r) => Object.fromEntries(columns.map((c) => [c.label, r[c.key] ?? ''])));
}
