// src/services/matching.js — multi-language product matching (§2.4, §7.1, flow F7, D-S2)
import { normalizeName, diceSimilarity, jsonOf } from '../util.js';

const FUZZY_THRESHOLD = 0.45;

export async function loadCatalog(db) {
  const rows = await db('products').where({ is_active: true }).select('id', 'name_en', 'name_local', 'aliases');
  return rows.map((r) => ({
    id: r.id,
    nameEn: r.name_en,
    nameLocal: r.name_local,
    aliases: jsonOf(r.aliases) ?? [],
    keys: {
      en: normalizeName(r.name_en),
      local: normalizeName(r.name_local ?? ''),
      aliases: (jsonOf(r.aliases) ?? []).map(normalizeName),
    },
  }));
}

// Returns {match: 'exact'|'alias'|'local'|'fuzzy'|'ambiguous'|'none', productId?, candidates: [{id, name, score}]}
export function matchInCatalog(catalog, { nameOriginal, nameNormalized }) {
  const nOrig = normalizeName(nameOriginal);
  const nNorm = normalizeName(nameNormalized);
  const target = nNorm || nOrig;

  for (const p of catalog) {
    if (p.keys.en && (p.keys.en === target || p.keys.en === nOrig)) return { match: 'exact', productId: p.id, candidates: [] };
    if (p.keys.aliases.includes(target) || p.keys.aliases.includes(nOrig)) return { match: 'alias', productId: p.id, candidates: [] };
    if (p.keys.local && (p.keys.local === nOrig || p.keys.local === target)) return { match: 'local', productId: p.id, candidates: [] };
  }
  // fuzzy: score against en + local + aliases (§7.1 search across all name fields)
  const scored = [];
  for (const p of catalog) {
    let best = 0;
    best = Math.max(best, diceSimilarity(target, p.keys.en));
    if (p.keys.local) best = Math.max(best, diceSimilarity(nOrig, p.keys.local));
    for (const a of p.keys.aliases) best = Math.max(best, diceSimilarity(target, a));
    if (best >= FUZZY_THRESHOLD) scored.push({ id: p.id, name: p.nameEn, score: Number(best.toFixed(3)) });
  }
  scored.sort((a, b) => b.score - a.score);
  if (scored.length === 0) return { match: 'none', productId: null, candidates: [] };
  if (scored.length === 1 || scored[0].score - scored[1].score >= 0.1) {
    return { match: 'fuzzy', productId: scored[0].id, candidates: scored.slice(0, 3) };
  }
  return { match: 'ambiguous', productId: null, candidates: scored.slice(0, 3) }; // ask, never guess (§7.1)
}

export async function matchProduct(db, { nameOriginal, nameNormalized }) {
  const catalog = await loadCatalog(db);
  const result = matchInCatalog(catalog, { nameOriginal, nameNormalized });
  return {
    ...result,
    needsReview: result.match === 'fuzzy' || result.match === 'ambiguous',
    isNew: result.match === 'none',
  };
}

// classify by keywords into the 5 initial categories (§9) — deterministic suggestion, manager can correct
export async function suggestCategory(db, nameNormalized) {
  const n = normalizeName(nameNormalized);
  const rules = [
    ['marketing', ['ad', 'advert', 'banner', 'flyer', 'printing', 'design', 'logo']],
    ['equipment', ['mixer', 'blender', 'oven', 'fridge', 'freezer', 'machine', 'equipment', 'tool', 'knife', 'pot', 'pan']],
    ['maintenance', ['faucet', 'tap', 'pipe', 'repair', 'cleaning', 'detergent', 'soap', 'maintenance', 'filter']],
    ['food', ['rice', 'flour', 'oil', 'chicken', 'beef', 'fish', 'vegetable', 'tomato', 'onion', 'egg', 'pepper', 'cheese', 'milk', 'sugar', 'salt', 'sauce', 'spice', 'noodle', 'fruit', 'soap ']],
  ];
  for (const [slugKey, words] of rules) {
    if (words.some((w) => n.includes(w))) {
      const cat = await db('expense_categories').where('name_en', 'like', `%${slugKey === 'food' ? 'Food' : slugKey[0].toUpperCase() + slugKey.slice(1)}%`).first();
      if (cat) return cat.id;
    }
  }
  const other = await db('expense_categories').where({ name_en: 'Other' }).first();
  return other?.id ?? null;
}
