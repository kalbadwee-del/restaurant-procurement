// Migration 001 — full schema per design/02-database.md (~24 tables), dialect-neutral (D-S3).
// Conventions: TEXT ISO-8601 timestamps (UTC), JSON as opaque json() columns,
// enums validated app-side with zod, booleans read via !!, money NUMERIC(14,2)/RM.

export async function up(kx) {
  // ---- Group 1: org & people ----
  await kx.schema.createTable('branches', (t) => {
    t.bigIncrements('id').primary();
    t.string('name_en').notNull();
    t.string('name_ar').notNull();
    t.boolean('is_active').notNull().defaultTo(true);
    t.integer('version').notNull().defaultTo(0);
    t.text('created_at').notNull();
    t.text('updated_at').notNull();
  });

  await kx.schema.createTable('users', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('telegram_id').nullable();
    t.string('username').nullable();
    t.string('password_hash').nullable();
    t.string('full_name').notNull();
    t.string('phone').nullable();
    t.string('role').notNull(); // owner|operations_manager|accountant|central_purchaser|branch_manager|employee
    t.bigInteger('branch_id').nullable().references('id').inTable('branches');
    t.string('language').notNull().defaultTo('en'); // en|ar
    t.json('permissions_override').nullable();
    t.boolean('is_active').notNull().defaultTo(true);
    t.integer('version').notNull().defaultTo(0);
    t.text('created_at').notNull();
    t.text('updated_at').notNull();
    t.unique(['telegram_id']);
    t.unique(['username']);
  });

  await kx.schema.createTable('telegram_groups', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('chat_id').notNull();
    t.string('kind').notNull(); // invoice_group|request_group
    t.bigInteger('branch_id').nullable().references('id').inTable('branches');
    t.string('title').nullable();
    t.boolean('is_active').notNull().defaultTo(true);
    t.integer('version').notNull().defaultTo(0);
    t.text('created_at').notNull();
    t.text('updated_at').notNull();
    t.unique(['chat_id']);
  });

  await kx.schema.createTable('expense_categories', (t) => {
    t.bigIncrements('id').primary();
    t.string('name_en').notNull();
    t.string('name_ar').notNull();
    t.boolean('is_active').notNull().defaultTo(true);
    t.integer('version').notNull().defaultTo(0);
    t.text('created_at').notNull();
    t.text('updated_at').notNull();
  });

  // ---- Group 2: catalog & prices ----
  await kx.schema.createTable('brands', (t) => {
    t.bigIncrements('id').primary();
    t.string('name').notNull();
    t.text('created_at').notNull();
    t.unique(['name']);
  });

  await kx.schema.createTable('units', (t) => {
    t.bigIncrements('id').primary();
    t.string('name').notNull();
    t.string('short_name').notNull();
    t.unique(['short_name']);
  });

  await kx.schema.createTable('products', (t) => {
    t.bigIncrements('id').primary();
    t.string('name_en').notNull();
    t.string('name_local').nullable();
    t.json('aliases').notNull().defaultTo('[]');
    t.bigInteger('brand_id').nullable().references('id').inTable('brands');
    t.bigInteger('unit_id').nullable().references('id').inTable('units');
    t.string('size_text').nullable();
    t.decimal('weight', 10, 3).nullable();
    t.bigInteger('category_id').nullable().references('id').inTable('expense_categories');
    t.string('quality_status').notNull().defaultTo('active'); // active|excluded
    t.boolean('is_active').notNull().defaultTo(true);
    t.integer('version').notNull().defaultTo(0);
    t.text('created_at').notNull();
    t.text('updated_at').notNull();
  });

  await kx.schema.createTable('product_quality_notes', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('product_id').notNull().references('id').inTable('products');
    t.text('note').notNull();
    t.string('note_date').notNull(); // YYYY-MM-DD
    t.bigInteger('created_by').notNull().references('id').inTable('users');
    t.text('created_at').notNull();
  });

  await kx.schema.createTable('stores', (t) => {
    t.bigIncrements('id').primary();
    t.string('name').notNull();
    t.json('aliases').notNull().defaultTo('[]');
    t.string('kind').notNull().defaultTo('both'); // store|supplier|both
    t.decimal('trip_cost', 14, 2).notNull().defaultTo(0);
    t.decimal('min_savings_threshold', 14, 2).notNull().defaultTo(0);
    t.boolean('is_active').notNull().defaultTo(true);
    t.integer('version').notNull().defaultTo(0);
    t.text('created_at').notNull();
    t.text('updated_at').notNull();
  });

  await kx.schema.createTable('observed_prices', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('product_id').notNull().references('id').inTable('products');
    t.bigInteger('store_id').notNull().references('id').inTable('stores');
    t.decimal('price', 14, 2).notNull();
    t.bigInteger('unit_id').nullable().references('id').inTable('units');
    t.string('observed_date').notNull();
    t.string('source').notNull().defaultTo('manual'); // manual|ai
    t.bigInteger('created_by').notNull().references('id').inTable('users');
    t.integer('version').notNull().defaultTo(0);
    t.text('created_at').notNull();
    t.text('updated_at').notNull();
  });

  // ---- files metadata (before invoices — invoices.file_id FK) ----
  await kx.schema.createTable('files', (t) => {
    t.bigIncrements('id').primary();
    t.string('kind').notNull(); // invoice_image|audio|report|backup|log
    t.string('r2_key').notNull();
    t.string('mime').notNull();
    t.bigInteger('size_bytes').notNull();
    t.string('sha256').notNull();
    t.string('entity_type').nullable();
    t.bigInteger('entity_id').nullable();
    t.text('uploaded_at').notNull();
    t.text('deleted_at').nullable();
    t.bigInteger('deleted_by').nullable();
    t.unique(['r2_key']);
  });

  // ---- Group 3: requests & invoices ----
  await kx.schema.createTable('requests', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('branch_id').notNull().references('id').inTable('branches');
    t.bigInteger('requested_by').notNull().references('id').inTable('users');
    t.string('status').notNull().defaultTo('open'); // open|partially_fulfilled|fulfilled|deferred|cancelled
    t.string('needed_by').nullable();
    t.integer('version').notNull().defaultTo(0);
    t.text('created_at').notNull();
    t.text('updated_at').notNull();
  });

  await kx.schema.createTable('request_items', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('request_id').notNull().references('id').inTable('requests');
    t.bigInteger('product_id').notNull().references('id').inTable('products');
    t.decimal('quantity', 12, 3).notNull();
    t.bigInteger('unit_id').nullable().references('id').inTable('units');
    t.string('status').notNull().defaultTo('open'); // open|partially|purchased|deferred|cancelled
    t.decimal('purchased_qty', 12, 3).notNull().defaultTo(0);
    t.integer('version').notNull().defaultTo(0);
    t.text('created_at').notNull();
    t.text('updated_at').notNull();
  });

  await kx.schema.createTable('request_modifications', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('request_item_id').notNull().references('id').inTable('request_items');
    t.string('change_type').notNull(); // increment|decrement|cancel|modify|create
    t.json('old_value').nullable();
    t.json('new_value').nullable();
    t.text('raw_message').nullable();
    t.bigInteger('telegram_message_id').nullable();
    t.bigInteger('created_by').notNull().references('id').inTable('users');
    t.text('created_at').notNull();
  });

  await kx.schema.createTable('invoices', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('branch_id').notNull().references('id').inTable('branches');
    t.bigInteger('supplier_id').nullable().references('id').inTable('stores');
    t.string('invoice_number').nullable();
    t.string('invoice_date').nullable();
    t.decimal('invoice_total', 14, 2).nullable();
    t.decimal('subtotal', 14, 2).nullable();
    t.decimal('tax_total', 14, 2).nullable();
    t.decimal('discount_total', 14, 2).nullable();
    t.string('currency').notNull().defaultTo('MYR');
    t.string('detected_language').nullable(); // en|ms|zh|ta|mixed
    t.string('status').notNull().defaultTo('draft'); // draft|in_review|approved|rejected
    t.string('source').notNull().defaultTo('text'); // photo|audio|text
    t.bigInteger('file_id').nullable().references('id').inTable('files');
    t.bigInteger('telegram_message_id').nullable();
    t.integer('review_round').notNull().defaultTo(0);
    t.boolean('duplicate_flag').notNull().defaultTo(false);
    t.boolean('discrepancy_flag').notNull().defaultTo(false);
    t.text('discrepancy_note').nullable();
    t.bigInteger('created_by').notNull().references('id').inTable('users');
    t.bigInteger('approved_by').nullable().references('id').inTable('users');
    t.text('approved_at').nullable();
    t.integer('version').notNull().defaultTo(0);
    t.text('created_at').notNull();
    t.text('updated_at').notNull();
  });

  await kx.schema.createTable('invoice_items', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('invoice_id').notNull().references('id').inTable('invoices');
    t.integer('line_no').notNull();
    t.bigInteger('product_id').nullable().references('id').inTable('products');
    t.text('name_original').notNull();
    t.string('name_normalized').notNull();
    t.string('brand_text').nullable();
    t.string('size_text').nullable();
    t.decimal('quantity', 12, 3).notNull();
    t.bigInteger('unit_id').nullable().references('id').inTable('units');
    t.string('unit_text').nullable();
    t.decimal('unit_price', 14, 2).notNull().defaultTo(0);
    t.decimal('discount', 14, 2).notNull().defaultTo(0);
    t.decimal('tax', 14, 2).notNull().defaultTo(0);
    t.decimal('line_total', 14, 2).notNull().defaultTo(0);
    t.bigInteger('category_id').nullable().references('id').inTable('expense_categories');
    t.string('confidence').notNull().defaultTo('low'); // high|medium|low
    t.boolean('needs_review').notNull().defaultTo(false);
    t.string('review_symbol').nullable(); // A, B, C ...
    t.boolean('is_new_product').notNull().defaultTo(false);
    t.bigInteger('matched_request_item_id').nullable().references('id').inTable('request_items');
    t.boolean('is_excess').notNull().defaultTo(false);
    t.integer('version').notNull().defaultTo(0);
    t.text('created_at').notNull();
    t.text('updated_at').notNull();
  });

  await kx.schema.createTable('approved_purchases', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('invoice_id').notNull().references('id').inTable('invoices');
    t.bigInteger('invoice_item_id').notNull().references('id').inTable('invoice_items');
    t.bigInteger('branch_id').notNull().references('id').inTable('branches');
    t.bigInteger('product_id').notNull().references('id').inTable('products');
    t.bigInteger('store_id').nullable().references('id').inTable('stores');
    t.decimal('quantity', 12, 3).notNull();
    t.bigInteger('unit_id').nullable().references('id').inTable('units');
    t.decimal('unit_price', 14, 2).notNull();
    t.decimal('line_total', 14, 2).notNull();
    t.bigInteger('request_item_id').nullable().references('id').inTable('request_items');
    t.boolean('is_excess').notNull().defaultTo(false);
    t.boolean('is_reversal').notNull().defaultTo(false);
    t.text('purchased_at').notNull();
    t.index(['invoice_item_id']);
  });

  // ---- Group 4: ops & infra ----
  await kx.schema.createTable('processed_updates', (t) => {
    t.bigInteger('update_id').primary();
    t.text('processed_at').notNull();
    t.string('status').notNull().defaultTo('ok'); // ok|skipped
  });

  await kx.schema.createTable('pending_ai_tasks', (t) => {
    t.bigIncrements('id').primary();
    t.string('task_type').notNull(); // invoice_extract|audio_transcribe|correction_parse
    t.json('payload').notNull();
    t.string('status').notNull().defaultTo('pending'); // pending|processing|failed|dead_letter
    t.integer('attempts').notNull().defaultTo(0);
    t.integer('max_attempts').notNull().defaultTo(5);
    t.text('next_attempt_at').notNull();
    t.text('last_error').nullable();
    t.bigInteger('invoice_id').nullable().references('id').inTable('invoices');
    t.bigInteger('created_by').nullable().references('id').inTable('users');
    t.text('created_at').notNull();
    t.text('updated_at').notNull();
    t.index(['status', 'next_attempt_at']);
  });

  await kx.schema.createTable('ai_call_logs', (t) => {
    t.bigIncrements('id').primary();
    t.string('provider').notNull();
    t.string('model').notNull();
    t.bigInteger('user_id').nullable();
    t.bigInteger('task_id').nullable();
    t.bigInteger('invoice_id').nullable();
    t.integer('tokens_in').notNull().defaultTo(0);
    t.integer('tokens_out').notNull().defaultTo(0);
    t.integer('duration_ms').notNull().defaultTo(0);
    t.string('status').notNull(); // success|fail
    t.text('error').nullable();
    t.text('created_at').notNull();
    t.index(['created_at']);
  });

  await kx.schema.createTable('app_secrets', (t) => {
    t.string('key').primary();
    t.text('value_enc').notNull(); // base64(iv|tag|ciphertext)
    t.text('updated_at').notNull();
  });

  await kx.schema.createTable('app_settings', (t) => {
    t.string('key').primary();
    t.text('value').notNull(); // JSON-encoded plain value
    t.text('updated_at').notNull();
  });

  await kx.schema.createTable('report_links', (t) => {
    t.bigIncrements('id').primary();
    t.string('token').notNull();
    t.bigInteger('user_id').notNull().references('id').inTable('users');
    t.json('params').notNull();
    t.text('expires_at').notNull();
    t.text('created_at').notNull();
    t.text('revoked_at').nullable();
    t.unique(['token']);
  });

  await kx.schema.createTable('backups', (t) => {
    t.bigIncrements('id').primary();
    t.string('r2_key').notNull();
    t.bigInteger('size_bytes').notNull();
    t.string('sha256').notNull();
    t.string('schema_version').notNull();
    t.json('table_counts').notNull();
    t.string('status').notNull().defaultTo('ok'); // ok|failed
    t.bigInteger('created_by').nullable().references('id').inTable('users');
    t.text('created_at').notNull();
    t.text('restored_at').nullable();
  });

  await kx.schema.createTable('audit_log', (t) => {
    t.bigIncrements('id').primary();
    t.string('event_type').notNull();
    t.string('actor_type').notNull(); // user|system|ai
    t.bigInteger('actor_id').nullable();
    t.string('entity_type').notNull();
    t.bigInteger('entity_id').nullable();
    t.string('action').notNull();
    t.json('before').nullable();
    t.json('after').nullable();
    t.json('meta').nullable();
    t.text('created_at').notNull();
    t.index(['entity_type', 'entity_id']);
    t.index(['created_at']);
  });

  await kx.schema.createTable('schema_migrations_meta', (t) => {
    t.string('key').primary();
    t.string('value').notNull();
  });

  await kx.schema.createTable('draft_sessions', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('chat_id').notNull();
    t.bigInteger('user_id').notNull().references('id').inTable('users');
    t.bigInteger('invoice_id').notNull().references('id').inTable('invoices');
    t.string('status').notNull().defaultTo('open'); // open|closed
    t.text('opened_at').notNull();
    t.text('last_activity_at').notNull();
    t.index(['chat_id', 'user_id', 'status']);
  });

  // ---- Indexes (design §02 §6) ----
  await kx.schema.alterTable('invoices', (t) => { t.index(['branch_id', 'status']); t.index(['status']); });
  await kx.schema.alterTable('invoice_items', (t) => { t.index(['invoice_id']); t.index(['product_id']); });
  await kx.schema.alterTable('approved_purchases', (t) => { t.index(['product_id', 'purchased_at']); t.index(['branch_id', 'purchased_at']); });
  await kx.schema.alterTable('observed_prices', (t) => { t.index(['product_id', 'store_id', 'observed_date']); });
  await kx.schema.alterTable('requests', (t) => { t.index(['branch_id', 'status']); });
  await kx.schema.alterTable('request_items', (t) => { t.index(['status']); });

  // Hard invoice dedup idempotency constraint (§12.2)
  await kx.raw('CREATE UNIQUE INDEX invoices_branch_no_date_uq ON invoices (branch_id, invoice_number, invoice_date) WHERE invoice_number IS NOT NULL');

  // ---- Views (design §02 §9) ----
  await kx.raw(`CREATE VIEW v_price_history AS
    SELECT ap.product_id, ap.store_id, 'purchase' AS record_type, ap.unit_price AS price,
           ap.unit_id, ap.quantity, ap.purchased_at AS price_at, ap.invoice_id AS source_id, ap.branch_id
      FROM approved_purchases ap
    UNION ALL
    SELECT op.product_id, op.store_id, 'observed' AS record_type, op.price,
           op.unit_id, NULL AS quantity, op.observed_date AS price_at, op.id AS source_id, NULL AS branch_id
      FROM observed_prices op`);

  await kx.raw(`CREATE VIEW v_open_requests AS
    SELECT ri.id AS request_item_id, r.id AS request_id, r.branch_id, ri.product_id,
           ri.quantity AS requested_qty, ri.purchased_qty,
           (ri.quantity - ri.purchased_qty) AS remaining_qty,
           r.needed_by, r.status AS request_status, ri.status AS item_status, r.created_at
      FROM request_items ri JOIN requests r ON r.id = ri.request_id
     WHERE ri.status IN ('open','partially') AND r.status IN ('open','partially_fulfilled')`);
}

export async function down(kx) {
  const tables = ['schema_migrations_meta','draft_sessions','audit_log','backups','report_links','app_settings','app_secrets','ai_call_logs',
    'pending_ai_tasks','processed_updates','files','approved_purchases','invoice_items','invoices','request_modifications',
    'request_items','requests','observed_prices','stores','product_quality_notes','products','units','brands',
    'expense_categories','telegram_groups','users','branches'];
  await kx.raw('DROP VIEW IF EXISTS v_open_requests');
  await kx.raw('DROP VIEW IF EXISTS v_price_history');
  await kx.raw('DROP INDEX IF EXISTS invoices_branch_no_date_uq');
  for (const t of tables) await kx.schema.dropTableIfExists(t);
}
