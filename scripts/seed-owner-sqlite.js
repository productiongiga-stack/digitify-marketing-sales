#!/usr/bin/env node
const bcrypt = require('bcryptjs');
const { db } = require('../db');

const email = String(process.env.OWNER_EMAIL || '').trim().toLowerCase();
const password = String(process.env.OWNER_PASSWORD || '');
const firstName = String(process.env.OWNER_FIRST_NAME || 'Owner').trim().slice(0, 80) || 'Owner';
const lastName = String(process.env.OWNER_LAST_NAME || 'Digitify').trim().slice(0, 80) || 'Digitify';

if (!email || !password) {
  console.error('Gebruik: OWNER_EMAIL="owner@domein.tld" OWNER_PASSWORD="SterkWachtwoord" node scripts/seed-owner-sqlite.js');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 10);
const existing = db.prepare('SELECT id, email, role FROM users WHERE lower(email) = ? LIMIT 1').get(email);

if (existing) {
  db.prepare(`
    UPDATE users
    SET password_hash = ?,
        first_name = ?,
        last_name = ?,
        role = 'OWNER',
        status = 'ACTIVE',
        email_verified = 1
    WHERE id = ?
  `).run(hash, firstName, lastName, existing.id);
  console.log(`OWNER bijgewerkt: ${email} (id=${existing.id})`);
} else {
  const result = db.prepare(`
    INSERT INTO users(email, password_hash, first_name, last_name, role, status, email_verified)
    VALUES(?, ?, ?, ?, 'OWNER', 'ACTIVE', 1)
  `).run(email, hash, firstName, lastName);
  console.log(`OWNER aangemaakt: ${email} (id=${result.lastInsertRowid})`);
}
