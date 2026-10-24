// Seed migration — units (§2.4/units table), the 5 initial expense categories (§9), audit events sample-safe.
export async function up(knex) {
  const ts = new Date().toISOString();
  const units = [['Kilogram', 'kg'], ['Gram', 'g'], ['Liter', 'L'], ['Milliliter', 'ml'], ['Piece', 'pcs'], ['Bottle', 'btl'], ['Pack', 'pack'], ['Bundle', 'bundle'], ['Carton', 'ctn'], ['Bag', 'bag']];
  for (const [name, short] of units) {
    await knex('units').insert({ name, short_name: short }).onConflict('short_name').ignore();
  }
  const cats = [
    ['Food & Operational Supplies', 'تموين ومستلزمات تشغيل'],
    ['Marketing', 'تسويق'],
    ['Maintenance', 'صيانة'],
    ['Equipment & Tools', 'معدات وأدوات'],
    ['Other', 'أخرى'],
  ];
  for (const [en, ar] of cats) {
    const exists = await knex('expense_categories').where({ name_en: en }).first();
    if (!exists) await knex('expense_categories').insert({ name_en: en, name_ar: ar, is_active: true, version: 0, created_at: ts, updated_at: ts });
  }
}

export async function down(knex) {
  // seeds are harmless to keep — nothing to reverse
}
