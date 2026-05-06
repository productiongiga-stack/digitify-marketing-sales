-- PostgreSQL schema for NEBULOUS / Digitify Marketing
-- Run this against your Supabase database to create all tables

-- ── Users ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
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
  company TEXT,
  vat_number TEXT,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  login_locked_until TIMESTAMPTZ,
  last_failed_login_at TIMESTAMPTZ,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  totp_enabled_at TIMESTAMPTZ,
  email_verified INTEGER NOT NULL DEFAULT 0,
  email_verification_token TEXT,
  email_verification_token_expires_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  newsletter_opt_in INTEGER NOT NULL DEFAULT 0,
  internal_notes TEXT,
  tags TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Settings ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ── Cart ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cart_items (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_type TEXT NOT NULL DEFAULT 'tshirt',
  product_label TEXT NOT NULL DEFAULT 'T-shirt',
  product_mockup_path TEXT,
  product_price_multiplier REAL NOT NULL DEFAULT 1,
  color_name TEXT, color_hex TEXT, size TEXT,
  qty INTEGER NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  extras_price REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  preview_path TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cart_item_designs (
  id SERIAL PRIMARY KEY,
  cart_item_id INTEGER NOT NULL REFERENCES cart_items(id) ON DELETE CASCADE,
  name TEXT, position TEXT, scale REAL, v_offset REAL, x_offset REAL, note TEXT, file_path TEXT
);

-- ── Orders ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'NEW',
  deleted_at TIMESTAMPTZ,
  deleted_by INTEGER REFERENCES users(id),
  delete_reason TEXT,
  shipping_carrier TEXT,
  tracking_code TEXT,
  tracking_url TEXT,
  shipping_status TEXT,
  shipping_last_update_at TIMESTAMPTZ,
  customer_first TEXT, customer_last TEXT, customer_email TEXT,
  customer_company TEXT, customer_vat TEXT,
  address TEXT, postcode TEXT, city TEXT, phone TEXT,
  subtotal REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_type TEXT NOT NULL DEFAULT 'tshirt',
  product_label TEXT NOT NULL DEFAULT 'T-shirt',
  product_mockup_path TEXT,
  product_price_multiplier REAL NOT NULL DEFAULT 1,
  color_name TEXT, color_hex TEXT, size TEXT,
  qty INTEGER NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  extras_price REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  preview_path TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS order_designs (
  id SERIAL PRIMARY KEY,
  order_item_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  name TEXT, position TEXT, scale REAL, v_offset REAL, x_offset REAL, note TEXT, file_path TEXT
);

CREATE TABLE IF NOT EXISTS order_status_history (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  note TEXT,
  changed_by INTEGER REFERENCES users(id),
  changed_by_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Payments ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'CREATED',
  amount REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'EUR',
  checkout_url TEXT,
  provider_payment_id TEXT,
  provider_checkout_id TEXT,
  payment_link_expires_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  failure_reason TEXT,
  metadata TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Invoices ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  invoice_number TEXT,
  status TEXT NOT NULL DEFAULT 'CONCEPT',
  issue_date TIMESTAMPTZ,
  due_date TIMESTAMPTZ,
  finalized_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  last_reminder_at TIMESTAMPTZ,
  reminder_count INTEGER NOT NULL DEFAULT 0,
  metadata TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Email tracking ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_tracking (
  id SERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  email_type TEXT NOT NULL,
  recipient TEXT,
  sent_at TIMESTAMPTZ,
  first_opened_at TIMESTAMPTZ,
  open_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Shipping events ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shipping_events (
  id SERIAL PRIMARY KEY,
  event_key TEXT UNIQUE,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  carrier TEXT,
  status_raw TEXT,
  status_normalized TEXT,
  tracking_code TEXT,
  event_at TIMESTAMPTZ,
  payload_json TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Deposit invoices ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deposit_invoices (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  linked_final_invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  invoice_number TEXT,
  status TEXT NOT NULL DEFAULT 'DEFINITIVE',
  deposit_percentage REAL,
  deposit_amount REAL NOT NULL DEFAULT 0,
  issue_date TIMESTAMPTZ,
  due_date TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  metadata TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Audit log ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_email TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  summary TEXT NOT NULL,
  details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_deleted_at ON orders(deleted_at);
CREATE INDEX IF NOT EXISTS idx_orders_shipping_status ON orders(shipping_status);
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

-- ── Auto-update triggers ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payments_updated_at ON payments;
CREATE TRIGGER trg_payments_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_invoices_updated_at ON invoices;
CREATE TRIGGER trg_invoices_updated_at
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_deposit_invoices_updated_at ON deposit_invoices;
CREATE TRIGGER trg_deposit_invoices_updated_at
  BEFORE UPDATE ON deposit_invoices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
