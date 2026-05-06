/**
 * PostgreSQL adapter that provides a better-sqlite3–compatible async API.
 *
 * Usage:
 *   const row = await db.prepare('SELECT * FROM users WHERE id = ?').get(42);
 *   const rows = await db.prepare('SELECT * FROM users').all();
 *   const info = await db.prepare('INSERT INTO users ...').run('a', 'b');
 *   await db.exec('CREATE TABLE ...');
 *
 * The wrapper converts:
 *   - `?` placeholders → $1, $2, … (PostgreSQL positional params)
 *   - `@name` named params → $1, $2, … (when param is an object)
 *   - datetime('now') → NOW()
 *   - datetime('now', '-X days') → NOW() - INTERVAL 'X days'
 *   - datetime('now', '-X hours') → NOW() - INTERVAL 'X hours'
 *   - CAST(x AS TEXT) → CAST(x AS TEXT)  (works in both)
 */
const { Pool } = require('pg');

let pool;

function getPool() {
  if (pool) return pool;
  const connStr = process.env.DATABASE_URL;
  if (!connStr) throw new Error('DATABASE_URL environment variable is required for PostgreSQL mode');

  pool = new Pool({
    connectionString: connStr,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });

  pool.on('error', (err) => {
    console.error('PG pool error:', err.message);
  });

  return pool;
}

/** Convert SQLite ? placeholders to $1, $2, ... */
function convertPlaceholders(sql) {
  let idx = 0;
  return sql.replace(/\?/g, () => `$${++idx}`);
}

/**
 * Convert SQLite @name placeholders to $1, $2, ...
 * Returns { sql, values } where values are extracted from the params object.
 */
function convertNamedParams(sql, paramsObj) {
  const names = [];
  const values = [];
  // Find all @name references (not inside quotes)
  const converted = sql.replace(/@(\w+)/g, (match, name) => {
    let idx = names.indexOf(name);
    if (idx === -1) {
      names.push(name);
      values.push(paramsObj[name]);
      idx = names.length - 1;
    }
    return `$${idx + 1}`;
  });
  return { sql: converted, values };
}

/** Convert SQLite datetime() to PostgreSQL NOW() / INTERVAL */
function convertDatetime(sql) {
  return sql
    .replace(/datetime\s*\(\s*'now'\s*,\s*'(-?\d+)\s*days?'\s*\)/gi, (_, d) =>
      `(NOW() + INTERVAL '${d} days')`)
    .replace(/datetime\s*\(\s*'now'\s*,\s*'(-?\d+)\s*hours?'\s*\)/gi, (_, h) =>
      `(NOW() + INTERVAL '${h} hours')`)
    .replace(/datetime\s*\(\s*'now'\s*,\s*'(-?\d+)\s*minutes?'\s*\)/gi, (_, m) =>
      `(NOW() + INTERVAL '${m} minutes')`)
    .replace(/datetime\s*\(\s*'now'\s*\)/gi, 'NOW()')
    // datetime(column) → column::timestamptz
    .replace(/datetime\s*\(\s*([^)]+)\s*\)/gi, '$1::timestamptz');
}

/** Detect INSERT and append RETURNING id if not already present */
function maybeAddReturning(sql) {
  const trimmed = sql.trim().toUpperCase();
  if (trimmed.startsWith('INSERT') && !trimmed.includes('RETURNING')) {
    return sql.replace(/;?\s*$/, '') + ' RETURNING id';
  }
  return sql;
}

/** Full SQL conversion pipeline */
function convertSQL(sql) {
  let out = convertDatetime(sql);
  out = convertPlaceholders(out);
  return out;
}

/**
 * Determine if params are named (object) or positional (array).
 * SQLite named params: db.prepare('... @foo ...').get({ foo: 42 })
 */
function resolveParams(rawSQL, params) {
  // If single object arg (not null, not array, not Buffer) → named params
  if (params.length === 1 && params[0] && typeof params[0] === 'object' && !Array.isArray(params[0]) && !Buffer.isBuffer(params[0])) {
    const obj = params[0];
    // Check if SQL contains @name patterns
    if (/@\w+/.test(rawSQL)) {
      const converted = convertDatetime(rawSQL);
      const { sql, values } = convertNamedParams(converted, obj);
      return { sql, values };
    }
  }
  // Positional params
  return { sql: convertSQL(rawSQL), values: params };
}

function prepare(rawSQL) {
  const pool = getPool();

  return {
    async run(...params) {
      const { sql: convertedSQL, values } = resolveParams(rawSQL, params);
      const sql = maybeAddReturning(convertedSQL);
      try {
        const result = await pool.query(sql, values);
        return {
          changes: result.rowCount || 0,
          lastInsertRowid: result.rows?.[0]?.id ?? null
        };
      } catch (err) {
        console.error('PG run error:', err.message, '\nSQL:', sql, '\nParams:', values);
        throw err;
      }
    },

    async get(...params) {
      const { sql, values } = resolveParams(rawSQL, params);
      try {
        const result = await pool.query(sql, values);
        return result.rows[0] || null;
      } catch (err) {
        console.error('PG get error:', err.message, '\nSQL:', sql, '\nParams:', values);
        throw err;
      }
    },

    async all(...params) {
      const { sql, values } = resolveParams(rawSQL, params);
      try {
        const result = await pool.query(sql, values);
        return result.rows;
      } catch (err) {
        console.error('PG all error:', err.message, '\nSQL:', sql, '\nParams:', values);
        throw err;
      }
    }
  };
}

async function exec(rawSQL) {
  const pool = getPool();
  const sql = convertDatetime(rawSQL);
  try {
    await pool.query(sql);
  } catch (err) {
    console.error('PG exec error:', err.message, '\nSQL:', sql.slice(0, 200));
    throw err;
  }
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// Helper: run the schema.sql file to initialize DB
async function initSchema() {
  const fs = require('fs');
  const path = require('path');
  const schemaPath = path.join(__dirname, 'schema.sql');
  if (fs.existsSync(schemaPath)) {
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    await exec(schemaSql);
    console.log('PostgreSQL schema initialized');
  }
}

module.exports = {
  prepare,
  exec,
  close,
  getPool,
  initSchema,
  pragma: () => {} // no-op for SQLite compat
};
