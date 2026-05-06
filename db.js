const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'nebulous.sqlite');
const SECRET_PATH = path.join(DATA_DIR, '.session-secret');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  role TEXT NOT NULL DEFAULT 'USER',
  status TEXT NOT NULL DEFAULT 'PENDING',
  address TEXT,
  postcode TEXT,
  city TEXT,
  phone TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cart_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  color_name TEXT, color_hex TEXT, size TEXT,
  qty INTEGER NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  extras_price REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  preview_path TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cart_item_designs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cart_item_id INTEGER NOT NULL REFERENCES cart_items(id) ON DELETE CASCADE,
  name TEXT, position TEXT, scale REAL, v_offset REAL, x_offset REAL, note TEXT, file_path TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'NEW',
  deleted_at TEXT,
  deleted_by INTEGER REFERENCES users(id),
  delete_reason TEXT,
  shipping_carrier TEXT,
  tracking_code TEXT,
  tracking_url TEXT,
  shipping_status TEXT,
  shipping_last_update_at TEXT,
  customer_first TEXT, customer_last TEXT, customer_email TEXT,
  customer_company TEXT, customer_vat TEXT,
  address TEXT, postcode TEXT, city TEXT, phone TEXT,
  subtotal REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  color_name TEXT, color_hex TEXT, size TEXT,
  qty INTEGER NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  extras_price REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  preview_path TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS order_designs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_item_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  name TEXT, position TEXT, scale REAL, v_offset REAL, x_offset REAL, note TEXT, file_path TEXT
);

CREATE TABLE IF NOT EXISTS order_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  note TEXT,
  changed_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'CREATED',
  amount REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'EUR',
  checkout_url TEXT,
  provider_payment_id TEXT,
  provider_checkout_id TEXT,
  payment_link_expires_at TEXT,
  paid_at TEXT,
  failure_reason TEXT,
  metadata TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  invoice_number TEXT,
  status TEXT NOT NULL DEFAULT 'CONCEPT',
  issue_date TEXT,
  due_date TEXT,
  finalized_at TEXT,
  paid_at TEXT,
  sent_at TEXT,
  last_reminder_at TEXT,
  reminder_count INTEGER NOT NULL DEFAULT 0,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS email_tracking (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  email_type TEXT NOT NULL,
  recipient TEXT,
  sent_at TEXT,
  first_opened_at TEXT,
  open_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shipping_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT UNIQUE,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  carrier TEXT,
  status_raw TEXT,
  status_normalized TEXT,
  tracking_code TEXT,
  event_at TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deposit_invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  linked_final_invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  invoice_number TEXT,
  status TEXT NOT NULL DEFAULT 'DEFINITIVE',
  deposit_percentage REAL,
  deposit_amount REAL NOT NULL DEFAULT 0,
  issue_date TEXT,
  due_date TEXT,
  sent_at TEXT,
  paid_at TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_email TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  summary TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER IF NOT EXISTS trg_payments_updated_at
AFTER UPDATE ON payments
FOR EACH ROW
BEGIN
  UPDATE payments SET updated_at = datetime('now') WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_invoices_updated_at
AFTER UPDATE ON invoices
FOR EACH ROW
BEGIN
  UPDATE invoices SET updated_at = datetime('now') WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_deposit_invoices_updated_at
AFTER UPDATE ON deposit_invoices
FOR EACH ROW
BEGIN
  UPDATE deposit_invoices SET updated_at = datetime('now') WHERE id = OLD.id;
END;

CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_cart_user ON cart_items(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_invoices_order ON invoices(order_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_due_date ON invoices(due_date);
CREATE INDEX IF NOT EXISTS idx_email_tracking_order ON email_tracking(order_id);
CREATE INDEX IF NOT EXISTS idx_email_tracking_token ON email_tracking(token);
CREATE INDEX IF NOT EXISTS idx_shipping_events_order ON shipping_events(order_id);
CREATE INDEX IF NOT EXISTS idx_shipping_events_event_at ON shipping_events(event_at);
CREATE INDEX IF NOT EXISTS idx_shipping_events_carrier ON shipping_events(carrier);
CREATE INDEX IF NOT EXISTS idx_deposit_invoices_order ON deposit_invoices(order_id);
CREATE INDEX IF NOT EXISTS idx_deposit_invoices_status ON deposit_invoices(status);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
`);

function ensureUserSecurityColumns() {
  const cols = db.prepare(`PRAGMA table_info(users)`).all().map(c => c.name);
  if (!cols.includes('failed_login_attempts')) {
    db.exec(`ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0`);
  }
  if (!cols.includes('login_locked_until')) {
    db.exec(`ALTER TABLE users ADD COLUMN login_locked_until TEXT`);
  }
  if (!cols.includes('last_failed_login_at')) {
    db.exec(`ALTER TABLE users ADD COLUMN last_failed_login_at TEXT`);
  }
  if (!cols.includes('totp_secret')) {
    db.exec(`ALTER TABLE users ADD COLUMN totp_secret TEXT`);
  }
  if (!cols.includes('totp_enabled')) {
    db.exec(`ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0`);
  }
  if (!cols.includes('totp_enabled_at')) {
    db.exec(`ALTER TABLE users ADD COLUMN totp_enabled_at TEXT`);
  }
}
ensureUserSecurityColumns();

function ensureProductItemColumns() {
  const cartCols = db.prepare(`PRAGMA table_info(cart_items)`).all().map(c => c.name);
  if (!cartCols.includes('product_type')) {
    db.exec(`ALTER TABLE cart_items ADD COLUMN product_type TEXT NOT NULL DEFAULT 'tshirt'`);
  }
  if (!cartCols.includes('product_label')) {
    db.exec(`ALTER TABLE cart_items ADD COLUMN product_label TEXT NOT NULL DEFAULT 'T-shirt'`);
  }
  if (!cartCols.includes('product_mockup_path')) {
    db.exec(`ALTER TABLE cart_items ADD COLUMN product_mockup_path TEXT`);
  }
  if (!cartCols.includes('product_price_multiplier')) {
    db.exec(`ALTER TABLE cart_items ADD COLUMN product_price_multiplier REAL NOT NULL DEFAULT 1`);
  }

  const orderCols = db.prepare(`PRAGMA table_info(order_items)`).all().map(c => c.name);
  if (!orderCols.includes('product_type')) {
    db.exec(`ALTER TABLE order_items ADD COLUMN product_type TEXT NOT NULL DEFAULT 'tshirt'`);
  }
  if (!orderCols.includes('product_label')) {
    db.exec(`ALTER TABLE order_items ADD COLUMN product_label TEXT NOT NULL DEFAULT 'T-shirt'`);
  }
  if (!orderCols.includes('product_mockup_path')) {
    db.exec(`ALTER TABLE order_items ADD COLUMN product_mockup_path TEXT`);
  }
  if (!orderCols.includes('product_price_multiplier')) {
    db.exec(`ALTER TABLE order_items ADD COLUMN product_price_multiplier REAL NOT NULL DEFAULT 1`);
  }
}
ensureProductItemColumns();

function ensureOrderCustomerFields() {
  const cols = db.prepare(`PRAGMA table_info(orders)`).all().map(c => c.name);
  if (!cols.includes('customer_company')) {
    db.exec(`ALTER TABLE orders ADD COLUMN customer_company TEXT`);
  }
  if (!cols.includes('customer_vat')) {
    db.exec(`ALTER TABLE orders ADD COLUMN customer_vat TEXT`);
  }
}
ensureOrderCustomerFields();

function ensureOrderLifecycleColumns() {
  const cols = db.prepare(`PRAGMA table_info(orders)`).all().map(c => c.name);
  if (!cols.includes('deleted_at')) db.exec(`ALTER TABLE orders ADD COLUMN deleted_at TEXT`);
  if (!cols.includes('deleted_by')) db.exec(`ALTER TABLE orders ADD COLUMN deleted_by INTEGER REFERENCES users(id)`);
  if (!cols.includes('delete_reason')) db.exec(`ALTER TABLE orders ADD COLUMN delete_reason TEXT`);
  if (!cols.includes('shipping_carrier')) db.exec(`ALTER TABLE orders ADD COLUMN shipping_carrier TEXT`);
  if (!cols.includes('tracking_code')) db.exec(`ALTER TABLE orders ADD COLUMN tracking_code TEXT`);
  if (!cols.includes('tracking_url')) db.exec(`ALTER TABLE orders ADD COLUMN tracking_url TEXT`);
  if (!cols.includes('shipping_status')) db.exec(`ALTER TABLE orders ADD COLUMN shipping_status TEXT`);
  if (!cols.includes('shipping_last_update_at')) db.exec(`ALTER TABLE orders ADD COLUMN shipping_last_update_at TEXT`);
}
ensureOrderLifecycleColumns();

function ensureOrderLifecycleIndexes() {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_orders_deleted_at ON orders(deleted_at);
    CREATE INDEX IF NOT EXISTS idx_orders_shipping_status ON orders(shipping_status);
  `);
}
ensureOrderLifecycleIndexes();

function ensureShippingEventsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shipping_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT UNIQUE,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      carrier TEXT,
      status_raw TEXT,
      status_normalized TEXT,
      tracking_code TEXT,
      event_at TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_shipping_events_order ON shipping_events(order_id);
    CREATE INDEX IF NOT EXISTS idx_shipping_events_event_at ON shipping_events(event_at);
    CREATE INDEX IF NOT EXISTS idx_shipping_events_carrier ON shipping_events(carrier);
  `);
}
ensureShippingEventsTable();

function ensureEmailVerificationColumns() {
  const cols = db.prepare(`PRAGMA table_info(users)`).all().map(c => c.name);
  if (!cols.includes('email_verified')) {
    db.exec(`ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0`);
    // Bestaande ACTIVE gebruikers beschouwen als geverifieerd
    db.exec(`UPDATE users SET email_verified = 1 WHERE status = 'ACTIVE'`);
  }
  if (!cols.includes('email_verification_token')) {
    db.exec(`ALTER TABLE users ADD COLUMN email_verification_token TEXT`);
  }
  if (!cols.includes('email_verification_token_expires_at')) {
    db.exec(`ALTER TABLE users ADD COLUMN email_verification_token_expires_at TEXT`);
  }
  if (!cols.includes('last_login_at')) {
    db.exec(`ALTER TABLE users ADD COLUMN last_login_at TEXT`);
  }
}
ensureEmailVerificationColumns();

function ensureUserCrmColumns() {
  const cols = db.prepare(`PRAGMA table_info(users)`).all().map(c => c.name);
  if (!cols.includes('newsletter_opt_in')) {
    db.exec(`ALTER TABLE users ADD COLUMN newsletter_opt_in INTEGER NOT NULL DEFAULT 0`);
  }
  if (!cols.includes('internal_notes')) {
    db.exec(`ALTER TABLE users ADD COLUMN internal_notes TEXT`);
  }
  if (!cols.includes('tags')) {
    db.exec(`ALTER TABLE users ADD COLUMN tags TEXT`);
  }
  if (!cols.includes('company')) {
    db.exec(`ALTER TABLE users ADD COLUMN company TEXT`);
  }
  if (!cols.includes('vat_number')) {
    db.exec(`ALTER TABLE users ADD COLUMN vat_number TEXT`);
  }
}
ensureUserCrmColumns();

// ── Session secret persistence ─────────────────────────────────────────────
function getOrCreateSecret() {
  try { const s = fs.readFileSync(SECRET_PATH, 'utf8').trim(); if (s) return s; } catch {}
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(SECRET_PATH, s, { mode: 0o600 });
  return s;
}

// ── Encrypted settings (AES-256-GCM) voor gevoelige config zoals Stripe-sleutels ──
function _getEncKey() {
  const secret = getOrCreateSecret();
  return crypto.pbkdf2Sync(secret, 'nebulous-enc-salt-v1', 100000, 32, 'sha256');
}

function encryptSetting(plaintext) {
  if (!plaintext) return '';
  const key = _getEncKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptSetting(ciphertext) {
  if (!ciphertext) return '';
  try {
    const key = _getEncKey();
    const buf = Buffer.from(ciphertext, 'base64');
    const iv = buf.slice(0, 12);
    const tag = buf.slice(12, 28);
    const enc = buf.slice(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

// ── Settings ───────────────────────────────────────────────────────────────
function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}
function setSetting(key, value) {
  db.prepare(`INSERT INTO settings(key, value) VALUES(?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(key, JSON.stringify(value));
}

const SIZE_ORDER = ['XXS','XS','S','M','L','XL','XXL','XXXL','3XL','4XL','5XL'];
function sortSizes(sizes) {
  return [...new Set(sizes)].sort((a, b) => {
    const ia = SIZE_ORDER.indexOf(a), ib = SIZE_ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });
}

const DEFAULT_CONFIG = {
  brand: { name: 'NEBULOUS', tagline: 'Professioneel marketingmateriaal, gemaakt voor jou.' },
  hero: {
    badge: 'Upload · Preview · Bestel',
    title1: 'Ontwerp jouw',
    title2: 'marketingmateriaal',
    subtitle: 'Upload je design, pas aan en bestel direct. Van t-shirts tot beachflags en spandoeken — binnen 3 werkdagen geleverd.',
    cta: 'Start met ontwerpen',
    videoUrl: '',
    videoOverlayColor: '#000000',
    videoOverlayOpacity: 0.55,
    videoBlurPx: 0
  },
  smtp: {
    host: '',
    port: 587,
    user: '',
    pass: '',
    secure: false,
    fromName: '',
    fromAddress: ''
  },
  pricing: {
    basePrice: 34.95,
    extraDesignFee: 7.50,
    sizeUpcharge: { XS: 0, S: 0, M: 0, L: 0, XL: 1.5, XXL: 2.5 },
    shippingCost: 4.95,
    shippingFree: true,
    shippingFreeThreshold: 0,
    deliveryText: '3 werkdagen'
  },
  checkout: {
    approvalMode: 'MANUAL',
    paymentProvider: 'STRIPE',
    paymentLinkExpiryHours: 24,
    currency: 'EUR'
  },
  conversion: {
    ctaVariant: 'SOFT',
    designerStep2Cta: 'Naar overzicht',
    designerStep3CtaSoft: 'Toevoegen naar winkelmand',
    designerStep3CtaStrong: 'Toevoegen naar winkelmand',
    cartCtaSoft: 'Bestelling plaatsen (nog niet betalen)',
    cartCtaStrong: 'Bestelling plaatsen',
    urgencyEnabled: false,
    urgencyText: 'Beperkte productiecapaciteit deze week.',
    socialProofEnabled: true,
    socialProofText: 'Gemiddelde goedkeuring op werkdagen: binnen 2 uur.',
    checkoutNote: 'Na goedkeuring ontvang je je beveiligde betaallink per e-mail.'
  },
  company: {
    legalName: 'NEBULOUS',
    invoicePrefix: 'INV',
    vatNumber: '',
    address: '',
    postcode: '',
    city: '',
    country: 'BE',
    supportEmail: '',
    supportPhone: ''
  },
  documents: {
    invoice: {
      title: 'Factuur',
      intro: 'Bedankt voor je bestelling. Hieronder vind je het overzicht van je order.',
      paymentTermsDays: 0,
      footer: 'Bedankt voor je vertrouwen.',
      showSupportContacts: true,
      legalDisclaimer: 'Bij laattijdige betaling kunnen wettelijke nalatigheidsinteresten en invorderingskosten worden aangerekend conform de Belgische wetgeving.',
      numberYearMode: 'ORDER_YEAR',
      numberPadLength: 6,
      reminderEnabled: true,
      reminderIntervalHours: 24,
      reminderMaxCount: 5
    },
    packingSlip: {
      title: 'Orderbon',
      intro: 'Interne productiebon voor picking, print en verpakking.',
      footer: 'Controleer aantallen en designbestanden voor start productie.',
      showFilePaths: true
    }
  },
  email: {
    fromName: 'NEBULOUS',
    fromAddress: '',
    replyTo: '',
    templates: {
      orderPlaced: {
        subject: 'We hebben je bestelling ontvangen (#{{orderId}})',
        html: `
          <h2>Bedankt voor je bestelling, {{customerName}}.</h2>
          <p>We hebben order <strong>#{{orderId}}</strong> goed ontvangen.</p>
          <p>Totaal: <strong>{{orderTotal}}</strong></p>
          <p>Je kan de status volgen via je dashboard:</p>
          <p><a href="{{dashboardUrl}}">Open mijn dashboard</a></p>
          <hr />
          <p style="color:#666">Met vriendelijke groet,<br>{{companyName}}</p>
        `
      },
      paymentLink: {
        subject: 'Je order is goedgekeurd — betaal nu veilig (#{{orderId}})',
        html: `
          <h2>Je bestelling is goedgekeurd.</h2>
          <p>Order <strong>#{{orderId}}</strong> staat klaar voor betaling.</p>
          <p>Totaal te betalen: <strong>{{orderTotal}}</strong></p>
          <p><a href="{{paymentUrl}}">Betaal nu via beveiligde betaalpagina</a></p>
          <p>Deze link verloopt op: {{paymentExpiresAt}}</p>
          <hr />
          <p style="color:#666">Vragen? Contacteer ons via {{supportEmail}}.</p>
        `
      },
      offerSent: {
        subject: 'Offerte voor order #{{orderId}}',
        html: `
          <h2>Hier is je offerte.</h2>
          <p>Voor order <strong>#{{orderId}}</strong> vind je de offerte in bijlage.</p>
          <p>Totaal indicatie: <strong>{{orderTotal}}</strong></p>
          <p><a href="{{dashboardUrl}}">Open dashboard</a></p>
          <hr />
          <p style="color:#666">Vragen? Contacteer ons via {{supportEmail}}.</p>
        `
      },
      paymentReceived: {
        subject: 'Betaling ontvangen voor order #{{orderId}}',
        html: `
          <h2>Betaling ontvangen, bedankt.</h2>
          <p>We hebben je betaling voor order <strong>#{{orderId}}</strong> succesvol ontvangen.</p>
          <p>Je bestelling gaat nu verder in productieplanning.</p>
          <p><a href="{{dashboardUrl}}">Bekijk orderstatus</a></p>
          <hr />
          <p style="color:#666">{{companyName}}</p>
        `
      },
      invoiceReminder: {
        subject: 'Herinnering: openstaande factuur {{invoiceNumber}} voor order #{{orderId}}',
        html: `
          <h2>Betalingsherinnering</h2>
          <p>Voor order <strong>#{{orderId}}</strong> staat nog een openstaande factuur.</p>
          <p>Factuur: <strong>{{invoiceNumber}}</strong></p>
          <p>Vervaldatum: <strong>{{invoiceDueDate}}</strong></p>
          <p>Openstaand bedrag: <strong>{{orderTotal}}</strong></p>
          <p><a href="{{paymentUrl}}">Betaal nu via beveiligde betaalpagina</a></p>
          <hr />
          <p style="color:#666">Voor vragen: {{supportEmail}}</p>
        `
      },
      orderStatusChanged: {
        subject: 'Statusupdate voor order #{{orderId}}: {{orderStatusLabel}}',
        html: `
          <h2>Status van je bestelling is bijgewerkt</h2>
          <p>Order <strong>#{{orderId}}</strong> staat nu op: <strong>{{orderStatusLabel}}</strong></p>
          <p><a href="{{dashboardUrl}}">Open dashboard</a></p>
          <hr />
          <p style="color:#666">{{companyName}}</p>
        `
      },
      accountApproved: {
        subject: 'Je account is goedgekeurd',
        html: `
          <h2>Welkom bij {{companyName}}</h2>
          <p>Je account is goedgekeurd. Je kan nu inloggen en bestellingen plaatsen.</p>
          <p><a href="{{loginUrl}}">Inloggen</a></p>
        `
      },
      passwordReset: {
        subject: 'Je wachtwoord is gereset',
        html: `
          <h2>Wachtwoord gereset</h2>
          <p>Er werd een nieuw wachtwoord ingesteld voor je account.</p>
          <p>Log in en wijzig dit wachtwoord meteen in je accountinstellingen.</p>
          <p><a href="{{loginUrl}}">Inloggen</a></p>
        `
      },
      emailVerification: {
        subject: 'Bevestig je e-mailadres — {{companyName}}',
        html: `
          <h2>Welkom bij {{companyName}}!</h2>
          <p>Bedankt voor je registratie. Klik op de knop hieronder om je e-mailadres te bevestigen.</p>
          <p style="text-align:center;margin:2rem 0">
            <a href="{{verificationUrl}}" style="display:inline-block;padding:.75rem 1.5rem;background:#111;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">E-mail bevestigen</a>
          </p>
          <p>Of kopieer deze link in je browser:<br><small>{{verificationUrl}}</small></p>
          <p>Deze link is 24 uur geldig.</p>
          <hr />
          <p style="color:#666;font-size:.85em">Als je dit account niet hebt aangemaakt, kun je deze e-mail negeren.</p>
        `
      }
    }
  },
  seo: {
    metaDescription: 'Ontwerp je eigen custom kleding en promotiemateriaal met live preview. Upload je design en bestel direct online.',
    ogTitle: 'NEBULOUS - Custom kleding & printproducten',
    ogDescription: 'Ontwerp je eigen custom kleding en promotiemateriaal met live preview. Upload je design en bestel direct online.',
    ogImagePath: 'assets/tshirt_mockup.png'
  },
  theme: {
    logoMark: '✦',
    logoPath: '',
    faviconPath: '',
    accentColor: '#ffffff',
    accentColor2: '#bdbdbd',
    headingFont: 'POPPINS',
    bodyFont: 'POPPINS',
    buttonStyle: 'ROUNDED',
    sectionTone: 'MUTED',
    invoiceOpenBg: '#1d4ed8',
    invoiceOpenText: '#eff6ff',
    invoiceDueBg: '#f59e0b',
    invoiceDueText: '#111827'
  },
  colors: [
    { name: 'Zwart', hex: '#0b0b0b', enabled: true },
    { name: 'Wit', hex: '#f2f2f2', enabled: true },
    { name: 'Grijs', hex: '#6b6b6b', enabled: true }
  ],
  sizes: ['XS', 'S', 'M', 'L', 'XL', 'XXL'],
  reviews: [
    { initials: 'MK', name: 'Maarten K.', text: 'Mijn eigen artwork op een shirt! De print is scherp en de kleuren kloppen perfect.' },
    { initials: 'SV', name: 'Sophie V.', text: 'Super makkelijk te gebruiken. Van upload naar bestelling in 2 minuten. Top kwaliteit!' },
    { initials: 'JB', name: 'Jesse B.', text: 'Al 10x gewassen, print ziet er nog steeds als nieuw uit. Besteld als cadeau, groot succes!' }
  ],
  features: [
    { title: 'Premium producten', text: 'Textiel, banners, beachflags en meer — voor elk marketing doel' },
    { title: 'Professionele afdruk', text: 'DTG voor textiel, UV-print voor banners en beachflags' },
    { title: 'Gratis verzending', text: 'Bezorgd binnen 3 werkdagen in heel Nederland' },
    { title: '30 dagen retour', text: 'Niet tevreden? Stuur gratis terug, geen vragen' }
  ],
  products: [
    {
      id: 'tshirt',
      name: 'T-shirt',
      description: 'Premium unisex T-shirt',
      mockupPath: 'assets/tshirt_mockup.png',
      basePrice: 34.95,
      extraDesignFee: 7.50,
      priceMultiplier: 1,
      extraDesignFeeMultiplier: 1,
      colorPrices: {},
      sizePrices: { XS: 0, S: 0, M: 0, L: 0, XL: 1.5, XXL: 2.5 },
      colorData: {},
      sortOrder: 10,
      sizes: [
        { code: 'XS', widthMm: 460, heightMm: 660 },
        { code: 'S', widthMm: 480, heightMm: 680 },
        { code: 'M', widthMm: 520, heightMm: 710 },
        { code: 'L', widthMm: 560, heightMm: 740 },
        { code: 'XL', widthMm: 600, heightMm: 770 },
        { code: 'XXL', widthMm: 640, heightMm: 800 }
      ],
      colorHexes: ['#f2f2f2', '#0b0b0b', '#6b6b6b'],
      enabled: true,
      isDefault: true
    },
    {
      id: 'hoodie',
      name: 'Trui / Hoodie',
      description: 'Warme hoodie met full-color print',
      mockupPath: 'assets/tshirt_mockup.png',
      basePrice: 54.95,
      extraDesignFee: 7.50,
      priceMultiplier: 1.55,
      extraDesignFeeMultiplier: 1.1,
      colorPrices: {},
      sizePrices: { XS: 0, S: 0, M: 0, L: 0, XL: 2.0, XXL: 4.0 },
      colorData: {},
      sortOrder: 20,
      sizes: [
        { code: 'XS', widthMm: 500, heightMm: 650 },
        { code: 'S', widthMm: 530, heightMm: 680 },
        { code: 'M', widthMm: 560, heightMm: 710 },
        { code: 'L', widthMm: 590, heightMm: 740 },
        { code: 'XL', widthMm: 620, heightMm: 770 },
        { code: 'XXL', widthMm: 650, heightMm: 800 }
      ],
      colorHexes: ['#f2f2f2', '#0b0b0b', '#6b6b6b'],
      enabled: true,
      isDefault: false
    },
    {
      id: 'beachflag',
      name: 'Beachflag',
      description: 'Outdoor beachflag met custom ontwerp',
      mockupPath: 'assets/tshirt_mockup.png',
      basePrice: 84.95,
      extraDesignFee: 10.0,
      priceMultiplier: 2.4,
      extraDesignFeeMultiplier: 1.25,
      colorPrices: {},
      sizePrices: { S: 0, M: 10.0, L: 25.0 },
      colorData: {},
      sortOrder: 30,
      sizes: [
        { code: 'S', widthMm: 600, heightMm: 2300 },
        { code: 'M', widthMm: 700, heightMm: 2900 },
        { code: 'L', widthMm: 800, heightMm: 3500 }
      ],
      colorHexes: ['#f2f2f2', '#0b0b0b', '#6b6b6b'],
      enabled: true,
      isDefault: false
    },
    {
      id: 'banner',
      name: 'Spandoek',
      description: 'PVC banner voor events en acties',
      mockupPath: 'assets/tshirt_mockup.png',
      basePrice: 69.95,
      extraDesignFee: 10.0,
      priceMultiplier: 1.95,
      extraDesignFeeMultiplier: 1.15,
      colorPrices: {},
      sizePrices: { S: 0, M: 20.0, L: 45.0 },
      colorData: {},
      sortOrder: 40,
      sizes: [
        { code: 'S', widthMm: 1000, heightMm: 700 },
        { code: 'M', widthMm: 2000, heightMm: 1000 },
        { code: 'L', widthMm: 3000, heightMm: 1500 }
      ],
      colorHexes: ['#f2f2f2', '#0b0b0b', '#6b6b6b'],
      enabled: true,
      isDefault: false
    }
  ]
};

function slugifyProductId(input, fallback = 'product') {
  const raw = String(input || '').trim().toLowerCase();
  const slug = raw
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || fallback;
}

function sanitizeProducts(products) {
  const DEFAULT_SIZE_MM = {
    XS: [460, 660],
    S: [480, 680],
    M: [520, 710],
    L: [560, 740],
    XL: [600, 770],
    XXL: [640, 800]
  };
  const DEFAULT_PRODUCT_SIZES_BY_ID = {
    tshirt: [
      { code: 'XS', widthMm: 460, heightMm: 660 },
      { code: 'S', widthMm: 480, heightMm: 680 },
      { code: 'M', widthMm: 520, heightMm: 710 },
      { code: 'L', widthMm: 560, heightMm: 740 },
      { code: 'XL', widthMm: 600, heightMm: 770 },
      { code: 'XXL', widthMm: 640, heightMm: 800 }
    ],
    hoodie: [
      { code: 'XS', widthMm: 500, heightMm: 650 },
      { code: 'S', widthMm: 530, heightMm: 680 },
      { code: 'M', widthMm: 560, heightMm: 710 },
      { code: 'L', widthMm: 590, heightMm: 740 },
      { code: 'XL', widthMm: 620, heightMm: 770 },
      { code: 'XXL', widthMm: 650, heightMm: 800 }
    ],
    beachflag: [
      { code: 'S', widthMm: 600, heightMm: 2300 },
      { code: 'M', widthMm: 700, heightMm: 2900 },
      { code: 'L', widthMm: 800, heightMm: 3500 }
    ],
    banner: [
      { code: 'S', widthMm: 1000, heightMm: 700 },
      { code: 'M', widthMm: 2000, heightMm: 1000 },
      { code: 'L', widthMm: 3000, heightMm: 1500 }
    ]
  };

  const parseColorHexes = (raw) => {
    const arr = Array.isArray(raw)
      ? raw
      : String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
    const out = [];
    const seen = new Set();
    arr.forEach((v) => {
      const m = /^#?[0-9a-fA-F]{6}$/.exec(String(v || '').trim());
      if (!m) return;
      const hex = ('#' + String(v).replace(/^#/, '')).toLowerCase();
      if (seen.has(hex)) return;
      seen.add(hex);
      out.push(hex);
    });
    return out.slice(0, 20);
  };

  const parseSizeValue = (rawValue, rawUnit) => {
    const val = Number(String(rawValue || '').replace(',', '.'));
    if (!Number.isFinite(val) || val <= 0) return 0;
    const unit = String(rawUnit || 'mm').toLowerCase();
    const mm = unit === 'cm' ? (val * 10) : val;
    return Math.min(20000, Math.max(10, Math.round(mm)));
  };

  const parseProductSizes = (raw) => {
    const out = [];
    const seen = new Set();
    const addSize = (codeRaw, widthRaw = 0, heightRaw = 0, unit = 'mm') => {
      const code = String(codeRaw || '').trim().toUpperCase().replace(/\s+/g, '');
      if (!code || seen.has(code)) return;
      let widthMm = parseSizeValue(widthRaw, unit);
      let heightMm = parseSizeValue(heightRaw, unit);
      if (!widthMm || !heightMm) {
        const fallback = DEFAULT_SIZE_MM[code];
        if (fallback) {
          widthMm = fallback[0];
          heightMm = fallback[1];
        }
      }
      out.push({ code, widthMm, heightMm });
      seen.add(code);
    };

    if (Array.isArray(raw)) {
      raw.forEach((entry) => {
        if (entry && typeof entry === 'object') {
          addSize(entry.code || entry.size, entry.widthMm || entry.width || entry.w, entry.heightMm || entry.height || entry.h, entry.unit || 'mm');
        } else if (typeof entry === 'string') {
          const m = entry.match(/^\s*([A-Za-z0-9+\-]+)\s*(?::\s*([0-9]+(?:[.,][0-9]+)?)\s*[xX×]\s*([0-9]+(?:[.,][0-9]+)?)\s*(cm|mm)?)?\s*$/i);
          if (m) addSize(m[1], m[2], m[3], m[4] || 'mm');
        }
      });
    } else if (raw != null) {
      String(raw).split(/[,\n;]+/).forEach((token) => {
        const t = String(token || '').trim();
        if (!t) return;
        const m = t.match(/^([A-Za-z0-9+\-]+)\s*(?::\s*([0-9]+(?:[.,][0-9]+)?)\s*[xX×]\s*([0-9]+(?:[.,][0-9]+)?)\s*(cm|mm)?)?$/i);
        if (m) addSize(m[1], m[2], m[3], m[4] || 'mm');
      });
    }
    return out.slice(0, 20);
  };

  const src = Array.isArray(products) ? products : [];
  const out = [];
  const seen = new Set();
  src.forEach((p, idx) => {
    const idBase = slugifyProductId(p?.id || p?.name || `product-${idx + 1}`, `product-${idx + 1}`);
    if (seen.has(idBase)) return;
    seen.add(idBase);
    const name = String(p?.name || idBase).trim().slice(0, 80) || idBase;
    const description = String(p?.description || '').trim().slice(0, 240);
    const mockupPath = String(p?.mockupPath || '').trim().replace(/^\/+/, '');
    const priceMultiplierRaw = Number(p?.priceMultiplier);
    const extraFeeMultiplierRaw = Number(p?.extraDesignFeeMultiplier);
    const priceMultiplier = Number.isFinite(priceMultiplierRaw) ? Math.min(10, Math.max(0.1, priceMultiplierRaw)) : 1;
    const extraDesignFeeMultiplier = Number.isFinite(extraFeeMultiplierRaw) ? Math.min(10, Math.max(0, extraFeeMultiplierRaw)) : 1;
    const colorHexes = parseColorHexes(p?.colorHexes);

    // Direct basisprijs per product — backward-compat: null = gebruik globale basePrice × priceMultiplier
    const basePriceRaw = Number(p?.basePrice);
    const basePrice = Number.isFinite(basePriceRaw) && basePriceRaw >= 0 ? Math.round(basePriceRaw * 100) / 100 : null;
    const extraDesignFeeRaw = Number(p?.extraDesignFee);
    const extraDesignFee = Number.isFinite(extraDesignFeeRaw) && extraDesignFeeRaw >= 0 ? Math.round(extraDesignFeeRaw * 100) / 100 : null;

    // Prijsopslag per kleur: { "#hex": EUR-bedrag }
    const colorPrices = {};
    if (p?.colorPrices && typeof p.colorPrices === 'object') {
      Object.entries(p.colorPrices).forEach(([hex, val]) => {
        const h = ('#' + String(hex).replace(/^#/, '')).toLowerCase();
        const v = Number(val);
        if (/^#[0-9a-f]{6}$/.test(h) && Number.isFinite(v)) colorPrices[h] = Math.round(v * 100) / 100;
      });
    }

    // Prijsopslag per maat: { "XL": EUR-bedrag } — overschrijft globale sizeUpcharge voor dit product
    const sizePrices = {};
    if (p?.sizePrices && typeof p.sizePrices === 'object') {
      Object.entries(p.sizePrices).forEach(([size, val]) => {
        const v = Number(val);
        if (size && Number.isFinite(v)) sizePrices[String(size).toUpperCase()] = Math.round(v * 100) / 100;
      });
    }

    // Kleurspecifieke data: { "#hex": { mockupPath, priceUpcharge } }
    const colorData = {};
    if (p?.colorData && typeof p.colorData === 'object') {
      Object.entries(p.colorData).forEach(([hex, data]) => {
        if (!data || typeof data !== 'object') return;
        const h = ('#' + String(hex).replace(/^#/, '')).toLowerCase();
        if (!/^#[0-9a-f]{6}$/.test(h)) return;
        colorData[h] = {
          mockupPath: String(data.mockupPath || '').trim().replace(/^\/+/, ''),
          priceUpcharge: Math.round((Number(data.priceUpcharge) || 0) * 100) / 100
        };
      });
    }

    let sizes = parseProductSizes(p?.sizes || p?.sizeSpecs);
    if (!sizes.length) {
      const builtIn = DEFAULT_PRODUCT_SIZES_BY_ID[idBase];
      if (builtIn?.length) {
        sizes = builtIn.map((s) => ({ ...s }));
      } else {
        sizes = Object.keys(DEFAULT_SIZE_MM).map((code) => ({
          code,
          widthMm: DEFAULT_SIZE_MM[code][0],
          heightMm: DEFAULT_SIZE_MM[code][1]
        }));
      }
    }
    out.push({
      id: idBase,
      name,
      description,
      mockupPath: mockupPath || 'assets/tshirt_mockup.png',
      basePrice,
      extraDesignFee,
      priceMultiplier,
      extraDesignFeeMultiplier,
      colorPrices,
      sizePrices,
      colorData,
      sortOrder: Number.isFinite(Number(p?.sortOrder)) ? Math.max(0, Math.min(9999, Math.round(Number(p.sortOrder)))) : ((idx + 1) * 10),
      sizes,
      colorHexes,
      enabled: p?.enabled !== false,
      isDefault: !!p?.isDefault
    });
  });

  const enabled = out.filter(p => p.enabled);
  if (!enabled.length) {
    const fallback = { ...DEFAULT_CONFIG.products[0] };
    return [fallback];
  }
  let defaultIdx = out.findIndex(p => p.enabled && p.isDefault);
  if (defaultIdx < 0) defaultIdx = out.findIndex(p => p.enabled);
  out.forEach((p, idx) => { p.isDefault = idx === defaultIdx; });
  return out.sort((a, b) => {
    const aOrder = Number.isFinite(Number(a.sortOrder)) ? Number(a.sortOrder) : 9999;
    const bOrder = Number.isFinite(Number(b.sortOrder)) ? Number(b.sortOrder) : 9999;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return String(a.name || '').localeCompare(String(b.name || ''), 'nl');
  });
}

function ensureConfig() {
  if (getSetting('config') == null) setSetting('config', DEFAULT_CONFIG);
}
function getConfig() {
  ensureConfig();
  const stored = getSetting('config') || {};
  const merged = { ...DEFAULT_CONFIG, ...stored };
  merged.brand = { ...(DEFAULT_CONFIG.brand || {}), ...(stored.brand || {}) };
  merged.hero = { ...(DEFAULT_CONFIG.hero || {}), ...(stored.hero || {}) };
  merged.smtp = { ...(DEFAULT_CONFIG.smtp || {}), ...(stored.smtp || {}) };
  merged.checkout = { ...(DEFAULT_CONFIG.checkout || {}), ...(stored.checkout || {}) };
  merged.theme = { ...(DEFAULT_CONFIG.theme || {}), ...(stored.theme || {}) };
  merged.pricing = { ...(DEFAULT_CONFIG.pricing || {}), ...(stored.pricing || {}) };
  merged.pricing.sizeUpcharge = {
    ...(DEFAULT_CONFIG.pricing?.sizeUpcharge || {}),
    ...((stored.pricing && stored.pricing.sizeUpcharge) || {})
  };
  merged.conversion = { ...(DEFAULT_CONFIG.conversion || {}), ...(stored.conversion || {}) };
  if (merged.conversion.designerStep3CtaSoft === 'Toevoegen zonder betaling' || merged.conversion.designerStep3CtaSoft === 'Toevoegen aan winkelmand') {
    merged.conversion.designerStep3CtaSoft = 'Toevoegen naar winkelmand';
  }
  if (merged.conversion.designerStep3CtaStrong === 'Reserveer productieplek' || merged.conversion.designerStep3CtaStrong === 'Toevoegen aan winkelmand') {
    merged.conversion.designerStep3CtaStrong = 'Toevoegen naar winkelmand';
  }
  if (merged.conversion.cartCtaStrong === 'Reserveer nu je productieplek') {
    merged.conversion.cartCtaStrong = 'Bestelling plaatsen';
  }
  merged.company = { ...(DEFAULT_CONFIG.company || {}), ...(stored.company || {}) };
  merged.documents = { ...(DEFAULT_CONFIG.documents || {}), ...(stored.documents || {}) };
  merged.documents.invoice = { ...(DEFAULT_CONFIG.documents?.invoice || {}), ...(stored.documents?.invoice || {}) };
  merged.documents.packingSlip = { ...(DEFAULT_CONFIG.documents?.packingSlip || {}), ...(stored.documents?.packingSlip || {}) };
  merged.email = { ...(DEFAULT_CONFIG.email || {}), ...(stored.email || {}) };
  merged.email.templates = {
    ...(DEFAULT_CONFIG.email?.templates || {}),
    ...((stored.email && stored.email.templates) || {})
  };
  if (Array.isArray(merged.sizes)) merged.sizes = sortSizes(merged.sizes);
  merged.products = sanitizeProducts(merged.products);
  return merged;
}

function ensureOwner() {
  const exists = db.prepare("SELECT id FROM users WHERE role = 'OWNER' LIMIT 1").get();
  if (exists) return null;
  const email = String(process.env.OWNER_EMAIL || 'owner@nebulous.local').trim().toLowerCase();
  const password = String(process.env.OWNER_PASSWORD || 'Owner!2026');
  const firstName = String(process.env.OWNER_FIRST_NAME || 'Owner').trim().slice(0, 80) || 'Owner';
  const lastName = String(process.env.OWNER_LAST_NAME || 'Nebulous').trim().slice(0, 80) || 'Nebulous';
  const hash = bcrypt.hashSync(password, 10);
  db.prepare(`INSERT INTO users(email, password_hash, first_name, last_name, role, status, email_verified)
              VALUES(?, ?, ?, ?, 'OWNER', 'ACTIVE', 1)`)
    .run(email, hash, firstName, lastName);
  return { email, password };
}

module.exports = {
  db,
  getConfig, setSetting, getSetting,
  ensureOwner, ensureConfig,
  getOrCreateSecret,
  encryptSetting, decryptSetting,
  sortSizes,
  DEFAULT_CONFIG
};
