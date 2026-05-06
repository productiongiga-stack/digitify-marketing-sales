#!/usr/bin/env node
/**
 * Seed the OWNER account. Works with both SQLite and PostgreSQL.
 * Set DATABASE_URL env var to use PostgreSQL, otherwise uses SQLite.
 *
 * Usage:
 *   OWNER_EMAIL=admin@example.com OWNER_PASSWORD=MyPass123 node scripts/seed-owner.js
 *   DATABASE_URL=postgresql://... OWNER_EMAIL=... node scripts/seed-owner.js
 */
const { initDatabase, ensureOwner, db } = require('../db');

(async () => {
  try {
    await initDatabase();
    const seeded = await ensureOwner();
    if (seeded) {
      console.log('✅ OWNER account aangemaakt:');
      console.log(`   Email:    ${seeded.email}`);
      console.log(`   Password: ${seeded.password}`);
    } else {
      console.log('ℹ️  OWNER account bestaat al.');
    }
  } catch (err) {
    console.error('❌ Fout bij seeden:', err.message);
    process.exit(1);
  } finally {
    if (db.close) await db.close();
    process.exit(0);
  }
})();
