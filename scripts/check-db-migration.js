#!/usr/bin/env node
/**
 * CI migration check for PostgreSQL.
 *
 * Verifies that:
 * 1) schema init is idempotent (run twice),
 * 2) critical tables exist,
 * 3) critical columns exist.
 */
async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for migration check');
  }

  const { initDatabase, db, USE_PG } = require('../db');
  if (!USE_PG) {
    throw new Error('Migration check must run in PostgreSQL mode (set DATABASE_URL)');
  }

  const requiredColumns = {
    users: ['id', 'email', 'role', 'status', 'failed_login_attempts'],
    settings: ['key', 'value'],
    orders: ['id', 'status', 'subtotal', 'total'],
    order_items: ['id', 'order_id', 'qty', 'total'],
    payments: ['id', 'order_id', 'status', 'updated_at'],
    invoices: ['id', 'order_id', 'status', 'updated_at'],
    shipping_events: ['id', 'order_id', 'event_key'],
    deposit_invoices: ['id', 'order_id', 'updated_at'],
    audit_log: ['id', 'actor_user_id', 'actor_email', 'action', 'summary']
  };

  try {
    console.log('Running initDatabase() migration pass #1...');
    await initDatabase();
    console.log('Running initDatabase() migration pass #2 (idempotency)...');
    await initDatabase();

    const tableRows = await db.prepare(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"
    ).all();
    const tables = new Set(tableRows.map((row) => row.table_name));

    for (const tableName of Object.keys(requiredColumns)) {
      if (!tables.has(tableName)) {
        throw new Error(`Missing required table: ${tableName}`);
      }
    }

    for (const [tableName, columns] of Object.entries(requiredColumns)) {
      const columnRows = await db.prepare(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?"
      ).all(tableName);
      const existingColumns = new Set(columnRows.map((row) => row.column_name));

      for (const columnName of columns) {
        if (!existingColumns.has(columnName)) {
          throw new Error(`Missing column ${tableName}.${columnName}`);
        }
      }
    }

    const probe = await db.prepare('SELECT 1 AS ok').get();
    if (!probe || probe.ok !== 1) {
      throw new Error('Database probe query failed');
    }

    console.log('Database migration check passed.');
  } finally {
    if (typeof db.close === 'function') {
      await db.close();
    }
  }
}

main().catch((err) => {
  console.error('Database migration check failed:', err.message);
  process.exit(1);
});
