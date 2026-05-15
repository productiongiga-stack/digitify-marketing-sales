const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const connectPgSimple = require('connect-pg-simple');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const sharp = require('sharp');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const archiver = require('archiver');
const crypto = require('crypto');

const { db, getConfig, setSetting, getSetting, ensureOwner, getOrCreateSecret, sortSizes, encryptSetting, decryptSetting, initDatabase, USE_PG, sanitizeProducts } = require('./db');
const pgAdapter = USE_PG ? require('./db-pg') : null;
const { version: APP_VERSION = '0.0.0' } = require('./package.json');
// Only load better-sqlite3 when in SQLite mode (for backup/restore)
const Database = USE_PG ? null : require('better-sqlite3');

const PORT = process.env.PORT || 3737;
const ROOT = __dirname;
const IS_VERCEL_RUNTIME = !!process.env.VERCEL;
const USE_WRITABLE_TMP = USE_PG || IS_VERCEL_RUNTIME;
const STORAGE_ROOT = USE_WRITABLE_TMP ? '/tmp' : ROOT;
const PUBLIC_DIR = path.join(ROOT, 'public');
const INDEX_HTML_PATH = path.join(PUBLIC_DIR, 'index.html');
const BRAND_ASSET_DIR = USE_WRITABLE_TMP
  ? path.join(STORAGE_ROOT, 'uploads', 'assets', 'branding')
  : path.join(PUBLIC_DIR, 'assets', 'branding');
const PRODUCT_ASSET_DIR = USE_WRITABLE_TMP
  ? path.join(STORAGE_ROOT, 'uploads', 'assets', 'products')
  : path.join(PUBLIC_DIR, 'assets', 'products');
const SESSION_REMEMBER_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30;
const UPLOAD_DIR = path.join(STORAGE_ROOT, 'uploads');
const CART_DIR = path.join(UPLOAD_DIR, 'cart');
const ORDER_DIR = path.join(UPLOAD_DIR, 'orders');
const BACKUP_DIR = path.join(STORAGE_ROOT, 'data', 'backups');

// Storage setup: local uses project root, serverless/writable runtime uses /tmp.
if (!USE_WRITABLE_TMP) {
  [UPLOAD_DIR, CART_DIR, ORDER_DIR, BACKUP_DIR, BRAND_ASSET_DIR, PRODUCT_ASSET_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));
} else {
  [UPLOAD_DIR, CART_DIR, ORDER_DIR, BRAND_ASSET_DIR, PRODUCT_ASSET_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));
}

const cartUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 25 },
  fileFilter: (_req, file, cb) => {
    if (String(file.mimetype || '').startsWith('image/')) return cb(null, true);
    cb(new Error('Alleen afbeeldingsbestanden zijn toegestaan'));
  }
});
const restoreUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 150 * 1024 * 1024, files: 1 }
});
const brandingUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const mime = String(file.mimetype || '').toLowerCase();
    if (mime.startsWith('image/') || mime === 'application/octet-stream' || mime === 'image/x-icon') return cb(null, true);
    cb(new Error('Alleen afbeeldingsbestanden zijn toegestaan'));
  }
});
const productMockupUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const mime = String(file.mimetype || '').toLowerCase();
    if (mime.startsWith('image/')) return cb(null, true);
    cb(new Error('Alleen afbeeldingsbestanden zijn toegestaan'));
  }
});

const app = express();
app.set('trust proxy', 1);
const APP_STARTED_AT = Date.now();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(express.json({
  limit: '20mb',
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));
app.use(express.urlencoded({ extended: true }));

// Session middleware placeholder — registered BEFORE routes so req.session is available.
// The real session handler is injected during boot().
let _sessionHandler = (_req, _res, next) => next();
app.use((req, res, next) => _sessionHandler(req, res, next));
const PgSessionStore = connectPgSimple(session);
let _sessionStore = null;
let _sessionPool = null;

// Session and DB init happen in async boot()
let _booted = false;
async function boot() {
  if (_booted) return;
  _booted = true;
  await initDatabase();
  const secret = await getOrCreateSecret();
  if (!UPLOAD_SIGNING_SECRET) UPLOAD_SIGNING_SECRET = secret.trim();
  if (USE_PG) {
    _sessionPool = pgAdapter.getPool();
    _sessionStore = new PgSessionStore({
      pool: _sessionPool,
      tableName: 'user_sessions',
      createTableIfMissing: false
    });
  }
  _sessionHandler = session({
    secret,
    resave: false,
    saveUninitialized: false,
    store: _sessionStore || undefined,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: SESSION_REMEMBER_MAX_AGE_MS
    }
  });
  const seeded = await ensureOwner();
  if (seeded) {
    console.log('\n========================================');
    console.log(' OWNER ACCOUNT AANGEMAAKT');
    console.log(` Email:    ${seeded.email}`);
    console.log(` Password: ${seeded.password}`);
    console.log(' Wijzig dit wachtwoord direct na eerste login (/account)');
    console.log('========================================\n');
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────
async function currentUser(req) {
  if (!req.session?.userId) return null;
  return await db.prepare(`SELECT id, email, first_name, last_name, role, status, address, postcode, city, phone, totp_enabled, email_verified
                     FROM users WHERE id = ?`).get(req.session.userId);
}
function isStaffRole(role) {
  return role === 'OWNER' || role === 'ADMIN';
}
function applyRememberCookie(req, remember) {
  if (remember) {
    req.session.cookie.maxAge = SESSION_REMEMBER_MAX_AGE_MS;
  } else {
    // Session cookie: geldig tot de browser gesloten wordt.
    req.session.cookie.expires = false;
    req.session.cookie.maxAge = null;
  }
}
function finalizeAuthenticatedSession(req, user, remember) {
  req.session.userId = user.id;
  req.session.pending2faUserId = null;
  req.session.pending2faRemember = null;
  req.session.pending2faAt = null;
  req.session.force2faSetup = (user.role === 'ADMIN') && !Number(user.totp_enabled || 0);
  applyRememberCookie(req, remember);
}
async function requireAuth(req, res, next) {
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ error: 'Niet ingelogd' });
  if (u.status !== 'ACTIVE') return res.status(403).json({ error: 'Account wacht op goedkeuring' });
  if (req.session?.force2faSetup && u.role === 'ADMIN' && !Number(u.totp_enabled || 0)) {
    const allowlist = new Set([
      '/api/auth/me',
      '/api/auth/logout',
      '/api/me/2fa/status',
      '/api/me/2fa/setup',
      '/api/me/2fa/enable',
      '/api/me/2fa/disable'
    ]);
    if (!allowlist.has(req.path)) {
      return res.status(403).json({
        error: '2FA setup is verplicht voor admin-accounts. Rond dit eerst af via /account.',
        code: 'TWO_FACTOR_SETUP_REQUIRED'
      });
    }
  }
  req.user = u;
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Niet ingelogd' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Geen toegang' });
    next();
  };
}
function dataUrlToBuffer(dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
  if (!m) return null;
  return { mime: m[1], buffer: Buffer.from(m[2], 'base64') };
}
function extFromMime(mime) {
  const normalized = String(mime || '').toLowerCase();
  return ({
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/svg+xml': 'svg',
    'image/webp': 'webp',
    'image/avif': 'avif',
    'image/tiff': 'tiff',
    'image/gif': 'gif'
  })[normalized] || 'bin';
}
function mimeFromExt(input) {
  const ext = String(input || '').toLowerCase().replace(/^\./, '');
  return ({
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    avif: 'image/avif',
    tiff: 'image/tiff',
    tif: 'image/tiff',
    gif: 'image/gif',
    ico: 'image/x-icon',
    pdf: 'application/pdf'
  })[ext] || 'application/octet-stream';
}
function parseJsonField(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}
function normalizeUploadPath(input) {
  let raw = String(input || '').trim();
  if (!raw) return null;
  raw = raw.replace(/\\/g, '/');
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      raw = u.pathname || '';
    } catch {}
  }
  raw = raw.replace(/^\/+/, '');
  if (raw.startsWith('uploads/')) raw = raw.slice('uploads/'.length);
  const parts = raw.split('/').filter(Boolean).map(p => p.replace(/[^a-zA-Z0-9._-]/g, '_'));
  if (!parts.length) return null;
  const absPath = path.join(UPLOAD_DIR, ...parts);
  if (!absPath.startsWith(UPLOAD_DIR)) return null;
  return { rel: parts.join('/'), abs: absPath, parts };
}
async function persistUploadBlob(relativePath, buffer, mime) {
  const normalized = normalizeUploadPath(relativePath);
  if (!normalized || !buffer?.length) return null;
  await db.prepare(`
    INSERT INTO upload_blobs(path, mime_type, data, size_bytes, created_at, updated_at)
    VALUES(?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(path) DO UPDATE SET
      mime_type = excluded.mime_type,
      data = excluded.data,
      size_bytes = excluded.size_bytes,
      updated_at = datetime('now')
  `).run(normalized.rel, String(mime || 'application/octet-stream'), buffer, Number(buffer.length) || 0);
  return normalized;
}
async function loadUploadBlob(relativePath) {
  const normalized = normalizeUploadPath(relativePath);
  if (!normalized) return null;
  const row = await db.prepare('SELECT path, mime_type, data, size_bytes, updated_at FROM upload_blobs WHERE path = ?').get(normalized.rel);
  if (!row?.data) return null;
  const buf = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
  return {
    rel: normalized.rel,
    abs: normalized.abs,
    parts: normalized.parts,
    buffer: buf,
    mime: String(row.mime_type || mimeFromExt(path.extname(normalized.rel))),
    sizeBytes: Number(row.size_bytes || buf.length || 0),
    updatedAt: row.updated_at || null
  };
}
async function removeUploadBlob(relativePath) {
  const normalized = normalizeUploadPath(relativePath);
  if (!normalized) return;
  await db.prepare('DELETE FROM upload_blobs WHERE path = ?').run(normalized.rel);
}
async function writeStoredUpload(relativePath, buffer, mime) {
  const normalized = normalizeUploadPath(relativePath);
  if (!normalized || !buffer?.length) return null;
  fs.mkdirSync(path.dirname(normalized.abs), { recursive: true });
  fs.writeFileSync(normalized.abs, buffer);
  await persistUploadBlob(normalized.rel, buffer, mime || mimeFromExt(path.extname(normalized.rel)));
  return normalized;
}
async function readStoredUpload(relativePath) {
  const normalized = normalizeUploadPath(relativePath);
  if (!normalized) return null;
  if (fs.existsSync(normalized.abs)) {
    const buffer = fs.readFileSync(normalized.abs);
    return {
      rel: normalized.rel,
      abs: normalized.abs,
      parts: normalized.parts,
      buffer,
      mime: mimeFromExt(path.extname(normalized.rel)),
      sizeBytes: buffer.length,
      updatedAt: null
    };
  }
  return loadUploadBlob(normalized.rel);
}
async function copyStoredUpload(sourcePath, targetPath, opts = {}) {
  const source = await readStoredUpload(sourcePath);
  if (!source?.buffer?.length) return null;
  const target = await writeStoredUpload(targetPath, source.buffer, source.mime);
  if (opts.removeSource) {
    const sourceNormalized = normalizeUploadPath(sourcePath);
    if (sourceNormalized?.abs) {
      try { fs.rmSync(sourceNormalized.abs, { force: true }); } catch {}
    }
    await removeUploadBlob(sourcePath);
  }
  return target;
}
async function respondWithStoredUpload(res, relativePath, mode = 'private', expiresAt = null) {
  const file = await readStoredUpload(relativePath);
  if (!file?.buffer?.length) return false;
  setUploadCacheHeaders(res, mode, expiresAt);
  res.type(file.mime || 'application/octet-stream');
  res.setHeader('Content-Length', String(file.buffer.length));
  res.send(file.buffer);
  return true;
}
async function canUserAccessUploadByParts(user, parts) {
  if (!user || !parts?.length) return false;
  const isStaff = user.role === 'OWNER' || user.role === 'ADMIN';
  if (isStaff) return true;
  if (parts[0] === 'cart') {
    const itemId = Number(parts[1]);
    if (!Number.isInteger(itemId) || itemId <= 0) return false;
    const ok = await db.prepare('SELECT 1 FROM cart_items WHERE id = ? AND user_id = ?').get(itemId, user.id);
    return !!ok;
  }
  if (parts[0] === 'orders') {
    const orderId = Number(parts[1]);
    if (!Number.isInteger(orderId) || orderId <= 0) return false;
    const ok = await db.prepare('SELECT 1 FROM orders WHERE id = ? AND user_id = ?').get(orderId, user.id);
    return !!ok;
  }
  return false;
}
function signUploadPayload(rel, exp) {
  return crypto.createHmac('sha256', UPLOAD_SIGNING_SECRET).update(`${rel}:${exp}`).digest('hex');
}
function safeSigEqual(a, b) {
  const aa = String(a || '');
  const bb = String(b || '');
  if (!aa || !bb || aa.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(aa, 'hex'), Buffer.from(bb, 'hex'));
  } catch {
    return false;
  }
}
function setUploadCacheHeaders(res, mode = 'private', expiresAt = null) {
  if (mode === 'signed') {
    const remainingSec = Math.max(0, Math.floor(((expiresAt || Date.now()) - Date.now()) / 1000));
    const maxAge = Math.min(86400, remainingSec);
    res.setHeader('Cache-Control', `public, max-age=${maxAge}, s-maxage=${maxAge}, stale-while-revalidate=60`);
    return;
  }
  res.setHeader('Cache-Control', 'private, max-age=3600, stale-while-revalidate=300');
  res.setHeader('Vary', 'Cookie');
}
function isRasterImageMime(mime) {
  return ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/avif', 'image/tiff'].includes(String(mime || '').toLowerCase());
}
function sanitizeBaseUrl(raw, fallback = '') {
  const txt = String(raw == null ? '' : raw).replace(/\s+/g, '').trim();
  if (!txt) return fallback;
  if (!/^https?:\/\//i.test(txt)) return fallback;
  try {
    const url = new URL(txt);
    return url.toString().replace(/\/+$/, '');
  } catch {
    return fallback;
  }
}
function normalizeUploadFilesForCart(previewFile, designFiles, maxDesigns = 20) {
  const preview = previewFile?.buffer?.length ? previewFile : null;
  const files = Array.isArray(designFiles) ? designFiles.filter(Boolean) : [];
  if (files.length > maxDesigns) {
    const err = new Error(`Te veel designbestanden (max ${maxDesigns})`);
    err.status = 400;
    throw err;
  }
  for (const f of files) {
    const mime = String(f?.mimetype || '').toLowerCase();
    if (!mime.startsWith('image/')) {
      const err = new Error(`Ongeldig bestandstype: ${f?.originalname || 'bestand'}`);
      err.status = 400;
      throw err;
    }
  }
  return { preview, files };
}
async function optimizeUploadedImage(buffer, mime, purpose = 'design') {
  if (!buffer?.length) return null;
  const inMime = String(mime || '').toLowerCase();
  if (!isRasterImageMime(inMime)) {
    return { buffer, mime: inMime || 'application/octet-stream', ext: extFromMime(inMime), optimized: false };
  }
  try {
    const pipeline = sharp(buffer, { failOn: 'none' }).rotate().resize({
      width: 2048,
      height: 2048,
      fit: 'inside',
      withoutEnlargement: true
    });
    const quality = purpose === 'preview' ? 76 : 82;
    const effort = purpose === 'preview' ? 2 : 4;
    const out = await pipeline.webp({ quality, alphaQuality: quality, effort }).toBuffer();
    if (out.length > 0 && out.length <= buffer.length) {
      return { buffer: out, mime: 'image/webp', ext: 'webp', optimized: true };
    }
  } catch {}
  return { buffer, mime: inMime || 'application/octet-stream', ext: extFromMime(inMime), optimized: false };
}
async function mapWithConcurrency(items, concurrency, mapper) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];
  const c = Math.max(1, Math.min(4, Number(concurrency) || 1));
  const out = new Array(list.length);
  let idx = 0;
  async function worker() {
    while (idx < list.length) {
      const cur = idx++;
      out[cur] = await mapper(list[cur], cur);
    }
  }
  await Promise.all(Array.from({ length: Math.min(c, list.length) }, () => worker()));
  return out;
}

const ALLOWED_STATUS = [
  'NEW',
  'APPROVED',
  'APPROVED_AWAITING_PAYMENT',
  'PAYMENT_PENDING',
  'PAID',
  'IN_PRODUCTION',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED'
];
const CUSTOMER_CANCELLABLE_STATUS = ['NEW', 'APPROVED', 'APPROVED_AWAITING_PAYMENT', 'PAYMENT_PENDING'];
const FINAL_ORDER_STATUS = ['PAID', 'IN_PRODUCTION', 'SHIPPED', 'DELIVERED', 'CANCELLED'];
const SHIPPING_CARRIERS = ['POSTNL', 'BPOST', 'GLS'];
const SHIPPING_STATUS = ['UNKNOWN', 'PRE_ADVICE', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'EXCEPTION', 'RETURNED'];

const APP_BASE_URL = sanitizeBaseUrl(
  process.env.APP_BASE_URL || process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`,
  `http://localhost:${PORT}`
);
let UPLOAD_SIGNING_SECRET = process.env.UPLOAD_SIGNING_SECRET || '';
// Will be resolved in boot() if not set via env

async function getStripeSecretKey() {
  if (process.env.STRIPE_SECRET_KEY) return process.env.STRIPE_SECRET_KEY.trim();
  const enc = await getSetting('stripe_secret_key_enc');
  if (enc) return await decryptSetting(enc);
  return '';
}

async function getStripeWebhookSecret() {
  if (process.env.STRIPE_WEBHOOK_SECRET) return process.env.STRIPE_WEBHOOK_SECRET.trim();
  const enc = await getSetting('stripe_webhook_secret_enc');
  if (enc) return await decryptSetting(enc);
  return '';
}

async function getAppBaseUrl() {
  if (process.env.APP_BASE_URL || process.env.PUBLIC_BASE_URL) return APP_BASE_URL;
  const stored = await getSetting('stripe_app_base_url');
  return stored ? sanitizeBaseUrl(stored, APP_BASE_URL) : APP_BASE_URL;
}

let _stripeCache = null;
let _stripeCacheKey = null;
async function getStripeClient() {
  const key = await getStripeSecretKey();
  if (!key) return null;
  if (_stripeCache && _stripeCacheKey === key) return _stripeCache;
  _stripeCache = new Stripe(key);
  _stripeCacheKey = key;
  return _stripeCache;
}

function normalizeCurrency(code) {
  const c = String(code || 'EUR').trim().toLowerCase();
  return c || 'eur';
}

function amountToMinor(amount, currency) {
  const zeroDecimal = new Set(['bif','clp','djf','gnf','jpy','kmf','krw','mga','pyg','rwf','ugx','vnd','vuv','xaf','xof','xpf']);
  const factor = zeroDecimal.has(normalizeCurrency(currency)) ? 1 : 100;
  return Math.max(0, Math.round((Number(amount) || 0) * factor));
}

function paymentLinkExpiryTs(config) {
  const hoursRaw = Number(config?.checkout?.paymentLinkExpiryHours || 24);
  const hours = Math.max(1, Math.min(24, Number.isFinite(hoursRaw) ? hoursRaw : 24));
  const ttlSeconds = Math.max(30 * 60, Math.round(hours * 3600));
  return Math.floor(Date.now() / 1000) + ttlSeconds;
}

function normalizeCarrier(raw) {
  const v = String(raw || '').trim().toUpperCase();
  if (['POSTNL', 'POST_NL', 'POST-NL'].includes(v)) return 'POSTNL';
  if (['BPOST', 'B-POST'].includes(v)) return 'BPOST';
  if (['GLS'].includes(v)) return 'GLS';
  return '';
}

function normalizeTrackingCode(raw) {
  return String(raw || '').trim().replace(/\s+/g, '').slice(0, 80);
}

function buildTrackingUrl(carrier, trackingCode) {
  const code = encodeURIComponent(String(trackingCode || '').trim());
  if (!code) return '';
  if (carrier === 'POSTNL') return `https://jouw.postnl.nl/track-and-trace/${code}-NL-`;
  if (carrier === 'BPOST') return `https://track.bpost.cloud/track/item/${code}`;
  if (carrier === 'GLS') return `https://gls-group.com/BE/nl/track-and-trace/?match=${code}`;
  return '';
}

function normalizeShippingStatus(raw) {
  const value = String(raw || '').trim().toUpperCase();
  if (!value) return 'UNKNOWN';
  if (SHIPPING_STATUS.includes(value)) return value;
  if (['PRE_ADVICE', 'PREPARING', 'LABEL_CREATED', 'ANNOUNCED', 'INFO_RECEIVED'].includes(value)) return 'PRE_ADVICE';
  if (['IN_TRANSIT', 'ON_THE_WAY', 'DEPARTED', 'TRANSPORTING', 'SORTING'].includes(value)) return 'IN_TRANSIT';
  if (['OUT_FOR_DELIVERY', 'ON_VEHICLE', 'COURIER_TODAY'].includes(value)) return 'OUT_FOR_DELIVERY';
  if (['DELIVERED', 'DELIVERED_AT_NEIGHBOUR', 'PICKED_UP'].includes(value)) return 'DELIVERED';
  if (['EXCEPTION', 'FAILED_ATTEMPT', 'UNDELIVERABLE', 'DELAYED'].includes(value)) return 'EXCEPTION';
  if (['RETURNED', 'RETURN_TO_SENDER'].includes(value)) return 'RETURNED';
  return 'UNKNOWN';
}

function isOrderArchived(order) {
  return !!(order && order.deleted_at);
}

async function getOrderById(id) {
  return await db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
}

async function addOrderHistory(orderId, status, note, changedBy = null) {
  await db.prepare(`INSERT INTO order_status_history(order_id, status, note, changed_by)
              VALUES(?, ?, ?, ?)`).run(orderId, status, note || '', changedBy);
}

async function logAudit({ actorUserId = null, actorEmail = null, action, entityType, entityId = null, summary, details = null }) {
  if (!action || !entityType || !summary) return;
  let detailsJson = null;
  if (details != null) {
    try { detailsJson = JSON.stringify(details); } catch { detailsJson = null; }
  }
  await db.prepare(`INSERT INTO audit_log(user_id, user_email, action, entity_type, entity_id, summary, details)
              VALUES(?, ?, ?, ?, ?, ?, ?)`)
    .run(actorUserId, actorEmail || null, action, entityType, entityId == null ? null : String(entityId), summary, detailsJson);
}

async function logAuditFromReq(req, payload) {
  await logAudit({
    actorUserId: req.user?.id || null,
    actorEmail: req.user?.email || null,
    ...payload
  });
}

function getNestedValue(obj, path) {
  return String(path || '').split('.').filter(Boolean).reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function formatAuditValue(v, type = 'text') {
  if (type === 'money') return fmtEUR(v);
  if (type === 'bool') return v ? 'ja' : 'nee';
  if (v == null || v === '') return '—';
  return String(v);
}

function buildConfigAuditChangeSet(prevConfig, nextConfig) {
  const fields = [
    { path: 'pricing.basePrice', label: 'Basisprijs', type: 'money' },
    { path: 'pricing.extraDesignFee', label: 'Extra design fee', type: 'money' },
    { path: 'pricing.shippingCost', label: 'Verzendkost', type: 'money' },
    { path: 'pricing.shippingFreeThreshold', label: 'Gratis verzending vanaf', type: 'money' },
    { path: 'pricing.shippingFree', label: 'Gratis verzending actief', type: 'bool' },
    { path: 'pricing.deliveryText', label: 'Levertijd tekst', type: 'text' },
    { path: 'products.length', label: 'Aantal producttypes', type: 'text' },
    { path: 'checkout.paymentProvider', label: 'Betaalprovider', type: 'text' },
    { path: 'checkout.currency', label: 'Valuta', type: 'text' },
    { path: 'checkout.paymentLinkExpiryHours', label: 'Betaallink vervalt na (uren)', type: 'text' },
    { path: 'company.legalName', label: 'Bedrijfsnaam', type: 'text' },
    { path: 'company.invoicePrefix', label: 'Factuurprefix', type: 'text' },
    { path: 'company.vatNumber', label: 'BTW nummer', type: 'text' },
    { path: 'documents.invoice.paymentTermsDays', label: 'Factuur betaaltermijn (dagen)', type: 'text' },
    { path: 'documents.invoice.numberYearMode', label: 'Factuurnummer jaarmodus', type: 'text' },
    { path: 'documents.invoice.numberPadLength', label: 'Factuurnummer padding', type: 'text' },
    { path: 'documents.invoice.reminderEnabled', label: 'Factuur reminders actief', type: 'bool' },
    { path: 'documents.invoice.reminderIntervalHours', label: 'Factuur reminder interval (uren)', type: 'text' },
    { path: 'documents.invoice.reminderMaxCount', label: 'Factuur reminder max', type: 'text' },
    { path: 'documents.packingSlip.showFilePaths', label: 'Orderbon toont bestandspaden', type: 'bool' }
  ];

  const changes = [];
  const map = {};
  fields.forEach((field) => {
    const before = getNestedValue(prevConfig, field.path);
    const after = getNestedValue(nextConfig, field.path);
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    changes.push(`${field.label}: ${formatAuditValue(before, field.type)} -> ${formatAuditValue(after, field.type)}`);
    map[field.path] = { before, after };
  });

  return {
    summary: changes.length ? `Config gewijzigd (${changes.join('; ')})` : 'Configuratie bijgewerkt',
    changes: map,
    changedCount: changes.length
  };
}

const RESTORE_TABLES = [
  'settings',
  'users',
  'cart_items',
  'cart_item_designs',
  'orders',
  'order_items',
  'order_designs',
  'order_status_history',
  'payments',
  'invoices',
  'audit_log'
];

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function getTableColumns(conn, table) {
  return conn.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all().map(r => r.name);
}

function getOrderIdFromSession(checkoutSession) {
  const raw = checkoutSession?.metadata?.order_id
    || checkoutSession?.client_reference_id
    || checkoutSession?.metadata?.orderId;
  if (!raw) return null;
  const m = String(raw).match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

async function createCheckoutSessionForOrder(order, config) {
  const stripe = await getStripeClient();
  if (!stripe) throw new Error('Stripe is niet geconfigureerd. Ga naar Instellingen → Betalingen om je Stripe-sleutels in te vullen.');
  const currency = normalizeCurrency(config?.checkout?.currency || 'EUR');
  const unitAmount = amountToMinor(order.total, currency);
  if (!unitAmount) throw new Error('Orderbedrag is ongeldig voor betaling');
  const expiresAt = paymentLinkExpiryTs(config);

  const sessionObj = await stripe.checkout.sessions.create({
    mode: 'payment',
    success_url: `${APP_BASE_URL}/dashboard?order=${order.id}&payment=success`,
    cancel_url: `${APP_BASE_URL}/dashboard?order=${order.id}&payment=cancel`,
    customer_email: order.customer_email || undefined,
    client_reference_id: String(order.id),
    expires_at: expiresAt,
    metadata: {
      order_id: String(order.id)
    },
    line_items: [{
      quantity: 1,
      price_data: {
        currency,
        unit_amount: unitAmount,
        product_data: {
          name: `Order #${String(order.id).padStart(4, '0')}`,
          description: 'Custom bestelling'
        }
      }
    }]
  });

  return {
    checkoutId: sessionObj.id,
    checkoutUrl: sessionObj.url,
    expiresAtIso: expiresAt ? new Date(expiresAt * 1000).toISOString() : null,
    currency: currency.toUpperCase(),
    amount: Number(order.total) || 0
  };
}

async function upsertPaymentStatusFromCheckoutEvent(checkoutSession, eventType, eventId = null) {
  const orderId = getOrderIdFromSession(checkoutSession);
  if (!orderId) return;
  const order = await getOrderById(orderId);
  if (!order || isOrderArchived(order)) return;

  const checkoutId = checkoutSession?.id || null;
  const paymentIntentId = checkoutSession?.payment_intent || null;
  const paymentStatus = String(checkoutSession?.payment_status || '').toLowerCase();
  const row = checkoutId
    ? await db.prepare(`SELECT * FROM payments WHERE provider = 'STRIPE' AND provider_checkout_id = ?
                  ORDER BY id DESC LIMIT 1`).get(checkoutId)
    : null;
  if (!row) return;

  const meta = {
    eventType,
    eventId: eventId || null,
    checkoutStatus: checkoutSession?.status || null,
    paymentStatus
  };

  if (eventType === 'checkout.session.completed' && paymentStatus === 'paid') {
    const becamePaid = row.status !== 'PAID';
    await db.prepare(`UPDATE payments
                SET status='PAID', provider_payment_id=COALESCE(?, provider_payment_id),
                    paid_at=datetime('now'), failure_reason=NULL, metadata=?
                WHERE id = ?`).run(paymentIntentId, JSON.stringify(meta), row.id);
    if (order.status !== 'PAID' && !FINAL_ORDER_STATUS.includes(order.status)) {
      await db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('PAID', orderId);
      await addOrderHistory(orderId, 'PAID', 'Betaling bevestigd via Stripe webhook', null);
    }
    await markInvoicePaid(orderId);
    if (becamePaid && order.customer_email) {
      await sendPaymentReceivedEmailWithInvoiceSafe(order);
    }
    return;
  }

  if (eventType === 'checkout.session.async_payment_succeeded') {
    const becamePaid = row.status !== 'PAID';
    await db.prepare(`UPDATE payments
                SET status='PAID', provider_payment_id=COALESCE(?, provider_payment_id),
                    paid_at=datetime('now'), failure_reason=NULL, metadata=?
                WHERE id = ?`).run(paymentIntentId, JSON.stringify(meta), row.id);
    if (order.status !== 'PAID' && !FINAL_ORDER_STATUS.includes(order.status)) {
      await db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('PAID', orderId);
      await addOrderHistory(orderId, 'PAID', 'Asynchrone betaling bevestigd via Stripe webhook', null);
    }
    await markInvoicePaid(orderId);
    if (becamePaid && order.customer_email) {
      await sendPaymentReceivedEmailWithInvoiceSafe(order);
    }
    return;
  }

  if (eventType === 'checkout.session.completed' && paymentStatus !== 'paid') {
    const becamePending = row.status !== 'PENDING';
    await db.prepare(`UPDATE payments
                SET status='PENDING', provider_payment_id=COALESCE(?, provider_payment_id), metadata=?
                WHERE id = ?`).run(paymentIntentId, JSON.stringify(meta), row.id);
    if (!FINAL_ORDER_STATUS.includes(order.status) && order.status !== 'PAYMENT_PENDING') {
      await db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('PAYMENT_PENDING', orderId);
      await addOrderHistory(orderId, 'PAYMENT_PENDING', 'Checkout afgerond, betaling nog in behandeling', null);
    }
    if (becamePending && order.customer_email) {
      sendTemplatedEmailSafe('orderStatusChanged', order.customer_email, {
        orderId: formatOrderId(orderId),
        customerName: `${order.customer_first || ''} ${order.customer_last || ''}`.trim(),
        orderTotal: fmtEUR(order.total),
        orderStatusLabel: statusLabel('PAYMENT_PENDING')
      });
    }
    return;
  }

  if (eventType === 'checkout.session.async_payment_failed' || eventType === 'checkout.session.expired') {
    await db.prepare(`UPDATE payments
                SET status='FAILED', failure_reason=?, metadata=?
                WHERE id = ?`).run(eventType, JSON.stringify(meta), row.id);
    if (!FINAL_ORDER_STATUS.includes(order.status) && order.status !== 'APPROVED_AWAITING_PAYMENT') {
      await db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('APPROVED_AWAITING_PAYMENT', orderId);
      await addOrderHistory(orderId, 'APPROVED_AWAITING_PAYMENT', 'Betaling mislukt of verlopen, nieuwe betaallink vereist', null);
    }
  }
}

const ORDER_STATUS_LABELS = {
  NEW: 'Nieuw',
  APPROVED: 'Goedgekeurd',
  APPROVED_AWAITING_PAYMENT: 'Goedgekeurd (wacht op betaling)',
  PAYMENT_PENDING: 'Betaling in behandeling',
  PAID: 'Betaald',
  IN_PRODUCTION: 'In productie',
  SHIPPED: 'Verzonden',
  DELIVERED: 'Bezorgd',
  CANCELLED: 'Geannuleerd'
};

function formatOrderId(orderId) {
  return String(orderId).padStart(4, '0');
}

function statusLabel(status) {
  return ORDER_STATUS_LABELS[status] || status;
}

function fmtEUR(value) {
  return '€' + (Number(value) || 0).toFixed(2).replace('.', ',');
}

function parseSqliteDate(raw) {
  if (!raw) return null;
  const str = String(raw);
  const dt = new Date(str.includes('T') ? str : `${str}Z`);
  return Number.isFinite(dt.getTime()) ? dt : null;
}

function paymentMethodLabelFromProvider(provider) {
  const code = String(provider || '').trim().toUpperCase();
  if (code === 'STRIPE') return 'Stripe Checkout';
  if (!code) return 'Onbekend';
  return code;
}

function buildInvoiceNumber(order, config, issueDate = new Date()) {
  const company = config?.company || {};
  const invoiceCfg = config?.documents?.invoice || {};
  const prefix = String(company.invoicePrefix || 'INV').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '') || 'INV';
  const padLength = Math.min(10, Math.max(4, Number(invoiceCfg.numberPadLength) || 6));
  const mode = String(invoiceCfg.numberYearMode || 'ORDER_YEAR').toUpperCase();
  const orderDate = parseSqliteDate(order?.created_at) || issueDate;
  const year = (mode === 'ISSUE_YEAR' ? issueDate : orderDate).getFullYear();
  return `${prefix}-${year}-${String(order?.id || 0).padStart(padLength, '0')}`;
}

function fmtDateBE(dateLike) {
  const d = dateLike instanceof Date ? dateLike : parseSqliteDate(dateLike);
  if (!d) return '';
  return d.toLocaleDateString('nl-BE');
}

function invoiceStatusLabel(status) {
  const s = String(status || '').toUpperCase();
  const map = {
    CONCEPT: 'Concept',
    DEFINITIVE: 'Definitief',
    PAID: 'Betaald',
    VOID: 'Geannuleerd'
  };
  return map[s] || s;
}

function computeInvoiceDueDateIso(issueDate, paymentTermsDays = 0) {
  const issue = issueDate instanceof Date ? issueDate : new Date();
  const days = Math.min(90, Math.max(0, Number(paymentTermsDays) || 0));
  const due = new Date(issue.getTime() + days * 24 * 60 * 60 * 1000);
  return due.toISOString();
}

async function getInvoiceByOrderId(orderId) {
  return await db.prepare('SELECT * FROM invoices WHERE order_id = ?').get(orderId);
}

async function ensureInvoiceForOrder(orderId, config) {
  if (!config) config = await getConfig();
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) return null;
  let inv = await getInvoiceByOrderId(id);
  if (inv) return inv;
  const now = new Date();
  const dueIso = computeInvoiceDueDateIso(now, config?.documents?.invoice?.paymentTermsDays);
  const invoiceNo = buildInvoiceNumber(order, config, now);
  const paidPayment = await db.prepare(`SELECT paid_at FROM payments WHERE order_id = ? AND status = 'PAID'
                                  ORDER BY id DESC LIMIT 1`).get(id);
  const derivedStatus = order.status === 'PAID'
    ? 'PAID'
    : (order.status === 'CANCELLED'
      ? 'VOID'
      : (['APPROVED_AWAITING_PAYMENT', 'PAYMENT_PENDING', 'IN_PRODUCTION', 'SHIPPED', 'DELIVERED'].includes(order.status)
        ? 'DEFINITIVE'
        : 'CONCEPT'));
  await db.prepare(`INSERT INTO invoices(order_id, invoice_number, status, issue_date, due_date, metadata)
              VALUES(?, ?, ?, ?, ?, ?)`)
    .run(id, invoiceNo, derivedStatus, now.toISOString(), dueIso, JSON.stringify({ source: 'order_created_backfill' }));
  if (derivedStatus === 'PAID' && paidPayment?.paid_at) {
    await db.prepare(`UPDATE invoices SET paid_at = ?, finalized_at = COALESCE(finalized_at, ?) WHERE order_id = ?`)
      .run(parseSqliteDate(paidPayment.paid_at)?.toISOString() || now.toISOString(), now.toISOString(), id);
  } else if (derivedStatus === 'DEFINITIVE') {
    await db.prepare(`UPDATE invoices SET finalized_at = COALESCE(finalized_at, ?) WHERE order_id = ?`)
      .run(now.toISOString(), id);
  }
  return await getInvoiceByOrderId(id);
}

async function backfillMissingInvoices(config, limit = 300) {
  if (!config) config = await getConfig();
  const rows = await db.prepare(`
    SELECT o.id
    FROM orders o
    LEFT JOIN invoices i ON i.order_id = o.id
    WHERE i.id IS NULL AND o.deleted_at IS NULL
    ORDER BY o.id DESC
    LIMIT ?
  `).all(Math.max(1, Number(limit) || 300));
  for (const r of rows) await ensureInvoiceForOrder(r.id, config);
  return rows.length;
}

async function finalizeInvoiceForOrder(orderId, config) {
  if (!config) config = await getConfig();
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) return null;
  const now = new Date();
  const dueIso = computeInvoiceDueDateIso(now, config?.documents?.invoice?.paymentTermsDays);
  const invoiceNo = buildInvoiceNumber(order, config, now);
  await ensureInvoiceForOrder(id, config);
  await db.prepare(`UPDATE invoices
              SET invoice_number = ?, status = 'DEFINITIVE', issue_date = ?, due_date = ?, finalized_at = ?, metadata = ?
              WHERE order_id = ? AND status != 'PAID'`)
    .run(invoiceNo, now.toISOString(), dueIso, now.toISOString(), JSON.stringify({ source: 'order_approved' }), id);
  return await getInvoiceByOrderId(id);
}

async function markInvoicePaid(orderId) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) return;
  const nowIso = new Date().toISOString();
  await ensureInvoiceForOrder(id, await getConfig());
  await db.prepare(`UPDATE invoices
              SET status = 'PAID', paid_at = ?, finalized_at = COALESCE(finalized_at, ?)
              WHERE order_id = ?`)
    .run(nowIso, nowIso, id);
}

async function markInvoiceVoid(orderId) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) return;
  await ensureInvoiceForOrder(id, await getConfig());
  await db.prepare(`UPDATE invoices
              SET status = CASE WHEN status = 'PAID' THEN status ELSE 'VOID' END
              WHERE order_id = ?`)
    .run(id);
}

function normalizeMoney(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return Number(fallback) || 0;
  return Math.max(0, n);
}

function computeShippingAmount(subtotal, pricing = {}) {
  const sub = normalizeMoney(subtotal, 0);
  const shippingCost = normalizeMoney(pricing.shippingCost, 0);
  if (shippingCost <= 0) return 0;
  const freeEnabled = !!pricing.shippingFree;
  const threshold = normalizeMoney(pricing.shippingFreeThreshold, 0);
  if (!freeEnabled) return shippingCost;
  if (threshold <= 0) return 0;
  return sub >= threshold ? 0 : shippingCost;
}

function normalizePublicAssetPath(raw) {
  const input = String(raw || '').trim();
  if (!input) return '';
  if (/^https?:\/\//i.test(input)) return input;
  const clean = input.split(/[?#]/)[0].replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.includes('..')) return '';
  return clean;
}

function publicAssetUrl(raw, fallback = '') {
  const normalized = normalizePublicAssetPath(raw);
  const chosen = normalized || normalizePublicAssetPath(fallback);
  if (!chosen) return '';
  if (/^https?:\/\//i.test(chosen)) return chosen;
  return `${APP_BASE_URL}/${chosen.replace(/^\/+/, '')}`;
}

function resolvePublicAssetAbs(raw) {
  const normalized = normalizePublicAssetPath(raw);
  if (!normalized || /^https?:\/\//i.test(normalized)) return null;
  const staticAbs = path.resolve(PUBLIC_DIR, normalized);
  if ((staticAbs.startsWith(PUBLIC_DIR + path.sep) || staticAbs === PUBLIC_DIR) && fs.existsSync(staticAbs)) {
    return { rel: normalized, abs: staticAbs };
  }
  if (USE_WRITABLE_TMP && (normalized.startsWith('assets/branding/') || normalized.startsWith('assets/products/'))) {
    const dynAbs = path.resolve(UPLOAD_DIR, normalized);
    const allowedRoot = path.resolve(UPLOAD_DIR, 'assets');
    if ((dynAbs.startsWith(allowedRoot + path.sep) || dynAbs === allowedRoot) && fs.existsSync(dynAbs)) {
      return { rel: normalized, abs: dynAbs };
    }
  }
  return null;
}

function sanitizeBrandColor(raw, fallback = '#0f172a') {
  const s = String(raw || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : fallback;
}

function getEmailBranding(config = {}) {
  const theme = config?.theme || {};
  const brandName = String(config?.brand?.name || config?.company?.legalName || 'NEBULOUS').trim() || 'NEBULOUS';
  const logoSymbol = String(theme.logoMark || '✦').trim().slice(0, 2) || '✦';
  const accent = sanitizeBrandColor(theme.accentColor, '#111827');
  const logoUrl = publicAssetUrl(theme.logoPath || '');
  const faviconUrl = publicAssetUrl(theme.faviconPath || '');
  return { brandName, logoSymbol, accent, logoUrl, faviconUrl };
}

function buildBrandedEmailHtml(innerHtml, subject, config = {}) {
  const safeBody = String(innerHtml || '');
  const safeSubject = htmlEscape(subject || '');
  const branding = getEmailBranding(config);
  const safeBrand = htmlEscape(branding.brandName);
  const safeLogoSymbol = htmlEscape(branding.logoSymbol);
  const safeLogoUrl = htmlEscape(branding.logoUrl || '');
  const safeAccent = htmlEscape(branding.accent);
  const year = new Date().getFullYear();
  const logoBlock = safeLogoUrl
    ? `<img src="${safeLogoUrl}" alt="${safeBrand}" style="max-height:34px;max-width:140px;display:block">`
    : `<span style="display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:10px;background:${safeAccent};color:#fff;font-size:18px;font-weight:700">${safeLogoSymbol}</span>`;

  return `<!doctype html>
<html lang="nl">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f6f8fb;font-family:Inter,Arial,sans-serif;color:#0f172a">
  <div style="max-width:640px;margin:24px auto;padding:0 12px">
    <div style="background:#ffffff;border:1px solid #e6eaf0;border-radius:14px;overflow:hidden;box-shadow:0 8px 30px rgba(15,23,42,.06)">
      <div style="padding:14px 18px;border-bottom:1px solid #edf1f5;display:flex;align-items:center;justify-content:space-between;gap:12px">
        <div style="display:flex;align-items:center;gap:10px">${logoBlock}<strong style="font-size:14px;letter-spacing:.2px">${safeBrand}</strong></div>
        <span style="font-size:11px;color:#64748b">Automatisch bericht</span>
      </div>
      <div style="padding:14px 18px;background:#fbfdff;border-bottom:1px solid #edf1f5;color:#334155;font-size:13px">${safeSubject}</div>
      <div style="padding:20px 18px;font-size:14px;line-height:1.6;color:#0f172a">${safeBody}</div>
      <div style="padding:12px 18px;border-top:1px solid #edf1f5;background:#fafbfd;font-size:12px;color:#64748b">© ${year} ${safeBrand}</div>
    </div>
  </div>
</body>
</html>`;
}

async function loadPdfLogoBuffer(config = {}) {
  const logoPath = config?.theme?.logoPath;
  const resolved = resolvePublicAssetAbs(logoPath);
  try {
    const input = resolved?.abs || (await readStoredUpload(logoPath))?.buffer;
    if (!input) return null;
    return await sharp(input)
      .rotate()
      .resize({ width: 420, height: 120, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer();
  } catch {
    return null;
  }
}

function absoluteUrlForAsset(rawPath, fallbackPath = '/assets/tshirt_mockup.png') {
  const raw = String(rawPath || '').trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  const candidate = raw || fallbackPath;
  const normalized = '/' + String(candidate).replace(/^\/+/, '');
  return `${APP_BASE_URL}${normalized}`;
}

function buildSeoPayload(config) {
  const brandName = String(config?.brand?.name || config?.company?.legalName || 'NEBULOUS').trim();
  const defaultDesc = String(config?.hero?.subtitle || config?.brand?.tagline || '').trim()
    || 'Ontwerp je eigen custom kleding en promotiemateriaal met live preview. Upload je design en bestel direct online.';
  const seo = config?.seo || {};
  const title = String(seo.ogTitle || `${brandName} - Custom kleding & printproducten`).trim();
  const description = String(seo.metaDescription || seo.ogDescription || defaultDesc).trim();
  const ogDescription = String(seo.ogDescription || description).trim();
  const ogImage = absoluteUrlForAsset(seo.ogImagePath || 'assets/tshirt_mockup.png');
  const pageUrl = `${APP_BASE_URL}/`;
  const lowPrice = Number(config?.pricing?.basePrice || 0);
  const currency = String(config?.checkout?.currency || 'EUR').toUpperCase();
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: title,
    description,
    brand: { '@type': 'Brand', name: brandName },
    image: [ogImage],
    offers: {
      '@type': 'AggregateOffer',
      priceCurrency: currency,
      lowPrice: (Number.isFinite(lowPrice) ? lowPrice : 0).toFixed(2),
      availability: 'https://schema.org/InStock',
      url: pageUrl
    },
    url: pageUrl
  };
  return { title, description, ogDescription, ogImage, pageUrl, jsonLd };
}

function jsonLdScriptTag(jsonLdObj) {
  const payload = JSON.stringify(jsonLdObj).replace(/<\/script/gi, '<\\/script');
  return `<script type="application/ld+json" id="seoJsonLd">${payload}</script>`;
}

function replaceHeadTag(html, matcher, replacement) {
  return matcher.test(html) ? html.replace(matcher, replacement) : html;
}

function renderIndexWithSeo(config) {
  let html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const seo = buildSeoPayload(config);
  html = replaceHeadTag(html, /<title>[\s\S]*?<\/title>/i, `<title>${htmlEscape(seo.title)}</title>`);
  html = replaceHeadTag(html, /<meta[^>]*name="description"[^>]*>/i, `<meta name="description" content="${htmlEscape(seo.description)}">`);
  html = replaceHeadTag(html, /<meta[^>]*property="og:title"[^>]*>/i, `<meta property="og:title" content="${htmlEscape(seo.title)}">`);
  html = replaceHeadTag(html, /<meta[^>]*property="og:description"[^>]*>/i, `<meta property="og:description" content="${htmlEscape(seo.ogDescription)}">`);
  html = replaceHeadTag(html, /<meta[^>]*property="og:image"[^>]*>/i, `<meta property="og:image" content="${htmlEscape(seo.ogImage)}">`);
  html = replaceHeadTag(html, /<meta[^>]*property="og:url"[^>]*>/i, `<meta property="og:url" content="${htmlEscape(seo.pageUrl)}">`);
  html = replaceHeadTag(html, /<meta[^>]*name="twitter:title"[^>]*>/i, `<meta name="twitter:title" content="${htmlEscape(seo.title)}">`);
  html = replaceHeadTag(html, /<meta[^>]*name="twitter:description"[^>]*>/i, `<meta name="twitter:description" content="${htmlEscape(seo.ogDescription)}">`);
  html = replaceHeadTag(html, /<meta[^>]*name="twitter:image"[^>]*>/i, `<meta name="twitter:image" content="${htmlEscape(seo.ogImage)}">`);
  if (/<link[^>]*rel="canonical"[^>]*>/i.test(html)) {
    html = replaceHeadTag(html, /<link[^>]*rel="canonical"[^>]*>/i, `<link rel="canonical" href="${htmlEscape(seo.pageUrl)}">`);
  } else {
    html = html.replace('</head>', `  <link rel="canonical" href="${htmlEscape(seo.pageUrl)}">\n</head>`);
  }
  html = replaceHeadTag(html, /<script[^>]*id="seoJsonLd"[^>]*>[\s\S]*?<\/script>/i, jsonLdScriptTag(seo.jsonLd));
  return html;
}

async function resolveCatalogProduct(rawProduct = {}, config = null) {
  const cfg = config || await getConfig();
  const catalog = Array.isArray(cfg?.products) ? cfg.products : [];
  const enabled = catalog.filter(p => p && p.enabled !== false);
  const fallback = enabled.find(p => p.isDefault) || enabled[0] || {
    id: 'tshirt',
    name: 'T-shirt',
    mockupPath: 'assets/tshirt_mockup.png',
    priceMultiplier: 1,
    extraDesignFeeMultiplier: 1
  };

  const wantedId = String(rawProduct?.productType || rawProduct?.productId || '').trim().toLowerCase();
  const selected = enabled.find(p => String(p.id || '').toLowerCase() === wantedId) || fallback;
  const priceMultiplierRaw = Number(selected?.priceMultiplier);
  const extraFeeMultiplierRaw = Number(selected?.extraDesignFeeMultiplier);
  return {
    id: String(selected?.id || fallback.id),
    name: String(selected?.name || fallback.name || 'Product'),
    mockupPath: String(selected?.mockupPath || fallback.mockupPath || 'assets/tshirt_mockup.png'),
    basePrice: selected?.basePrice ?? null,
    extraDesignFee: selected?.extraDesignFee ?? null,
    priceMultiplier: Number.isFinite(priceMultiplierRaw) ? Math.min(10, Math.max(0.1, priceMultiplierRaw)) : 1,
    extraDesignFeeMultiplier: Number.isFinite(extraFeeMultiplierRaw) ? Math.min(10, Math.max(0, extraFeeMultiplierRaw)) : 1,
    colorPrices: selected?.colorPrices || {},
    sizePrices: selected?.sizePrices || {},
    colorData: selected?.colorData || {}
  };
}

function normalizeHexColor(value) {
  const m = /^#?([a-f0-9]{6})$/i.exec(String(value || '').trim());
  return m ? `#${m[1].toLowerCase()}` : '';
}

function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

// As-is -> target checklist:
// - Pricing is server-authoritative from this helper.
// - Legacy priceMultiplier/global fallbacks stay supported.
// - Public /api/config wire-shape remains backward compatible.
async function computeItemPrice(rawItem = {}, config) {
  if (!config) config = await getConfig();
  const product = await resolveCatalogProduct(rawItem, config);
  const size = String(rawItem?.size || '').trim().toUpperCase();
  const colorHex = normalizeHexColor(rawItem?.colorHex || rawItem?.color_hex || rawItem?.color || '');
  const qty = Math.max(1, Math.min(999, Math.round(Number(rawItem?.qty) || 1)));

  const basePrice = product.basePrice != null
    ? Number(product.basePrice)
    : Number(config?.pricing?.basePrice || 0) * Math.max(0.1, Number(product.priceMultiplier || 1));
  const safeBase = Math.max(0, basePrice || 0);

  const sizeUp = Number(product?.sizePrices?.[size]);
  const fallbackSizeUp = Number(config?.pricing?.sizeUpcharge?.[size] || 0);
  const sizeUpcharge = Number.isFinite(sizeUp) ? sizeUp : (Number.isFinite(fallbackSizeUp) ? fallbackSizeUp : 0);

  const colorUp = Number(product?.colorPrices?.[colorHex]);
  const fallbackColorUp = Number(product?.colorData?.[colorHex]?.priceUpcharge || 0);
  const colorUpcharge = Number.isFinite(colorUp) ? colorUp : (Number.isFinite(fallbackColorUp) ? fallbackColorUp : 0);

  const configuredExtraFee = product.extraDesignFee != null
    ? Number(product.extraDesignFee)
    : Number(config?.pricing?.extraDesignFee || 0) * Math.max(0, Number(product.extraDesignFeeMultiplier || 1));
  const extraFeePerDesign = Math.max(0, configuredExtraFee || 0);
  const extraDesignsRaw = Number(rawItem?.extraDesigns);
  const fallbackExtraDesigns = Array.isArray(rawItem?.designs) ? Math.max(0, rawItem.designs.length - 1) : 0;
  const extraDesigns = Number.isFinite(extraDesignsRaw) ? Math.max(0, Math.floor(extraDesignsRaw)) : fallbackExtraDesigns;

  const unitPrice = roundMoney(Math.max(0, safeBase + Math.max(0, sizeUpcharge) + Math.max(0, colorUpcharge)));
  const extrasPrice = roundMoney(extraDesigns * extraFeePerDesign);
  const total = roundMoney((unitPrice + extrasPrice) * qty);
  return { unitPrice, extrasPrice, total, qty, product, size, colorHex, extraDesigns };
}

function htmlEscape(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function renderTemplate(raw, vars) {
  return String(raw || '').replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_m, key) => {
    const v = vars[key];
    return v == null ? '' : String(v);
  });
}

let mailerCache = { key: null, transporter: null };
async function getMailerTransport() {
  const cfgSmtp = ((await getConfig()).smtp) || {};
  const host = (process.env.SMTP_HOST || cfgSmtp.host || '').trim();
  const port = Number(process.env.SMTP_PORT || cfgSmtp.port || 587);
  const user = (process.env.SMTP_USER || cfgSmtp.user || '').trim();
  const pass = (process.env.SMTP_PASS || cfgSmtp.pass || '').trim();
  if (!host || !port || !user || !pass) return null;

  const secureRaw = (process.env.SMTP_SECURE || '').trim().toLowerCase();
  const secure = secureRaw ? ['1', 'true', 'yes'].includes(secureRaw) : (!!cfgSmtp.secure || port === 465);
  const key = [host, port, user, secure ? '1' : '0'].join('|');
  if (mailerCache.transporter && mailerCache.key === key) return mailerCache.transporter;

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass }
  });
  mailerCache = { key, transporter };
  return transporter;
}

async function createEmailTrackingToken(orderId, emailType, recipient = '') {
  const token = crypto.randomBytes(24).toString('hex');
  await db.prepare(`
    INSERT INTO email_tracking(token, order_id, email_type, recipient, sent_at)
    VALUES(?, ?, ?, ?, ?)
  `).run(
    token,
    Number.isFinite(Number(orderId)) ? Number(orderId) : null,
    String(emailType || 'generic').slice(0, 40),
    String(recipient || '').slice(0, 180),
    new Date().toISOString()
  );
  return token;
}

async function getEmailTrackingForOrder(orderId) {
  return await db.prepare(`
    SELECT id, token, order_id, email_type, recipient, sent_at, first_opened_at, open_count, created_at
    FROM email_tracking
    WHERE order_id = ?
    ORDER BY id DESC
  `).all(Number(orderId) || 0);
}

function buildOrderActivityFeed(order, history = [], emailTracking = [], depositInvoices = [], payments = [], shippingEvents = []) {
  const items = [];
  const push = (at, type, title, meta = {}) => {
    const date = parseSqliteDate(at);
    if (!date) return;
    items.push({
      at: date.toISOString(),
      type: String(type || ''),
      title: String(title || ''),
      ...meta
    });
  };

  (history || []).forEach((h) => {
    push(h.created_at, 'status', `Status: ${statusLabel(h.status)}`, {
      note: h.note || '',
      by: h.changed_by_email || ''
    });
  });
  (emailTracking || []).forEach((t) => {
    const labelMap = {
      payment_link: 'Betaallink',
      invoice: 'Factuur',
      offer: 'Offerte',
      deposit_invoice: 'Voorschotfactuur'
    };
    const base = labelMap[String(t.email_type || '').toLowerCase()] || 'E-mail';
    push(t.sent_at || t.created_at, 'email_sent', `${base} verstuurd`, {
      emailType: t.email_type || '',
      recipient: t.recipient || ''
    });
    if (t.first_opened_at) {
      push(t.first_opened_at, 'email_opened', `${base} geopend`, {
        emailType: t.email_type || '',
        openCount: Number(t.open_count || 0)
      });
    }
  });
  (depositInvoices || []).forEach((d) => {
    push(d.created_at || d.issue_date, 'deposit_created', `Voorschotfactuur ${d.invoice_number || ''} aangemaakt`, {
      amount: Number(d.deposit_amount || 0)
    });
    if (d.sent_at) {
      push(d.sent_at, 'deposit_sent', `Voorschotfactuur ${d.invoice_number || ''} verstuurd`, {
        amount: Number(d.deposit_amount || 0)
      });
    }
  });
  (payments || []).forEach((p) => {
    if (p.paid_at) {
      push(p.paid_at, 'payment_paid', 'Betaling ontvangen', {
        amount: Number(p.amount || 0),
        provider: p.provider || ''
      });
    }
  });
  (shippingEvents || []).forEach((e) => {
    push(e.event_at || e.created_at, 'shipping_event', `Verzending: ${e.status_normalized || 'UNKNOWN'}`, {
      carrier: e.carrier || '',
      trackingCode: e.tracking_code || '',
      statusRaw: e.status_raw || ''
    });
  });
  if (order?.deleted_at) {
    push(order.deleted_at, 'order_archived', 'Bestelling gearchiveerd', {
      byUserId: Number(order.deleted_by || 0) || null,
      reason: String(order.delete_reason || '')
    });
  }

  return items.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

async function sendTemplatedEmail(templateKey, to, vars = {}, opts = {}) {
  const toEmail = String(to || '').trim();
  if (!toEmail) return { skipped: 'no_recipient' };
  const transporter = await getMailerTransport();
  if (!transporter) return { skipped: 'smtp_not_configured' };

  const cfg = await getConfig();
  const companyName = cfg?.company?.legalName || cfg?.brand?.name || 'Onze shop';
  const template = cfg?.email?.templates?.[templateKey];
  if (!template?.subject || !template?.html) return { skipped: 'missing_template' };

  const dashboardUrl = `${APP_BASE_URL}/dashboard`;
  const loginUrl = `${APP_BASE_URL}/login`;
  const branding = getEmailBranding(cfg);
  const mergedVars = {
    companyName: htmlEscape(companyName),
    supportEmail: htmlEscape(cfg?.company?.supportEmail || cfg?.email?.fromAddress || ''),
    dashboardUrl,
    loginUrl,
    brandName: htmlEscape(branding.brandName),
    brandLogoUrl: htmlEscape(branding.logoUrl || ''),
    brandFaviconUrl: htmlEscape(branding.faviconUrl || ''),
    brandAccentColor: htmlEscape(branding.accent),
    year: String(new Date().getFullYear()),
    ...Object.fromEntries(Object.entries(vars || {}).map(([k, v]) => [k, htmlEscape(v)]))
  };

  const subject = renderTemplate(template.subject, mergedVars);
  const bodyHtml = renderTemplate(template.html, mergedVars);
  const baseHtml = buildBrandedEmailHtml(bodyHtml, subject, cfg);
  const trackingToken = String(opts.trackingToken || '').trim();
  const trackingPixel = trackingToken
    ? `<img src="${APP_BASE_URL}/api/track/open/${encodeURIComponent(trackingToken)}.gif" width="1" height="1" style="display:none" alt="">`
    : '';
  const html = `${baseHtml}${trackingPixel}`;
  const fromName = cfg?.email?.fromName || companyName;
  const fromAddress = cfg?.email?.fromAddress || process.env.SMTP_FROM || process.env.SMTP_USER;
  const replyTo = cfg?.email?.replyTo || cfg?.company?.supportEmail || undefined;

  await transporter.sendMail({
    from: `"${fromName.replace(/"/g, '')}" <${fromAddress}>`,
    to: toEmail,
    replyTo,
    subject: opts.subject || subject,
    html,
    text: stripHtml(bodyHtml),
    attachments: Array.isArray(opts.attachments) ? opts.attachments : undefined
  });
  return { ok: true };
}

function sendTemplatedEmailSafe(templateKey, to, vars = {}, opts = {}) {
  sendTemplatedEmail(templateKey, to, vars, opts).catch((err) => {
    console.error(`Email send failed [${templateKey}] to ${to}:`, err.message);
  });
}

const INVOICE_REMINDER_RUN = {
  running: false,
  lastAt: 0
};

async function sendInvoiceReminderForRow(row, cfg) {
  if (!cfg) cfg = await getConfig();
  if (!row?.customer_email) return { skipped: 'no_recipient' };
  const vars = {
    orderId: formatOrderId(row.order_id),
    customerName: `${row.customer_first || ''} ${row.customer_last || ''}`.trim(),
    orderTotal: fmtEUR(row.total),
    paymentUrl: row.checkout_url || `${APP_BASE_URL}/dashboard?order=${row.order_id}`,
    invoiceNumber: row.invoice_number || buildInvoiceNumber({ id: row.order_id, created_at: row.issue_date }, cfg),
    invoiceDueDate: fmtDateBE(row.due_date),
    invoiceStatusLabel: invoiceStatusLabel(row.status)
  };
  const info = await sendTemplatedEmail('invoiceReminder', row.customer_email, vars);
  if (info?.ok) {
    await db.prepare(`UPDATE invoices
                SET last_reminder_at = ?, sent_at = COALESCE(sent_at, ?), reminder_count = reminder_count + 1
                WHERE id = ?`)
      .run(new Date().toISOString(), new Date().toISOString(), row.id);
  }
  return info;
}

async function processInvoiceRemindersSafe(force = false) {
  const now = Date.now();
  if (INVOICE_REMINDER_RUN.running) return { skipped: 'running' };
  if (!force && now - INVOICE_REMINDER_RUN.lastAt < 15 * 60 * 1000) return { skipped: 'throttled' };

  const cfg = await getConfig();
  const invoiceCfg = cfg?.documents?.invoice || {};
  if (invoiceCfg.reminderEnabled === false) return { skipped: 'disabled' };
  const intervalHours = Math.min(240, Math.max(1, Number(invoiceCfg.reminderIntervalHours) || 24));
  const maxCount = Math.min(20, Math.max(1, Number(invoiceCfg.reminderMaxCount) || 5));

  INVOICE_REMINDER_RUN.running = true;
  INVOICE_REMINDER_RUN.lastAt = now;
  try {
    const rows = await db.prepare(`
      SELECT i.*, o.customer_email, o.customer_first, o.customer_last, o.total,
             (SELECT checkout_url FROM payments p WHERE p.order_id = o.id AND p.checkout_url IS NOT NULL
              ORDER BY p.id DESC LIMIT 1) AS checkout_url
      FROM invoices i
      JOIN orders o ON o.id = i.order_id
      WHERE i.status = 'DEFINITIVE'
        AND i.paid_at IS NULL
        AND o.status != 'CANCELLED'
        AND i.due_date IS NOT NULL
        AND datetime(i.due_date) <= datetime('now')
        AND (i.last_reminder_at IS NULL OR datetime(i.last_reminder_at) <= datetime('now', ?))
        AND i.reminder_count < ?
      ORDER BY i.due_date ASC
      LIMIT 50
    `).all(`-${intervalHours} hours`, maxCount);

    let sent = 0;
    for (const row of rows) {
      const info = await sendInvoiceReminderForRow(row, cfg);
      if (info?.ok) sent++;
    }
    if (sent > 0) {
      await logAudit({
        actorUserId: null,
        actorEmail: null,
        action: 'INVOICE_REMINDER_SENT',
        entityType: 'invoice',
        entityId: null,
        summary: `${sent} betalingsherinnering(en) verstuurd`,
        details: { sent, intervalHours, maxCount }
      });
    }
    return { ok: true, sent };
  } catch (err) {
    console.error('Invoice reminder job failed:', err);
    return { error: err.message || 'invoice reminder failed' };
  } finally {
    INVOICE_REMINDER_RUN.running = false;
  }
}

function safeFilename(s) {
  return String(s || 'document').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

async function loadUserGdprExportData(userId) {
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid <= 0) throw new Error('Ongeldige gebruiker');

  const user = await db.prepare(`
    SELECT id, email, first_name, last_name, role, status, address, postcode, city, phone, created_at,
           totp_enabled, totp_enabled_at, failed_login_attempts, last_failed_login_at, login_locked_until
    FROM users
    WHERE id = ?
  `).get(uid);
  if (!user) return null;

  const orders = await db.prepare(`SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC`).all(uid);
  const orderIds = orders.map(o => o.id);
  const orderIdPlaceholders = orderIds.map(() => '?').join(',');

  const orderItems = orderIds.length
    ? await db.prepare(`SELECT * FROM order_items WHERE order_id IN (${orderIdPlaceholders}) ORDER BY id`).all(...orderIds)
    : [];
  const orderItemIds = orderItems.map(i => i.id);
  const orderItemPlaceholders = orderItemIds.map(() => '?').join(',');

  const orderDesigns = orderItemIds.length
    ? await db.prepare(`SELECT * FROM order_designs WHERE order_item_id IN (${orderItemPlaceholders}) ORDER BY id`).all(...orderItemIds)
    : [];
  const orderStatusHistory = orderIds.length
    ? await db.prepare(`SELECT * FROM order_status_history WHERE order_id IN (${orderIdPlaceholders}) ORDER BY id`).all(...orderIds)
    : [];
  const payments = orderIds.length
    ? await db.prepare(`SELECT * FROM payments WHERE order_id IN (${orderIdPlaceholders}) ORDER BY id`).all(...orderIds)
    : [];
  const invoices = orderIds.length
    ? await db.prepare(`SELECT * FROM invoices WHERE order_id IN (${orderIdPlaceholders}) ORDER BY id`).all(...orderIds)
    : [];

  const cartItems = await db.prepare(`SELECT * FROM cart_items WHERE user_id = ? ORDER BY id`).all(uid);
  const cartItemIds = cartItems.map(i => i.id);
  const cartItemPlaceholders = cartItemIds.map(() => '?').join(',');
  const cartDesigns = cartItemIds.length
    ? await db.prepare(`SELECT * FROM cart_item_designs WHERE cart_item_id IN (${cartItemPlaceholders}) ORDER BY id`).all(...cartItemIds)
    : [];

  const uploadPathSet = new Set();
  const collectPath = (raw) => {
    const normalized = normalizeUploadPath(raw);
    if (normalized) uploadPathSet.add(`uploads/${normalized.rel}`);
  };
  for (const item of orderItems) collectPath(item.preview_path);
  for (const item of cartItems) collectPath(item.preview_path);
  for (const d of orderDesigns) collectPath(d.file_path);
  for (const d of cartDesigns) collectPath(d.file_path);

  const uploadFiles = [...uploadPathSet].sort().map((relativePath) => {
    const normalized = normalizeUploadPath(relativePath);
    if (!normalized) return { path: relativePath, exists: false };
    const exists = fs.existsSync(normalized.abs);
    let sizeBytes = 0;
    let modifiedAt = null;
    if (exists) {
      try {
        const stat = fs.statSync(normalized.abs);
        sizeBytes = stat.size;
        modifiedAt = stat.mtime.toISOString();
      } catch {}
    }
    return {
      path: relativePath,
      exists,
      sizeBytes,
      modifiedAt
    };
  });

  return {
    user,
    orders,
    orderItems,
    orderDesigns,
    orderStatusHistory,
    payments,
    invoices,
    cartItems,
    cartDesigns,
    uploadFiles
  };
}

async function collectOrderDocumentData(orderId, opts = {}) {
  const includeArchived = !!opts.includeArchived;
  const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return null;
  if (!includeArchived && isOrderArchived(order)) return null;
  const invoice = await db.prepare('SELECT * FROM invoices WHERE order_id = ?').get(orderId) || null;
  const items = await db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(orderId);
  const payments = await db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY id DESC').all(orderId);
  const designs = await db.prepare(`SELECT * FROM order_designs WHERE order_item_id IN
                              (SELECT id FROM order_items WHERE order_id = ?)
                              ORDER BY id`).all(orderId);
  const byItem = {};
  designs.forEach(d => { (byItem[d.order_item_id] ||= []).push(d); });
  return {
    order,
    invoice,
    payments,
    items: items.map(i => ({ ...i, designs: byItem[i.id] || [] }))
  };
}

function buildPdfBuffer(drawFn) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    drawFn(doc);
    doc.end();
  });
}

async function generateInvoicePdfBuffer(orderData, config) {
  const company = config?.company || {};
  const invoiceCfg = config?.documents?.invoice || {};
  const logoBuffer = await loadPdfLogoBuffer(config);
  const invoiceTitle = String(invoiceCfg.title || 'Factuur').trim() || 'Factuur';
  const intro = String(invoiceCfg.intro || '').trim();
  const footer = String(invoiceCfg.footer || '').trim();
  const legalDisclaimer = String(invoiceCfg.legalDisclaimer || '').trim();
  const showSupportContacts = invoiceCfg.showSupportContacts !== false;
  const paymentTermsDays = Math.min(90, Math.max(0, Number(invoiceCfg.paymentTermsDays) || 0));
  const accent = sanitizeBrandColor(config?.theme?.accentColor, '#111827');

  return buildPdfBuffer((doc) => {
    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const left = 48;
    const width = pageW - (left * 2);
    const issueDate = new Date();
    const orderDate = parseSqliteDate(orderData.order.created_at) || issueDate;
    const invoiceNo = orderData.invoice?.invoice_number || buildInvoiceNumber(orderData.order, config, issueDate);
    const latestPayment = (orderData.payments || [])[0] || null;
    const dueDate = new Date(issueDate.getTime() + paymentTermsDays * 24 * 60 * 60 * 1000);
    const paidAt = parseSqliteDate(latestPayment?.paid_at);
    const isPaid = orderData.order.status === 'PAID' || !!paidAt;
    const paymentMethod = paymentMethodLabelFromProvider(latestPayment?.provider);

    // ── HEADER ──────────────────────────────────────────────────────────────
    if (logoBuffer) {
      try { doc.image(logoBuffer, 48, 36, { fit: [180, 52] }); } catch {}
    }
    const titleX = logoBuffer ? 240 : 48;
    const titleY = logoBuffer ? 44 : undefined;
    doc.fontSize(18).fillColor('#111').text(
      `${company.legalName || config?.brand?.name || 'Bedrijf'} — ${invoiceTitle}`,
      titleX, titleY
    );
    doc.moveDown(0.4);
    doc.fontSize(10).fillColor('#555').text(`Factuurnummer: ${invoiceNo}`);
    doc.text(`Factuurdatum: ${issueDate.toLocaleDateString('nl-BE')}`);
    doc.text(`Orderdatum: ${orderDate.toLocaleDateString('nl-BE')}`);
    doc.text(`Order: #${formatOrderId(orderData.order.id)}`);
    doc.text(`Betalingsstatus: ${isPaid ? 'Betaald' : statusLabel(orderData.order.status)}`);
    doc.text(`Betaalmethode: ${paymentMethod}`);
    if (!isPaid && paymentTermsDays > 0) {
      doc.text(`Vervaldatum: ${dueDate.toLocaleDateString('nl-BE')}`);
    }
    if (paidAt) {
      doc.text(`Betaald op: ${paidAt.toLocaleDateString('nl-BE')}`);
    }
    doc.fillColor('#000');

    if (intro) {
      doc.moveDown(0.5);
      doc.fontSize(10).text(intro);
    }

    // Accent-lijn onder header
    doc.moveDown(0.5);
    doc.save()
      .moveTo(left, doc.y).lineTo(left + width, doc.y)
      .lineWidth(2).strokeColor(accent).stroke()
      .restore();
    doc.moveDown(0.7);

    // ── ADRESBLOK ────────────────────────────────────────────────────────────
    const blockTop = doc.y;
    const rightX = left + Math.floor(width * 0.55);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#333')
      .text('Facturatiegegevens', left, blockTop);
    doc.text('Klant', rightX, blockTop);
    doc.font('Helvetica').fontSize(9).fillColor('#444');

    const companyLines = [
      company.legalName || config?.brand?.name || '',
      company.address || '',
      [company.postcode, company.city].filter(Boolean).join(' '),
      company.country || '',
      company.vatNumber ? `BTW: ${company.vatNumber}` : ''
    ].filter(Boolean);
    if (showSupportContacts) {
      if (company.supportEmail) companyLines.push(`E-mail: ${company.supportEmail}`);
      if (company.supportPhone) companyLines.push(`Tel: ${company.supportPhone}`);
    }
    let yCompany = blockTop + 15;
    companyLines.forEach((line) => {
      doc.text(line, left, yCompany, { width: rightX - left - 14 });
      yCompany = doc.y + 1;
    });

    const customerLines = [
      `${orderData.order.customer_first || ''} ${orderData.order.customer_last || ''}`.trim(),
      orderData.order.customer_company ? `Bedrijf: ${orderData.order.customer_company}` : '',
      orderData.order.customer_vat ? `BTW: ${orderData.order.customer_vat}` : '',
      orderData.order.customer_email || '',
      orderData.order.address || '',
      [orderData.order.postcode, orderData.order.city].filter(Boolean).join(' '),
      orderData.order.phone || ''
    ].filter(Boolean);
    let yCustomer = blockTop + 15;
    customerLines.forEach((line) => {
      doc.text(line, rightX, yCustomer, { width: left + width - rightX });
      yCustomer = doc.y + 1;
    });

    doc.y = Math.max(yCompany, yCustomer) + 18;
    doc.fillColor('#000');

    // ── ITEMS TABEL ──────────────────────────────────────────────────────────
    const tableX = left;
    const tableW = width;
    const colQty = 42;
    const colDesc = 282;
    const colDesigns = 65;
    const colAmount = tableW - colQty - colDesc - colDesigns;
    const rowH = 22;

    const drawInvoiceTableHeader = () => {
      const y = doc.y;
      // Accent-lijn boven header
      doc.save()
        .moveTo(tableX, y).lineTo(tableX + tableW, y)
        .lineWidth(1.5).strokeColor(accent).stroke()
        .restore();
      doc.save().rect(tableX, y, tableW, rowH).fill('#f3f4f6').restore();
      doc.rect(tableX, y, tableW, rowH).lineWidth(0.5).strokeColor('#d1d5db').stroke();
      doc.moveTo(tableX + colQty, y).lineTo(tableX + colQty, y + rowH).stroke('#d1d5db');
      doc.moveTo(tableX + colQty + colDesc, y).lineTo(tableX + colQty + colDesc, y + rowH).stroke('#d1d5db');
      doc.moveTo(tableX + colQty + colDesc + colDesigns, y).lineTo(tableX + colQty + colDesc + colDesigns, y + rowH).stroke('#d1d5db');
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#111');
      doc.text('QTY', tableX + 6, y + 7, { width: colQty - 10, align: 'center' });
      doc.text('Omschrijving', tableX + colQty + 6, y + 7, { width: colDesc - 12 });
      doc.text('Designs', tableX + colQty + colDesc + 5, y + 7, { width: colDesigns - 10, align: 'center' });
      doc.text('Bedrag', tableX + colQty + colDesc + colDesigns + 6, y + 7, { width: colAmount - 10, align: 'right' });
      doc.font('Helvetica').fillColor('#000');
      doc.y = y + rowH;
    };

    drawInvoiceTableHeader();
    orderData.items.forEach((item, rowIdx) => {
      if (doc.y + rowH > pageH - 160) {
        doc.addPage();
        drawInvoiceTableHeader();
      }
      const y = doc.y;
      const label = `${item.product_label || item.color_name || 'Custom item'}${item.size ? ` (maat ${item.size})` : ''}`;
      // Alternerende rijen
      const rowBg = rowIdx % 2 === 0 ? '#ffffff' : '#f9fafb';
      doc.save().rect(tableX, y, tableW, rowH).fill(rowBg).restore();
      doc.rect(tableX, y, tableW, rowH).lineWidth(0.4).strokeColor('#e5e7eb').stroke();
      doc.moveTo(tableX + colQty, y).lineTo(tableX + colQty, y + rowH).stroke('#e5e7eb');
      doc.moveTo(tableX + colQty + colDesc, y).lineTo(tableX + colQty + colDesc, y + rowH).stroke('#e5e7eb');
      doc.moveTo(tableX + colQty + colDesc + colDesigns, y).lineTo(tableX + colQty + colDesc + colDesigns, y + rowH).stroke('#e5e7eb');
      doc.fontSize(9).fillColor('#111');
      doc.text(String(item.qty || 1), tableX + 5, y + 7, { width: colQty - 10, align: 'center' });
      doc.text(label, tableX + colQty + 6, y + 7, { width: colDesc - 12 });
      doc.text(String(item.designs.length || 0), tableX + colQty + colDesc + 5, y + 7, { width: colDesigns - 10, align: 'center' });
      doc.text(fmtEUR(item.total || 0), tableX + colQty + colDesc + colDesigns + 6, y + 7, { width: colAmount - 10, align: 'right' });
      doc.y = y + rowH;
    });

    // ── TOTAALBLOK ────────────────────────────────────────────────────────────
    const subtotal = Number(orderData.order.subtotal) || 0;
    const total = Number(orderData.order.total) || 0;
    const shipping = Math.max(0, total - subtotal);
    const shippingLabel = shipping > 0 ? fmtEUR(shipping) : 'GRATIS';

    doc.moveDown(1);
    const totW = 210;
    const totX = left + width - totW;
    const totY = doc.y;
    const totH = 72;

    // Kader achtergrond
    doc.save().rect(totX, totY, totW, totH).fill('#f3f4f6').restore();
    doc.rect(totX, totY, totW, totH).lineWidth(0.5).strokeColor('#d1d5db').stroke();

    // Subtotaal
    doc.fontSize(9).fillColor('#555')
      .text('Subtotaal', totX + 10, totY + 10, { width: totW - 20 })
      .text(fmtEUR(subtotal), totX + 10, totY + 10, { width: totW - 20, align: 'right' });
    // Verzending
    doc.text('Verzending', totX + 10, totY + 26, { width: totW - 20 })
      .text(shippingLabel, totX + 10, totY + 26, { width: totW - 20, align: 'right' });
    // Accent-scheidingslijn boven totaalregel
    doc.save()
      .moveTo(totX + 8, totY + 44).lineTo(totX + totW - 8, totY + 44)
      .lineWidth(1).strokeColor(accent).stroke()
      .restore();
    // Totaalregel (vet)
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111')
      .text('Totaal', totX + 10, totY + 50, { width: totW - 20 })
      .text(fmtEUR(total), totX + 10, totY + 50, { width: totW - 20, align: 'right' });
    doc.font('Helvetica').fillColor('#000');
    doc.y = totY + totH + 10;

    // ── DIAGONAAL BETAALSTEMPEL ───────────────────────────────────────────────
    const stampText = isPaid ? 'BETAALD' : 'OPENSTAAND';
    const stampColor = isPaid ? '#22c55e' : '#f97316';
    doc.save();
    doc.translate(pageW / 2, pageH / 2);
    doc.rotate(-35);
    doc.fontSize(60).fillColor(stampColor).opacity(0.10)
      .text(stampText, -250, -36, { width: 500, align: 'center', lineBreak: false, characterSpacing: 6 });
    doc.restore();

    // ── FOOTER ────────────────────────────────────────────────────────────────
    const footerY = pageH - 58;
    doc.save()
      .moveTo(left, footerY).lineTo(left + width, footerY)
      .lineWidth(1).strokeColor(accent).stroke()
      .restore();
    const footerParts = [
      company.legalName || config?.brand?.name || '',
      company.vatNumber ? `BTW: ${company.vatNumber}` : '',
      company.website || '',
      showSupportContacts && company.supportEmail ? company.supportEmail : ''
    ].filter(Boolean).join('  ·  ');
    doc.fontSize(7.5).fillColor('#888')
      .text(footerParts, left, footerY + 6, { width, align: 'center' });
    doc.text(footer || 'Bedankt voor je bestelling.', left, footerY + 18, { width, align: 'center' });
    if (legalDisclaimer) {
      doc.text(legalDisclaimer, left, footerY + 30, { width, align: 'center' });
    }
  });
}

async function generatePackingSlipPdfBuffer(orderData, config) {
  const company = config?.company || {};
  const packingCfg = config?.documents?.packingSlip || {};
  const logoBuffer = await loadPdfLogoBuffer(config);
  const title = String(packingCfg.title || 'Orderbon').trim() || 'Orderbon';
  const intro = String(packingCfg.intro || '').trim();
  const footer = String(packingCfg.footer || '').trim();
  const showFilePaths = packingCfg.showFilePaths !== false;
  const accent = sanitizeBrandColor(config?.theme?.accentColor, '#111827');

  // Genereer QR-code van het ordernummer vóór de buildPdfBuffer callback
  let qrBuffer = null;
  try {
    qrBuffer = await QRCode.toBuffer(
      `ORDER-${formatOrderId(orderData.order.id)}`,
      { type: 'png', width: 96, margin: 1 }
    );
  } catch {}

  return buildPdfBuffer((doc) => {
    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const left = 48;
    const width = pageW - (left * 2);

    // ── HEADER ──────────────────────────────────────────────────────────────
    if (logoBuffer) {
      try { doc.image(logoBuffer, 48, 36, { fit: [180, 52] }); } catch {}
    }
    // QR-code rechtsboven
    if (qrBuffer) {
      try {
        doc.image(qrBuffer, pageW - 48 - 76, 32, { width: 76 });
        doc.fontSize(7).fillColor('#666')
          .text(`#${formatOrderId(orderData.order.id)}`, pageW - 48 - 76, 112, { width: 76, align: 'center' });
      } catch {}
    }

    const titleX = logoBuffer ? 240 : 48;
    const titleY = logoBuffer ? 44 : undefined;
    doc.fontSize(18).fillColor('#111')
      .text(`${company.legalName || config?.brand?.name || 'Bedrijf'} — ${title}`, titleX, titleY);
    doc.moveDown(0.4);
    doc.fontSize(10).fillColor('#555')
      .text(`Order: #${formatOrderId(orderData.order.id)}`)
      .text(`Status: ${statusLabel(orderData.order.status)}`)
      .text(`Datum: ${(parseSqliteDate(orderData.order.created_at) || new Date()).toLocaleString('nl-BE')}`);
    doc.fillColor('#000');

    if (intro) {
      doc.moveDown(0.5);
      doc.fontSize(10).text(intro);
    }

    // Accent-lijn onder header
    doc.moveDown(0.5);
    doc.save()
      .moveTo(left, doc.y).lineTo(left + width, doc.y)
      .lineWidth(2).strokeColor(accent).stroke()
      .restore();
    doc.moveDown(0.7);

    // ── LEVERADRES ────────────────────────────────────────────────────────────
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#333').text('Leveradres');
    doc.font('Helvetica').fontSize(9).fillColor('#444');
    [
      `${orderData.order.customer_first || ''} ${orderData.order.customer_last || ''}`.trim(),
      orderData.order.customer_company ? `Bedrijf: ${orderData.order.customer_company}` : '',
      orderData.order.customer_vat ? `BTW: ${orderData.order.customer_vat}` : '',
      orderData.order.address || '',
      [orderData.order.postcode, orderData.order.city].filter(Boolean).join(' '),
      orderData.order.phone || '',
      orderData.order.customer_email || ''
    ].filter(Boolean).forEach((line) => doc.text(line));

    doc.fillColor('#000');
    doc.moveDown(0.7);

    // ── ITEMS TABEL ──────────────────────────────────────────────────────────
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#333').text('Items & designs');
    doc.moveDown(0.4);

    // Tabelkolommen (links=48, breedte=pageW-96)
    const tX = 48;
    const tW = pageW - 96;
    const cQty = 38;
    const cProd = Math.floor(tW * 0.38);
    const cMaat = 46;
    const cDes = 52;
    const cNote = tW - cQty - cProd - cMaat - cDes;
    const hRowH = 22;

    const drawPackingHeader = () => {
      const hy = doc.y;
      // Accent-lijn boven header
      doc.save()
        .moveTo(tX, hy).lineTo(tX + tW, hy)
        .lineWidth(1.5).strokeColor(accent).stroke()
        .restore();
      doc.save().rect(tX, hy, tW, hRowH).fill('#f3f4f6').restore();
      doc.rect(tX, hy, tW, hRowH).lineWidth(0.5).strokeColor('#d1d5db').stroke();
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#111');
      doc.text('QTY',     tX,                        hy + 7, { width: cQty,  align: 'center' });
      doc.text('Product', tX + cQty,                 hy + 7, { width: cProd - 6 });
      doc.text('Maat',    tX + cQty + cProd,         hy + 7, { width: cMaat, align: 'center' });
      doc.text('Designs', tX + cQty + cProd + cMaat, hy + 7, { width: cDes,  align: 'center' });
      doc.text('Notitie', tX + cQty + cProd + cMaat + cDes, hy + 7, { width: cNote - 4 });
      doc.font('Helvetica').fillColor('#000');
      doc.y = hy + hRowH;
    };

    drawPackingHeader();

    orderData.items.forEach((item, rowIdx) => {
      const rowY = doc.y;
      const label = item.product_label || item.color_name || 'Custom item';
      const rowBg = rowIdx % 2 === 0 ? '#ffffff' : '#f9fafb';
      doc.save().rect(tX, rowY, tW, hRowH).fill(rowBg).restore();
      doc.rect(tX, rowY, tW, hRowH).lineWidth(0.4).strokeColor('#e5e7eb').stroke();
      doc.fontSize(8).fillColor('#111');
      doc.text(String(item.qty || 1),                  tX,                        rowY + 7, { width: cQty,  align: 'center' });
      doc.text(label,                                   tX + cQty,                 rowY + 7, { width: cProd - 6 });
      doc.text(item.size || '-',                        tX + cQty + cProd,         rowY + 7, { width: cMaat, align: 'center' });
      doc.text(String(item.designs.length || 0),        tX + cQty + cProd + cMaat, rowY + 7, { width: cDes,  align: 'center' });
      doc.text(String(item.notes || '-').slice(0, 26),  tX + cQty + cProd + cMaat + cDes, rowY + 7, { width: cNote - 4 });
      doc.y = rowY + hRowH;

      // Design-details
      if (!item.designs.length) {
        doc.fontSize(7.5).fillColor('#888').text('   Geen designbestanden');
      } else {
        item.designs.forEach((d, i) => {
          doc.fontSize(7.5).fillColor('#555')
            .text(`   Design ${i + 1}: ${d.name || 'Naamloos'} | pos ${d.position || '-'} | scale ${d.scale || 100}%`);
          if (showFilePaths) {
            doc.text(`     Bestand: ${d.file_path || '(geen pad)'}`);
          }
        });
      }
      doc.fillColor('#000');
      doc.moveDown(0.25);
    });

    // ── DIAGONAAL BETAALSTEMPEL ───────────────────────────────────────────────
    const isPaid = orderData.order.status === 'PAID';
    const stampText = isPaid ? 'BETAALD' : 'OPENSTAAND';
    const stampColor = isPaid ? '#22c55e' : '#f97316';
    doc.save();
    doc.translate(pageW / 2, pageH / 2);
    doc.rotate(-35);
    doc.fontSize(60).fillColor(stampColor).opacity(0.10)
      .text(stampText, -250, -36, { width: 500, align: 'center', lineBreak: false, characterSpacing: 6 });
    doc.restore();

    // ── FOOTER ────────────────────────────────────────────────────────────────
    const footerY = pageH - 58;
    doc.save()
      .moveTo(left, footerY).lineTo(left + width, footerY)
      .lineWidth(1).strokeColor(accent).stroke()
      .restore();
    const footerParts = [
      company.legalName || config?.brand?.name || '',
      company.vatNumber ? `BTW: ${company.vatNumber}` : '',
      company.website || '',
      company.supportEmail || ''
    ].filter(Boolean).join('  ·  ');
    doc.fontSize(7.5).fillColor('#888')
      .text(footerParts, left, footerY + 6, { width, align: 'center' });
    if (footer) {
      doc.text(footer, left, footerY + 18, { width, align: 'center' });
    }
  });
}

async function buildInvoiceAttachmentForOrder(orderId) {
  const data = await collectOrderDocumentData(orderId);
  if (!data) return null;
  const cfg = await getConfig();
  const pdf = await generateInvoicePdfBuffer(data, cfg);
  const invoiceNo = data.invoice?.invoice_number || buildInvoiceNumber(data.order, cfg, new Date());
  return {
    filename: safeFilename(`factuur-${invoiceNo}.pdf`),
    content: pdf,
    contentType: 'application/pdf'
  };
}

function buildDepositInvoiceNumber(depositId, issueDate = new Date()) {
  const year = (issueDate instanceof Date ? issueDate : new Date()).getFullYear();
  return `VRK-${year}-${String(Number(depositId) || 0).padStart(6, '0')}`;
}

async function getLatestDepositInvoiceByOrderId(orderId) {
  return await db.prepare(`
    SELECT *
    FROM deposit_invoices
    WHERE order_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(Number(orderId) || 0);
}

async function generateDepositInvoicePdfBuffer({ order, depositInvoice, finalInvoice }, config) {
  const company = config?.company || {};
  const accent = sanitizeBrandColor(config?.theme?.accentColor, '#1d4ed8');
  const logoBuffer = await loadPdfLogoBuffer(config);
  return buildPdfBuffer((doc) => {
    const pageW = doc.page.width;
    const left = 48;
    const width = pageW - (left * 2);
    const top = 48;
    const issueDate = parseSqliteDate(depositInvoice?.issue_date) || new Date();
    const dueDate = parseSqliteDate(depositInvoice?.due_date);

    if (logoBuffer) {
      try {
        doc.image(logoBuffer, left, top, { fit: [170, 44], align: 'left', valign: 'top' });
      } catch {}
    }

    doc.font('Helvetica-Bold').fillColor('#111827').fontSize(22).text('VOORSCHOTSFACTUUR', left, top + 56);
    doc.font('Helvetica').fontSize(10).fillColor('#334155')
      .text(`Factuurnummer: ${depositInvoice?.invoice_number || '-'}`, left, top + 86)
      .text(`Order: #${formatOrderId(order?.id)}`, left, top + 102)
      .text(`Factuurdatum: ${fmtDateBE(issueDate) || '-'}`, left, top + 118)
      .text(`Vervaldatum: ${fmtDateBE(dueDate) || '-'}`, left, top + 134);

    const customerName = `${order?.customer_first || ''} ${order?.customer_last || ''}`.trim();
    const rightX = left + width - 220;
    doc.font('Helvetica-Bold').fillColor('#0f172a').fontSize(11).text('Factuur aan', rightX, top + 56, { width: 220 });
    doc.font('Helvetica').fontSize(10).fillColor('#1f2937')
      .text(customerName || '-', rightX, top + 74, { width: 220 })
      .text(order?.customer_company || '', rightX, top + 90, { width: 220 })
      .text(order?.address || '', rightX, top + 106, { width: 220 })
      .text([order?.postcode, order?.city].filter(Boolean).join(' '), rightX, top + 122, { width: 220 })
      .text(order?.customer_email || '', rightX, top + 138, { width: 220 });

    const blockY = top + 190;
    doc.save();
    doc.rect(left, blockY, width, 118).fill('#f8fafc').restore();
    doc.rect(left, blockY, width, 118).lineWidth(1).strokeColor('#dbeafe').stroke();
    doc.font('Helvetica-Bold').fillColor('#0f172a').fontSize(12)
      .text('Omschrijving', left + 14, blockY + 16)
      .text('Bedrag', left + width - 160, blockY + 16, { width: 146, align: 'right' });

    const percentage = Number(depositInvoice?.deposit_percentage);
    const percentageLabel = Number.isFinite(percentage) && percentage > 0 ? `${roundMoney(percentage)}% voorschot` : 'Voorschotbedrag';
    const finalInvoiceNo = finalInvoice?.invoice_number ? ` (eindfactuur ${finalInvoice.invoice_number})` : '';
    doc.font('Helvetica').fontSize(10).fillColor('#334155')
      .text(`${percentageLabel} op bestelling #${formatOrderId(order?.id)}${finalInvoiceNo}`, left + 14, blockY + 42, { width: width - 180 })
      .text(fmtEUR(Number(depositInvoice?.deposit_amount) || 0), left + width - 160, blockY + 42, { width: 146, align: 'right' });

    doc.font('Helvetica').fontSize(9).fillColor('#64748b')
      .text('Het resterende bedrag wordt apart gefactureerd op de eindfactuur.', left + 14, blockY + 74, { width: width - 28 });

    const totalY = blockY + 146;
    doc.font('Helvetica-Bold').fillColor('#0f172a').fontSize(13)
      .text('Te betalen voorschot', left, totalY, { width: width - 170 })
      .text(fmtEUR(Number(depositInvoice?.deposit_amount) || 0), left + width - 170, totalY, { width: 170, align: 'right' });

    doc.save();
    doc.translate(pageW / 2, doc.page.height / 2);
    doc.rotate(-34);
    doc.font('Helvetica-Bold').fontSize(62).fillColor(accent).opacity(0.09)
      .text('VOORSCHOT', -240, -32, { width: 480, align: 'center', lineBreak: false, characterSpacing: 6 });
    doc.restore();

    const footerY = doc.page.height - 82;
    doc.moveTo(left, footerY).lineTo(left + width, footerY).lineWidth(1).strokeColor('#cbd5e1').stroke();
    doc.font('Helvetica').fontSize(8).fillColor('#64748b')
      .text(company.legalName || config?.brand?.name || 'Bedrijf', left, footerY + 8, { width, align: 'center' });
    if (company.vatNumber || company.supportEmail) {
      doc.text([company.vatNumber ? `BTW: ${company.vatNumber}` : '', company.supportEmail || ''].filter(Boolean).join(' · '), left, footerY + 20, { width, align: 'center' });
    }
  });
}

async function generateOfferPdfBuffer(orderData, config) {
  const company = config?.company || {};
  const accent = sanitizeBrandColor(config?.theme?.accentColor, '#0f172a');
  const logoBuffer = await loadPdfLogoBuffer(config);
  return buildPdfBuffer((doc) => {
    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const left = 48;
    const width = pageW - (left * 2);
    const top = 48;
    const order = orderData?.order || {};
    const customerName = `${order.customer_first || ''} ${order.customer_last || ''}`.trim();
    const issueDate = new Date();

    if (logoBuffer) {
      try { doc.image(logoBuffer, left, top, { fit: [180, 50] }); } catch {}
    }
    doc.font('Helvetica-Bold').fontSize(24).fillColor('#111827').text('OFFERTEDOCUMENT', left, top + 58);
    doc.font('Helvetica').fontSize(10).fillColor('#334155')
      .text(`Referentie: OFF-${formatOrderId(order.id)}`, left, top + 92)
      .text(`Order: #${formatOrderId(order.id)}`, left, top + 108)
      .text(`Datum: ${fmtDateBE(issueDate)}`, left, top + 124);

    const rightX = left + width - 225;
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#0f172a').text('Offerte aan', rightX, top + 58, { width: 225 });
    doc.font('Helvetica').fontSize(10).fillColor('#1f2937')
      .text(customerName || '-', rightX, top + 76, { width: 225 })
      .text(order.customer_company || '', rightX, top + 92, { width: 225 })
      .text(order.customer_email || '', rightX, top + 108, { width: 225 })
      .text(order.address || '', rightX, top + 124, { width: 225 })
      .text([order.postcode, order.city].filter(Boolean).join(' '), rightX, top + 140, { width: 225 });

    const tableY = top + 190;
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#111')
      .text('Product', left + 8, tableY)
      .text('Aantal', left + width - 230, tableY, { width: 60, align: 'right' })
      .text('Bedrag', left + width - 145, tableY, { width: 130, align: 'right' });
    doc.moveTo(left, tableY + 16).lineTo(left + width, tableY + 16).lineWidth(1).strokeColor('#d1d5db').stroke();

    let y = tableY + 24;
    (orderData?.items || []).forEach((item) => {
      const label = `${item.product_label || 'Product'} · ${item.size || '-'} · ${item.color_name || '-'}`;
      doc.font('Helvetica').fontSize(9).fillColor('#1f2937')
        .text(label, left + 8, y, { width: width - 250 })
        .text(String(item.qty || 1), left + width - 230, y, { width: 60, align: 'right' })
        .text(fmtEUR(Number(item.total || 0)), left + width - 145, y, { width: 130, align: 'right' });
      y += 16;
      if (y > pageH - 130) {
        doc.addPage();
        y = 62;
      }
    });

    y += 8;
    doc.moveTo(left, y).lineTo(left + width, y).lineWidth(1).strokeColor(accent).stroke();
    y += 12;
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#0f172a')
      .text('Totaal offerte', left + width - 210, y, { width: 90, align: 'left' })
      .text(fmtEUR(Number(order.total || 0)), left + width - 120, y, { width: 110, align: 'right' });
    y += 24;
    doc.font('Helvetica').fontSize(9).fillColor('#475569')
      .text('Dit document is een offerte en geen betaalbevestiging of factuur.', left, y, { width });

    const footerY = pageH - 74;
    doc.moveTo(left, footerY).lineTo(left + width, footerY).lineWidth(1).strokeColor('#cbd5e1').stroke();
    doc.font('Helvetica').fontSize(8).fillColor('#64748b')
      .text(company.legalName || config?.brand?.name || 'Bedrijf', left, footerY + 8, { width, align: 'center' });
  });
}

async function buildOrderEmailPreview(orderId, type, opts = {}) {
  const id = Number(orderId);
  const cfg = await getConfig();
  const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) throw new Error('Order niet gevonden');
  if (isOrderArchived(order)) throw new Error('Order is gearchiveerd. Zet eerst terug.');
  let invoice = await ensureInvoiceForOrder(id, cfg);
  if (!invoice) invoice = await getInvoiceByOrderId(id);
  const payment = await db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1').get(id) || null;
  const depositInvoice = await getLatestDepositInvoiceByOrderId(id);
  const customerName = `${order.customer_first || ''} ${order.customer_last || ''}`.trim();

  const vars = {
    orderId: formatOrderId(order.id),
    customerName,
    orderTotal: fmtEUR(order.total),
    paymentUrl: payment?.checkout_url || `${APP_BASE_URL}/dashboard?order=${order.id}`,
    paymentExpiresAt: payment?.payment_link_expires_at ? new Date(payment.payment_link_expires_at).toLocaleString('nl-BE') : '',
    invoiceNumber: invoice?.invoice_number || '',
    invoiceDueDate: fmtDateBE(invoice?.due_date) || '',
    invoiceStatusLabel: invoiceStatusLabel(invoice?.status || 'DEFINITIVE'),
    orderStatusLabel: statusLabel(order.status),
    extraMessage: String(opts.extraMessage || '').trim()
  };
  if (type === 'deposit_invoice' && depositInvoice) {
    vars.invoiceNumber = depositInvoice.invoice_number || vars.invoiceNumber;
    vars.invoiceDueDate = fmtDateBE(depositInvoice.due_date) || vars.invoiceDueDate;
    vars.invoiceStatusLabel = 'Voorschotfactuur';
  }

  let templateKey = 'paymentLink';
  if (type === 'offer') templateKey = 'offerSent';
  if (type === 'invoice') templateKey = 'invoiceSent';
  if (type === 'deposit_invoice') templateKey = 'invoiceSent';

  let template = cfg?.email?.templates?.[templateKey];
  if (!template?.subject || !template?.html) {
    const fallbackKey = templateKey === 'offerSent' ? 'paymentLink' : 'orderPlaced';
    templateKey = fallbackKey;
    template = cfg?.email?.templates?.[templateKey];
  }
  if (!template?.subject || !template?.html) throw new Error(`Template ontbreekt: ${templateKey}`);
  const branding = getEmailBranding(cfg);
  const mergedVars = {
    companyName: htmlEscape(cfg?.company?.legalName || cfg?.brand?.name || 'Onze shop'),
    supportEmail: htmlEscape(cfg?.company?.supportEmail || cfg?.email?.fromAddress || ''),
    dashboardUrl: `${APP_BASE_URL}/dashboard`,
    loginUrl: `${APP_BASE_URL}/login`,
    brandName: htmlEscape(branding.brandName),
    brandLogoUrl: htmlEscape(branding.logoUrl || ''),
    brandFaviconUrl: htmlEscape(branding.faviconUrl || ''),
    brandAccentColor: htmlEscape(branding.accent),
    year: String(new Date().getFullYear()),
    ...Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, htmlEscape(v)]))
  };
  const renderedSubject = renderTemplate(template.subject, mergedVars);
  const subjectOverride = String(opts.subjectOverride || '').trim().slice(0, 180);
  const subject = subjectOverride || renderedSubject;
  const bodyHtml = renderTemplate(template.html, mergedVars);
  const html = buildBrandedEmailHtml(bodyHtml, subject, cfg);

  return {
    order,
    invoice,
    payment,
    depositInvoice,
    templateKey,
    subject,
    html
  };
}

async function sendPaymentLinkEmailWithInvoice(order, payment = null, opts = {}) {
  if (!order?.customer_email) return { skipped: 'no_recipient' };
  const cfg = opts.config || await getConfig();
  const includeInvoice = opts.includeInvoice !== false;
  let invoice = await ensureInvoiceForOrder(order.id, cfg);
  if (!invoice) invoice = await getInvoiceByOrderId(order.id);
  if (!invoice || invoice.status === 'CONCEPT') {
    invoice = await finalizeInvoiceForOrder(order.id, cfg);
    if (!invoice) invoice = await getInvoiceByOrderId(order.id);
  }
  const attachment = includeInvoice ? await buildInvoiceAttachmentForOrder(order.id) : null;
  const paymentUrl = payment?.checkoutUrl
    || payment?.checkout_url
    || (await db.prepare(`SELECT checkout_url FROM payments WHERE order_id = ? AND checkout_url IS NOT NULL ORDER BY id DESC LIMIT 1`).get(order.id))?.checkout_url
    || `${APP_BASE_URL}/dashboard?order=${order.id}`;
  const expiresAt = payment?.expiresAtIso || payment?.payment_link_expires_at || null;
  const vars = {
    orderId: formatOrderId(order.id),
    customerName: `${order.customer_first || ''} ${order.customer_last || ''}`.trim(),
    orderTotal: fmtEUR(order.total),
    paymentUrl,
    paymentExpiresAt: expiresAt ? new Date(expiresAt).toLocaleString('nl-BE') : 'Binnenkort',
    invoiceNumber: invoice?.invoice_number || '',
    invoiceDueDate: fmtDateBE(invoice?.due_date) || '',
    invoiceStatusLabel: invoiceStatusLabel(invoice?.status || 'DEFINITIVE'),
    extraMessage: String(opts.extraMessage || '').trim()
  };
  const trackingToken = createEmailTrackingToken(order.id, 'payment_link', order.customer_email);
  const info = await sendTemplatedEmail('paymentLink', order.customer_email, vars, {
    ...(attachment ? { attachments: [attachment] } : {}),
    trackingToken,
    subject: String(opts.subject || '').trim().slice(0, 180) || undefined
  });
    if (info?.ok && invoice?.id) {
    await db.prepare(`UPDATE invoices SET sent_at = COALESCE(sent_at, ?) WHERE id = ?`)
      .run(new Date().toISOString(), invoice.id);
    await logAudit({
      actorUserId: opts.actorUserId || null,
      actorEmail: opts.actorEmail || null,
      action: 'INVOICE_EMAIL_SENT',
      entityType: 'invoice',
      entityId: String(invoice.id),
      summary: `Factuurmail verstuurd voor order #${formatOrderId(order.id)}`,
      details: {
        orderId: order.id,
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoice_number || null,
        to: order.customer_email
      }
    });
  }
  return info;
}

function sendPaymentLinkEmailWithInvoiceSafe(order, payment = null, opts = {}) {
  sendPaymentLinkEmailWithInvoice(order, payment, opts).catch((err) => {
    console.error(`Payment link mail failed for order ${order?.id}:`, err.message);
  });
}

async function sendPaymentReceivedEmailWithInvoiceSafe(order) {
  if (!order?.customer_email) return;
  (async () => {
    const attachment = await buildInvoiceAttachmentForOrder(order.id);
    sendTemplatedEmailSafe('paymentReceived', order.customer_email, {
      orderId: formatOrderId(order.id),
      customerName: `${order.customer_first || ''} ${order.customer_last || ''}`.trim(),
      orderTotal: fmtEUR(order.total),
      orderStatusLabel: statusLabel('PAID')
    }, attachment ? { attachments: [attachment] } : {});
  })().catch((err) => {
    console.error(`Could not attach invoice for paid order ${order?.id}:`, err.message);
  });
}

// ── Public config ──────────────────────────────────────────────────────────
app.get('/api/config', async (_req, res) => {
  const cfg = await getConfig();
  const safe = { ...cfg };
  if (safe.smtp) safe.smtp = { ...safe.smtp, pass: undefined, user: undefined };
  res.json(safe);
});

app.get('/api/track/open/:token.gif', async (req, res) => {
  const token = String(req.params.token || '').trim();
  if (/^[a-f0-9]{24,80}$/i.test(token)) {
    const row = await db.prepare('SELECT id, first_opened_at, open_count FROM email_tracking WHERE token = ?').get(token);
    if (row) {
      if (!row.first_opened_at) {
        await db.prepare(`
          UPDATE email_tracking
          SET open_count = COALESCE(open_count, 0) + 1,
              first_opened_at = ?,
              sent_at = COALESCE(sent_at, ?)
          WHERE id = ?
        `).run(new Date().toISOString(), new Date().toISOString(), row.id);
      } else {
        await db.prepare('UPDATE email_tracking SET open_count = COALESCE(open_count, 0) + 1 WHERE id = ?').run(row.id);
      }
    }
  }
  const gif = Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64');
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Content-Length', gif.length);
  res.end(gif);
});

// ── Stripe webhook ─────────────────────────────────────────────────────────
app.post('/api/payments/stripe/webhook', async (req, res) => {
  const stripe = await getStripeClient();
  if (!stripe) return res.status(503).json({ error: 'Stripe niet geconfigureerd' });
  const webhookSecret = await getStripeWebhookSecret();

  let event;
  try {
    if (webhookSecret) {
      const sig = req.headers['stripe-signature'];
      if (!sig) return res.status(400).json({ error: 'Stripe-signature ontbreekt' });
      event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
    } else {
      event = req.body;
    }
  } catch (err) {
    console.error('Stripe webhook signature error:', err.message);
    return res.status(400).json({ error: 'Webhook signature ongeldig' });
  }

  try {
    const type = event?.type;
    if ([
      'checkout.session.completed',
      'checkout.session.async_payment_succeeded',
      'checkout.session.async_payment_failed',
      'checkout.session.expired'
    ].includes(type)) {
      await upsertPaymentStatusFromCheckoutEvent(event.data.object, type, event.id);
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Stripe webhook handler error:', err);
    res.status(500).json({ error: 'Webhook verwerking mislukt' });
  }
});

// ── Auth (rate-limited login) ──────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Te veel pogingen — probeer het over 15 minuten opnieuw.' }
});
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10 });
const ACCOUNT_LOCKOUT_MAX_ATTEMPTS = 5;
const ACCOUNT_LOCKOUT_MS = 15 * 60 * 1000;
const PENDING_2FA_TTL_MS = 10 * 60 * 1000;

function parseDbDateToMs(value) {
  if (!value) return null;
  const s = String(value);
  const d = new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
  const t = d.getTime();
  return Number.isFinite(t) ? t : null;
}

app.post('/api/auth/register', registerLimiter, async (req, res) => {
  const { email, password, firstName, lastName } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email en wachtwoord verplicht' });
  if (password.length < 6) return res.status(400).json({ error: 'Wachtwoord moet minstens 6 tekens zijn' });
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const exists = await db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
  if (exists) return res.status(400).json({ error: 'Email is al geregistreerd' });
  const hash = bcrypt.hashSync(password, 10);
  const token = crypto.randomBytes(32).toString('hex');
  const tokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await db.prepare(`INSERT INTO users(email, password_hash, first_name, last_name, role, status, email_verified, email_verification_token, email_verification_token_expires_at)
              VALUES(?, ?, ?, ?, 'USER', 'ACTIVE', 0, ?, ?)`)
    .run(normalizedEmail, hash, firstName || '', lastName || '', token, tokenExpiry);
  const verificationUrl = `${await getAppBaseUrl()}/api/auth/verify-email?token=${token}`;
  sendTemplatedEmailSafe('emailVerification', normalizedEmail, {
    verificationUrl,
    customerName: `${firstName || ''} ${lastName || ''}`.trim()
  });
  res.json({ ok: true, message: 'Account aangemaakt! Controleer je e-mail voor een verificatielink.' });
});

app.get('/api/auth/verify-email', async (req, res) => {
  const token = String(req.query.token || '').trim();
  if (!token) return res.redirect('/login?verified=error');
  const user = await db.prepare('SELECT * FROM users WHERE email_verification_token = ?').get(token);
  if (!user) return res.redirect('/login?verified=error');
  const expiry = user.email_verification_token_expires_at;
  if (expiry && new Date(expiry) < new Date()) {
    return res.redirect('/login?verified=expired');
  }
  await db.prepare('UPDATE users SET email_verified = 1, email_verification_token = NULL, email_verification_token_expires_at = NULL WHERE id = ?').run(user.id);
  res.redirect('/login?verified=1');
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  const rememberRaw = req.body?.remember;
  const remember = rememberRaw === true || rememberRaw === 'true' || rememberRaw === 1 || rememberRaw === '1' || rememberRaw === 'on';
  if (!email || !password) return res.status(400).json({ error: 'Email en wachtwoord verplicht' });
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const user = await db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);

  if (user?.login_locked_until) {
    const lockUntilMs = parseDbDateToMs(user.login_locked_until);
    if (lockUntilMs && lockUntilMs > Date.now()) {
      const remainingMin = Math.max(1, Math.ceil((lockUntilMs - Date.now()) / 60000));
      const unlockAt = new Date(lockUntilMs).toLocaleString('nl-BE');
      return res.status(423).json({
        error: `Account tijdelijk vergrendeld na meerdere foutieve pogingen. Probeer opnieuw over ${remainingMin} min (vanaf ${unlockAt}).`
      });
    }
    await db.prepare('UPDATE users SET failed_login_attempts = 0, login_locked_until = NULL WHERE id = ?').run(user.id);
  }

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    if (user) {
      const nextAttempts = Number(user.failed_login_attempts || 0) + 1;
      if (nextAttempts >= ACCOUNT_LOCKOUT_MAX_ATTEMPTS) {
        const lockUntilIso = new Date(Date.now() + ACCOUNT_LOCKOUT_MS).toISOString();
        await db.prepare(`UPDATE users
                    SET failed_login_attempts = 0,
                        login_locked_until = ?,
                        last_failed_login_at = datetime('now')
                    WHERE id = ?`).run(lockUntilIso, user.id);
        return res.status(423).json({
          error: `Te veel foutieve pogingen. Account vergrendeld tot ${new Date(lockUntilIso).toLocaleString('nl-BE')}.`
        });
      }
      await db.prepare(`UPDATE users
                  SET failed_login_attempts = ?,
                      last_failed_login_at = datetime('now')
                  WHERE id = ?`).run(nextAttempts, user.id);
    }
    return res.status(401).json({ error: 'Ongeldige inloggegevens' });
  }
  if (user.status === 'PENDING') return res.status(403).json({ error: 'Account wacht nog op goedkeuring.' });
  if (user.status === 'BLOCKED') return res.status(403).json({ error: 'Account is geblokkeerd.' });

  if (Number(user.totp_enabled || 0) && user.totp_secret) {
    req.session.pending2faUserId = user.id;
    req.session.pending2faRemember = remember;
    req.session.pending2faAt = Date.now();
    req.session.userId = null;
    return res.json({
      ok: true,
      requires2fa: true,
      user: { id: user.id, email: user.email, role: user.role, firstName: user.first_name, lastName: user.last_name }
    });
  }
  await db.prepare('UPDATE users SET failed_login_attempts = 0, login_locked_until = NULL, last_login_at = datetime(\'now\') WHERE id = ?').run(user.id);
  finalizeAuthenticatedSession(req, user, remember);
  res.json({
    ok: true,
    remember,
    enforce2faSetup: !!req.session.force2faSetup,
    user: { id: user.id, email: user.email, role: user.role, firstName: user.first_name, lastName: user.last_name }
  });
});

app.post('/api/auth/login/2fa', loginLimiter, async (req, res) => {
  const pendingUserId = Number(req.session.pending2faUserId || 0);
  const code = String(req.body?.code || '').replace(/\s+/g, '');
  if (!pendingUserId) return res.status(401).json({ error: 'Geen actieve 2FA-login sessie' });
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Ongeldige 2FA-code' });
  const pendingAt = Number(req.session.pending2faAt || 0);
  if (!pendingAt || (Date.now() - pendingAt) > PENDING_2FA_TTL_MS) {
    req.session.pending2faUserId = null;
    req.session.pending2faRemember = null;
    req.session.pending2faAt = null;
    return res.status(401).json({ error: '2FA-login sessie verlopen. Log opnieuw in.' });
  }

  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(pendingUserId);
  if (!user) {
    req.session.pending2faUserId = null;
    req.session.pending2faRemember = null;
    req.session.pending2faAt = null;
    return res.status(401).json({ error: 'Gebruiker niet gevonden' });
  }
  if (!Number(user.totp_enabled || 0) || !user.totp_secret) {
    req.session.pending2faUserId = null;
    req.session.pending2faRemember = null;
    req.session.pending2faAt = null;
    return res.status(400).json({ error: '2FA is niet actief voor dit account' });
  }
  if (user.status === 'PENDING') return res.status(403).json({ error: 'Account wacht nog op goedkeuring.' });
  if (user.status === 'BLOCKED') return res.status(403).json({ error: 'Account is geblokkeerd.' });

  const ok = speakeasy.totp.verify({
    secret: user.totp_secret,
    encoding: 'base32',
    token: code,
    window: 1
  });
  if (!ok) return res.status(401).json({ error: '2FA-code ongeldig of verlopen' });

  const remember = !!req.session.pending2faRemember;
  finalizeAuthenticatedSession(req, user, remember);
  res.json({
    ok: true,
    remember,
    enforce2faSetup: !!req.session.force2faSetup,
    user: { id: user.id, email: user.email, role: user.role, firstName: user.first_name, lastName: user.last_name }
  });
});

app.post('/api/auth/logout', async (req, res) => {
  if (req.session?.destroy) return req.session.destroy(() => res.json({ ok: true }));
  res.json({ ok: true });
});

app.get('/api/auth/me', async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.json({ user: null });
  res.json({
    user: {
      id: u.id, email: u.email, role: u.role, status: u.status,
      firstName: u.first_name, lastName: u.last_name,
      address: u.address || '', postcode: u.postcode || '', city: u.city || '', phone: u.phone || '',
      twoFactorEnabled: !!Number(u.totp_enabled || 0),
      twoFactorSetupRequired: !!(req.session?.force2faSetup && u.role === 'ADMIN'),
      emailVerified: !!Number(u.email_verified || 0)
    }
  });
});

const resendVerificationLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 3, standardHeaders: true, legacyHeaders: false });
app.post('/api/me/resend-verification', requireAuth, resendVerificationLimiter, async (req, res) => {
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (Number(user.email_verified || 0)) return res.json({ ok: true, message: 'E-mail is al geverifieerd.' });
  const token = crypto.randomBytes(32).toString('hex');
  const tokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await db.prepare('UPDATE users SET email_verification_token = ?, email_verification_token_expires_at = ? WHERE id = ?')
    .run(token, tokenExpiry, user.id);
  const verificationUrl = `${await getAppBaseUrl()}/api/auth/verify-email?token=${token}`;
  sendTemplatedEmailSafe('emailVerification', user.email, {
    verificationUrl,
    customerName: `${user.first_name || ''} ${user.last_name || ''}`.trim()
  });
  res.json({ ok: true, message: 'Verificatiemail verstuurd.' });
});

// ── Profile ────────────────────────────────────────────────────────────────
app.put('/api/me/password', requireAuth, async (req, res) => {
  const { current, next: nextPw } = req.body || {};
  if (!current || !nextPw || nextPw.length < 6) return res.status(400).json({ error: 'Ongeldig wachtwoord (min 6 tekens)' });
  const row = await db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(current, row.password_hash)) return res.status(401).json({ error: 'Huidig wachtwoord onjuist' });
  await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(nextPw, 10), req.user.id);
  res.json({ ok: true });
});

app.put('/api/me/profile', requireAuth, async (req, res) => {
  const b = req.body || {};
  await db.prepare(`UPDATE users SET first_name=?, last_name=?, address=?, postcode=?, city=?, phone=? WHERE id=?`)
    .run(
      (b.firstName || '').trim(), (b.lastName || '').trim(),
      (b.address || '').trim(), (b.postcode || '').trim(),
      (b.city || '').trim(), (b.phone || '').trim(),
      req.user.id
    );
  res.json({ ok: true });
});

app.get('/api/me/export-data', requireAuth, async (req, res) => {
  try {
    const exportData = await loadUserGdprExportData(req.user.id);
    if (!exportData) return res.status(404).json({ error: 'Gebruiker niet gevonden' });

    const stamp = new Date().toISOString().replace(/[:]/g, '-').replace(/\..+/, 'Z');
    const filename = safeFilename(`gdpr-export-user-${req.user.id}-${stamp}.zip`);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('warning', (err) => {
      console.warn('GDPR export zip warning:', err.message);
    });
    archive.on('error', (err) => {
      console.error('GDPR export zip failed:', err);
      if (!res.headersSent) return res.status(500).json({ error: 'Data-export mislukt' });
      res.destroy(err);
    });
    archive.pipe(res);

    const appendJson = (name, payload) => {
      archive.append(`${JSON.stringify(payload, null, 2)}\n`, { name });
    };

    appendJson('meta/export.json', {
      generatedAt: new Date().toISOString(),
      formatVersion: 1,
      type: 'gdpr-data-export',
      userId: exportData.user.id,
      email: exportData.user.email,
      counts: {
        orders: exportData.orders.length,
        orderItems: exportData.orderItems.length,
        orderDesigns: exportData.orderDesigns.length,
        orderStatusHistory: exportData.orderStatusHistory.length,
        payments: exportData.payments.length,
        invoices: exportData.invoices.length,
        cartItems: exportData.cartItems.length,
        cartDesigns: exportData.cartDesigns.length,
        uploadFiles: exportData.uploadFiles.length
      }
    });
    appendJson('user/profile.json', exportData.user);
    appendJson('orders/orders.json', exportData.orders);
    appendJson('orders/order-items.json', exportData.orderItems);
    appendJson('orders/order-designs.json', exportData.orderDesigns);
    appendJson('orders/order-status-history.json', exportData.orderStatusHistory);
    appendJson('orders/payments.json', exportData.payments);
    appendJson('orders/invoices.json', exportData.invoices);
    appendJson('cart/cart-items.json', exportData.cartItems);
    appendJson('cart/cart-designs.json', exportData.cartDesigns);
    appendJson('uploads/files-manifest.json', exportData.uploadFiles);

    await logAuditFromReq(req, {
      action: 'GDPR_DATA_EXPORTED',
      entityType: 'user',
      entityId: req.user.id,
      summary: `GDPR data-export gedownload door ${req.user.email}`,
      details: {
        userId: req.user.id,
        email: req.user.email,
        counts: {
          orders: exportData.orders.length,
          payments: exportData.payments.length,
          invoices: exportData.invoices.length,
          uploadFiles: exportData.uploadFiles.length
        }
      }
    });

    archive.finalize();
  } catch (err) {
    console.error('GDPR export failed:', err);
    res.status(500).json({ error: 'Data-export mislukt' });
  }
});

app.post('/api/uploads/sign', requireAuth, async (req, res) => {
  const normalized = normalizeUploadPath(req.body?.path);
  if (!normalized) return res.status(400).json({ error: 'Ongeldig uploadpad' });
  if (!fs.existsSync(normalized.abs)) return res.status(404).json({ error: 'Bestand niet gevonden' });
  if (!await canUserAccessUploadByParts(req.user, normalized.parts)) return res.status(403).json({ error: 'Geen toegang tot dit bestand' });

  const ttlRaw = Number(req.body?.ttlSeconds || 86400);
  const ttlSeconds = Math.max(60, Math.min(7 * 24 * 3600, Number.isFinite(ttlRaw) ? Math.floor(ttlRaw) : 86400));
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = signUploadPayload(normalized.rel, exp);
  const qs = new URLSearchParams({ p: normalized.rel, exp: String(exp), sig }).toString();
  const url = `${APP_BASE_URL}/uploads-signed?${qs}`;
  res.json({
    ok: true,
    path: `uploads/${normalized.rel}`,
    url,
    expiresAt: new Date(exp * 1000).toISOString(),
    ttlSeconds
  });
});

app.get('/api/me/2fa/status', requireAuth, async (req, res) => {
  const enabled = !!Number(req.user.totp_enabled || 0);
  const requiredForRole = req.user.role === 'ADMIN';
  res.json({
    enabled,
    requiredForRole,
    setupRequired: requiredForRole && !enabled
  });
});

app.post('/api/me/2fa/setup', requireAuth, async (req, res) => {
  try {
    const existing = await db.prepare('SELECT totp_enabled FROM users WHERE id = ?').get(req.user.id);
    if (Number(existing?.totp_enabled || 0)) return res.status(400).json({ error: '2FA staat al aan voor dit account' });

    const issuer = 'NEBULOUS';
    const secret = speakeasy.generateSecret({
      name: `${issuer} (${req.user.email})`,
      issuer,
      length: 20
    });
    req.session.pendingTotpSecret = secret.base32;
    const qrDataUrl = await QRCode.toDataURL(secret.otpauth_url);

    res.json({
      ok: true,
      manualKey: secret.base32,
      otpAuthUrl: secret.otpauth_url,
      qrDataUrl
    });
  } catch (err) {
    console.error('2FA setup generation failed:', err);
    res.status(500).json({ error: '2FA setup genereren mislukt' });
  }
});

app.post('/api/me/2fa/enable', requireAuth, async (req, res) => {
  const code = String(req.body?.code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Ongeldige 2FA-code' });
  const secret = String(req.session.pendingTotpSecret || '');
  if (!secret) return res.status(400).json({ error: 'Start eerst 2FA setup om een nieuwe sleutel te genereren' });

  const ok = speakeasy.totp.verify({
    secret,
    encoding: 'base32',
    token: code,
    window: 1
  });
  if (!ok) return res.status(401).json({ error: '2FA-code ongeldig of verlopen' });

  await db.prepare(`UPDATE users
              SET totp_secret = ?, totp_enabled = 1, totp_enabled_at = datetime('now')
              WHERE id = ?`).run(secret, req.user.id);
  req.session.pendingTotpSecret = null;
  req.session.force2faSetup = false;

  await logAuditFromReq(req, {
    action: 'USER_2FA_ENABLED',
    entityType: 'user',
    entityId: req.user.id,
    summary: `2FA geactiveerd voor ${req.user.email}`,
    details: { userId: req.user.id, email: req.user.email, role: req.user.role }
  });

  res.json({ ok: true, enabled: true });
});

app.post('/api/me/2fa/disable', requireAuth, async (req, res) => {
  const fresh = await db.prepare('SELECT role, totp_enabled, totp_secret FROM users WHERE id = ?').get(req.user.id);
  if (!fresh) return res.status(404).json({ error: 'Gebruiker niet gevonden' });
  if (fresh.role === 'ADMIN') {
    return res.status(403).json({ error: '2FA is verplicht voor admin-accounts en kan niet gedeactiveerd worden.' });
  }
  if (!Number(fresh.totp_enabled || 0) || !fresh.totp_secret) {
    return res.status(400).json({ error: '2FA is niet actief op dit account' });
  }

  const code = String(req.body?.code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Ongeldige 2FA-code' });

  const ok = speakeasy.totp.verify({
    secret: fresh.totp_secret,
    encoding: 'base32',
    token: code,
    window: 1
  });
  if (!ok) return res.status(401).json({ error: '2FA-code ongeldig of verlopen' });

  await db.prepare(`UPDATE users
              SET totp_secret = NULL, totp_enabled = 0, totp_enabled_at = NULL
              WHERE id = ?`).run(req.user.id);
  req.session.pendingTotpSecret = null;
  req.session.force2faSetup = false;

  await logAuditFromReq(req, {
    action: 'USER_2FA_DISABLED',
    entityType: 'user',
    entityId: req.user.id,
    summary: `2FA gedeactiveerd voor ${req.user.email}`,
    details: { userId: req.user.id, email: req.user.email, role: fresh.role }
  });

  res.json({ ok: true, enabled: false });
});

// ── Cart ───────────────────────────────────────────────────────────────────
async function loadCart(userId) {
  const items = await db.prepare(`SELECT * FROM cart_items WHERE user_id = ? ORDER BY id`).all(userId);
  const designs = await db.prepare(`SELECT * FROM cart_item_designs WHERE cart_item_id IN
                              (SELECT id FROM cart_items WHERE user_id = ?)`).all(userId);
  const byItem = {};
  designs.forEach(d => { (byItem[d.cart_item_id] ||= []).push(d); });
  return items.map(i => ({ ...i, designs: byItem[i.id] || [] }));
}

app.get('/api/cart', requireAuth, async (req, res) => {
  res.json({ items: await loadCart(req.user.id) });
});

app.post('/api/cart', requireAuth, cartUpload.fields([
  { name: 'preview', maxCount: 1 },
  { name: 'designFiles', maxCount: 20 }
]), async (req, res) => {
  let createdItemId = null;
  let createdDir = null;
  try {
  const productRaw = req.body?.product ?? req.body?.productJson ?? req.body?.product_data;
  const designsRaw = req.body?.designs ?? req.body?.designsJson ?? req.body?.designs_data;
  const product = parseJsonField(productRaw, req.body?.product || {});
  let designs = parseJsonField(designsRaw, req.body?.designs || []);
  const notes = (req.body?.notes || '').trim();

  if (!product?.size) return res.status(400).json({ error: 'Maat ontbreekt' });
  if (!Array.isArray(designs)) designs = [];

  const uploaded = normalizeUploadFilesForCart(req.files?.preview?.[0] || null, req.files?.designFiles, 20);
  const previewFile = uploaded.preview;
  const designFiles = uploaded.files;
  const designFileLayerIdsRaw = req.body?.designFileLayerIds;
  const designFileLayerIds = (Array.isArray(designFileLayerIdsRaw)
    ? designFileLayerIdsRaw
    : (designFileLayerIdsRaw == null ? [] : [designFileLayerIdsRaw]))
    .map(v => String(v || '').trim())
    .filter(Boolean);
  const hasExplicitFileMapping = designFileLayerIds.length > 0;

  if (hasExplicitFileMapping && designFileLayerIds.length !== designFiles.length) {
    return res.status(400).json({ error: 'Aantal design-bestanden komt niet overeen met de layer-koppeling' });
  }

  // Backward compatibility: if only files are sent, generate metadata automatically.
  if (!designs.length && designFiles.length) {
    designs = designFiles.map((f, idx) => ({
      id: designFileLayerIds[idx] || `design-${idx + 1}`,
      name: f.originalname || `Design ${idx + 1}`,
      position: 'center',
      scale: 100,
      vOffset: 0,
      xOffset: 0,
      note: ''
    }));
  }

  const hasLegacyDataUrls = designs.some(d => d?.dataUrl);
  if (!designFiles.length && !hasLegacyDataUrls) {
    return res.status(400).json({ error: 'Geen design geüpload' });
  }
  if (!designs.length) {
    return res.status(400).json({ error: 'Design metadata ontbreekt' });
  }
  if (!hasExplicitFileMapping && designFiles.length && !hasLegacyDataUrls && designs.length !== designFiles.length) {
    return res.status(400).json({ error: 'Aantal design-bestanden komt niet overeen met metadata' });
  }

  const seenDesignIds = new Set();
  designs = designs.map((d, idx) => {
    const id = String(d?.id || '').trim();
    if (id) {
      if (seenDesignIds.has(id)) {
        const duplicate = new Error(`Dubbele design-id voor design ${idx + 1}`);
        duplicate.status = 400;
        throw duplicate;
      }
      seenDesignIds.add(id);
    }
    return { ...d, id };
  });

  const fileByLayerId = new Map();
  if (hasExplicitFileMapping) {
    designFileLayerIds.forEach((layerId, idx) => {
      if (fileByLayerId.has(layerId)) {
        const duplicate = new Error(`Dubbele bestandskoppeling voor layer ${layerId}`);
        duplicate.status = 400;
        throw duplicate;
      }
      fileByLayerId.set(layerId, designFiles[idx]);
    });
    for (let idx = 0; idx < designs.length; idx++) {
      const designId = String(designs[idx]?.id || '').trim();
      if (!designId) {
        const missingId = new Error(`Layer-id ontbreekt voor design ${idx + 1}`);
        missingId.status = 400;
        throw missingId;
      }
      if (!fileByLayerId.has(designId) && !designs[idx]?.dataUrl) {
        const missingFile = new Error(`Bestand ontbreekt voor design ${idx + 1}`);
        missingFile.status = 400;
        throw missingFile;
      }
    }
  }

  const cfg = await getConfig();
  const priced = await computeItemPrice({
    ...product,
    designs,
    extraDesigns: Math.max(0, designs.length - 1)
  }, cfg);
  const catalogProduct = priced.product;
  const result = await db.prepare(`
    INSERT INTO cart_items(user_id, color_name, color_hex, size, qty, unit_price, extras_price, total, notes,
                           product_type, product_label, product_mockup_path, product_price_multiplier)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.user.id,
    product.colorName || '', product.colorHex || '',
    priced.size || String(product.size || '').trim(),
    priced.qty,
    priced.unitPrice,
    priced.extrasPrice,
    priced.total,
    notes || '',
    catalogProduct.id,
    catalogProduct.name,
    catalogProduct.mockupPath,
    catalogProduct.priceMultiplier
  );
  const itemId = result.lastInsertRowid;
  createdItemId = itemId;
  const dir = path.join(CART_DIR, String(itemId));
  createdDir = dir;
  fs.mkdirSync(dir, { recursive: true });

  let previewPath = null;
  if (previewFile?.buffer?.length) {
    const optimized = await optimizeUploadedImage(previewFile.buffer, previewFile.mimetype || 'image/png', 'preview');
    const ext = optimized?.ext || extFromMime(previewFile.mimetype || 'image/png');
    previewPath = path.join('uploads', 'cart', String(itemId), `preview.${ext}`);
    await writeStoredUpload(previewPath, optimized?.buffer || previewFile.buffer, optimized?.mime || previewFile.mimetype || 'image/png');
    await db.prepare('UPDATE cart_items SET preview_path = ? WHERE id = ?').run(previewPath, itemId);
  } else {
    // Legacy JSON fallback (old clients)
    const previewBuf = dataUrlToBuffer(req.body?.previewDataUrl);
    if (previewBuf) {
      const optimized = await optimizeUploadedImage(previewBuf.buffer, previewBuf.mime || 'image/png', 'preview');
      const ext = optimized?.ext || extFromMime(previewBuf.mime || 'image/png');
      previewPath = path.join('uploads', 'cart', String(itemId), `preview.${ext}`);
      await writeStoredUpload(previewPath, optimized?.buffer || previewBuf.buffer, optimized?.mime || previewBuf.mime || 'image/png');
      await db.prepare('UPDATE cart_items SET preview_path = ? WHERE id = ?').run(previewPath, itemId);
    }
  }

  const insertDesign = await db.prepare(`
    INSERT INTO cart_item_designs(cart_item_id, name, position, scale, v_offset, x_offset, note, file_path)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const storedDesignFiles = await mapWithConcurrency(designs, 3, async (d, idx) => {
    let filePath = null;
    const designId = String(d?.id || '').trim();
    const file = (designId && fileByLayerId.get(designId)) || designFiles[idx];
    if (file?.buffer?.length) {
      const optimized = await optimizeUploadedImage(file.buffer, file.mimetype || 'image/png', 'design');
      const ext = optimized?.ext || extFromMime(file.mimetype || 'image/png');
      filePath = path.join('uploads', 'cart', String(itemId), `design-${idx + 1}.${ext}`);
      await writeStoredUpload(filePath, optimized?.buffer || file.buffer, optimized?.mime || file.mimetype || 'image/png');
    } else {
      const legacy = dataUrlToBuffer(d?.dataUrl);
      if (legacy) {
        const optimized = await optimizeUploadedImage(legacy.buffer, legacy.mime, 'design');
        const ext = optimized?.ext || extFromMime(legacy.mime);
        filePath = path.join('uploads', 'cart', String(itemId), `design-${idx + 1}.${ext}`);
        await writeStoredUpload(filePath, optimized?.buffer || legacy.buffer, optimized?.mime || legacy.mime || 'image/png');
      }
    }
    return filePath;
  });

  for (let idx = 0; idx < designs.length; idx++) {
    const d = designs[idx] || {};
    const filePath = storedDesignFiles[idx];
    if (!filePath) {
      const fileMissing = new Error(`Bestand ontbreekt voor design ${idx + 1}`);
      fileMissing.status = 400;
      throw fileMissing;
    }

    insertDesign.run(itemId, d.name || `Design ${idx + 1}`, d.position || 'center',
      Number(d.scale) || 100, Number(d.vOffset) || 0, Number(d.xOffset) || 0, d.note || '', filePath);
  }

  res.json({ ok: true, itemId, count: (await db.prepare('SELECT COUNT(*) AS c FROM cart_items WHERE user_id = ?').get(req.user.id)).c });
  } catch (err) {
    if (createdItemId) {
      await db.prepare('DELETE FROM cart_item_designs WHERE cart_item_id = ?').run(createdItemId);
      await db.prepare('DELETE FROM cart_items WHERE id = ?').run(createdItemId);
    }
    if (createdDir) {
      fs.rmSync(createdDir, { recursive: true, force: true });
    }
    console.error('Cart upload error:', err);
    const status = Number(err?.status);
    const httpStatus = Number.isInteger(status) && status >= 400 && status < 600 ? status : 500;
    res.status(httpStatus).json({ error: httpStatus === 500 ? 'Upload verwerken mislukt' : (err.message || 'Upload verwerken mislukt') });
  }
});

app.put('/api/cart/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const item = await db.prepare('SELECT * FROM cart_items WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!item) return res.status(404).json({ error: 'Item niet gevonden' });
  const qty = Math.max(1, Math.min(99, Number(req.body?.qty) || item.qty));
  const total = roundMoney((Number(item.unit_price) + Number(item.extras_price)) * qty);
  await db.prepare('UPDATE cart_items SET qty = ?, total = ? WHERE id = ?').run(qty, total, id);
  res.json({ ok: true });
});

app.delete('/api/cart/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const item = await db.prepare('SELECT * FROM cart_items WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!item) return res.status(404).json({ error: 'Item niet gevonden' });
  const designs = await db.prepare('SELECT file_path FROM cart_item_designs WHERE cart_item_id = ?').all(id);
  await db.prepare('DELETE FROM cart_items WHERE id = ?').run(id);
  if (item.preview_path) await removeUploadBlob(item.preview_path);
  for (const d of designs) if (d?.file_path) await removeUploadBlob(d.file_path);
  fs.rmSync(path.join(CART_DIR, String(id)), { recursive: true, force: true });
  res.json({ ok: true });
});

app.delete('/api/cart', requireAuth, async (req, res) => {
  const items = await db.prepare('SELECT id FROM cart_items WHERE user_id = ?').all(req.user.id);
  const ids = items.map(i => i.id).filter(Boolean);
  const placeholders = ids.map(() => '?').join(',');
  const previews = ids.length ? await db.prepare(`SELECT preview_path FROM cart_items WHERE id IN (${placeholders})`).all(...ids) : [];
  const designs = ids.length ? await db.prepare(`SELECT file_path FROM cart_item_designs WHERE cart_item_id IN (${placeholders})`).all(...ids) : [];
  await db.prepare('DELETE FROM cart_items WHERE user_id = ?').run(req.user.id);
  for (const row of previews) if (row?.preview_path) await removeUploadBlob(row.preview_path);
  for (const row of designs) if (row?.file_path) await removeUploadBlob(row.file_path);
  items.forEach(i => fs.rmSync(path.join(CART_DIR, String(i.id)), { recursive: true, force: true }));
  res.json({ ok: true });
});

// ── Checkout (cart → order) ────────────────────────────────────────────────
app.post('/api/orders', requireAuth, async (req, res) => {
  if (!Number(req.user.email_verified || 0)) {
    return res.status(403).json({
      error: 'Verifieer eerst je e-mailadres voordat je een bestelling kunt plaatsen. Controleer je inbox of stuur een nieuwe verificatiemail via je accountinstellingen.',
      code: 'EMAIL_NOT_VERIFIED'
    });
  }
  const cart = await loadCart(req.user.id);
  if (!cart.length) return res.status(400).json({ error: 'Winkelmand is leeg' });
  const { customer = {}, notes, saveAddress } = req.body || {};
  const required = ['firstName', 'lastName', 'email', 'address', 'postcode', 'city'];
  for (const f of required) if (!customer[f]?.trim()) return res.status(400).json({ error: 'Vul alle adresvelden in' });

  const pricedCart = cart.map((i) => {
    const qty = Math.max(1, Math.min(999, Math.round(Number(i.qty) || 1)));
    const unit = roundMoney(Number(i.unit_price) || 0);
    const extras = roundMoney(Number(i.extras_price) || 0);
    return {
      ...i,
      qty,
      unit_price: unit,
      extras_price: extras,
      total: roundMoney((unit + extras) * qty)
    };
  });

  const subtotal = pricedCart.reduce((s, i) => s + (i.total || 0), 0);
  const cfgForShipping = await getConfig();
  const shipping = computeShippingAmount(subtotal, cfgForShipping?.pricing || {});
  const total = subtotal + shipping;
  const customerCompany = String(customer.company || '').trim().slice(0, 120);
  const customerVat = String(customer.vatNumber || '').trim().slice(0, 40);

  // Create order (sequential async — works for both SQLite and PG)
  const r = await db.prepare(`
    INSERT INTO orders(user_id, status, customer_first, customer_last, customer_email,
                       customer_company, customer_vat, address, postcode, city, phone, subtotal, total, notes)
    VALUES(?, 'NEW', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.user.id, customer.firstName.trim(), customer.lastName.trim(), customer.email.trim(),
    customerCompany || null, customerVat || null,
    customer.address.trim(), customer.postcode.trim(), customer.city.trim(),
    (customer.phone || '').trim(), subtotal, total, notes || '');
  const orderId = r.lastInsertRowid;

  await db.prepare(`INSERT INTO order_status_history(order_id, status, note, changed_by)
              VALUES(?, 'NEW', 'Bestelling geplaatst', ?)`).run(orderId, req.user.id);

  for (const item of pricedCart) {
    const r2 = await db.prepare(`
      INSERT INTO order_items(order_id, color_name, color_hex, size, qty, unit_price, extras_price, total, preview_path, notes,
                              product_type, product_label, product_mockup_path, product_price_multiplier)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(orderId, item.color_name, item.color_hex, item.size, item.qty,
      item.unit_price, item.extras_price, item.total, null, item.notes || '',
      item.product_type || 'tshirt',
      item.product_label || 'T-shirt',
      item.product_mockup_path || null,
      Number(item.product_price_multiplier) || 1);
    const itemId = r2.lastInsertRowid;

    // Persist preview into an order-owned path so previews remain available after cart cleanup.
    let newPreview = null;
    if (item.preview_path) {
      const ext = path.extname(item.preview_path) || '.png';
      newPreview = path.join('uploads', 'orders', String(orderId), String(itemId), `preview${ext}`);
      const movedPreview = await copyStoredUpload(item.preview_path, newPreview, { removeSource: true });
      newPreview = movedPreview ? newPreview : null;
    }
    if (newPreview) await db.prepare('UPDATE order_items SET preview_path = ? WHERE id = ?').run(newPreview, itemId);

    for (let i = 0; i < item.designs.length; i++) {
      const d = item.designs[i];
      let newFile = null;
      if (d.file_path) {
        const ext = path.extname(d.file_path) || '.png';
        newFile = path.join('uploads', 'orders', String(orderId), String(itemId), `design-${i + 1}${ext}`);
        const movedDesign = await copyStoredUpload(d.file_path, newFile, { removeSource: true });
        newFile = movedDesign ? newFile : null;
      }
      await db.prepare(`INSERT INTO order_designs(order_item_id, name, position, scale, v_offset, x_offset, note, file_path)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)`).run(itemId, d.name, d.position, d.scale, d.v_offset, d.x_offset, d.note || '', newFile || d.file_path);
    }

    // Cleanup leftover cart dir
    try { fs.rmSync(path.join(CART_DIR, String(item.id)), { recursive: true, force: true }); } catch {}
  }

  await db.prepare('DELETE FROM cart_items WHERE user_id = ?').run(req.user.id);
  await ensureInvoiceForOrder(orderId, await getConfig());

  if (saveAddress) {
    await db.prepare(`UPDATE users SET first_name=COALESCE(NULLIF(first_name,''),?),
                                  last_name=COALESCE(NULLIF(last_name,''),?),
                                  address=?, postcode=?, city=?, phone=?
                WHERE id=?`)
      .run(customer.firstName.trim(), customer.lastName.trim(),
        customer.address.trim(), customer.postcode.trim(), customer.city.trim(),
        (customer.phone || '').trim(), req.user.id);
  }

  sendTemplatedEmailSafe('orderPlaced', customer.email.trim(), {
    orderId: formatOrderId(orderId),
    customerName: `${customer.firstName || ''} ${customer.lastName || ''}`.trim(),
    orderTotal: fmtEUR(total),
    orderStatusLabel: statusLabel('NEW')
  });

  res.json({ ok: true, orderId });
});

// ── Orders (user + staff) ──────────────────────────────────────────────────
app.get('/api/orders/mine', requireAuth, async (req, res) => {
  const rows = await db.prepare(`SELECT id, status, subtotal, total, created_at FROM orders
                           WHERE user_id = ? AND deleted_at IS NULL ORDER BY id DESC`).all(req.user.id);
  const orderIds = rows.map(r => r.id);
  if (orderIds.length) {
    await backfillMissingInvoices(await getConfig(), 400);
  }
  const placeholders = orderIds.map(() => '?').join(',');
  const invoices = orderIds.length
    ? await db.prepare(`SELECT order_id, status, due_date, paid_at, invoice_number
                  FROM invoices WHERE order_id IN (${placeholders})`).all(...orderIds)
    : [];
  const invoiceByOrder = {};
  invoices.forEach((inv) => { invoiceByOrder[inv.order_id] = inv; });
  const items = await db.prepare(`SELECT order_id, id, color_name, color_hex, size, qty, total, preview_path, product_label
                            FROM order_items WHERE order_id IN
                            (SELECT id FROM orders WHERE user_id = ?)`).all(req.user.id);
  const byOrder = {};
  items.forEach(i => { (byOrder[i.order_id] ||= []).push(i); });
  res.json({
    orders: rows.map(o => {
      const inv = invoiceByOrder[o.id] || null;
      const overdue = !!(inv && inv.status === 'DEFINITIVE' && !inv.paid_at && inv.due_date && new Date(inv.due_date).getTime() <= Date.now());
      return {
        ...o,
        items: byOrder[o.id] || [],
        invoice: inv ? { ...inv, overdue } : null
      };
    })
  });
});

app.get('/api/orders/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) return res.status(404).json({ error: 'Order niet gevonden' });
  const isStaff = req.user.role === 'OWNER' || req.user.role === 'ADMIN';
  if (!isStaff && (order.user_id !== req.user.id || isOrderArchived(order))) {
    return res.status(403).json({ error: 'Geen toegang' });
  }
  if (isOrderArchived(order) && !isStaff) return res.status(404).json({ error: 'Order niet gevonden' });
  await ensureInvoiceForOrder(id, await getConfig());
  const invoice = await db.prepare(`SELECT id, order_id, invoice_number, status, issue_date, due_date, paid_at, sent_at, last_reminder_at, reminder_count
                              FROM invoices WHERE order_id = ?`).get(id) || null;
  const invoicePayload = invoice
    ? { ...invoice, overdue: !!(invoice.status === 'DEFINITIVE' && !invoice.paid_at && invoice.due_date && new Date(invoice.due_date).getTime() <= Date.now()) }
    : null;
  const items = await db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(id);
  const designs = await db.prepare(`SELECT * FROM order_designs WHERE order_item_id IN
                              (SELECT id FROM order_items WHERE order_id = ?)`).all(id);
  const byItem = {};
  designs.forEach(d => { (byItem[d.order_item_id] ||= []).push(d); });
  const history = await db.prepare(`SELECT h.*, u.email AS changed_by_email FROM order_status_history h
                              LEFT JOIN users u ON u.id = h.changed_by
                              WHERE order_id = ? ORDER BY h.id`).all(id);
  const payments = await db.prepare(`SELECT id, provider, status, amount, currency, checkout_url,
                                      provider_payment_id, provider_checkout_id, payment_link_expires_at,
                                      paid_at, failure_reason, created_at, updated_at
                               FROM payments WHERE order_id = ?
                               ORDER BY id DESC`).all(id);
  const emailTracking = isStaff ? await getEmailTrackingForOrder(id) : [];
  const depositInvoices = isStaff
    ? await db.prepare(`SELECT id, order_id, linked_final_invoice_id, invoice_number, status, deposit_percentage, deposit_amount,
                         issue_date, due_date, sent_at, paid_at, created_at, updated_at
                  FROM deposit_invoices
                  WHERE order_id = ?
                  ORDER BY id DESC`).all(id)
    : [];
  const shippingEvents = isStaff
    ? await db.prepare(`SELECT id, event_key, carrier, status_raw, status_normalized, tracking_code, event_at, created_at
                  FROM shipping_events WHERE order_id = ? ORDER BY id DESC LIMIT 50`).all(id)
    : [];
  const activityFeed = isStaff ? buildOrderActivityFeed(order, history, emailTracking, depositInvoices, payments, shippingEvents) : [];
  res.json({
    order,
    invoice: invoicePayload,
    items: items.map(i => ({ ...i, designs: byItem[i.id] || [] })),
    history,
    payments,
    shippingEvents,
    emailTracking,
    depositInvoices,
    activityFeed
  });
});

app.put('/api/orders/:id/cancel', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) return res.status(404).json({ error: 'Order niet gevonden' });
  if (isOrderArchived(order)) return res.status(400).json({ error: 'Deze bestelling is gearchiveerd' });
  if (order.user_id !== req.user.id) return res.status(403).json({ error: 'Geen toegang' });
  if (!CUSTOMER_CANCELLABLE_STATUS.includes(order.status)) {
    return res.status(400).json({ error: 'Deze bestelling kan niet meer geannuleerd worden' });
  }
  await db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('CANCELLED', id);
  await db.prepare(`INSERT INTO order_status_history(order_id, status, note, changed_by)
              VALUES(?, 'CANCELLED', 'Geannuleerd door klant', ?)`).run(id, req.user.id);
  await markInvoiceVoid(id);
  res.json({ ok: true });
});

// ── Staff ─────────────────────────────────────────────────────────────────
app.get('/api/admin/orders', requireAuth, requireRole('ADMIN', 'OWNER'), async (req, res) => {
  processInvoiceRemindersSafe(false).catch(() => {});
  await backfillMissingInvoices(await getConfig(), 400);
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(5, Number(req.query.limit) || 20));
  const offset = (page - 1) * limit;
  const status = (req.query.status || '').toUpperCase();
  const archivedRaw = String(req.query.archived || '').toUpperCase();
  const archived = archivedRaw === 'DELETED' ? 'DELETED' : archivedRaw === 'ALL' ? 'ALL' : 'ACTIVE';
  const invoiceStatus = String(req.query.invoiceStatus || '').toUpperCase();
  const q = (req.query.q || '').trim();

  let where = '1=1', params = {};
  if (archived === 'ACTIVE') where += ' AND o.deleted_at IS NULL';
  if (archived === 'DELETED') where += ' AND o.deleted_at IS NOT NULL';
  if (ALLOWED_STATUS.includes(status)) { where += ' AND o.status = @status'; params.status = status; }
  if (invoiceStatus) {
    if (invoiceStatus === 'OPEN') {
      where += ` AND i.status = 'DEFINITIVE' AND i.paid_at IS NULL`;
    } else if (invoiceStatus === 'OVERDUE') {
      where += ` AND i.status = 'DEFINITIVE' AND i.paid_at IS NULL AND i.due_date IS NOT NULL AND datetime(i.due_date) <= datetime('now')`;
    } else if (['CONCEPT', 'DEFINITIVE', 'PAID', 'VOID'].includes(invoiceStatus)) {
      where += ' AND i.status = @invoiceStatus';
      params.invoiceStatus = invoiceStatus;
    }
  }
  if (q) {
    where += ` AND (o.customer_first LIKE @q OR o.customer_last LIKE @q OR o.customer_email LIKE @q
                    OR CAST(o.id AS TEXT) LIKE @q OR i.invoice_number LIKE @q)`;
    params.q = `%${q}%`;
  }

  const totalRow = await db.prepare(`
    SELECT COUNT(*) AS c
    FROM orders o
    LEFT JOIN invoices i ON i.order_id = o.id
    WHERE ${where}
  `).get(params);
  const total = totalRow?.c || 0;
  const rows = await db.prepare(`
    SELECT o.id, o.status, o.subtotal, o.total, o.created_at,
           o.deleted_at, o.deleted_by, o.delete_reason,
           o.shipping_carrier, o.tracking_code, o.tracking_url, o.shipping_status, o.shipping_last_update_at,
           o.customer_first, o.customer_last, o.customer_email,
           u.email AS user_email,
           i.invoice_number, i.status AS invoice_status, i.due_date AS invoice_due_date, i.paid_at AS invoice_paid_at, i.sent_at AS invoice_sent_at,
           CASE WHEN i.status='DEFINITIVE' AND i.paid_at IS NULL AND i.due_date IS NOT NULL AND datetime(i.due_date) <= datetime('now')
             THEN 1 ELSE 0 END AS invoice_overdue,
           (SELECT preview_path FROM order_items WHERE order_id = o.id LIMIT 1) AS preview_path,
           (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) AS item_count
    FROM orders o
    LEFT JOIN users u ON u.id = o.user_id
    LEFT JOIN invoices i ON i.order_id = o.id
    WHERE ${where}
    ORDER BY o.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `).all(params);

  const stats = await db.prepare(`SELECT
    COUNT(*) AS total_orders,
    SUM(CASE WHEN status='NEW' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS new_count,
    SUM(CASE WHEN status IN ('NEW','APPROVED','APPROVED_AWAITING_PAYMENT','PAYMENT_PENDING','PAID','IN_PRODUCTION') AND deleted_at IS NULL THEN 1 ELSE 0 END) AS open_count,
    SUM(CASE WHEN status IN ('SHIPPED','DELIVERED') AND deleted_at IS NULL THEN 1 ELSE 0 END) AS done_count,
    COALESCE(SUM(CASE WHEN deleted_at IS NULL THEN total ELSE 0 END),0) AS revenue
    FROM orders`).get();

  res.json({ orders: rows, total, page, limit, pages: Math.ceil(total / limit), stats, archived });
});

function normalizeInvoiceStatusFilter(raw) {
  const statusRaw = String(raw || 'OPEN').toUpperCase();
  if (statusRaw === 'ALL') return null;
  if (['OPEN', 'OVERDUE', 'CONCEPT', 'DEFINITIVE', 'PAID', 'VOID'].includes(statusRaw)) return statusRaw;
  return 'OPEN';
}

function buildInvoiceWhereClause(statusFilter, q, params) {
  let where = '1=1';
  if (statusFilter === 'OPEN') {
    where += ` AND i.status = 'DEFINITIVE' AND i.paid_at IS NULL`;
  } else if (statusFilter === 'OVERDUE') {
    where += ` AND i.status = 'DEFINITIVE' AND i.paid_at IS NULL AND i.due_date IS NOT NULL AND datetime(i.due_date) <= datetime('now')`;
  } else if (['CONCEPT', 'DEFINITIVE', 'PAID', 'VOID'].includes(statusFilter || '')) {
    where += ' AND i.status = @st';
    params.st = statusFilter;
  }
  if (q) {
    where += ` AND (i.invoice_number LIKE @q OR CAST(i.order_id AS TEXT) LIKE @q OR
                    o.customer_first LIKE @q OR o.customer_last LIKE @q OR o.customer_email LIKE @q)`;
    params.q = `%${q}%`;
  }
  return where;
}

function invoiceSortOrderSql(raw) {
  const code = String(raw || 'DUE_ASC').toUpperCase();
  if (code === 'DUE_DESC') return `datetime(i.due_date) DESC, i.id DESC`;
  if (code === 'AGE_DESC') return `datetime(COALESCE(i.issue_date, i.created_at)) ASC, i.id ASC`;
  if (code === 'AMOUNT_DESC') return `o.total DESC, i.id DESC`;
  return `datetime(i.due_date) ASC, i.id DESC`;
}

app.get('/api/admin/invoices', requireAuth, requireRole('ADMIN', 'OWNER'), async (req, res) => {
  const cfg = await getConfig();
  await backfillMissingInvoices(cfg, 400);
  await processInvoiceRemindersSafe(false);
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 20));
  const offset = (page - 1) * limit;
  const sort = String(req.query.sort || 'DUE_ASC').toUpperCase();
  const q = String(req.query.q || '').trim();
  const statusFilter = normalizeInvoiceStatusFilter(req.query.status);
  const params = {};
  const where = buildInvoiceWhereClause(statusFilter, q, params);
  const orderBy = invoiceSortOrderSql(sort);

  const invTotalRow = await db.prepare(`
    SELECT COUNT(*) AS c
    FROM invoices i
    JOIN orders o ON o.id = i.order_id
    WHERE ${where}
  `).get(params);
  const total = invTotalRow?.c || 0;

  const rows = await db.prepare(`
    SELECT i.id, i.order_id, i.invoice_number, i.status, i.issue_date, i.due_date, i.paid_at, i.sent_at,
           i.last_reminder_at, i.reminder_count,
           o.customer_first, o.customer_last, o.customer_email, o.total, o.status AS order_status,
           (SELECT checkout_url FROM payments p WHERE p.order_id = o.id AND p.checkout_url IS NOT NULL
            ORDER BY p.id DESC LIMIT 1) AS payment_url
    FROM invoices i
    JOIN orders o ON o.id = i.order_id
    WHERE ${where}
    ORDER BY
      CASE WHEN i.status='DEFINITIVE' AND i.paid_at IS NULL THEN 0 ELSE 1 END,
      ${orderBy}
    LIMIT ${limit} OFFSET ${offset}
  `).all(params);

  const stats = await db.prepare(`
    SELECT
      COUNT(*) AS total_invoices,
      SUM(CASE WHEN status='CONCEPT' THEN 1 ELSE 0 END) AS concept_count,
      SUM(CASE WHEN status='DEFINITIVE' AND paid_at IS NULL THEN 1 ELSE 0 END) AS open_count,
      SUM(CASE WHEN status='PAID' THEN 1 ELSE 0 END) AS paid_count,
      SUM(CASE WHEN status='VOID' THEN 1 ELSE 0 END) AS void_count,
      SUM(CASE WHEN status='DEFINITIVE' AND paid_at IS NULL AND due_date IS NOT NULL AND datetime(due_date) <= datetime('now')
               THEN 1 ELSE 0 END) AS overdue_count
    FROM invoices
  `).get();

  res.json({ invoices: rows, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)), stats, sort, status: statusFilter || 'ALL' });
});

app.get('/api/admin/invoices.csv', requireAuth, requireRole('ADMIN', 'OWNER'), async (req, res) => {
  const statusFilter = normalizeInvoiceStatusFilter(req.query.status);
  const sort = String(req.query.sort || 'DUE_ASC').toUpperCase();
  const q = String(req.query.q || '').trim();
  const params = {};
  const where = buildInvoiceWhereClause(statusFilter, q, params);
  const orderBy = invoiceSortOrderSql(sort);
  const rows = await db.prepare(`
    SELECT i.invoice_number, i.status, i.issue_date, i.due_date, i.paid_at, i.sent_at, i.last_reminder_at, i.reminder_count,
           i.order_id, o.customer_first, o.customer_last, o.customer_email, o.total
    FROM invoices i
    JOIN orders o ON o.id = i.order_id
    WHERE ${where}
    ORDER BY ${orderBy}
  `).all(params);
  const cols = [
    'invoice_number','status','order_id','customer_first','customer_last','customer_email',
    'total','issue_date','due_date','paid_at','sent_at','last_reminder_at','reminder_count'
  ];
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };
  const csv = [cols.join(',')].concat(rows.map(r => cols.map(c => esc(r[c])).join(','))).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=invoices-${(statusFilter || 'ALL').toLowerCase()}-${new Date().toISOString().slice(0,10)}.csv`);
  res.send(csv);
});

app.post('/api/admin/invoices/run-reminders', requireAuth, requireRole('ADMIN', 'OWNER'), async (_req, res) => {
  const out = await processInvoiceRemindersSafe(true);
  res.json({ ok: true, result: out });
});

app.post('/api/admin/invoices/remind-bulk', requireAuth, requireRole('ADMIN', 'OWNER'), async (req, res) => {
  try {
    const inputIds = Array.isArray(req.body?.invoiceIds) ? req.body.invoiceIds : [];
    const ids = [...new Set(inputIds.map(v => Number(v)).filter(v => Number.isInteger(v) && v > 0))];
    if (!ids.length) return res.status(400).json({ error: 'Selecteer minstens 1 factuur' });
    if (ids.length > 200) return res.status(400).json({ error: 'Maximaal 200 facturen per bulkactie' });
    const cfg = await getConfig();
    const maxCount = Math.min(20, Math.max(1, Number(cfg?.documents?.invoice?.reminderMaxCount) || 5));

    const placeholders = ids.map(() => '?').join(',');
    const rows = await db.prepare(`
      SELECT i.*, o.customer_email, o.customer_first, o.customer_last, o.total,
             (SELECT checkout_url FROM payments p WHERE p.order_id = o.id AND p.checkout_url IS NOT NULL
              ORDER BY p.id DESC LIMIT 1) AS checkout_url
      FROM invoices i
      JOIN orders o ON o.id = i.order_id
      WHERE i.id IN (${placeholders})
        AND i.status = 'DEFINITIVE'
        AND i.paid_at IS NULL
        AND i.reminder_count < ?
    `).all(...ids, maxCount);

    let sent = 0;
    let skipped = 0;
    let failed = 0;
    const failedItems = [];

    for (const row of rows) {
      try {
        const info = await sendInvoiceReminderForRow(row, cfg);
        if (info?.ok) sent++;
        else {
          skipped++;
          if (info?.error) {
            failed++;
            failedItems.push({
              invoiceId: Number(row.id),
              orderId: Number(row.order_id),
              reason: String(info.error || 'onbekende fout')
            });
          }
        }
      } catch (err) {
        failed++;
        failedItems.push({
          invoiceId: Number(row.id),
          orderId: Number(row.order_id),
          reason: String(err?.message || 'onbekende fout')
        });
      }
    }
    const foundSet = new Set(rows.map(r => Number(r.id)));
    const missing = ids.filter(i => !foundSet.has(i));
    skipped += missing.length;

    await logAuditFromReq(req, {
      action: 'INVOICE_REMINDER_BULK_SENT',
      entityType: 'invoice',
      entityId: null,
      summary: `Bulk factuurreminder: ${sent} verstuurd, ${skipped} overgeslagen, ${failed} mislukt`,
      details: { requested: ids.length, sent, skipped, failed, missing, failedItems }
    });

    res.json({
      ok: true,
      summary: { requested: ids.length, sent, skipped, failed, missing, failedItems }
    });
  } catch (err) {
    console.error('Bulk invoice reminders failed:', err);
    res.status(500).json({ error: err.message || 'Bulk herinnering mislukt' });
  }
});

app.post('/api/admin/invoices/:id/resend', requireAuth, requireRole('ADMIN', 'OWNER'), async (req, res) => {
  try {
    const invoiceId = Number(req.params.id);
    if (!Number.isInteger(invoiceId) || invoiceId <= 0) return res.status(400).json({ error: 'Ongeldige factuur' });
    const row = await db.prepare(`
      SELECT i.id, i.order_id, i.invoice_number,
             o.customer_email, o.customer_first, o.customer_last, o.total
      FROM invoices i
      JOIN orders o ON o.id = i.order_id
      WHERE i.id = ?
    `).get(invoiceId);
    if (!row) return res.status(404).json({ error: 'Factuur niet gevonden' });
    if (!row.customer_email) return res.status(400).json({ error: 'Geen klant e-mail beschikbaar' });
    const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(row.order_id);
    if (!order) return res.status(404).json({ error: 'Order niet gevonden' });
    if (isOrderArchived(order)) return res.status(400).json({ error: 'Order is gearchiveerd. Zet eerst terug.' });
    const payment = await db.prepare(`SELECT checkout_url, payment_link_expires_at FROM payments
                                WHERE order_id = ? AND checkout_url IS NOT NULL
                                ORDER BY id DESC LIMIT 1`).get(order.id) || null;
    const info = await sendPaymentLinkEmailWithInvoice(order, payment, {
      actorUserId: req.user?.id || null,
      actorEmail: req.user?.email || null
    });
    if (info?.ok) {
      await db.prepare(`UPDATE invoices SET sent_at = ? WHERE id = ?`).run(new Date().toISOString(), invoiceId);
    }
    res.json({ ok: true, info });
  } catch (err) {
    console.error('Invoice resend failed:', err);
    res.status(500).json({ error: err.message || 'Factuur opnieuw versturen mislukt' });
  }
});

app.put('/api/admin/orders/:id/status', requireAuth, requireRole('ADMIN', 'OWNER'), async (req, res) => {
  const status = String(req.body?.status || '').toUpperCase();
  const note = (req.body?.note || '').trim();
  if (!ALLOWED_STATUS.includes(status)) return res.status(400).json({ error: 'Ongeldige status' });
  const id = Number(req.params.id);
  const cur = await db.prepare('SELECT status, customer_email, customer_first, customer_last, total, deleted_at FROM orders WHERE id = ?').get(id);
  if (!cur) return res.status(404).json({ error: 'Order niet gevonden' });
  if (cur.deleted_at) return res.status(400).json({ error: 'Order is gearchiveerd. Zet eerst terug.' });
  if (cur.status === status) return res.json({ ok: true });
  await db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, id);
  await db.prepare(`INSERT INTO order_status_history(order_id, status, note, changed_by)
              VALUES(?, ?, ?, ?)`).run(id, status, note, req.user.id);
  if (status === 'PAID') await markInvoicePaid(id);
  else if (status === 'CANCELLED') await markInvoiceVoid(id);
  else if (status === 'APPROVED_AWAITING_PAYMENT' || status === 'PAYMENT_PENDING') await finalizeInvoiceForOrder(id, await getConfig());

  await logAuditFromReq(req, {
    action: 'ORDER_STATUS_UPDATED',
    entityType: 'order',
    entityId: id,
    summary: `Order #${formatOrderId(id)} status: ${cur.status} -> ${status}`,
    details: { orderId: id, before: cur.status, after: status, note: note || null }
  });
  if (cur.customer_email) {
    if (status === 'PAID') {
      await sendPaymentReceivedEmailWithInvoiceSafe({
        id,
        customer_email: cur.customer_email,
        customer_first: cur.customer_first,
        customer_last: cur.customer_last,
        total: cur.total
      });
    } else {
      sendTemplatedEmailSafe('orderStatusChanged', cur.customer_email, {
        orderId: formatOrderId(id),
        customerName: `${cur.customer_first || ''} ${cur.customer_last || ''}`.trim(),
        orderTotal: fmtEUR(cur.total),
        orderStatusLabel: statusLabel(status)
      });
    }
  }
  res.json({ ok: true });
});

// Order klantgegevens bewerken
app.put('/api/admin/orders/:id/customer', requireAuth, requireRole('ADMIN', 'OWNER'), async (req, res) => {
  const id = Number(req.params.id);
  const order = await db.prepare('SELECT id, deleted_at FROM orders WHERE id = ?').get(id);
  if (!order) return res.status(404).json({ error: 'Order niet gevonden' });
  if (order.deleted_at) return res.status(400).json({ error: 'Order is gearchiveerd. Zet eerst terug.' });
  const b = req.body || {};
  const clean = (v, max = 160) => String(v == null ? '' : v).trim().slice(0, max);
  await db.prepare(`UPDATE orders SET
    customer_first=?, customer_last=?, customer_email=?, customer_company=?, customer_vat=?,
    address=?, postcode=?, city=?, phone=?
    WHERE id=?`).run(
    clean(b.firstName), clean(b.lastName), clean(b.email, 120),
    clean(b.company, 120), clean(b.vatNumber, 40),
    clean(b.address), clean(b.postcode, 20), clean(b.city), clean(b.phone, 40),
    id
  );
  await logAuditFromReq(req, { action: 'ORDER_STATUS_UPDATED', entityType: 'order', entityId: id, summary: `Klantgegevens order #${id} bijgewerkt` });
  res.json({ ok: true });
});

async function handleSoftDeleteOrder(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Ongeldige order' });

  const order = await db.prepare('SELECT id, status, customer_email, deleted_at FROM orders WHERE id = ?').get(id);
  if (!order) return res.status(404).json({ error: 'Order niet gevonden' });
  if (order.deleted_at) return res.json({ ok: true, archived: true, orderId: id, alreadyArchived: true });
  const reason = String(req.body?.reason || 'Gearchiveerd via admin').trim().slice(0, 240);
  await db.prepare(`UPDATE orders
              SET deleted_at = ?, deleted_by = ?, delete_reason = ?
              WHERE id = ?`)
    .run(new Date().toISOString(), req.user.id, reason, id);

  await logAuditFromReq(req, {
    action: 'ORDER_SOFT_DELETED',
    entityType: 'order',
    entityId: id,
    summary: `Order #${formatOrderId(id)} gearchiveerd`,
    details: {
      orderId: id,
      status: order.status,
      customerEmail: order.customer_email || null,
      reason
    }
  });

  res.json({ ok: true, archived: true, orderId: id });
}

// Order soft-delete (archiveren)
app.delete('/api/admin/orders/:id', requireAuth, requireRole('ADMIN', 'OWNER'), handleSoftDeleteOrder);
// Compat: legacy clients can still POST to /delete
app.post('/api/admin/orders/:id/delete', requireAuth, requireRole('ADMIN', 'OWNER'), handleSoftDeleteOrder);

// Order-item bewerken
app.put('/api/admin/order-items/:id', requireAuth, requireRole('ADMIN', 'OWNER'), async (req, res) => {
  const id = Number(req.params.id);
  const item = await db.prepare(`
    SELECT oi.id, o.deleted_at
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE oi.id = ?
  `).get(id);
  if (!item) return res.status(404).json({ error: 'Order-item niet gevonden' });
  if (item.deleted_at) return res.status(400).json({ error: 'Order is gearchiveerd. Zet eerst terug.' });
  const b = req.body || {};
  if (b.qty !== undefined) {
    const qty = Math.max(1, Math.min(9999, Number(b.qty) || 1));
    await db.prepare('UPDATE order_items SET qty = ? WHERE id = ?').run(qty, id);
  }
  if (b.notes !== undefined) {
    await db.prepare('UPDATE order_items SET notes = ? WHERE id = ?').run(String(b.notes || '').trim().slice(0, 500), id);
  }
  res.json({ ok: true });
});

app.put('/api/admin/orders/bulk-status', requireAuth, requireRole('ADMIN', 'OWNER'), async (req, res) => {
  const status = String(req.body?.status || '').toUpperCase();
  const note = (req.body?.note || '').trim();
  const inputIds = Array.isArray(req.body?.orderIds) ? req.body.orderIds : [];
  const ids = [...new Set(inputIds.map(v => Number(v)).filter(v => Number.isInteger(v) && v > 0))];

  if (!ALLOWED_STATUS.includes(status)) return res.status(400).json({ error: 'Ongeldige status' });
  if (!ids.length) return res.status(400).json({ error: 'Selecteer minstens 1 order' });
  if (ids.length > 200) return res.status(400).json({ error: 'Maximaal 200 orders per bulkactie' });

  const placeholders = ids.map(() => '?').join(',');
  const rows = await db.prepare(`
    SELECT id, status, customer_email, customer_first, customer_last, total, deleted_at
    FROM orders
    WHERE id IN (${placeholders})
  `).all(...ids);

  const foundSet = new Set(rows.map(r => r.id));
  const missing = ids.filter(id => !foundSet.has(id));
  const toNotify = [];
  let changed = 0;
  let skipped = 0;

  for (const row of rows) {
    if (row.deleted_at) { skipped++; continue; }
    if (row.status === status) { skipped++; continue; }
    await db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, row.id);
    await db.prepare(`INSERT INTO order_status_history(order_id, status, note, changed_by)
                VALUES(?, ?, ?, ?)`).run(row.id, status, note, req.user.id);
    if (status === 'PAID') await markInvoicePaid(row.id);
    else if (status === 'CANCELLED') await markInvoiceVoid(row.id);
    else if (status === 'APPROVED_AWAITING_PAYMENT' || status === 'PAYMENT_PENDING') await finalizeInvoiceForOrder(row.id, await getConfig());
    changed++;
    toNotify.push(row);
  }

  for (const row of toNotify) {
    if (!row.customer_email) continue;
    if (status === 'PAID') {
      await sendPaymentReceivedEmailWithInvoiceSafe({
        id: row.id,
        customer_email: row.customer_email,
        customer_first: row.customer_first,
        customer_last: row.customer_last,
        total: row.total
      });
    } else {
      sendTemplatedEmailSafe('orderStatusChanged', row.customer_email, {
        orderId: formatOrderId(row.id),
        customerName: `${row.customer_first || ''} ${row.customer_last || ''}`.trim(),
        orderTotal: fmtEUR(row.total),
        orderStatusLabel: statusLabel(status)
      });
    }
  }

  await logAuditFromReq(req, {
    action: 'ORDER_BULK_STATUS_UPDATED',
    entityType: 'order',
    entityId: null,
    summary: `Bulk status update naar ${status}: ${changed} gewijzigd, ${skipped} ongewijzigd`,
    details: {
      targetStatus: status,
      note: note || null,
      requestedOrderIds: ids,
      changed,
      skipped,
      missing
    }
  });

  res.json({
    ok: true,
    summary: {
      requested: ids.length,
      found: rows.length,
      changed,
      skipped,
      missing
    }
  });
});

async function handleBulkSoftDeleteOrders(req, res) {
  const inputIds = Array.isArray(req.body?.orderIds) ? req.body.orderIds : [];
  const reason = String(req.body?.reason || 'Bulk gearchiveerd via admin').trim().slice(0, 240);
  const ids = [...new Set(inputIds.map(v => Number(v)).filter(v => Number.isInteger(v) && v > 0))];
  if (!ids.length) return res.status(400).json({ error: 'Selecteer minstens 1 order' });
  if (ids.length > 200) return res.status(400).json({ error: 'Maximaal 200 orders per bulkactie' });
  const placeholders = ids.map(() => '?').join(',');
  const rows = await db.prepare(`SELECT id, deleted_at FROM orders WHERE id IN (${placeholders})`).all(...ids);
  const foundSet = new Set(rows.map(r => r.id));
  const missing = ids.filter(id => !foundSet.has(id));
  let updated = 0;
  let skipped = 0;
  const nowIso = new Date().toISOString();
  for (const row of rows) {
    if (row.deleted_at) { skipped++; continue; }
    await db.prepare(`UPDATE orders SET deleted_at = ?, deleted_by = ?, delete_reason = ? WHERE id = ?`)
      .run(nowIso, req.user.id, reason, row.id);
    updated++;
  }

  await logAuditFromReq(req, {
    action: 'ORDER_BULK_SOFT_DELETED',
    entityType: 'order',
    entityId: null,
    summary: `Bulk archiveren: ${updated} gearchiveerd, ${skipped} overgeslagen`,
    details: { requested: ids.length, updated, skipped, missing, reason }
  });

  res.json({ ok: true, summary: { requested: ids.length, found: rows.length, updated, skipped, missing } });
}

app.post('/api/admin/orders/bulk-delete', requireAuth, requireRole('ADMIN', 'OWNER'), handleBulkSoftDeleteOrders);
// Compat: support DELETE method on same route for older frontends.
app.delete('/api/admin/orders/bulk-delete', requireAuth, requireRole('ADMIN', 'OWNER'), handleBulkSoftDeleteOrders);

app.post('/api/admin/orders/:id/restore', requireAuth, requireRole('ADMIN', 'OWNER'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Ongeldige order' });
  const order = await db.prepare('SELECT id, status, deleted_at FROM orders WHERE id = ?').get(id);
  if (!order) return res.status(404).json({ error: 'Order niet gevonden' });
  if (!order.deleted_at) return res.json({ ok: true, restored: true, alreadyActive: true, orderId: id });

  await db.prepare(`UPDATE orders SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL WHERE id = ?`).run(id);
  await logAuditFromReq(req, {
    action: 'ORDER_RESTORED',
    entityType: 'order',
    entityId: id,
    summary: `Order #${formatOrderId(id)} teruggezet uit archief`
  });
  res.json({ ok: true, restored: true, orderId: id });
});

app.post('/api/admin/orders/:id/shipment', requireAuth, requireRole('ADMIN', 'OWNER'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Ongeldige order' });
  const order = await db.prepare('SELECT id, status, deleted_at FROM orders WHERE id = ?').get(id);
  if (!order) return res.status(404).json({ error: 'Order niet gevonden' });
  if (order.deleted_at) return res.status(400).json({ error: 'Order is gearchiveerd. Zet eerst terug.' });

  const carrier = normalizeCarrier(req.body?.carrier);
  const trackingCode = normalizeTrackingCode(req.body?.trackingCode);
  const shippingStatus = normalizeShippingStatus(req.body?.shippingStatus || 'UNKNOWN');
  if (!carrier || !SHIPPING_CARRIERS.includes(carrier)) return res.status(400).json({ error: 'Ongeldige vervoerder' });
  if (!trackingCode) return res.status(400).json({ error: 'Tracking code is verplicht' });

  const trackingUrl = buildTrackingUrl(carrier, trackingCode);
  const nowIso = new Date().toISOString();
  await db.prepare(`UPDATE orders
              SET shipping_carrier = ?, tracking_code = ?, tracking_url = ?, shipping_status = ?, shipping_last_update_at = ?
              WHERE id = ?`)
    .run(carrier, trackingCode, trackingUrl, shippingStatus, nowIso, id);

  const eventKey = `manual:${id}:${carrier}:${trackingCode}:${nowIso}`;
  await db.prepare(`INSERT INTO shipping_events(event_key, order_id, carrier, status_raw, status_normalized, tracking_code, event_at, payload_json)
              VALUES(?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(eventKey, id, carrier, shippingStatus, shippingStatus, trackingCode, nowIso, JSON.stringify({ source: 'admin_shipment_update' }));

  if (['IN_TRANSIT', 'OUT_FOR_DELIVERY'].includes(shippingStatus) && ['PAID', 'IN_PRODUCTION'].includes(order.status)) {
    await db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('SHIPPED', id);
    await addOrderHistory(id, 'SHIPPED', `Automatische update via ${carrier} tracking`, req.user.id);
  } else if (shippingStatus === 'DELIVERED' && order.status !== 'DELIVERED') {
    await db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('DELIVERED', id);
    await addOrderHistory(id, 'DELIVERED', `Automatische levering via ${carrier} tracking`, req.user.id);
  }

  await logAuditFromReq(req, {
    action: 'ORDER_SHIPMENT_UPDATED',
    entityType: 'order',
    entityId: id,
    summary: `Verzending bijgewerkt (${carrier} ${trackingCode})`,
    details: { carrier, trackingCode, trackingUrl, shippingStatus }
  });
  res.json({ ok: true, shipment: { carrier, trackingCode, trackingUrl, shippingStatus, shippingLastUpdateAt: nowIso } });
});

app.post('/api/admin/shipping/events', requireAuth, requireRole('ADMIN', 'OWNER'), async (req, res) => {
  const eventKeyRaw = String(req.body?.eventKey || req.body?.idempotencyKey || '').trim();
  const orderId = Number(req.body?.orderId || 0);
  const carrier = normalizeCarrier(req.body?.carrier);
  const trackingCode = normalizeTrackingCode(req.body?.trackingCode);
  const statusRaw = String(req.body?.status || '').trim();
  const normalized = normalizeShippingStatus(statusRaw);
  const eventAtIso = parseSqliteDate(req.body?.timestamp || req.body?.eventAt)?.toISOString() || new Date().toISOString();
  if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({ error: 'orderId is verplicht' });
  if (!carrier || !trackingCode) return res.status(400).json({ error: 'carrier en trackingCode zijn verplicht' });

  const order = await db.prepare('SELECT id, status, deleted_at FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).json({ error: 'Order niet gevonden' });
  if (order.deleted_at) return res.status(400).json({ error: 'Order is gearchiveerd. Zet eerst terug.' });

  const eventKey = eventKeyRaw || `evt:${orderId}:${carrier}:${trackingCode}:${statusRaw}:${eventAtIso}`;
  const exists = await db.prepare('SELECT id FROM shipping_events WHERE event_key = ?').get(eventKey);
  if (exists) return res.json({ ok: true, duplicate: true, eventId: exists.id });

  const trackingUrl = buildTrackingUrl(carrier, trackingCode);
  await db.prepare(`INSERT INTO shipping_events(event_key, order_id, carrier, status_raw, status_normalized, tracking_code, event_at, payload_json)
              VALUES(?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(eventKey, orderId, carrier, statusRaw, normalized, trackingCode, eventAtIso, JSON.stringify(req.body || {}));
  await db.prepare(`UPDATE orders
              SET shipping_carrier = ?, tracking_code = ?, tracking_url = ?, shipping_status = ?, shipping_last_update_at = ?
              WHERE id = ?`)
    .run(carrier, trackingCode, trackingUrl, normalized, eventAtIso, orderId);

  if (['IN_TRANSIT', 'OUT_FOR_DELIVERY'].includes(normalized) && ['PAID', 'IN_PRODUCTION'].includes(order.status)) {
    await db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('SHIPPED', orderId);
    await addOrderHistory(orderId, 'SHIPPED', `Automatische update via ${carrier} tracking`, req.user.id);
  } else if (normalized === 'DELIVERED' && order.status !== 'DELIVERED') {
    await db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('DELIVERED', orderId);
    await addOrderHistory(orderId, 'DELIVERED', `Automatische levering via ${carrier} tracking`, req.user.id);
  }

  await logAuditFromReq(req, {
    action: 'ORDER_SHIPPING_EVENT_INGESTED',
    entityType: 'order',
    entityId: orderId,
    summary: `Shipping event verwerkt: ${carrier} ${normalized}`,
    details: { eventKey, carrier, trackingCode, statusRaw, statusNormalized: normalized, eventAt: eventAtIso }
  });

  res.json({ ok: true, duplicate: false, shipment: { carrier, trackingCode, trackingUrl, shippingStatus: normalized, shippingLastUpdateAt: eventAtIso } });
});

app.get('/api/admin/orders/:id/email-preview', requireAuth, requireRole('ADMIN', 'OWNER'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const type = String(req.query.type || 'payment_link').trim().toLowerCase();
    const allowed = new Set(['payment_link', 'offer', 'invoice', 'deposit_invoice']);
    if (!allowed.has(type)) return res.status(400).json({ error: 'Ongeldig preview type' });
    const extraMessage = String(req.query.extraMessage || '').slice(0, 500);
    const subjectOverride = String(req.query.subjectOverride || '').slice(0, 180);
    const out = await buildOrderEmailPreview(id, type, { extraMessage, subjectOverride });
    res.json({
      ok: true,
      type,
      templateKey: out.templateKey,
      subject: out.subject,
      html: out.html
    });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Email preview mislukt' });
  }
});

// Step 1: Approve only — change status NEW → APPROVED, finalize invoice, NO Stripe, NO email
app.post('/api/admin/orders/:id/approve', requireAuth, requireRole('ADMIN', 'OWNER'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!order) return res.status(404).json({ error: 'Order niet gevonden' });
    if (isOrderArchived(order)) return res.status(400).json({ error: 'Order is gearchiveerd. Zet eerst terug.' });
    if (FINAL_ORDER_STATUS.includes(order.status)) {
      return res.status(400).json({ error: `Deze bestelling is al afgerond (${statusLabel(order.status)})` });
    }
    if (order.status !== 'NEW') {
      return res.status(400).json({ error: `Enkel NEW orders kunnen worden goedgekeurd (huidige status: ${statusLabel(order.status)})` });
    }

    const config = await getConfig();
    await db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('APPROVED', order.id);
    await addOrderHistory(order.id, 'APPROVED', 'Order goedgekeurd door admin', req.user.id);
    await finalizeInvoiceForOrder(order.id, config);

    await logAuditFromReq(req, {
      action: 'ORDER_APPROVED',
      entityType: 'order',
      entityId: order.id,
      summary: `Order #${formatOrderId(order.id)} goedgekeurd`,
      details: { orderId: order.id, previousStatus: 'NEW' }
    });

    res.json({ ok: true, status: 'APPROVED', statusLabel: statusLabel('APPROVED') });
  } catch (err) {
    console.error('Approve error:', err);
    res.status(500).json({ error: err.message || 'Goedkeuren mislukt' });
  }
});

// Step 2: Create Stripe payment link + send betaallink email to customer
app.post('/api/admin/orders/:id/send-payment-link', requireAuth, requireRole('ADMIN', 'OWNER'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!order) return res.status(404).json({ error: 'Order niet gevonden' });
    if (isOrderArchived(order)) return res.status(400).json({ error: 'Order is gearchiveerd. Zet eerst terug.' });
    if (FINAL_ORDER_STATUS.includes(order.status)) {
      return res.status(400).json({ error: `Betaallink kan niet worden verstuurd voor een afgeronde bestelling` });
    }
    if (!['APPROVED', 'APPROVED_AWAITING_PAYMENT'].includes(order.status)) {
      return res.status(400).json({ error: `Keur de bestelling eerst goed voordat je een betaallink verstuurt` });
    }

    const config = await getConfig();
    const extraMsg = (req.body?.extraMessage || '').trim().slice(0, 600);
    const subject = String(req.body?.subject || '').trim().slice(0, 180);
    const includeInvoice = req.body?.includeInvoice !== false;
    const payment = await createCheckoutSessionForOrder(order, config);

    await db.prepare(`INSERT INTO payments(order_id, provider, status, amount, currency, checkout_url,
                                     provider_payment_id, provider_checkout_id, payment_link_expires_at,
                                     failure_reason, metadata, created_by)
                VALUES(?, 'STRIPE', 'CREATED', ?, ?, ?, NULL, ?, ?, ?, ?, ?)`)
      .run(
        order.id, payment.amount, payment.currency, payment.checkoutUrl || null,
        payment.checkoutId || null, payment.expiresAtIso, null,
        JSON.stringify({ source: 'admin_send_payment_link', extraMsg: extraMsg || null }),
        req.user.id
      );
    await db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('APPROVED_AWAITING_PAYMENT', order.id);
    await addOrderHistory(order.id, 'APPROVED_AWAITING_PAYMENT', 'Betaallink verstuurd naar klant', req.user.id);

    await logAuditFromReq(req, {
      action: 'PAYMENT_LINK_SENT',
      entityType: 'order',
      entityId: order.id,
      summary: `Betaallink verstuurd voor order #${formatOrderId(order.id)}`,
      details: { orderId: order.id, checkoutId: payment.checkoutId || null, expiresAt: payment.expiresAtIso || null }
    });

    let mailResult = { skipped: 'no_recipient' };
    if (order.customer_email) {
      mailResult = await sendPaymentLinkEmailWithInvoice(order, payment, {
        config,
        extraMessage: extraMsg || null,
        subject,
        includeInvoice,
        actorUserId: req.user?.id || null,
        actorEmail: req.user?.email || null
      });
      if (!mailResult?.ok) {
        const reasonMap = {
          smtp_not_configured: 'SMTP is niet geconfigureerd',
          missing_template: 'E-mail template ontbreekt',
          no_recipient: 'Geen ontvanger ingesteld'
        };
        const reason = reasonMap[String(mailResult?.skipped || '').toLowerCase()] || 'E-mail kon niet verzonden worden';
        return res.status(500).json({ error: `Betaallink aangemaakt, maar e-mail verzenden mislukte: ${reason}` });
      }
    }

    res.json({
      ok: true,
      status: 'APPROVED_AWAITING_PAYMENT',
      mail: mailResult,
      payment: {
        provider: 'STRIPE',
        checkoutUrl: payment.checkoutUrl,
        checkoutId: payment.checkoutId,
        expiresAt: payment.expiresAtIso,
        amount: payment.amount,
        currency: payment.currency
      }
    });
  } catch (err) {
    console.error('Send-payment-link error:', err);
    res.status(500).json({ error: err.message || 'Betaallink versturen mislukt' });
  }
});

// Send invoice PDF by email (standalone, not tied to payment link)
app.post('/api/admin/orders/:id/send-invoice', requireAuth, requireRole('ADMIN', 'OWNER'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!order) return res.status(404).json({ error: 'Order niet gevonden' });
    if (isOrderArchived(order)) return res.status(400).json({ error: 'Order is gearchiveerd. Zet eerst terug.' });
    if (!order.customer_email) return res.status(400).json({ error: 'Klant heeft geen e-mailadres' });

    const config = await getConfig();
    // Ensure invoice is finalized
    let invoice = await ensureInvoiceForOrder(order.id, config);
    if (!invoice) invoice = await getInvoiceByOrderId(order.id);
    if (!invoice || invoice.status === 'CONCEPT') {
      invoice = await finalizeInvoiceForOrder(order.id, config);
      if (!invoice) invoice = await getInvoiceByOrderId(order.id);
    }

    const attachment = await buildInvoiceAttachmentForOrder(order.id);
    const invoiceNo = invoice?.invoice_number || buildInvoiceNumber(order, config, new Date());
    const customerName = `${order.customer_first || ''} ${order.customer_last || ''}`.trim() || order.customer_email;

    const trackingToken = createEmailTrackingToken(order.id, 'invoice', order.customer_email);
    const extraMessage = String(req.body?.extraMessage || '').trim().slice(0, 600);
    const subject = String(req.body?.subject || '').trim().slice(0, 180);
    const info = await sendTemplatedEmail('invoiceSent', order.customer_email, {
      orderId: formatOrderId(order.id),
      customerName,
      orderTotal: fmtEUR(order.total),
      invoiceNumber: invoiceNo,
      invoiceDueDate: fmtDateBE(invoice?.due_date) || '',
      invoiceStatusLabel: invoiceStatusLabel(invoice?.status || 'DEFINITIVE'),
      extraMessage
    }, {
      ...(attachment ? { attachments: [attachment] } : {}),
      trackingToken,
      subject: subject || undefined
    });

    if (info?.skipped) {
      // Fall back: send plain email via nodemailer directly
      const transporter = await getMailerTransport();
      if (!transporter) return res.status(500).json({ error: 'SMTP niet geconfigureerd' });
      const data = await collectOrderDocumentData(id);
      const pdf = data ? await generateInvoicePdfBuffer(data, config) : null;
      const brandName = config.brand?.name || 'Uw leverancier';
      const bodyHtml = `<p>Beste ${htmlEscape(customerName)},</p><p>Hierbij vindt u de factuur <strong>${htmlEscape(invoiceNo)}</strong> voor uw bestelling #${formatOrderId(order.id)} in bijlage.</p>`;
      const fallbackSubject = subject || `Factuur ${invoiceNo}`;
      const emailHtml = `${buildBrandedEmailHtml(bodyHtml, fallbackSubject, config)}<img src="${APP_BASE_URL}/api/track/open/${encodeURIComponent(trackingToken)}.gif" width="1" height="1" style="display:none" alt="">`;
      const fromName = config?.email?.fromName || config?.brand?.name || brandName;
      const fromAddress = config?.email?.fromAddress || config?.smtp?.fromAddress || process.env.SMTP_FROM || process.env.SMTP_USER || '';
      await transporter.sendMail({
        from: `"${fromName.replace(/"/g, '')}" <${fromAddress}>`,
        to: order.customer_email,
        subject: subject || `Uw factuur ${invoiceNo} — ${brandName}`,
        html: emailHtml,
        attachments: pdf ? [{ filename: safeFilename(`factuur-${invoiceNo}.pdf`), content: pdf, contentType: 'application/pdf' }] : []
      });
    }

    await addOrderHistory(order.id, order.status, 'Factuur per e-mail verstuurd', req.user.id);
    await logAuditFromReq(req, {
      action: 'INVOICE_SENT',
      entityType: 'order',
      entityId: order.id,
      summary: `Factuur ${invoiceNo} per e-mail verstuurd naar ${order.customer_email}`
    });

    res.json({ ok: true, sentTo: order.customer_email, invoiceNumber: invoiceNo });
  } catch (err) {
    console.error('Send-invoice error:', err);
    res.status(500).json({ error: err.message || 'Factuur versturen mislukt' });
  }
});

app.post('/api/admin/orders/:id/create-deposit-invoice', requireAuth, requireRole('ADMIN', 'OWNER'), async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) return res.status(404).json({ error: 'Order niet gevonden' });
    if (isOrderArchived(order)) return res.status(400).json({ error: 'Order is gearchiveerd. Zet eerst terug.' });
    if (String(order.status || '').toUpperCase() === 'CANCELLED') {
      return res.status(400).json({ error: 'Voorschotfactuur kan niet voor geannuleerde bestelling' });
    }

    const cfg = await getConfig();
    let finalInvoice = await ensureInvoiceForOrder(orderId, cfg);
    if (!finalInvoice) finalInvoice = await getInvoiceByOrderId(orderId);
    const total = Math.max(0, Number(order.total) || 0);
    const pctRaw = Number(req.body?.depositPercentage);
    const amountRaw = Number(req.body?.depositAmount);

    let depositPercentage = null;
    let depositAmount = 0;
    if (Number.isFinite(amountRaw) && amountRaw > 0) {
      depositAmount = Math.min(total, amountRaw);
    } else if (Number.isFinite(pctRaw) && pctRaw > 0) {
      depositPercentage = Math.min(100, Math.max(0.1, pctRaw));
      depositAmount = total * (depositPercentage / 100);
    } else {
      return res.status(400).json({ error: 'Geef een geldig voorschotpercentage of bedrag op' });
    }
    depositAmount = roundMoney(Math.max(0, depositAmount));
    if (depositAmount <= 0) return res.status(400).json({ error: 'Voorschotbedrag moet groter zijn dan 0' });

    const now = new Date();
    const dueIso = computeInvoiceDueDateIso(now, cfg?.documents?.invoice?.paymentTermsDays);
    const result = await db.prepare(`
      INSERT INTO deposit_invoices(order_id, linked_final_invoice_id, status, deposit_percentage, deposit_amount, issue_date, due_date, created_by, metadata)
      VALUES(?, ?, 'DEFINITIVE', ?, ?, ?, ?, ?, ?)
    `).run(
      orderId,
      finalInvoice?.id || null,
      depositPercentage,
      depositAmount,
      now.toISOString(),
      dueIso,
      req.user.id,
      JSON.stringify({ source: 'admin_create_deposit_invoice' })
    );

    const depositId = Number(result.lastInsertRowid);
    const invoiceNumber = buildDepositInvoiceNumber(depositId, now);
    await db.prepare('UPDATE deposit_invoices SET invoice_number = ? WHERE id = ?').run(invoiceNumber, depositId);
    const created = await db.prepare('SELECT * FROM deposit_invoices WHERE id = ?').get(depositId);

    await logAuditFromReq(req, {
      action: 'DEPOSIT_INVOICE_CREATED',
      entityType: 'order',
      entityId: orderId,
      summary: `Voorschotfactuur ${invoiceNumber} aangemaakt voor order #${formatOrderId(orderId)}`,
      details: { orderId, depositInvoiceId: depositId, depositPercentage, depositAmount }
    });

    res.json({
      ok: true,
      depositInvoice: {
        id: created.id,
        orderId: created.order_id,
        invoiceNumber: created.invoice_number,
        depositPercentage: created.deposit_percentage,
        depositAmount: created.deposit_amount,
        issueDate: created.issue_date,
        dueDate: created.due_date,
        status: created.status
      }
    });
  } catch (err) {
    console.error('Create-deposit-invoice error:', err);
    res.status(500).json({ error: err.message || 'Voorschotfactuur aanmaken mislukt' });
  }
});

app.get('/api/admin/orders/:id/deposit-invoice.pdf', requireAuth, requireRole('ADMIN', 'OWNER'), async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) return res.status(404).json({ error: 'Order niet gevonden' });
    if (isOrderArchived(order)) return res.status(400).json({ error: 'Order is gearchiveerd. Zet eerst terug.' });
    const depositInvoice = await getLatestDepositInvoiceByOrderId(orderId);
    if (!depositInvoice) return res.status(404).json({ error: 'Geen voorschotfactuur gevonden' });
    const finalInvoice = await ensureInvoiceForOrder(orderId, await getConfig()) || await getInvoiceByOrderId(orderId);
    const pdf = await generateDepositInvoicePdfBuffer({ order, depositInvoice, finalInvoice }, await getConfig());
    const fileNo = depositInvoice.invoice_number || buildDepositInvoiceNumber(depositInvoice.id || 0);
    const name = safeFilename(`voorschotfactuur-${fileNo}.pdf`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(pdf);
  } catch (err) {
    console.error('Deposit invoice PDF error:', err);
    res.status(500).json({ error: err.message || 'Voorschotfactuur PDF genereren mislukt' });
  }
});

app.post('/api/admin/orders/:id/send-deposit-invoice', requireAuth, requireRole('ADMIN', 'OWNER'), async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) return res.status(404).json({ error: 'Order niet gevonden' });
    if (isOrderArchived(order)) return res.status(400).json({ error: 'Order is gearchiveerd. Zet eerst terug.' });
    if (!order.customer_email) return res.status(400).json({ error: 'Klant heeft geen e-mailadres' });
    const cfg = await getConfig();
    const depositInvoice = await getLatestDepositInvoiceByOrderId(orderId);
    if (!depositInvoice) return res.status(404).json({ error: 'Geen voorschotfactuur gevonden' });
    let finalInvoice = await ensureInvoiceForOrder(orderId, cfg);
    if (!finalInvoice) finalInvoice = await getInvoiceByOrderId(orderId);
    const pdf = await generateDepositInvoicePdfBuffer({ order, depositInvoice, finalInvoice }, cfg);
    const customerName = `${order.customer_first || ''} ${order.customer_last || ''}`.trim() || order.customer_email;
    const trackingToken = createEmailTrackingToken(order.id, 'deposit_invoice', order.customer_email);

    const extraMessage = String(req.body?.extraMessage || '').trim().slice(0, 600);
    const subject = String(req.body?.subject || '').trim().slice(0, 180);
    let info = await sendTemplatedEmail('invoiceSent', order.customer_email, {
      orderId: formatOrderId(order.id),
      customerName,
      orderTotal: fmtEUR(order.total),
      invoiceNumber: depositInvoice.invoice_number || buildDepositInvoiceNumber(depositInvoice.id || 0),
      invoiceDueDate: fmtDateBE(depositInvoice.due_date) || '',
      invoiceStatusLabel: 'Voorschotfactuur',
      extraMessage
    }, {
      trackingToken,
      subject: subject || `Voorschotfactuur ${depositInvoice.invoice_number || ''}`.trim(),
      attachments: [{
        filename: safeFilename(`voorschotfactuur-${depositInvoice.invoice_number || depositInvoice.id}.pdf`),
        content: pdf,
        contentType: 'application/pdf'
      }]
    });

    if (info?.skipped === 'missing_template') {
      info = await sendTemplatedEmail('paymentLink', order.customer_email, {
        orderId: formatOrderId(order.id),
        customerName,
        orderTotal: fmtEUR(order.total),
        invoiceNumber: depositInvoice.invoice_number || buildDepositInvoiceNumber(depositInvoice.id || 0),
        invoiceDueDate: fmtDateBE(depositInvoice.due_date) || '',
        invoiceStatusLabel: 'Voorschotfactuur',
        extraMessage
      }, {
        trackingToken,
        subject: subject || `Voorschotfactuur ${depositInvoice.invoice_number || ''}`.trim(),
        attachments: [{
          filename: safeFilename(`voorschotfactuur-${depositInvoice.invoice_number || depositInvoice.id}.pdf`),
          content: pdf,
          contentType: 'application/pdf'
        }]
      });
    }

    if (!info?.ok) {
      const reasonMap = {
        smtp_not_configured: 'SMTP is niet geconfigureerd',
        missing_template: 'E-mail template ontbreekt',
        no_recipient: 'Geen ontvanger ingesteld'
      };
      const reason = reasonMap[String(info?.skipped || '').toLowerCase()] || 'E-mail kon niet verzonden worden';
      return res.status(500).json({ error: `Voorschotsfactuur kon niet gemaild worden: ${reason}` });
    }

    if (info?.ok) {
      await db.prepare('UPDATE deposit_invoices SET sent_at = COALESCE(sent_at, ?) WHERE id = ?')
        .run(new Date().toISOString(), depositInvoice.id);
      await addOrderHistory(order.id, order.status, 'Voorschotfactuur per e-mail verstuurd', req.user.id);
    }

    await logAuditFromReq(req, {
      action: 'DEPOSIT_INVOICE_SENT',
      entityType: 'order',
      entityId: order.id,
      summary: `Voorschotfactuur verstuurd voor order #${formatOrderId(order.id)}`,
      details: { orderId: order.id, depositInvoiceId: depositInvoice.id, sentTo: order.customer_email }
    });

    res.json({ ok: true, sentTo: order.customer_email, invoiceNumber: depositInvoice.invoice_number || null });
  } catch (err) {
    console.error('Send-deposit-invoice error:', err);
    res.status(500).json({ error: err.message || 'Voorschotfactuur versturen mislukt' });
  }
});

app.get('/api/admin/orders/:id/offer.pdf', requireAuth, requireRole('ADMIN', 'OWNER'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const data = await collectOrderDocumentData(id);
    if (!data) return res.status(404).json({ error: 'Order niet gevonden' });
    const pdf = await generateOfferPdfBuffer(data, await getConfig());
    const name = safeFilename(`offerte-${formatOrderId(id)}.pdf`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(pdf);
  } catch (err) {
    console.error('Offer pdf generation failed:', err);
    res.status(500).json({ error: 'Offerte PDF genereren mislukt' });
  }
});

app.post('/api/admin/orders/:id/send-offer', requireAuth, requireRole('ADMIN', 'OWNER'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!order) return res.status(404).json({ error: 'Order niet gevonden' });
    if (isOrderArchived(order)) return res.status(400).json({ error: 'Order is gearchiveerd. Zet eerst terug.' });
    if (!order.customer_email) return res.status(400).json({ error: 'Klant heeft geen e-mailadres' });

    const cfg = await getConfig();
    const data = await collectOrderDocumentData(id);
    if (!data) return res.status(404).json({ error: 'Orderdata ontbreekt' });
    const pdf = await generateOfferPdfBuffer(data, cfg);
    const customerName = `${order.customer_first || ''} ${order.customer_last || ''}`.trim() || order.customer_email;
    const trackingToken = createEmailTrackingToken(order.id, 'offer', order.customer_email);
    const extraMessage = String(req.body?.extraMessage || '').trim().slice(0, 600);
    const subject = String(req.body?.subject || '').trim().slice(0, 180);
    let info = await sendTemplatedEmail('offerSent', order.customer_email, {
      orderId: formatOrderId(order.id),
      customerName,
      orderTotal: fmtEUR(order.total),
      orderStatusLabel: statusLabel(order.status),
      extraMessage
    }, {
      trackingToken,
      subject: subject || undefined,
      attachments: [{
        filename: safeFilename(`offerte-${formatOrderId(order.id)}.pdf`),
        content: pdf,
        contentType: 'application/pdf'
      }]
    });
    if (info?.skipped === 'missing_template') {
      info = await sendTemplatedEmail('paymentLink', order.customer_email, {
        orderId: formatOrderId(order.id),
        customerName,
        orderTotal: fmtEUR(order.total),
        orderStatusLabel: statusLabel(order.status),
        extraMessage
      }, {
        trackingToken,
        subject: subject || `Offerte voor order #${formatOrderId(order.id)}`,
        attachments: [{
          filename: safeFilename(`offerte-${formatOrderId(order.id)}.pdf`),
          content: pdf,
          contentType: 'application/pdf'
        }]
      });
    }

    if (!info?.ok) return res.status(500).json({ error: 'Offerte e-mail kon niet verzonden worden' });
    await addOrderHistory(order.id, order.status, 'Offerte per e-mail verstuurd', req.user.id);
    await logAuditFromReq(req, {
      action: 'OFFER_SENT',
      entityType: 'order',
      entityId: order.id,
      summary: `Offerte verstuurd voor order #${formatOrderId(order.id)}`,
      details: { sentTo: order.customer_email }
    });
    res.json({ ok: true, sentTo: order.customer_email });
  } catch (err) {
    console.error('Send-offer error:', err);
    res.status(500).json({ error: err.message || 'Offerte versturen mislukt' });
  }
});

app.get('/api/admin/orders/:id/invoice.pdf', requireAuth, requireRole('ADMIN', 'OWNER'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const data = await collectOrderDocumentData(id);
    if (!data) return res.status(404).json({ error: 'Order niet gevonden' });
    const cfg = await getConfig();
    const pdf = await generateInvoicePdfBuffer(data, cfg);
    const invoiceNo = data.invoice?.invoice_number || buildInvoiceNumber(data.order, cfg, new Date());
    const name = safeFilename(`factuur-${invoiceNo}.pdf`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(pdf);
  } catch (err) {
    console.error('Invoice pdf generation failed:', err);
    res.status(500).json({ error: 'Factuur PDF genereren mislukt' });
  }
});

app.get('/api/admin/orders/:id/packing-slip.pdf', requireAuth, requireRole('ADMIN', 'OWNER'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const data = await collectOrderDocumentData(id);
    if (!data) return res.status(404).json({ error: 'Order niet gevonden' });
    const pdf = await generatePackingSlipPdfBuffer(data, await getConfig());
    const name = safeFilename(`orderbon-${formatOrderId(id)}.pdf`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(pdf);
  } catch (err) {
    console.error('Packing slip pdf generation failed:', err);
    res.status(500).json({ error: 'Orderbon PDF genereren mislukt' });
  }
});

app.get('/api/admin/orders.csv', requireAuth, requireRole('ADMIN', 'OWNER'), async (_req, res) => {
  const archivedRaw = String(_req.query.archived || '').toUpperCase();
  const archived = archivedRaw === 'DELETED' ? 'DELETED' : archivedRaw === 'ALL' ? 'ALL' : 'ACTIVE';
  let where = '1=1';
  if (archived === 'ACTIVE') where += ' AND deleted_at IS NULL';
  if (archived === 'DELETED') where += ' AND deleted_at IS NOT NULL';
  const rows = await db.prepare(`SELECT id, status, customer_first, customer_last, customer_email,
                                  customer_company, customer_vat, address, postcode, city, phone, subtotal, total, notes, created_at,
                                  deleted_at, shipping_carrier, tracking_code, tracking_url, shipping_status, shipping_last_update_at
                           FROM orders WHERE ${where} ORDER BY id DESC`).all();
  const cols = ['id','status','customer_first','customer_last','customer_email',
                'customer_company','customer_vat','address','postcode','city','phone','subtotal','total','notes','created_at',
                'deleted_at','shipping_carrier','tracking_code','tracking_url','shipping_status','shipping_last_update_at'];
  const esc = v => {
    if (v == null) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };
  const csv = [cols.join(',')].concat(rows.map(r => cols.map(c => esc(r[c])).join(','))).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=nebulous-orders-${new Date().toISOString().slice(0,10)}.csv`);
  res.send(csv);
});

app.get('/api/admin/badges', requireAuth, requireRole('ADMIN', 'OWNER'), async (req, res) => {
  const newOrders = (await db.prepare("SELECT COUNT(*) AS c FROM orders WHERE status = 'NEW' AND deleted_at IS NULL").get()).c;
  let pending = 0;
  if (req.user.role === 'OWNER') pending = (await db.prepare("SELECT COUNT(*) AS c FROM users WHERE status = 'PENDING'").get()).c;
  res.json({ newOrders, pending });
});

// ── Owner: users ──────────────────────────────────────────────────────────
app.get('/api/admin/users', requireAuth, requireRole('OWNER'), async (req, res) => {
  const { q = '', tag = '', newsletter = '', status: statusFilter = '', role: roleFilter = '' } = req.query;
  let sql = `SELECT id, email, first_name, last_name, role, status, created_at, last_login_at,
                    email_verified, newsletter_opt_in, tags, company, phone
             FROM users WHERE 1=1`;
  const params = [];
  if (q) { sql += ` AND (email LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR company LIKE ?)`; const like = `%${q}%`; params.push(like, like, like, like); }
  if (statusFilter) { sql += ` AND status = ?`; params.push(statusFilter); }
  if (roleFilter) { sql += ` AND role = ?`; params.push(roleFilter); }
  if (newsletter === '1') { sql += ` AND newsletter_opt_in = 1`; }
  sql += ` ORDER BY id DESC LIMIT 500`;
  let rows = await db.prepare(sql).all(...params);
  if (tag) {
    rows = rows.filter(r => {
      try { const t = JSON.parse(r.tags || '[]'); return Array.isArray(t) && t.includes(tag); } catch { return false; }
    });
  }
  // Voeg ordercount toe per gebruiker
  const countStmt = await db.prepare('SELECT COUNT(*) as cnt FROM orders WHERE user_id = ?');
  rows = rows.map(r => ({ ...r, order_count: countStmt.get(r.id)?.cnt || 0 }));
  res.json({ users: rows });
});

app.get('/api/admin/users/:id(\\d+)', requireAuth, requireRole('OWNER'), async (req, res) => {
  const id = Number(req.params.id);
  const user = await db.prepare(`SELECT id, email, first_name, last_name, role, status, created_at, last_login_at,
                                   address, postcode, city, phone, email_verified, totp_enabled,
                                   newsletter_opt_in, internal_notes, tags, company, vat_number
                           FROM users WHERE id = ?`).get(id);
  if (!user) return res.status(404).json({ error: 'Gebruiker niet gevonden' });
  const orders = await db.prepare(`SELECT id, status, total, created_at FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 20`).all(id);
  res.json({ user, orders });
});

app.get('/api/admin/users/:id(\\d+)/orders', requireAuth, requireRole('OWNER', 'ADMIN'), async (req, res) => {
  const id = Number(req.params.id);
  const orders = await db.prepare(`SELECT id, status, total, subtotal, created_at, customer_first, customer_last FROM orders WHERE user_id = ? ORDER BY id DESC`).all(id);
  res.json({ orders });
});

const ALLOWED_ROLES = ['USER', 'ADMIN', 'OWNER'];
const ALLOWED_USER_STATUS = ['PENDING', 'ACTIVE', 'BLOCKED'];

app.put('/api/admin/users/:id(\\d+)', requireAuth, requireRole('OWNER'), async (req, res) => {
  const id = Number(req.params.id);
  const target = await db.prepare('SELECT id, role, email, first_name, last_name, status FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'User niet gevonden' });
  if (target.id === req.user.id && (req.body?.status || req.body?.role)) {
    return res.status(400).json({ error: 'Je kan je eigen rol/status niet wijzigen' });
  }
  const { role, status, newsletterOptIn, internalNotes, tags, company, vatNumber, resendVerification } = req.body || {};
  if (role !== undefined && !ALLOWED_ROLES.includes(role)) return res.status(400).json({ error: 'Ongeldige rol' });
  if (status !== undefined && !ALLOWED_USER_STATUS.includes(status)) return res.status(400).json({ error: 'Ongeldige status' });

  const roleChanged = role !== undefined && role !== target.role;
  const statusChanged = status !== undefined && status !== target.status;

  if (role !== undefined) await db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  if (status !== undefined) await db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, id);
  if (newsletterOptIn !== undefined) await db.prepare('UPDATE users SET newsletter_opt_in = ? WHERE id = ?').run(newsletterOptIn ? 1 : 0, id);
  if (internalNotes !== undefined) await db.prepare('UPDATE users SET internal_notes = ? WHERE id = ?').run(String(internalNotes || '').trim().slice(0, 2000), id);
  if (tags !== undefined) {
    const tagsArr = Array.isArray(tags) ? tags.map(t => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 20) : [];
    await db.prepare('UPDATE users SET tags = ? WHERE id = ?').run(JSON.stringify(tagsArr), id);
  }
  if (company !== undefined) await db.prepare('UPDATE users SET company = ? WHERE id = ?').run(String(company || '').trim().slice(0, 120), id);
  if (vatNumber !== undefined) await db.prepare('UPDATE users SET vat_number = ? WHERE id = ?').run(String(vatNumber || '').trim().slice(0, 40), id);

  if (roleChanged || statusChanged) {
    const pieces = [];
    if (roleChanged) pieces.push(`rol ${target.role} -> ${role}`);
    if (statusChanged) pieces.push(`status ${target.status} -> ${status}`);
    await logAuditFromReq(req, {
      action: 'USER_UPDATED', entityType: 'user', entityId: id,
      summary: `Gebruiker ${target.email} gewijzigd (${pieces.join(', ')})`,
      details: {
        userId: id, email: target.email,
        role: roleChanged ? { before: target.role, after: role } : null,
        status: statusChanged ? { before: target.status, after: status } : null
      }
    });
  }
  if (status === 'ACTIVE' && target.status !== 'ACTIVE' && target.email) {
    sendTemplatedEmailSafe('accountApproved', target.email, {
      customerName: `${target.first_name || ''} ${target.last_name || ''}`.trim()
    });
  }
  if (resendVerification) {
    const token = crypto.randomBytes(32).toString('hex');
    const tokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await db.prepare('UPDATE users SET email_verification_token = ?, email_verification_token_expires_at = ? WHERE id = ?')
      .run(token, tokenExpiry, id);
    const verificationUrl = `${await getAppBaseUrl()}/api/auth/verify-email?token=${token}`;
    sendTemplatedEmailSafe('emailVerification', target.email, { verificationUrl, customerName: `${target.first_name || ''} ${target.last_name || ''}`.trim() });
  }
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id(\\d+)', requireAuth, requireRole('OWNER'), async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Je kan jezelf niet verwijderen' });
  const target = await db.prepare('SELECT id, email, role, status FROM users WHERE id = ?').get(id);
  await db.prepare('DELETE FROM users WHERE id = ?').run(id);
  if (target) {
    await logAuditFromReq(req, {
      action: 'USER_DELETED',
      entityType: 'user',
      entityId: id,
      summary: `Gebruiker verwijderd: ${target.email}`,
      details: target
    });
  }
  res.json({ ok: true });
});

// ── Owner: settings ───────────────────────────────────────────────────────
app.put('/api/admin/config', requireAuth, requireRole('OWNER'), async (req, res) => {
  const cfg = req.body || {};
  const before = await getConfig();
  const cleanText = (v, max = 180) => String(v == null ? '' : v).trim().slice(0, max);
  if (cfg.colors && !Array.isArray(cfg.colors)) return res.status(400).json({ error: 'colors moet een lijst zijn' });
  if (cfg.sizes && !Array.isArray(cfg.sizes)) return res.status(400).json({ error: 'sizes moet een lijst zijn' });
  if (cfg.products && !Array.isArray(cfg.products)) return res.status(400).json({ error: 'products moet een lijst zijn' });
  if (cfg.company != null && (typeof cfg.company !== 'object' || Array.isArray(cfg.company))) {
    return res.status(400).json({ error: 'company moet een object zijn' });
  }
  if (cfg.company) {
    const base = { ...(before?.company || {}) };
    const nextCompany = { ...base, ...cfg.company };
    nextCompany.legalName = cleanText(nextCompany.legalName || before?.brand?.name || 'Bedrijf', 120);
    nextCompany.invoicePrefix = cleanText(nextCompany.invoicePrefix || 'INV', 12).toUpperCase().replace(/[^A-Z0-9-]/g, '') || 'INV';
    nextCompany.vatNumber = cleanText(nextCompany.vatNumber || '', 40);
    nextCompany.address = cleanText(nextCompany.address || '', 160);
    nextCompany.postcode = cleanText(nextCompany.postcode || '', 20);
    nextCompany.city = cleanText(nextCompany.city || '', 80);
    nextCompany.country = cleanText(nextCompany.country || 'BE', 50);
    nextCompany.supportEmail = cleanText(nextCompany.supportEmail || '', 120);
    nextCompany.supportPhone = cleanText(nextCompany.supportPhone || '', 40);
    cfg.company = nextCompany;
  }
  if (cfg.documents != null && (typeof cfg.documents !== 'object' || Array.isArray(cfg.documents))) {
    return res.status(400).json({ error: 'documents moet een object zijn' });
  }
  if (cfg.documents) {
    const base = before?.documents || {};
    const nextDocs = {
      invoice: { ...(base.invoice || {}), ...((cfg.documents && cfg.documents.invoice) || {}) },
      packingSlip: { ...(base.packingSlip || {}), ...((cfg.documents && cfg.documents.packingSlip) || {}) }
    };
    nextDocs.invoice.title = cleanText(nextDocs.invoice.title || 'Factuur', 70);
    nextDocs.invoice.intro = cleanText(nextDocs.invoice.intro || '', 500);
    nextDocs.invoice.footer = cleanText(nextDocs.invoice.footer || '', 500);
    nextDocs.invoice.legalDisclaimer = cleanText(nextDocs.invoice.legalDisclaimer || '', 700);
    nextDocs.invoice.paymentTermsDays = Math.min(90, Math.max(0, Number(nextDocs.invoice.paymentTermsDays) || 0));
    const yearMode = String(nextDocs.invoice.numberYearMode || 'ORDER_YEAR').toUpperCase();
    nextDocs.invoice.numberYearMode = yearMode === 'ISSUE_YEAR' ? 'ISSUE_YEAR' : 'ORDER_YEAR';
    nextDocs.invoice.numberPadLength = Math.min(10, Math.max(4, Number(nextDocs.invoice.numberPadLength) || 6));
    nextDocs.invoice.reminderEnabled = nextDocs.invoice.reminderEnabled !== false;
    nextDocs.invoice.reminderIntervalHours = Math.min(240, Math.max(1, Number(nextDocs.invoice.reminderIntervalHours) || 24));
    nextDocs.invoice.reminderMaxCount = Math.min(20, Math.max(1, Number(nextDocs.invoice.reminderMaxCount) || 5));
    nextDocs.invoice.showSupportContacts = nextDocs.invoice.showSupportContacts !== false;

    nextDocs.packingSlip.title = cleanText(nextDocs.packingSlip.title || 'Orderbon', 70);
    nextDocs.packingSlip.intro = cleanText(nextDocs.packingSlip.intro || '', 500);
    nextDocs.packingSlip.footer = cleanText(nextDocs.packingSlip.footer || '', 500);
    nextDocs.packingSlip.showFilePaths = nextDocs.packingSlip.showFilePaths !== false;
    cfg.documents = nextDocs;
  }
  if (cfg.conversion != null && (typeof cfg.conversion !== 'object' || Array.isArray(cfg.conversion))) {
    return res.status(400).json({ error: 'conversion moet een object zijn' });
  }
  if (cfg.conversion) {
    const base = { ...(before?.conversion || {}) };
    const nextConversion = { ...base, ...cfg.conversion };
    const variantRaw = String(nextConversion.ctaVariant || 'SOFT').toUpperCase();
    nextConversion.ctaVariant = variantRaw === 'STRONG' ? 'STRONG' : 'SOFT';
    nextConversion.designerStep2Cta = cleanText(nextConversion.designerStep2Cta || 'Naar overzicht', 70);
    nextConversion.designerStep3CtaSoft = cleanText(nextConversion.designerStep3CtaSoft || 'Toevoegen naar winkelmand', 90);
    nextConversion.designerStep3CtaStrong = cleanText(nextConversion.designerStep3CtaStrong || 'Toevoegen naar winkelmand', 90);
    nextConversion.cartCtaSoft = cleanText(nextConversion.cartCtaSoft || 'Bestelling plaatsen (nog niet betalen)', 110);
    nextConversion.cartCtaStrong = cleanText(nextConversion.cartCtaStrong || 'Bestelling plaatsen', 110);
    nextConversion.urgencyEnabled = !!nextConversion.urgencyEnabled;
    nextConversion.urgencyText = cleanText(nextConversion.urgencyText || 'Beperkte productiecapaciteit deze week.', 160);
    nextConversion.socialProofEnabled = !!nextConversion.socialProofEnabled;
    nextConversion.socialProofText = cleanText(nextConversion.socialProofText || 'Gemiddelde goedkeuring op werkdagen: binnen 2 uur.', 180);
    nextConversion.checkoutNote = cleanText(nextConversion.checkoutNote || 'Na goedkeuring ontvang je je beveiligde betaallink per e-mail.', 220);
    cfg.conversion = nextConversion;
  }
  if (cfg.theme != null && (typeof cfg.theme !== 'object' || Array.isArray(cfg.theme))) {
    return res.status(400).json({ error: 'theme moet een object zijn' });
  }
  if (cfg.theme) {
    const nextTheme = { ...cfg.theme };
    const hex6 = /^#[0-9a-fA-F]{6}$/;
    const normalizeThemeColor = (raw, fallback) => {
      const v = String(raw || '').trim();
      return hex6.test(v) ? v.toLowerCase() : fallback;
    };
    if (nextTheme.accentColor != null) {
      const v = String(nextTheme.accentColor || '').trim();
      nextTheme.accentColor = hex6.test(v) ? v.toLowerCase() : '#ffffff';
    }
    if (nextTheme.accentColor2 != null) {
      const v = String(nextTheme.accentColor2 || '').trim();
      nextTheme.accentColor2 = hex6.test(v) ? v.toLowerCase() : '#bdbdbd';
    }
    if (nextTheme.logoMark != null) {
      nextTheme.logoMark = String(nextTheme.logoMark || '✦').trim().slice(0, 2) || '✦';
    }
    if (nextTheme.logoPath != null) {
      nextTheme.logoPath = normalizePublicAssetPath(nextTheme.logoPath);
    }
    if (nextTheme.faviconPath != null) {
      nextTheme.faviconPath = normalizePublicAssetPath(nextTheme.faviconPath);
    }
    const allowedHeading = new Set(['POPPINS', 'SPACE_GROTESK', 'INTER', 'SYSTEM', 'SERIF']);
    const allowedBody = new Set(['POPPINS', 'INTER', 'SPACE_GROTESK', 'SYSTEM', 'SERIF']);
    const allowedBtn = new Set(['ROUNDED', 'PILL', 'SHARP']);
    const allowedSection = new Set(['MUTED', 'FLAT', 'BOLD']);
    const allowedPresets = new Set(['CUSTOM', 'GREEN', 'BLUE', 'NEUTRAL']);
    if (nextTheme.headingFont != null) {
      const v = String(nextTheme.headingFont || '').toUpperCase();
      nextTheme.headingFont = allowedHeading.has(v) ? v : 'POPPINS';
    }
    if (nextTheme.bodyFont != null) {
      const v = String(nextTheme.bodyFont || '').toUpperCase();
      nextTheme.bodyFont = allowedBody.has(v) ? v : 'POPPINS';
    }
    if (nextTheme.buttonStyle != null) {
      const v = String(nextTheme.buttonStyle || '').toUpperCase();
      nextTheme.buttonStyle = allowedBtn.has(v) ? v : 'ROUNDED';
    }
    if (nextTheme.sectionTone != null) {
      const v = String(nextTheme.sectionTone || '').toUpperCase();
      nextTheme.sectionTone = allowedSection.has(v) ? v : 'MUTED';
    }
    if (nextTheme.themePreset != null) {
      const v = String(nextTheme.themePreset || '').toUpperCase();
      nextTheme.themePreset = allowedPresets.has(v) ? v : 'CUSTOM';
    }
    nextTheme.invoiceOpenBg = normalizeThemeColor(nextTheme.invoiceOpenBg, '#1d4ed8');
    nextTheme.invoiceOpenText = normalizeThemeColor(nextTheme.invoiceOpenText, '#eff6ff');
    nextTheme.invoiceDueBg = normalizeThemeColor(nextTheme.invoiceDueBg, '#f59e0b');
    nextTheme.invoiceDueText = normalizeThemeColor(nextTheme.invoiceDueText, '#111827');
    cfg.theme = nextTheme;
  }
  if (Array.isArray(cfg.sizes)) cfg.sizes = sortSizes(cfg.sizes);
  if (cfg.smtp != null && typeof cfg.smtp === 'object' && !Array.isArray(cfg.smtp)) {
    const base = before?.smtp || {};
    cfg.smtp = {
      host: cleanText(cfg.smtp.host != null ? cfg.smtp.host : (base.host || ''), 120),
      port: Math.min(65535, Math.max(1, Number(cfg.smtp.port != null ? cfg.smtp.port : (base.port || 587)) || 587)),
      user: cleanText(cfg.smtp.user != null ? cfg.smtp.user : (base.user || ''), 120),
      pass: cleanText(cfg.smtp.pass != null ? cfg.smtp.pass : (base.pass || ''), 200),
      secure: !!(cfg.smtp.secure != null ? cfg.smtp.secure : base.secure),
      fromName: cleanText(cfg.smtp.fromName != null ? cfg.smtp.fromName : (base.fromName || ''), 80),
      fromAddress: cleanText(cfg.smtp.fromAddress != null ? cfg.smtp.fromAddress : (base.fromAddress || ''), 120)
    };
    mailerCache = { key: null, transporter: null };
  }
  if (cfg.hero != null && typeof cfg.hero === 'object') {
    const rawVideoUrl = String(cfg.hero.videoUrl || '').trim();
    const plainMatch = rawVideoUrl.match(/^[A-Za-z0-9_-]{8,20}$/);
    const vidMatch = plainMatch || rawVideoUrl.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{8,20})/);
    cfg.hero.videoUrl = vidMatch ? String(vidMatch[1] || vidMatch[0]).slice(0, 20) : '';
    const overlayColorRaw = String(cfg.hero.videoOverlayColor != null ? cfg.hero.videoOverlayColor : (before?.hero?.videoOverlayColor || '#000000')).trim();
    cfg.hero.videoOverlayColor = /^#[0-9a-fA-F]{6}$/.test(overlayColorRaw) ? overlayColorRaw.toLowerCase() : '#000000';
    const overlayRaw = Number(cfg.hero.videoOverlayOpacity);
    cfg.hero.videoOverlayOpacity = Number.isFinite(overlayRaw)
      ? Math.max(0, Math.min(0.9, overlayRaw))
      : Math.max(0, Math.min(0.9, Number(before?.hero?.videoOverlayOpacity ?? 0.55)));
    const blurRaw = Number(cfg.hero.videoBlurPx);
    cfg.hero.videoBlurPx = Number.isFinite(blurRaw)
      ? Math.max(0, Math.min(8, Math.round(blurRaw)))
      : Math.max(0, Math.min(8, Math.round(Number(before?.hero?.videoBlurPx ?? 0))));
  }
  if (cfg.seo != null && (typeof cfg.seo !== 'object' || Array.isArray(cfg.seo))) {
    return res.status(400).json({ error: 'seo moet een object zijn' });
  }
  if (cfg.seo) {
    const baseSeo = before?.seo || {};
    const nextSeo = { ...baseSeo, ...cfg.seo };
    nextSeo.metaDescription = cleanText(nextSeo.metaDescription || '', 320);
    nextSeo.ogTitle = cleanText(nextSeo.ogTitle || '', 120);
    nextSeo.ogDescription = cleanText(nextSeo.ogDescription || '', 320);
    const ogRaw = String(nextSeo.ogImagePath || '').trim();
    nextSeo.ogImagePath = /^https?:\/\//i.test(ogRaw) ? ogRaw.replace(/\s+/g, '') : normalizePublicAssetPath(ogRaw);
    if (!nextSeo.ogImagePath) nextSeo.ogImagePath = 'assets/tshirt_mockup.png';
    cfg.seo = nextSeo;
  }
  const next = { ...before, ...cfg };
  await setSetting('config', next);
  const saved = await getConfig();
  const audit = buildConfigAuditChangeSet(before, saved);
  await logAuditFromReq(req, {
    action: 'CONFIG_UPDATED',
    entityType: 'config',
    entityId: 'main',
    summary: audit.summary,
    details: {
      changedCount: audit.changedCount,
      changes: audit.changes,
      updatedTopLevelKeys: Object.keys(cfg || {})
    }
  });
  res.json({ ok: true, config: saved });
});

app.post('/api/admin/branding/upload', requireAuth, requireRole('OWNER'), brandingUpload.single('asset'), async (req, res) => {
  const kindRaw = String(req.body?.kind || '').trim().toLowerCase();
  const kind = kindRaw === 'favicon' ? 'favicon' : kindRaw === 'logo' ? 'logo' : '';
  if (!kind) return res.status(400).json({ error: 'Upload type ongeldig (logo of favicon)' });
  if (!req.file?.buffer) return res.status(400).json({ error: 'Geen bestand ontvangen' });

  try {
    const fileSuffix = crypto.randomBytes(4).toString('hex');
    const outName = `${kind}-${Date.now()}-${fileSuffix}.png`;
    const relPath = `assets/branding/${outName}`;

    let pipeline = sharp(req.file.buffer, { failOn: 'none' }).rotate();
    if (kind === 'logo') {
      pipeline = pipeline.resize({ width: 1400, height: 400, fit: 'inside', withoutEnlargement: true });
    } else {
      pipeline = pipeline.resize({
        width: 256,
        height: 256,
        fit: 'contain',
        withoutEnlargement: false,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      });
    }

    const optimized = await pipeline.png({ compressionLevel: 9, quality: 90 }).toBuffer();
    await writeStoredUpload(relPath, optimized, 'image/png');

    await logAuditFromReq(req, {
      action: 'CONFIG_UPDATED',
      entityType: 'config',
      entityId: 'main',
      summary: `Branding asset geüpload (${kind})`,
      details: {
        kind,
        path: relPath,
        originalName: req.file.originalname || null,
        mime: req.file.mimetype || null,
        sizeBytes: optimized.length
      }
    });

    res.json({ ok: true, kind, path: relPath, sizeBytes: optimized.length });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Branding upload mislukt' });
  }
});

app.post('/api/admin/products/mockup', requireAuth, requireRole('OWNER', 'ADMIN'), productMockupUpload.single('mockup'), async (req, res) => {
  if (!req.file?.buffer) return res.status(400).json({ error: 'Geen bestand ontvangen' });
  try {
    const fileSuffix = crypto.randomBytes(4).toString('hex');
    const outName = `mockup-${Date.now()}-${fileSuffix}.png`;
    const relPath = `assets/products/${outName}`;
    const optimized = await sharp(req.file.buffer, { failOn: 'none' })
      .rotate()
      .resize({
        width: 1200,
        height: 1200,
        fit: 'inside',
        withoutEnlargement: true
      })
      .png({ compressionLevel: 9, quality: 90 })
      .toBuffer();
    await writeStoredUpload(relPath, optimized, 'image/png');

    await logAuditFromReq(req, {
      action: 'CONFIG_UPDATED',
      entityType: 'config',
      entityId: 'main',
      summary: 'Product mockup geüpload',
      details: {
        path: relPath,
        originalName: req.file.originalname || null,
        mime: req.file.mimetype || null,
        sizeBytes: optimized.length
      }
    });

    res.json({ ok: true, path: relPath, sizeBytes: optimized.length });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Mockup upload mislukt' });
  }
});

// ── Notifications (live aggregation) ────────────────────────────────────────
app.get('/api/admin/notifications', requireAuth, requireRole('ADMIN', 'OWNER'), async (req, res) => {
  try {
    const overdueInvoices = await db.prepare(`
      SELECT i.id, i.invoice_number, i.due_date, o.id AS order_id, o.total,
             o.customer_first, o.customer_last, o.customer_email
      FROM invoices i JOIN orders o ON o.id = i.order_id
      WHERE i.status = 'DEFINITIVE' AND i.paid_at IS NULL
      AND i.due_date IS NOT NULL AND datetime(i.due_date) <= datetime('now')
      AND o.status != 'CANCELLED' AND o.deleted_at IS NULL
      ORDER BY i.due_date ASC LIMIT 50
    `).all();

    const newOrders = await db.prepare(`
      SELECT id, customer_first, customer_last, total, created_at
      FROM orders WHERE status = 'NEW' AND deleted_at IS NULL ORDER BY id DESC LIMIT 20
    `).all();

    const awaitingPaymentLink = await db.prepare(`
      SELECT id, customer_first, customer_last, total, created_at
      FROM orders WHERE status = 'APPROVED' AND deleted_at IS NULL ORDER BY id DESC LIMIT 20
    `).all();

    const recentPayments = await db.prepare(`
      SELECT o.id AS order_id, o.customer_first, o.customer_last, o.total,
             p.paid_at, p.amount
      FROM payments p JOIN orders o ON o.id = p.order_id
      WHERE p.status = 'PAID' AND p.paid_at >= datetime('now', '-7 days')
      AND o.deleted_at IS NULL
      ORDER BY p.paid_at DESC LIMIT 20
    `).all();

    const pendingAccounts = await db.prepare(`
      SELECT id, email, first_name, last_name, created_at
      FROM users WHERE status = 'PENDING' ORDER BY id DESC LIMIT 10
    `).all();

    const todoSignals = [];
    const unsentInvoicesCount = await db.prepare(`
      SELECT COUNT(*) AS n
      FROM invoices
      WHERE status = 'DEFINITIVE'
        AND sent_at IS NULL
        AND paid_at IS NULL
        AND order_id IN (SELECT id FROM orders WHERE deleted_at IS NULL)
    `).get()?.n || 0;
    if (unsentInvoicesCount > 0) {
      todoSignals.push({
        type: 'unsent_invoices',
        level: 'warn',
        title: 'Facturen nog niet verzonden',
        detail: `${unsentInvoicesCount} definitieve facturen zijn nog niet verstuurd.`,
        count: unsentInvoicesCount
      });
    }

    const awaitingProdCount = await db.prepare(`
      SELECT COUNT(*) AS n
      FROM orders
      WHERE status = 'PAID' AND deleted_at IS NULL
    `).get()?.n || 0;
    if (awaitingProdCount > 0) {
      todoSignals.push({
        type: 'awaiting_production',
        level: 'info',
        title: 'Betaald, wacht op productie',
        detail: `${awaitingProdCount} betaalde orders wachten op productie-start.`,
        count: awaitingProdCount
      });
    }

    res.json({ overdueInvoices, newOrders, awaitingPaymentLink, recentPayments, pendingAccounts, todoSignals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Newsletter routes ────────────────────────────────────────────────────────
app.get('/api/admin/users/newsletter', requireAuth, requireRole('ADMIN', 'OWNER'), async (req, res) => {
  try {
    const subscribers = await db.prepare(`
      SELECT id, email, first_name, last_name, created_at
      FROM users WHERE newsletter_opt_in = 1 AND status != 'BANNED'
      ORDER BY created_at DESC
    `).all();
    const total = (await db.prepare(`SELECT COUNT(*) AS n FROM users WHERE status != 'BANNED'`).get())?.n || 0;
    res.json({ subscribers, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/users/newsletter.csv', requireAuth, requireRole('ADMIN', 'OWNER'), async (req, res) => {
  try {
    const rows = await db.prepare(`
      SELECT id, email, first_name, last_name, created_at
      FROM users WHERE newsletter_opt_in = 1 AND status != 'BANNED'
      ORDER BY created_at DESC
    `).all();
    const csv = ['id,email,first_name,last_name,created_at',
      ...rows.map(r => [r.id, r.email, r.first_name || '', r.last_name || '', r.created_at || ''].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
    ].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="newsletter-subscribers.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/newsletter/send', requireAuth, requireRole('OWNER'), async (req, res) => {
  const { subject, html } = req.body || {};
  if (!subject || !html) return res.status(400).json({ error: 'subject en html zijn verplicht' });
  try {
    const cfg = await getConfig();
    if (!cfg.smtp?.host) return res.status(400).json({ error: 'SMTP niet geconfigureerd' });
    const subscribers = await db.prepare(`
      SELECT email, first_name, last_name FROM users
      WHERE newsletter_opt_in = 1 AND status != 'BANNED' LIMIT 200
    `).all();
    if (!subscribers.length) return res.json({ sent: 0, failed: 0, skipped: 0 });

    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: cfg.smtp.host, port: Number(cfg.smtp.port) || 587,
      secure: cfg.smtp.secure || false,
      auth: cfg.smtp.user ? { user: cfg.smtp.user, pass: cfg.smtp.pass } : undefined
    });

    let sent = 0, failed = 0;
    for (const sub of subscribers) {
      try {
        await transporter.sendMail({
          from: `"${cfg.shopName || 'NEBULOUS'}" <${cfg.smtp.from || cfg.smtp.user}>`,
          to: sub.email,
          subject,
          html
        });
        sent++;
      } catch { failed++; }
    }

    await db.prepare(`INSERT INTO audit_log (user_id, user_email, action, summary, created_at)
      VALUES (?, ?, 'NEWSLETTER_SENT', ?, datetime('now'))`)
      .run(req.user.id, req.user.email, `Nieuwsbrief verstuurd: "${subject}" — ${sent} verzonden, ${failed} mislukt`);

    res.json({ sent, failed, skipped: subscribers.length - sent - failed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/audit', requireAuth, requireRole('OWNER'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 30));
  const offset = (page - 1) * limit;
  const q = String(req.query.q || '').trim();
  const action = String(req.query.action || '').trim().toUpperCase();

  let where = '1=1';
  const params = {};
  if (q) {
    where += ` AND (summary LIKE @q OR user_email LIKE @q OR entity_type LIKE @q OR action LIKE @q)`;
    params.q = `%${q}%`;
  }
  if (action) {
    where += ' AND action = @action';
    params.action = action;
  }

  const total = (await db.prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE ${where}`).get(params)).c;
  const logs = await db.prepare(`
    SELECT id, user_id AS actor_user_id, user_email AS actor_email, action, entity_type, entity_id, summary, details, created_at
    FROM audit_log
    WHERE ${where}
    ORDER BY id DESC
    LIMIT ${limit} OFFSET ${offset}
  `).all(params);

  const actions = await db.prepare(`SELECT action, COUNT(*) AS count FROM audit_log GROUP BY action ORDER BY action`).all();

  res.json({
    logs,
    actions,
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit))
  });
});

app.post('/api/admin/email/test', requireAuth, requireRole('OWNER'), async (req, res) => {
  try {
    const templateKey = String(req.body?.templateKey || 'orderPlaced');
    const to = String(req.body?.to || req.user.email || '').trim();
    if (!to) return res.status(400).json({ error: 'Geen ontvanger opgegeven' });
    const info = await sendTemplatedEmail(templateKey, to, {
      orderId: '0000',
      customerName: 'Testklant',
      orderTotal: fmtEUR(49.95),
      orderStatusLabel: statusLabel('PAID'),
      paymentUrl: `${APP_BASE_URL}/dashboard`,
      paymentExpiresAt: new Date(Date.now() + 24 * 3600 * 1000).toLocaleString('nl-BE'),
      invoiceNumber: 'INV-2026-000001',
      invoiceDueDate: new Date(Date.now() + 3 * 24 * 3600 * 1000).toLocaleDateString('nl-BE'),
      invoiceStatusLabel: invoiceStatusLabel('DEFINITIVE')
    });
    res.json({ ok: true, info });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Testmail versturen mislukt' });
  }
});

// ── Owner: Stripe configuratie ────────────────────────────────────────────
app.get('/api/admin/config/stripe', requireAuth, requireRole('OWNER'), async (req, res) => {
  const secretKey = await getStripeSecretKey();
  const webhookSecret = await getStripeWebhookSecret();
  const appUrl = await getSetting('stripe_app_base_url') || APP_BASE_URL;
  res.json({
    secretKeySet: !!secretKey,
    secretKeyMasked: secretKey ? ('sk_' + '*'.repeat(20) + secretKey.slice(-4)) : '',
    webhookSecretSet: !!webhookSecret,
    appBaseUrl: appUrl,
    fromEnv: !!(process.env.STRIPE_SECRET_KEY)
  });
});

app.put('/api/admin/config/stripe', requireAuth, requireRole('OWNER'), async (req, res) => {
  const { secretKey, webhookSecret, appBaseUrl, test } = req.body || {};
  if (secretKey !== undefined && secretKey !== null && secretKey !== '') {
    const cleaned = String(secretKey).trim();
    if (!cleaned.startsWith('sk_')) return res.status(400).json({ error: 'Secret key moet beginnen met sk_' });
    const enc = await encryptSetting(cleaned);
    const { setSetting: ss } = require('./db');
    await require('./db').setSetting('stripe_secret_key_enc', enc);
    _stripeCache = null;
    _stripeCacheKey = null;
  }
  if (webhookSecret !== undefined && webhookSecret !== null && webhookSecret !== '') {
    const cleaned = String(webhookSecret).trim();
    if (!cleaned.startsWith('whsec_')) return res.status(400).json({ error: 'Webhook secret moet beginnen met whsec_' });
    await require('./db').setSetting('stripe_webhook_secret_enc', await encryptSetting(cleaned));
  }
  if (appBaseUrl !== undefined && appBaseUrl !== null) {
    await require('./db').setSetting('stripe_app_base_url', String(appBaseUrl).trim().replace(/\/+$/, ''));
  }
  if (test) {
    try {
      const client = await getStripeClient();
      if (!client) return res.status(400).json({ error: 'Geen Stripe-sleutel geconfigureerd' });
      await client.paymentMethods.list({ limit: 1 });
      logAuditFromReq(req, { action: 'CONFIG_UPDATED', entityType: 'STRIPE', summary: 'Stripe configuratie getest en opgeslagen' });
      return res.json({ ok: true, connected: true });
    } catch (err) {
      return res.status(400).json({ error: `Stripe verbindingstest mislukt: ${err.message}` });
    }
  }
  await logAuditFromReq(req, { action: 'CONFIG_UPDATED', entityType: 'STRIPE', summary: 'Stripe configuratie bijgewerkt' });
  res.json({ ok: true });
});

app.get('/api/admin/config/stripe/test', requireAuth, requireRole('OWNER'), async (req, res) => {
  try {
    const client = await getStripeClient();
    if (!client) return res.status(400).json({ error: 'Geen Stripe-sleutel geconfigureerd' });
    await client.paymentMethods.list({ limit: 1 });
    res.json({ ok: true, connected: true });
  } catch (err) {
    res.status(400).json({ error: `Stripe verbindingstest mislukt: ${err.message}` });
  }
});

// ── Admin: product color mockup upload ───────────────────────────────────
app.post('/api/admin/products/:productId/colors/:hex/mockup',
  requireAuth, requireRole('ADMIN', 'OWNER'),
  productMockupUpload.single('mockup'),
  async (req, res) => {
    try {
      const productId = String(req.params.productId || '').trim().toLowerCase();
      const hexRaw = String(req.params.hex || '').trim().toLowerCase().replace(/^#?/, '#');
      if (!/^#[0-9a-f]{6}$/.test(hexRaw)) return res.status(400).json({ error: 'Ongeldige hex-kleur' });
      if (!req.file?.buffer?.length) return res.status(400).json({ error: 'Geen bestand geüpload' });

      const cfg = await getConfig();
      const products = Array.isArray(cfg.products) ? cfg.products : [];
      const prodIdx = products.findIndex(p => String(p.id || '').toLowerCase() === productId);
      if (prodIdx < 0) return res.status(404).json({ error: 'Product niet gevonden' });

      // Sla mockup op in branding-map
      const ext = extFromMime(req.file.mimetype || 'image/png');
      const safeName = `product-${productId}-color-${hexRaw.replace('#', '')}.${ext}`;
      const optimized = await optimizeUploadedImage(req.file.buffer, req.file.mimetype || 'image/png', 'mockup');
      const relativePath = path.join('assets', 'branding', safeName);
      await writeStoredUpload(relativePath, optimized?.buffer || req.file.buffer, optimized?.mime || req.file.mimetype || 'image/png');

      // Update config
      const updatedProducts = products.map((p, i) => {
        if (i !== prodIdx) return p;
        const colorData = { ...(p.colorData || {}) };
        colorData[hexRaw] = { ...(colorData[hexRaw] || {}), mockupPath: relativePath };
        return { ...p, colorData };
      });
      const newCfg = { ...cfg, products: updatedProducts };
      await setSetting('config', newCfg);
      logAuditFromReq(req, { action: 'PRODUCT_COLOR_MOCKUP_UPLOADED', entityType: 'PRODUCT', entityId: productId, summary: `Kleur-mockup geüpload voor ${productId} ${hexRaw}` });
      res.json({ ok: true, mockupPath: relativePath });
    } catch (err) {
      console.error('Color mockup upload error:', err);
      res.status(500).json({ error: 'Upload mislukt' });
    }
  }
);

// DELETE: verwijder kleur-mockup
app.delete('/api/admin/products/:productId/colors/:hex/mockup',
  requireAuth, requireRole('ADMIN', 'OWNER'),
  async (req, res) => {
    const productId = String(req.params.productId || '').trim().toLowerCase();
    const hexRaw = String(req.params.hex || '').trim().toLowerCase().replace(/^#?/, '#');
    if (!/^#[0-9a-f]{6}$/.test(hexRaw)) return res.status(400).json({ error: 'Ongeldige hex-kleur' });

    const cfg = await getConfig();
    const products = Array.isArray(cfg.products) ? cfg.products : [];
    const prodIdx = products.findIndex(p => String(p.id || '').toLowerCase() === productId);
    if (prodIdx < 0) return res.status(404).json({ error: 'Product niet gevonden' });

    const updatedProducts = products.map((p, i) => {
      if (i !== prodIdx) return p;
      const colorData = { ...(p.colorData || {}) };
      if (colorData[hexRaw]) colorData[hexRaw] = { ...colorData[hexRaw], mockupPath: '' };
      return { ...p, colorData };
    });
    await setSetting('config', { ...cfg, products: updatedProducts });
    res.json({ ok: true });
  }
);

// ── Owner: backup ─────────────────────────────────────────────────────────
app.get('/api/admin/backup', requireAuth, requireRole('OWNER'), async (_req, res) => {
  if (USE_PG) return res.status(501).json({ error: 'Backup is niet beschikbaar in PostgreSQL-modus. Gebruik de Supabase dashboard.' });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(BACKUP_DIR, `nebulous-${stamp}.sqlite`);
  await db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  res.download(file, path.basename(file));
});

app.post('/api/admin/backup/restore', requireAuth, requireRole('OWNER'), restoreUpload.single('backup'), async (req, res) => {
  if (USE_PG) return res.status(501).json({ error: 'Restore is niet beschikbaar in PostgreSQL-modus. Gebruik de Supabase dashboard.' });
  if (!req.file?.buffer?.length) return res.status(400).json({ error: 'Geen backupbestand geüpload' });

  const tmpFile = path.join(BACKUP_DIR, `restore-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sqlite`);
  let sourceDb = null;
  try {
    fs.writeFileSync(tmpFile, req.file.buffer);
    sourceDb = new Database(tmpFile, { readonly: true, fileMustExist: true });

    const integrityRow = sourceDb.prepare('PRAGMA integrity_check').get();
    const integrityValue = integrityRow ? Object.values(integrityRow)[0] : null;
    if (String(integrityValue || '').toLowerCase() !== 'ok') {
      throw new Error('Backupbestand is ongeldig of beschadigd');
    }

    for (const table of RESTORE_TABLES) {
      const cols = getTableColumns(sourceDb, table);
      if (!cols.length) throw new Error(`Backup mist vereiste tabel: ${table}`);
    }

    // SQLite-only restore: use raw sync API inside transaction
    const rawDb = db._raw;
    const deleteOrder = [...RESTORE_TABLES].reverse();
    const insertOrder = [...RESTORE_TABLES];
    const tx = rawDb.transaction(() => {
      deleteOrder.forEach((table) => {
        rawDb.prepare(`DELETE FROM ${quoteIdent(table)}`).run();
      });

      insertOrder.forEach((table) => {
        const targetCols = getTableColumns(rawDb, table);
        const sourceCols = getTableColumns(sourceDb, table);
        const commonCols = targetCols.filter(c => sourceCols.includes(c));
        if (!commonCols.length) return;

        const columnSql = commonCols.map(quoteIdent).join(', ');
        const rows = sourceDb.prepare(`SELECT ${columnSql} FROM ${quoteIdent(table)}`).all();
        if (!rows.length) return;

        const placeholders = commonCols.map(() => '?').join(', ');
        const ins = rawDb.prepare(`INSERT INTO ${quoteIdent(table)} (${columnSql}) VALUES (${placeholders})`);
        rows.forEach((row) => ins.run(...commonCols.map(c => row[c])));
      });
    });
    tx();

    await logAudit({
      actorUserId: null,
      actorEmail: req.user?.email || null,
      action: 'BACKUP_RESTORED',
      entityType: 'backup',
      entityId: path.basename(req.file.originalname || 'upload.sqlite'),
      summary: 'Database hersteld vanuit geüploade backup',
      details: {
        originalName: req.file.originalname || null,
        bytes: req.file.size || req.file.buffer.length || 0
      }
    });

    req.session.destroy(() => {
      res.json({ ok: true, reloginRequired: true });
    });
  } catch (err) {
    console.error('Backup restore failed:', err);
    res.status(400).json({ error: err.message || 'Backup herstellen mislukt' });
  } finally {
    try { sourceDb?.close(); } catch {}
    try { fs.rmSync(tmpFile, { force: true }); } catch {}
  }
});

// Debug endpoint for session diagnostics
app.get('/api/debug/session', (req, res) => {
  res.json({
    hasSession: !!req.session,
    sessionID: req.sessionID || null,
    booted: _booted,
    sessionHandlerType: typeof _sessionHandler
  });
});

// ── Static & uploads ──────────────────────────────────────────────────────
app.get('/api/health', async (_req, res) => {
  const now = new Date();
  try {
    const dbRow = await db.prepare('SELECT 1 AS ok').get();
    const dbOk = !!dbRow?.ok;
    if (!dbOk) throw new Error('DB check failed');
    const reminderJob = await processInvoiceRemindersSafe(false);
    res.json({
      ok: true,
      status: 'healthy',
      service: 'nebulous-api',
      version: APP_VERSION,
      now: now.toISOString(),
      uptimeSec: Math.floor((Date.now() - APP_STARTED_AT) / 1000),
      checks: {
        database: 'ok'
      },
      jobs: {
        invoiceReminders: reminderJob?.ok ? `sent:${reminderJob.sent || 0}` : (reminderJob?.skipped || 'idle')
      }
    });
  } catch (err) {
    res.status(503).json({
      ok: false,
      status: 'unhealthy',
      service: 'nebulous-api',
      version: APP_VERSION,
      now: now.toISOString(),
      uptimeSec: Math.floor((Date.now() - APP_STARTED_AT) / 1000),
      checks: {
        database: 'error'
      },
      error: err.message || 'Health check failed'
    });
  }
});

app.get('/uploads-signed', async (req, res) => {
  const p = req.query?.p;
  const exp = Number(req.query?.exp || 0);
  const sig = String(req.query?.sig || '');
  if (!p || !Number.isFinite(exp) || !sig) return res.status(400).end();
  const nowSec = Math.floor(Date.now() / 1000);
  if (exp < nowSec) return res.status(410).end();

  const normalized = normalizeUploadPath(p);
  if (!normalized) return res.status(400).end();
  const expected = signUploadPayload(normalized.rel, exp);
  if (!safeSigEqual(sig, expected)) return res.status(403).end();
  if (fs.existsSync(normalized.abs)) {
    setUploadCacheHeaders(res, 'signed', exp * 1000);
    return res.sendFile(normalized.abs);
  }
  if (await respondWithStoredUpload(res, normalized.rel, 'signed', exp * 1000)) return;
  return res.status(404).end();
});

app.get('/uploads/*', async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.status(401).end();
  const normalized = normalizeUploadPath(req.params[0]);
  if (!normalized) return res.status(404).end();
  if (!await canUserAccessUploadByParts(u, normalized.parts)) return res.status(403).end();
  if (fs.existsSync(normalized.abs)) {
    setUploadCacheHeaders(res, 'private');
    return res.sendFile(normalized.abs);
  }
  if (await respondWithStoredUpload(res, normalized.rel, 'private')) return;
  return res.status(404).end();
});

// Branding/product assets can exist in public assets, runtime uploads, or the blob store.
// This route serves runtime/blob-backed assets and falls back to static public assets if not found.
app.get('/assets/*', async (req, res, next) => {
  const rel = normalizePublicAssetPath(req.path);
  if (!rel || (!rel.startsWith('assets/branding/') && !rel.startsWith('assets/products/'))) return next();
  const abs = path.resolve(UPLOAD_DIR, rel);
  const allowedRoot = path.resolve(UPLOAD_DIR, 'assets');
  if (!abs.startsWith(allowedRoot + path.sep) && abs !== allowedRoot) return res.status(400).end();
  if (fs.existsSync(abs)) {
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300, stale-while-revalidate=300');
    return res.sendFile(abs);
  }
  if (await respondWithStoredUpload(res, rel, 'signed', Date.now() + (300 * 1000))) return;
  return next();
});

app.get('/', async (_req, res) => {
  try {
    const cfg = await getConfig();
    res.type('html').send(renderIndexWithSeo(cfg));
  } catch (err) {
    console.error('SEO render fallback naar statische index:', err?.message || err);
    res.sendFile(INDEX_HTML_PATH);
  }
});

app.get('/designer', async (_req, res) => {
  try {
    const cfg = await getConfig();
    res.type('html').send(renderIndexWithSeo(cfg));
  } catch (err) {
    console.error('Designer render fallback naar statische index:', err?.message || err);
    res.sendFile(INDEX_HTML_PATH);
  }
});

app.use(express.static(PUBLIC_DIR));

const pageRoutes = [
  '/login', '/register', '/dashboard', '/admin', '/account', '/cart',
  '/shop', '/prijzen', '/maattabel', '/support', '/faq', '/contact',
  '/verzending', '/legal', '/privacy', '/voorwaarden', '/retourneren'
];
pageRoutes.forEach(route => {
  app.get(route, async (_req, res) => {
    res.sendFile(path.join(ROOT, 'public', route.replace('/', '') + '.html'));
  });
});

app.use((err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Bestand te groot (max 15MB per bestand)' });
    return res.status(400).json({ error: `Upload fout: ${err.message}` });
  }
  if (err && /afbeeldingsbestanden/i.test(err.message || '')) {
    return res.status(400).json({ error: err.message });
  }
  return next(err);
});

// ── Async startup + Vercel export ─────────────────────────────────────────────
async function startServer() {
  await boot();
  app.listen(PORT, () => console.log(`Nebulous draait op http://localhost:${PORT}`));
}

// If run directly (not imported by Vercel), start the server
if (require.main === module) {
  startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

module.exports = { app, boot };
