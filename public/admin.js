// ==========================================================================
// NEBULOUS — Admin/Owner panel
// ==========================================================================

const STATUS_CHOICES = [
  ['NEW', 'Nieuw'],
  ['APPROVED', 'Goedgekeurd'],
  ['APPROVED_AWAITING_PAYMENT', 'Goedgekeurd (wacht op betaling)'],
  ['PAYMENT_PENDING', 'Betaling in behandeling'],
  ['PAID', 'Betaald'],
  ['IN_PRODUCTION', 'In productie'],
  ['SHIPPED', 'Verzonden'], ['DELIVERED', 'Bezorgd'], ['CANCELLED', 'Geannuleerd']
];
const ROLE_CHOICES = ['USER', 'ADMIN', 'OWNER'];
const STATUS_USER_CHOICES = [['PENDING', 'In afwachting'], ['ACTIVE', 'Actief'], ['BLOCKED', 'Geblokkeerd']];
const EMAIL_TEMPLATES = [
  { key: 'orderPlaced', label: '📦 Bestelling geplaatst' },
  { key: 'paymentLink', label: '💳 Betaallink' },
  { key: 'offerSent', label: '🧾 Offerte verstuurd' },
  { key: 'paymentReceived', label: '✅ Betaling ontvangen' },
  { key: 'invoiceReminder', label: '🔔 Factuurherinnering' },
  { key: 'orderStatusChanged', label: '🔄 Statuswijziging' },
  { key: 'accountApproved', label: '👤 Account goedgekeurd' },
  { key: 'emailVerification', label: '✉️ E-mailverificatie' },
  { key: 'passwordReset', label: '🔑 Wachtwoord reset' }
];
const THEME_PRESETS = {
  GREEN: { accentColor: '#22c55e', accentColor2: '#84cc16', headingFont: 'SPACE_GROTESK', bodyFont: 'INTER', buttonStyle: 'PILL', sectionTone: 'BOLD' },
  BLUE: { accentColor: '#3b82f6', accentColor2: '#0ea5e9', headingFont: 'POPPINS', bodyFont: 'INTER', buttonStyle: 'ROUNDED', sectionTone: 'MUTED' },
  NEUTRAL: { accentColor: '#e5e7eb', accentColor2: '#a3a3a3', headingFont: 'SERIF', bodyFont: 'SYSTEM', buttonStyle: 'SHARP', sectionTone: 'FLAT' }
};
const THEME_PRESET_META = {
  GREEN: { label: 'Green Atelier', note: 'Levendig, premium en conversion-gericht' },
  BLUE: { label: 'Blue Studio', note: 'Strak, helder en trust-first' },
  NEUTRAL: { label: 'Neutral Editorial', note: 'Rustig, chic en productgericht' }
};

let CURRENT_USER = null;
let ORDER_STATE = { page: 1, limit: 20, q: '', status: '', invoiceStatus: '', archived: 'ACTIVE' };
let ORDER_SELECTION = new Set();
let INVOICE_OVERVIEW_STATE = { status: 'OPEN', sort: 'DUE_ASC', limit: 20 };
let INVOICE_SELECTION = new Set();
let AUDIT_STATE = { page: 1, limit: 30, q: '', action: '' };
let CURRENT_SETTINGS_STAB = 'algemeen';
let NEWSLETTER_STATE = { q: '' };

function updateBulkBar() {
  const bar = document.getElementById('ordersBulkBar');
  const countEl = document.getElementById('ordersBulkCount');
  const count = ORDER_SELECTION.size;
  if (countEl) countEl.textContent = `${count} geselecteerd`;
  if (bar) bar.hidden = count === 0;
}

function clearOrderSelection() {
  ORDER_SELECTION.clear();
  document.querySelectorAll('[data-order-select]').forEach(el => { el.checked = false; });
  const all = document.getElementById('orderSelectAll');
  if (all) all.checked = false;
  updateBulkBar();
}

function syncOrderSelectAllState() {
  const boxes = Array.from(document.querySelectorAll('[data-order-select]'));
  const all = document.getElementById('orderSelectAll');
  if (!all) return;
  if (!boxes.length) {
    all.checked = false;
    all.indeterminate = false;
    return;
  }
  const selectedOnPage = boxes.filter(b => b.checked).length;
  all.checked = selectedOnPage > 0 && selectedOnPage === boxes.length;
  all.indeterminate = selectedOnPage > 0 && selectedOnPage < boxes.length;
}

async function applyBulkOrderStatus() {
  if (!ORDER_SELECTION.size) return;
  const select = document.getElementById('bulkOrderStatus');
  const status = String(select?.value || '');
  if (!status) return NEB.toast('Kies eerst een status voor de bulkactie', 'error');

  const ids = Array.from(ORDER_SELECTION);
  try {
    const res = await NEB.put('/api/admin/orders/bulk-status', { orderIds: ids, status });
    const s = res?.summary || {};
    NEB.toast(`${s.changed || 0} orders bijgewerkt (${s.skipped || 0} ongewijzigd)`, 'success');
    clearOrderSelection();
    if (select) select.value = '';
    await loadOrders();
    NEB.paintAdminBadges();
  } catch (err) {
    NEB.toast(err.message || 'Bulkactie mislukt', 'error');
  }
}

async function applyBulkOrderArchive() {
  if (!ORDER_SELECTION.size) return;
  const ids = Array.from(ORDER_SELECTION);
  const yes = confirm(`Wil je ${ids.length} geselecteerde bestelling(en) archiveren?`);
  if (!yes) return;
  try {
    const res = await NEB.post('/api/admin/orders/bulk-delete', { orderIds: ids, reason: 'Bulk archiveren via admin' });
    const s = res?.summary || {};
    NEB.toast(`${s.updated || 0} gearchiveerd (${s.skipped || 0} overgeslagen)`, 'success');
    clearOrderSelection();
    await loadOrders();
    NEB.paintAdminBadges();
  } catch (err) {
    const msg = String(err?.message || 'Bulk archiveren mislukt');
    if (/404/.test(msg)) {
      NEB.toast('Route niet actief — server herstart nodig', 'error');
      return;
    }
    NEB.toast(msg, 'error');
  }
}

function escAttr(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function escText(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

function shippingStatusLabel(code) {
  const map = {
    PENDING: 'Aangemaakt',
    LABEL_CREATED: 'Label aangemaakt',
    IN_TRANSIT: 'Onderweg',
    OUT_FOR_DELIVERY: 'Onderweg naar levering',
    DELIVERED: 'Bezorgd',
    FAILED_ATTEMPT: 'Mislukte levering',
    RETURNED: 'Retour',
    EXCEPTION: 'Probleem',
    UNKNOWN: 'Onbekend'
  };
  return map[String(code || '').toUpperCase()] || 'Onbekend';
}

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

function normalizeProducts(products) {
  const normalizeHex = (raw) => {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(String(raw || '').trim());
    return m ? `#${m[1].toLowerCase()}` : '';
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
  const seen = new Set();
  const out = [];
  src.forEach((p, idx) => {
    const id = slugifyProductId(p?.id || p?.name || `product-${idx + 1}`, `product-${idx + 1}`);
    if (seen.has(id)) return;
    seen.add(id);
    let sizes = parseProductSizes(p?.sizes || p?.sizeSpecs);
    if (!sizes.length) {
      const builtIn = DEFAULT_PRODUCT_SIZES_BY_ID[id];
      if (builtIn?.length) sizes = builtIn.map((s) => ({ ...s }));
      else {
        sizes = Object.keys(DEFAULT_SIZE_MM).map((code) => ({
          code,
          widthMm: DEFAULT_SIZE_MM[code][0],
          heightMm: DEFAULT_SIZE_MM[code][1]
        }));
      }
    }
    const colorPrices = {};
    if (p?.colorPrices && typeof p.colorPrices === 'object') {
      Object.entries(p.colorPrices).forEach(([hex, val]) => {
        const h = normalizeHex(hex);
        const v = Number(val);
        if (!h || !Number.isFinite(v)) return;
        colorPrices[h] = Math.round(Math.max(0, v) * 100) / 100;
      });
    }

    const sizePrices = {};
    if (p?.sizePrices && typeof p.sizePrices === 'object') {
      Object.entries(p.sizePrices).forEach(([size, val]) => {
        const code = String(size || '').trim().toUpperCase();
        const v = Number(val);
        if (!code || !Number.isFinite(v)) return;
        sizePrices[code] = Math.round(Math.max(0, v) * 100) / 100;
      });
    }

    const colorData = {};
    if (p?.colorData && typeof p.colorData === 'object') {
      Object.entries(p.colorData).forEach(([hex, row]) => {
        const h = normalizeHex(hex);
        if (!h || !row || typeof row !== 'object') return;
        const up = Number(row.priceUpcharge);
        colorData[h] = {
          mockupPath: String(row.mockupPath || '').trim().replace(/^\/+/, ''),
          priceUpcharge: Number.isFinite(up) ? Math.round(Math.max(0, up) * 100) / 100 : 0
        };
      });
    }

    const basePriceRaw = Number(p?.basePrice);
    const extraDesignFeeRaw = Number(p?.extraDesignFee);

    out.push({
      id,
      name: String(p?.name || `Product ${idx + 1}`),
      description: String(p?.description || ''),
      mockupPath: String(p?.mockupPath || 'assets/tshirt_mockup.png'),
      basePrice: Number.isFinite(basePriceRaw) ? Math.max(0, Math.round(basePriceRaw * 100) / 100) : null,
      extraDesignFee: Number.isFinite(extraDesignFeeRaw) ? Math.max(0, Math.round(extraDesignFeeRaw * 100) / 100) : null,
      priceMultiplier: Number.isFinite(Number(p?.priceMultiplier)) ? Number(p.priceMultiplier) : 1,
      extraDesignFeeMultiplier: Number.isFinite(Number(p?.extraDesignFeeMultiplier)) ? Number(p.extraDesignFeeMultiplier) : 1,
      colorPrices,
      sizePrices,
      colorData,
      sizes,
      colorHexes: parseColorHexes(p?.colorHexes),
      enabled: p?.enabled !== false,
      isDefault: !!p?.isDefault,
      sortOrder: Number.isFinite(Number(p?.sortOrder)) ? Math.max(0, Math.min(9999, Math.round(Number(p.sortOrder)))) : ((idx + 1) * 10)
    });
  });

  if (!out.length) {
    return [{
      id: 'tshirt',
      name: 'T-shirt',
      description: 'Premium unisex T-shirt',
      mockupPath: 'assets/tshirt_mockup.png',
      basePrice: null,
      extraDesignFee: null,
      priceMultiplier: 1,
      extraDesignFeeMultiplier: 1,
      colorPrices: {},
      sizePrices: {},
      colorData: {},
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
    }];
  }
  if (!out.some(p => p.enabled)) out[0].enabled = true;
  let defaultIdx = out.findIndex(p => p.enabled && p.isDefault);
  if (defaultIdx < 0) defaultIdx = out.findIndex(p => p.enabled);
  out.forEach((p, idx) => { p.isDefault = idx === defaultIdx; });
  return out.sort((a, b) => {
    const ao = Number.isFinite(Number(a.sortOrder)) ? Number(a.sortOrder) : 9999;
    const bo = Number.isFinite(Number(b.sortOrder)) ? Number(b.sortOrder) : 9999;
    if (ao !== bo) return ao - bo;
    return String(a.name || '').localeCompare(String(b.name || ''), 'nl');
  });
}

function interpolateTemplate(raw, vars) {
  return String(raw || '').replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_m, key) => {
    const v = vars[key];
    return v == null ? '' : String(v);
  });
}

function sanitizePreviewHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
}

function buildPreviewVars(config = {}) {
  const companyName = config?.company?.legalName || config?.brand?.name || 'NEBULOUS';
  const theme = config?.theme || {};
  const logoPathRaw = String(theme.logoPath || '').trim();
  const faviconPathRaw = String(theme.faviconPath || '').trim();
  const toAbs = (raw) => {
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    return '/' + raw.replace(/^\/+/, '');
  };
  return {
    orderId: '0042',
    customerName: 'Sophie Vermeulen',
    orderTotal: '€49,95',
    paymentUrl: 'https://checkout.stripe.com/c/pay/cs_test_12345',
    paymentExpiresAt: '15/05/2026 14:00',
    invoiceNumber: 'INV-2026-000042',
    invoiceDueDate: '18/05/2026',
    invoiceStatusLabel: 'Definitief',
    dashboardUrl: 'https://example.com/dashboard',
    loginUrl: 'https://example.com/login',
    companyName,
    supportEmail: config?.company?.supportEmail || config?.email?.fromAddress || '[email protected]',
    orderStatusLabel: 'In productie',
    year: String(new Date().getFullYear()),
    brandName: companyName,
    brandLogoUrl: toAbs(logoPathRaw),
    brandFaviconUrl: toAbs(faviconPathRaw),
    brandAccentColor: String(theme.accentColor || '#111827')
  };
}

function renderTemplatePreviewFrame(template, config) {
  const vars = buildPreviewVars(config);
  const subject = interpolateTemplate(template?.subject || '', vars);
  const html = sanitizePreviewHtml(interpolateTemplate(template?.html || '', vars));
  const body = html || '<p style="color:#666">Geen HTML-inhoud.</p>';
  const accent = /^#[0-9a-fA-F]{6}$/.test(vars.brandAccentColor) ? vars.brandAccentColor : '#111827';
  const logoBlock = vars.brandLogoUrl
    ? `<img src="${escAttr(vars.brandLogoUrl)}" alt="${escAttr(vars.brandName)}" style="max-height:30px;max-width:120px;display:block">`
    : `<span style="display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;background:${escAttr(accent)};color:#fff;font-size:16px;font-weight:700">✦</span>`;

  return `
    <div class="mail-preview-shell">
      <div class="mail-preview-header">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <div style="display:flex;align-items:center;gap:9px">${logoBlock}<strong style="font-size:.78rem;color:#111">${escText(vars.brandName)}</strong></div>
          <span style="font-size:.68rem;color:#667085">Automatisch</span>
        </div>
      </div>
      <div style="padding:.65rem .95rem;border-bottom:1px solid #ececec;background:#fafbff">
        <div class="mail-preview-subject">${escText(subject || '(geen onderwerp)')}</div>
      </div>
      <div class="mail-preview-body">${body}</div>
    </div>
  `;
}

function normalizedTemplateValue(value) {
  return String(value == null ? '' : value).replace(/\r\n/g, '\n');
}

function templateChanged(a = {}, b = {}) {
  return normalizedTemplateValue(a.subject) !== normalizedTemplateValue(b.subject)
    || normalizedTemplateValue(a.html) !== normalizedTemplateValue(b.html);
}

function renderTemplateDiffHtml(saved = {}, current = {}) {
  const oldSubject = normalizedTemplateValue(saved.subject || '');
  const newSubject = normalizedTemplateValue(current.subject || '');
  const oldHtml = normalizedTemplateValue(saved.html || '');
  const newHtml = normalizedTemplateValue(current.html || '');

  const subjectSame = oldSubject === newSubject;
  const htmlSame = oldHtml === newHtml;

  return `
    <div class="tmpl-diff-grid">
      <div class="tmpl-diff-col">
        <h4>Laatst opgeslagen</h4>
        <div class="tmpl-diff-block ${subjectSame ? 'same' : 'changed'}">
          <label>Onderwerp</label>
          <pre>${escText(oldSubject || '(leeg)')}</pre>
        </div>
        <div class="tmpl-diff-block ${htmlSame ? 'same' : 'changed'}">
          <label>HTML</label>
          <pre>${escText(oldHtml || '(leeg)')}</pre>
        </div>
      </div>
      <div class="tmpl-diff-col">
        <h4>Huidig concept</h4>
        <div class="tmpl-diff-block ${subjectSame ? 'same' : 'changed'}">
          <label>Onderwerp</label>
          <pre>${escText(newSubject || '(leeg)')}</pre>
        </div>
        <div class="tmpl-diff-block ${htmlSame ? 'same' : 'changed'}">
          <label>HTML</label>
          <pre>${escText(newHtml || '(leeg)')}</pre>
        </div>
      </div>
    </div>
  `;
}

function formatAuditDetails(details) {
  if (!details) return '';
  try {
    const parsed = typeof details === 'string' ? JSON.parse(details) : details;
    return escText(JSON.stringify(parsed, null, 2));
  } catch {
    return escText(String(details));
  }
}

(async function init() {
  CURRENT_USER = await NEB.requireAuth(['ADMIN', 'OWNER']);
  if (!CURRENT_USER) return;
  window.NEB_USER = CURRENT_USER;
  await NEB.paintNav();

  document.getElementById('welcome').textContent =
    CURRENT_USER.role === 'OWNER'
      ? 'Beheer bestellingen, klanten en winkelinstellingen.'
      : 'Beheer bestellingen.';

  if (CURRENT_USER.role === 'OWNER') {
    document.querySelectorAll('[data-owner-only]').forEach(el => el.hidden = false);
    const settingsTabs = document.getElementById('settingsTabs');
    if (settingsTabs && !settingsTabs._stabClickHandler) {
      settingsTabs._stabClickHandler = (e) => {
        const btn = e.target.closest('.stab[data-stab]');
        if (!btn) return;
        applySettingsSubTab(btn.dataset.stab);
      };
      settingsTabs.addEventListener('click', settingsTabs._stabClickHandler);
    }
  }

  setupTabs();
  setupOrdersSubTabs();
  await loadOrders();
  NEB.paintAdminBadges();
  setInterval(() => NEB.paintAdminBadges(), 30000);
  // Load notification badge count in background for all staff
  if (['ADMIN', 'OWNER'].includes(CURRENT_USER.role)) {
    NEB.get('/api/admin/notifications').then(updateNotifBadge).catch(() => {});
  }

  document.getElementById('backupBtn')?.addEventListener('click', () => {
    location.href = '/api/admin/backup';
  });
  const restoreBtn = document.getElementById('restoreBackupBtn');
  const restoreFile = document.getElementById('restoreBackupFile');
  restoreBtn?.addEventListener('click', () => restoreFile?.click());
  restoreFile?.addEventListener('change', async () => {
    const file = restoreFile.files?.[0];
    if (!file) return;
    const c1 = confirm('Backup herstellen overschrijft ALLE huidige data (users, orders, settings). Verdergaan?');
    if (!c1) { restoreFile.value = ''; return; }
    const c2 = confirm('Laatste bevestiging: dit kan je niet ongedaan maken. Backup nu herstellen?');
    if (!c2) { restoreFile.value = ''; return; }

    const fd = new FormData();
    fd.append('backup', file, file.name || 'restore.sqlite');
    restoreBtn.disabled = true;
    const oldTxt = restoreBtn.textContent;
    restoreBtn.textContent = 'Herstellen...';
    try {
      await NEB.post('/api/admin/backup/restore', fd);
      NEB.toast('Backup hersteld. Je wordt opnieuw ingelogd.', 'success');
      setTimeout(() => { location.href = '/login?restored=1'; }, 500);
    } catch (err) {
      NEB.toast(err.message || 'Backup herstellen mislukt', 'error');
    } finally {
      restoreBtn.disabled = false;
      restoreBtn.textContent = oldTxt || 'Herstel uit upload';
      restoreFile.value = '';
    }
  });

  // Live search/filter
  let qTimer;
  document.getElementById('orderQ')?.addEventListener('input', e => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { ORDER_STATE.q = e.target.value.trim(); ORDER_STATE.page = 1; loadOrders(); }, 250);
  });
  document.getElementById('orderStatus')?.addEventListener('change', e => {
    ORDER_STATE.status = e.target.value; ORDER_STATE.page = 1; loadOrders();
  });
  document.getElementById('orderInvoiceStatus')?.addEventListener('change', e => {
    ORDER_STATE.invoiceStatus = e.target.value; ORDER_STATE.page = 1; loadOrders();
  });
  document.getElementById('orderArchived')?.addEventListener('change', e => {
    ORDER_STATE.archived = String(e.target.value || 'ACTIVE').toUpperCase();
    ORDER_STATE.page = 1;
    clearOrderSelection();
    loadOrders();
  });
  document.getElementById('bulkApplyBtn')?.addEventListener('click', applyBulkOrderStatus);
  document.getElementById('bulkArchiveBtn')?.addEventListener('click', applyBulkOrderArchive);
  document.getElementById('bulkClearBtn')?.addEventListener('click', () => {
    clearOrderSelection();
    const select = document.getElementById('bulkOrderStatus');
    if (select) select.value = '';
  });

  if (CURRENT_USER.role === 'OWNER') {
    let auditTimer;
    document.getElementById('auditQ')?.addEventListener('input', (e) => {
      clearTimeout(auditTimer);
      auditTimer = setTimeout(() => {
        AUDIT_STATE.q = e.target.value.trim();
        AUDIT_STATE.page = 1;
        loadAudit();
      }, 250);
    });
    document.getElementById('auditAction')?.addEventListener('change', (e) => {
      AUDIT_STATE.action = e.target.value;
      AUDIT_STATE.page = 1;
      loadAudit();
    });
  }
})();

function setupOrdersSubTabs() {
  const bar = document.getElementById('ordersSubTabBar');
  if (!bar) return;
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-orders-subtab]');
    if (!btn) return;
    const name = btn.dataset.ordersSubtab;
    bar.querySelectorAll('.orders-subtab').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.orders-subtab-panel').forEach(p => {
      p.classList.toggle('active', p.id === `orders-subpanel-${name}`);
    });
  });
}

function setupTabs() {
  const tabs = document.getElementById('tabs');
  const panels = {
    orders: document.getElementById('panel-orders'),
    users: document.getElementById('panel-users'),
    settings: document.getElementById('panel-settings'),
    audit: document.getElementById('panel-audit'),
    meldingen: document.getElementById('panel-meldingen')
  };

  async function activateTab(name) {
    if (!panels[name]) return;
    tabs.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === name));
    Object.values(panels).forEach(p => p && p.classList.remove('active'));
    panels[name].classList.add('active');
    // Stop any existing notification refresh timer
    if (_notifTimer) { clearInterval(_notifTimer); _notifTimer = null; }
    if (name === 'users') await loadUsers();
    if (name === 'settings') await loadSettings();
    if (name === 'audit') await loadAudit();
    if (name === 'meldingen') {
      await loadNotifications();
      // Auto-refresh every 60 seconds while on this tab
      _notifTimer = setInterval(loadNotifications, 60000);
    }
  }

  // Activate tab from URL ?tab= param on initial load
  const urlTab = new URLSearchParams(location.search).get('tab');
  if (urlTab && panels[urlTab]) {
    activateTab(urlTab);
  }

  tabs.addEventListener('click', async (e) => {
    const t = e.target.closest('.tab');
    if (!t) return;
    activateTab(t.dataset.tab);
  });
}

function applySettingsSubTab(stab) {
  const tabsWrap = document.getElementById('settingsTabs');
  const settingsWrap = document.getElementById('settingsWrap');
  if (!tabsWrap || !settingsWrap) return;

  const available = new Set(Array.from(settingsWrap.querySelectorAll('.stab-panel')).map((el) => String(el.dataset.stab || '')));
  const requested = String(stab || '').trim();
  const active = available.has(requested) ? requested : (available.has('algemeen') ? 'algemeen' : (available.values().next().value || ''));
  if (!active) return;

  CURRENT_SETTINGS_STAB = active;
  tabsWrap.querySelectorAll('.stab').forEach((btn) => {
    btn.classList.toggle('active', String(btn.dataset.stab || '') === active);
  });
  settingsWrap.querySelectorAll('.stab-panel').forEach((panel) => {
    panel.classList.toggle('active', String(panel.dataset.stab || '') === active);
  });
}

// ── Orders ────────────────────────────────────────────────────────────────
async function loadOrders() {
  const { page, limit, q, status, invoiceStatus, archived } = ORDER_STATE;
  const params = new URLSearchParams({ page, limit, q, status, invoiceStatus, archived });
  const invParams = new URLSearchParams({
    status: INVOICE_OVERVIEW_STATE.status,
    sort: INVOICE_OVERVIEW_STATE.sort,
    limit: INVOICE_OVERVIEW_STATE.limit
  });
  const [data, invoiceData] = await Promise.all([
    NEB.get('/api/admin/orders?' + params.toString()),
    NEB.get('/api/admin/invoices?' + invParams.toString())
  ]);
  const csvLink = document.querySelector('#ordersToolbar a[href^="/api/admin/orders.csv"]');
  if (csvLink) {
    const csvParams = new URLSearchParams();
    if (archived) csvParams.set('archived', archived);
    csvLink.href = '/api/admin/orders.csv' + (csvParams.toString() ? `?${csvParams.toString()}` : '');
  }

  // Stats
  const stats = document.getElementById('orderStats');
  const s = data.stats || {};
  ORDER_STATE.archived = String(data.archived || ORDER_STATE.archived || 'ACTIVE').toUpperCase();
  const archivedSel = document.getElementById('orderArchived');
  if (archivedSel && archivedSel.value !== ORDER_STATE.archived) archivedSel.value = ORDER_STATE.archived;
  stats.innerHTML = `
    <div class="stat"><div class="stat-label">Totale orders</div><div class="stat-value">${s.total_orders || 0}</div></div>
    <div class="stat"><div class="stat-label">Open</div><div class="stat-value">${s.open_count || 0}</div></div>
    <div class="stat"><div class="stat-label">Verzonden + bezorgd</div><div class="stat-value">${s.done_count || 0}</div></div>
    <div class="stat"><div class="stat-label">Bruto omzet</div><div class="stat-value">${NEB.fmtEUR(s.revenue || 0)}</div></div>
  `;
  renderInvoiceOverview(invoiceData);

  const wrap = document.getElementById('ordersWrap');
  if (!data.orders.length) {
    clearOrderSelection();
    const emptyText = ORDER_STATE.archived === 'DELETED'
      ? 'Geen gearchiveerde bestellingen gevonden.'
      : ORDER_STATE.archived === 'ALL'
        ? 'Geen bestellingen gevonden voor deze filters.'
        : 'Pas je filters aan of wacht tot er nieuwe orders binnenkomen.';
    wrap.innerHTML = `<div class="card empty-state"><h3>Geen bestellingen gevonden</h3><p>${emptyText}</p></div>`;
    document.getElementById('pager').innerHTML = '';
    return;
  }
  const visibleIds = new Set(data.orders.map(o => Number(o.id)));
  ORDER_SELECTION = new Set(Array.from(ORDER_SELECTION).filter(id => visibleIds.has(Number(id))));
  updateBulkBar();
  wrap.innerHTML = `
    <div class="table-wrap">
      <table class="tbl">
        <thead><tr>
          <th class="cell-select"><input type="checkbox" id="orderSelectAll" aria-label="Selecteer alle orders op deze pagina"></th>
          <th>Preview</th><th>#</th><th>Klant</th><th>Items</th><th>Status</th><th>Datum</th>
          <th style="text-align:right">Totaal</th><th></th>
        </tr></thead>
        <tbody>
          ${data.orders.map((o) => {
            const isArchived = !!o.deleted_at;
            const rowPill = isArchived
              ? '<span class="pill pill-cancelled">Gearchiveerd</span>'
              : NEB.statusPill(o.status);
            const shippingPill = o.shipping_status
              ? `<span class="pill pill-neutral">${escText(shippingStatusLabel(o.shipping_status))}</span>`
              : '';
            return `
              <tr class="${isArchived ? 'row-archived' : ''}">
                <td class="cell-select"><input type="checkbox" data-order-select="${o.id}" ${ORDER_SELECTION.has(Number(o.id)) ? 'checked' : ''} aria-label="Selecteer order ${o.id}"></td>
                <td>${o.preview_path ? `<img class="thumb" src="/${o.preview_path}" alt="">` : '<div class="thumb"></div>'}</td>
                <td><strong>#${String(o.id).padStart(4, '0')}</strong></td>
                <td>${(o.customer_first || '') + ' ' + (o.customer_last || '')}<br><small class="muted">${o.customer_email || o.user_email || ''}</small></td>
                <td>${o.item_count} item${o.item_count === 1 ? '' : 's'}</td>
                <td>
                  <select class="select-inline" data-status="${o.id}" ${isArchived ? 'disabled' : ''}>
                    ${STATUS_CHOICES.map(([v, l]) => `<option value="${v}" ${o.status === v ? 'selected' : ''}>${l}</option>`).join('')}
                  </select>
                  <div style="margin-top:.45rem;display:flex;flex-wrap:wrap;gap:.35rem">
                    ${rowPill}
                    ${shippingPill}
                    ${o.invoice_status ? NEB.invoiceStatusPill({ status: o.invoice_status, overdue: Number(o.invoice_overdue || 0) === 1 }) : '<span class="muted compact">Geen factuurstatus</span>'}
                    ${o.invoice_status ? (NEB.invoiceDuePill({ status: o.invoice_status, due_date: o.invoice_due_date, overdue: Number(o.invoice_overdue || 0) === 1 }) || '') : ''}
                  </div>
                </td>
                <td>${NEB.fmtDate(o.created_at)}</td>
                <td style="text-align:right"><strong>${NEB.fmtEUR(o.total)}</strong></td>
                <td>
                  <div class="row-actions">
                    <button class="btn btn-ghost btn-sm" data-view="${o.id}">Bekijk</button>
                    ${isArchived
                      ? `<button class="btn btn-primary btn-sm" data-restore-order="${o.id}">Terugzetten</button>`
                      : `<button class="btn btn-danger btn-sm" data-delete-order="${o.id}">Archiveren</button>`}
                  </div>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>`;
  syncOrderSelectAllState();

  // Pager
  const pager = document.getElementById('pager');
  if (data.pages > 1) {
    let buttons = '';
    for (let i = 1; i <= data.pages; i++) {
      buttons += `<button data-page="${i}" class="${i === data.page ? 'active' : ''}">${i}</button>`;
    }
    pager.innerHTML = `
      <button data-page="${Math.max(1, data.page - 1)}" ${data.page === 1 ? 'disabled' : ''}>‹</button>
      ${buttons}
      <button data-page="${Math.min(data.pages, data.page + 1)}" ${data.page === data.pages ? 'disabled' : ''}>›</button>`;
    pager.onclick = e => {
      const p = e.target.closest('[data-page]')?.dataset.page;
      if (p) { ORDER_STATE.page = Number(p); loadOrders(); }
    };
  } else { pager.innerHTML = ''; }

  wrap.onchange = async (e) => {
    if (e.target.id === 'orderSelectAll') {
      const checked = !!e.target.checked;
      wrap.querySelectorAll('[data-order-select]').forEach(cb => {
        cb.checked = checked;
        const id = Number(cb.dataset.orderSelect);
        if (!Number.isInteger(id)) return;
        if (checked) ORDER_SELECTION.add(id);
        else ORDER_SELECTION.delete(id);
      });
      syncOrderSelectAllState();
      updateBulkBar();
      return;
    }
    const selectedId = e.target.dataset?.orderSelect;
    if (selectedId) {
      const id = Number(selectedId);
      if (Number.isInteger(id)) {
        if (e.target.checked) ORDER_SELECTION.add(id);
        else ORDER_SELECTION.delete(id);
      }
      syncOrderSelectAllState();
      updateBulkBar();
      return;
    }
    const id = e.target.dataset?.status;
    if (!id) return;
    try {
      await NEB.put(`/api/admin/orders/${id}/status`, { status: e.target.value });
      NEB.toast('Status bijgewerkt', 'success');
      NEB.paintAdminBadges();
    } catch (err) { NEB.toast(err.message, 'error'); }
  };
  wrap.onclick = (e) => {
    const restoreId = e.target.closest('[data-restore-order]')?.dataset.restoreOrder;
    if (restoreId) {
      restoreOrderById(Number(restoreId));
      return;
    }
    const delId = e.target.closest('[data-delete-order]')?.dataset.deleteOrder;
    if (delId) {
      deleteOrderById(Number(delId));
      return;
    }
    const id = e.target.closest('[data-view]')?.dataset.view;
    if (id) showOrderDetail(id);
  };
}

async function deleteOrderById(id, onDone = null) {
  const orderId = Number(id || 0);
  if (!orderId) return;
  const yes = confirm(`Order #${String(orderId).padStart(4, '0')} archiveren? Je kan dit later nog terugzetten via Archief.`);
  if (!yes) return;
  try {
    await NEB.del(`/api/admin/orders/${orderId}`);
    NEB.toast('Order gearchiveerd', 'success');
    if (typeof onDone === 'function') await onDone();
    await loadOrders();
    NEB.paintAdminBadges();
  } catch (err) {
    const msg = String(err?.message || '');
    if (/404/.test(msg)) {
      NEB.toast('Route niet actief — server herstart nodig', 'error');
      return;
    }
    NEB.toast(msg || 'Order archiveren mislukt', 'error');
  }
}

async function restoreOrderById(id, onDone = null) {
  const orderId = Number(id || 0);
  if (!orderId) return;
  try {
    await NEB.post(`/api/admin/orders/${orderId}/restore`, {});
    NEB.toast('Order teruggezet', 'success');
    if (typeof onDone === 'function') await onDone();
    await loadOrders();
    NEB.paintAdminBadges();
  } catch (err) {
    NEB.toast(err.message || 'Order terugzetten mislukt', 'error');
  }
}

function renderInvoiceOverview(invoiceData) {
  const mount = document.getElementById('invoiceOverview');
  if (!mount) return;
  const rows = Array.isArray(invoiceData?.invoices) ? invoiceData.invoices : [];
  const s = invoiceData?.stats || {};
  // Update the Facturen tab badge
  const invBadge = document.getElementById('invoiceBadge');
  if (invBadge) {
    const badgeCount = (s.open_count || 0) + (s.overdue_count || 0);
    invBadge.textContent = badgeCount;
    invBadge.hidden = badgeCount === 0;
  }
  const visibleIds = new Set(rows.map(r => Number(r.id)));
  INVOICE_SELECTION = new Set(Array.from(INVOICE_SELECTION).filter(id => visibleIds.has(Number(id))));
  const selectedCount = INVOICE_SELECTION.size;
  const currentStatus = String(INVOICE_OVERVIEW_STATE.status || 'OPEN').toUpperCase();
  const currentSort = String(INVOICE_OVERVIEW_STATE.sort || 'DUE_ASC').toUpperCase();
  const csvCurrent = `/api/admin/invoices.csv?status=${encodeURIComponent(currentStatus)}&sort=${encodeURIComponent(currentSort)}`;
  const csvOpen = `/api/admin/invoices.csv?status=OPEN&sort=${encodeURIComponent(currentSort)}`;
  const csvOverdue = `/api/admin/invoices.csv?status=OVERDUE&sort=${encodeURIComponent(currentSort)}`;

  const controls = `
    <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
      <select id="invOverviewStatus" class="select-inline">
        <option value="OPEN" ${currentStatus === 'OPEN' ? 'selected' : ''}>Open</option>
        <option value="OVERDUE" ${currentStatus === 'OVERDUE' ? 'selected' : ''}>Overdue</option>
        <option value="CONCEPT" ${currentStatus === 'CONCEPT' ? 'selected' : ''}>Concept</option>
        <option value="DEFINITIVE" ${currentStatus === 'DEFINITIVE' ? 'selected' : ''}>Definitief</option>
        <option value="PAID" ${currentStatus === 'PAID' ? 'selected' : ''}>Betaald</option>
        <option value="VOID" ${currentStatus === 'VOID' ? 'selected' : ''}>Geannuleerd</option>
        <option value="ALL" ${currentStatus === 'ALL' ? 'selected' : ''}>Alles</option>
      </select>
      <select id="invOverviewSort" class="select-inline">
        <option value="DUE_ASC" ${currentSort === 'DUE_ASC' ? 'selected' : ''}>Vervaldatum ↑</option>
        <option value="DUE_DESC" ${currentSort === 'DUE_DESC' ? 'selected' : ''}>Vervaldatum ↓</option>
        <option value="AGE_DESC" ${currentSort === 'AGE_DESC' ? 'selected' : ''}>Oudste eerst</option>
        <option value="AMOUNT_DESC" ${currentSort === 'AMOUNT_DESC' ? 'selected' : ''}>Bedrag hoog-laag</option>
      </select>
      <a class="btn btn-ghost btn-sm" href="${csvCurrent}">CSV huidige view</a>
      <a class="btn btn-ghost btn-sm" href="${csvOpen}">CSV open</a>
      <a class="btn btn-ghost btn-sm" href="${csvOverdue}">CSV overdue</a>
    </div>`;

  if (!rows.length) {
    mount.innerHTML = `
      <div class="invoice-section-header">
        <span class="invoice-section-icon">📋</span>
        <div class="invoice-section-title-wrap">
          <span class="invoice-section-title">Openstaande Facturen</span>
          <span class="invoice-section-sub">Open: ${s.open_count || 0} · Overdue: <strong style="color:var(--danger)">${s.overdue_count || 0}</strong></span>
        </div>
        <button class="btn btn-ghost btn-sm" id="runInvoiceRemindersBtn">Run reminders</button>
      </div>
      <div class="card" style="padding:1rem 1.1rem">
        <div style="margin:.35rem 0">${controls}</div>
        <p class="muted compact" style="margin:.55rem 0 0">Geen openstaande facturen. Herinneringen worden automatisch verwerkt.</p>
      </div>`;
    bindInvoiceOverviewActions();
    return;
  }

  mount.innerHTML = `
    <div class="invoice-section-header">
      <span class="invoice-section-icon">📋</span>
      <div class="invoice-section-title-wrap">
        <span class="invoice-section-title">Openstaande Facturen</span>
        <span class="invoice-section-sub">Open: ${s.open_count || 0} · Overdue: <strong style="color:var(--danger)">${s.overdue_count || 0}</strong></span>
      </div>
      <button class="btn btn-ghost btn-sm" id="runInvoiceRemindersBtn">Run reminders</button>
    </div>
    <div class="card" style="padding:1rem 1.1rem">
      <div style="display:flex;justify-content:space-between;gap:.6rem;align-items:center;flex-wrap:wrap;margin-bottom:.6rem">
        ${controls}
        <div style="display:flex;gap:.45rem;align-items:center">
          <span class="muted compact" id="invSelectedCount">${selectedCount} geselecteerd</span>
          <button class="btn btn-primary btn-sm" id="bulkInvoiceReminderBtn" ${selectedCount ? '' : 'disabled'}>Bulk herinnering</button>
        </div>
      </div>
      <div class="table-wrap">
        <table class="tbl">
          <thead><tr><th class="cell-select"><input type="checkbox" id="invoiceSelectAll" ${selectedCount && selectedCount === rows.length ? 'checked' : ''}></th><th>Factuur</th><th>Order</th><th>Klant</th><th>Vervaldatum</th><th>Verstuurd op</th><th style="text-align:right">Bedrag</th><th>Reminders</th><th></th></tr></thead>
          <tbody>
            ${rows.map((r) => `
              <tr>
                <td class="cell-select"><input type="checkbox" data-invoice-select="${r.id}" ${INVOICE_SELECTION.has(Number(r.id)) ? 'checked' : ''}></td>
                <td><strong>${r.invoice_number || '—'}</strong></td>
                <td>#${String(r.order_id || 0).padStart(4, '0')}</td>
                <td>${escText(`${r.customer_first || ''} ${r.customer_last || ''}`.trim() || '—')}<br><small class="muted">${escText(r.customer_email || '')}</small></td>
                <td>${r.due_date ? NEB.fmtDate(r.due_date) : '—'}</td>
                <td>${r.sent_at ? NEB.fmtDate(r.sent_at) : '<span class="muted">nog niet</span>'}</td>
                <td style="text-align:right"><strong>${NEB.fmtEUR(r.total || 0)}</strong></td>
                <td>${Number(r.reminder_count || 0)}x</td>
                <td><button class="btn btn-ghost btn-sm" data-resend-invoice="${r.id}">Opnieuw sturen</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
  bindInvoiceOverviewActions();
}

function bindInvoiceOverviewActions() {
  const btn = document.getElementById('runInvoiceRemindersBtn');
  if (btn) btn.onclick = async () => {
    const old = btn.textContent;
    try {
      btn.disabled = true;
      btn.textContent = 'Bezig...';
      const out = await NEB.post('/api/admin/invoices/run-reminders', {});
      const sent = Number(out?.result?.sent || 0);
      NEB.toast(sent > 0 ? `${sent} herinnering(en) verstuurd` : 'Geen reminders verstuurd', 'success');
      await loadOrders();
    } catch (err) {
      NEB.toast(err.message || 'Reminders run mislukt', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = old || 'Run reminders';
    }
  };

  const statusSel = document.getElementById('invOverviewStatus');
  if (statusSel) statusSel.onchange = () => {
    INVOICE_OVERVIEW_STATE.status = statusSel.value || 'OPEN';
    INVOICE_SELECTION.clear();
    loadOrders();
  };
  const sortSel = document.getElementById('invOverviewSort');
  if (sortSel) sortSel.onchange = () => {
    INVOICE_OVERVIEW_STATE.sort = sortSel.value || 'DUE_ASC';
    loadOrders();
  };

  const selectAll = document.getElementById('invoiceSelectAll');
  if (selectAll) selectAll.onchange = () => {
    const checked = !!selectAll.checked;
    document.querySelectorAll('[data-invoice-select]').forEach((cb) => {
      cb.checked = checked;
      const id = Number(cb.dataset.invoiceSelect || 0);
      if (!id) return;
      if (checked) INVOICE_SELECTION.add(id);
      else INVOICE_SELECTION.delete(id);
    });
    const countEl = document.getElementById('invSelectedCount');
    if (countEl) countEl.textContent = `${INVOICE_SELECTION.size} geselecteerd`;
    const bulkBtn = document.getElementById('bulkInvoiceReminderBtn');
    if (bulkBtn) bulkBtn.disabled = INVOICE_SELECTION.size === 0;
  };
  document.querySelectorAll('[data-invoice-select]').forEach((cb) => {
    cb.onchange = () => {
      const id = Number(cb.dataset.invoiceSelect || 0);
      if (!id) return;
      if (cb.checked) INVOICE_SELECTION.add(id);
      else INVOICE_SELECTION.delete(id);
      const countEl = document.getElementById('invSelectedCount');
      if (countEl) countEl.textContent = `${INVOICE_SELECTION.size} geselecteerd`;
      const bulkBtn = document.getElementById('bulkInvoiceReminderBtn');
      if (bulkBtn) bulkBtn.disabled = INVOICE_SELECTION.size === 0;
    };
  });

  const bulkBtn = document.getElementById('bulkInvoiceReminderBtn');
  if (bulkBtn) bulkBtn.onclick = async () => {
    if (!INVOICE_SELECTION.size) return;
    const ids = Array.from(INVOICE_SELECTION);
    const old = bulkBtn.textContent;
    try {
      bulkBtn.disabled = true;
      bulkBtn.textContent = 'Versturen...';
      const out = await NEB.post('/api/admin/invoices/remind-bulk', { invoiceIds: ids });
      const sum = out?.summary || {};
      const sent = Number(sum.sent || 0);
      const skipped = Number(sum.skipped || 0);
      const failed = Number(sum.failed || 0);
      if (failed > 0) NEB.toast(`${sent} verstuurd, ${skipped} overgeslagen, ${failed} mislukt`, 'error');
      else NEB.toast(`${sent} verstuurd${skipped ? `, ${skipped} overgeslagen` : ''}`, 'success');
      if (Array.isArray(sum.failedItems) && sum.failedItems.length) {
        console.warn('Bulk reminder failures:', sum.failedItems);
      }
      INVOICE_SELECTION.clear();
      await loadOrders();
    } catch (err) {
      NEB.toast(err.message || 'Bulk herinnering mislukt', 'error');
    } finally {
      bulkBtn.disabled = false;
      bulkBtn.textContent = old || 'Bulk herinnering';
    }
  };

  document.querySelectorAll('[data-resend-invoice]').forEach((el) => {
    el.onclick = async () => {
      const id = Number(el.dataset.resendInvoice || 0);
      if (!id) return;
      const old = el.textContent;
      try {
        el.disabled = true;
        el.textContent = 'Versturen...';
        await NEB.post(`/api/admin/invoices/${id}/resend`, {});
        NEB.toast('Factuurmail opnieuw verstuurd', 'success');
        await loadOrders();
      } catch (err) {
        NEB.toast(err.message || 'Opnieuw versturen mislukt', 'error');
      } finally {
        el.disabled = false;
        el.textContent = old || 'Opnieuw sturen';
      }
    };
  });
}

async function showOrderDetail(id) {
  // Remove any existing order modal
  document.getElementById('orderDetailModal')?.remove();
  try {
    const { order, invoice = null, items, history, payments = [], shippingEvents = [], emailTracking = [], depositInvoices = [], activityFeed = [] } = await NEB.get('/api/orders/' + id);
    const cust = `${order.customer_first || ''} ${order.customer_last || ''}`.trim() || '—';
    const isArchived = !!order.deleted_at;
    const canApprove = !isArchived && order.status === 'NEW';
    const canSendPaymentLink = !isArchived && ['APPROVED', 'APPROVED_AWAITING_PAYMENT'].includes(order.status);
    const canSendInvoice = !isArchived && !!order.customer_email;
    const trackingByType = {
      payment_link: emailTracking.find((t) => t.email_type === 'payment_link') || null,
      offer: emailTracking.find((t) => t.email_type === 'offer') || null,
      invoice: emailTracking.find((t) => t.email_type === 'invoice') || null
    };
    const latestDeposit = depositInvoices[0] || null;
    const canSendDepositInvoice = !!(latestDeposit && canSendInvoice);
    const primaryActionLabel = canApprove ? 'Goedkeuren' : 'Betaallink versturen';

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'orderDetailModal';

    const closeModal = () => { modal.classList.remove('show'); setTimeout(() => modal.remove(), 250); };

    modal.innerHTML = `
      <div class="modal-box order-modal-box">
        <div class="order-modal-header">
          <div>
            <h2 style="margin:0;font-size:1.1rem;font-weight:700">Order #${String(order.id).padStart(4, '0')}</h2>
            <p style="margin:.2rem 0 0;font-size:.82rem;color:var(--text-muted)">${NEB.fmtDate(order.created_at)} · ${isArchived ? '<span class="pill pill-cancelled">Gearchiveerd</span>' : NEB.statusPill(order.status)}</p>
          </div>
          <div style="display:flex;gap:.45rem;flex-wrap:wrap;align-items:center">
            <a class="btn btn-ghost btn-sm" href="/api/admin/orders/${order.id}/offer.pdf" target="_blank">Offerte PDF</a>
            <a class="btn btn-ghost btn-sm" href="/api/admin/orders/${order.id}/invoice.pdf" target="_blank">Factuur PDF</a>
            <a class="btn btn-ghost btn-sm" href="/api/admin/orders/${order.id}/packing-slip.pdf" target="_blank">Orderbon PDF</a>
            ${latestDeposit ? `<a class="btn btn-ghost btn-sm" href="/api/admin/orders/${order.id}/deposit-invoice.pdf" target="_blank">Voorschotsfactuur</a>` : ''}
            ${(canApprove || canSendPaymentLink) ? `<button class="btn btn-primary btn-sm" id="approveOrPayBtn">${primaryActionLabel}</button>` : ''}
            ${canSendInvoice ? `<button class="btn btn-ghost btn-sm" id="sendOfferBtn">Stuur Offerte</button>` : ''}
            ${canSendInvoice ? `<button class="btn btn-ghost btn-sm" id="sendInvoiceBtn">📧 Stuur factuur</button>` : ''}
            ${canSendDepositInvoice ? `<button class="btn btn-ghost btn-sm" id="sendDepositInvoiceBtn">📄 Stuur voorschotsfactuur</button>` : ''}
            ${!isArchived ? '<button class="btn btn-ghost btn-sm" id="createDepositInvoiceBtn">Voorschotsfactuur</button>' : ''}
            ${isArchived
              ? '<button class="btn btn-primary btn-sm" id="restoreOrderBtn">Terugzetten</button>'
              : '<button class="btn btn-danger btn-sm" id="deleteOrderBtn">Archiveren</button>'}
            <button class="btn btn-ghost btn-sm" id="closeOrderModal" style="font-size:1rem;padding:.35rem .65rem">✕</button>
          </div>
        </div>
        <div class="order-modal-body">
        <div class="prod-subtab-bar" style="margin-top:1rem">
          <button class="prod-subtab active" data-od-tab="overview" type="button">Overzicht</button>
          <button class="prod-subtab" data-od-tab="customer" type="button">Klant</button>
          <button class="prod-subtab" data-od-tab="items" type="button">Artikelen</button>
          <button class="prod-subtab" data-od-tab="docs" type="button">Documenten &amp; E-mails</button>
          <button class="prod-subtab" data-od-tab="progress" type="button">Voortgang</button>
        </div>

        <div class="prod-subtab-panel active" data-od-panel="overview">
          <div style="display:grid;grid-template-columns:1fr 1.2fr;gap:1rem" class="order-detail-grid">
            <div>
              <div class="ds-title" style="margin-bottom:.6rem">Voortgang</div>
              ${renderTimeline(order.status, history)}
            </div>
            <div class="kv-list">
              <div class="kv"><span class="kv-key">Factuurstatus</span><span class="kv-val">${invoice ? NEB.invoiceStatusPill(invoice) : '<span class="muted">Nog niet beschikbaar</span>'}</span></div>
              <div class="kv"><span class="kv-key">Factuurnummer</span><span class="kv-val">${invoice?.invoice_number || '—'}</span></div>
              <div class="kv"><span class="kv-key">Totaal</span><span class="kv-val"><strong>${NEB.fmtEUR(order.total)}</strong></span></div>
              <div class="kv"><span class="kv-key">Klant</span><span class="kv-val">${escText(cust)}</span></div>
              <div class="kv"><span class="kv-key">E-mail</span><span class="kv-val">${escText(order.customer_email || '—')}</span></div>
            </div>
          </div>
        </div>

        <div class="prod-subtab-panel" data-od-panel="customer">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.6rem">
            <div class="ds-title">Klantgegevens</div>
            <button class="btn btn-ghost btn-sm" id="editCustBtn">Bewerken</button>
          </div>
          <div id="custInfoDisplay" class="kv-list">
            <div class="kv"><span class="kv-key">Naam</span><span class="kv-val">${escText(cust)}</span></div>
            ${order.customer_company ? `<div class="kv"><span class="kv-key">Bedrijf</span><span class="kv-val">${escText(order.customer_company)}</span></div>` : ''}
            ${order.customer_vat ? `<div class="kv"><span class="kv-key">BTW-nr</span><span class="kv-val">${escText(order.customer_vat)}</span></div>` : ''}
            <div class="kv"><span class="kv-key">E-mail</span><span class="kv-val">${escText(order.customer_email || '—')}</span></div>
            <div class="kv"><span class="kv-key">Adres</span><span class="kv-val">${escText([order.address, [order.postcode, order.city].filter(Boolean).join(' ')].filter(Boolean).join(', ')) || '—'}</span></div>
            ${order.phone ? `<div class="kv"><span class="kv-key">Telefoon</span><span class="kv-val">${escText(order.phone)}</span></div>` : ''}
            ${order.notes ? `<div class="kv"><span class="kv-key">Notities</span><span class="kv-val">${escText(order.notes)}</span></div>` : ''}
          </div>
          <div id="custInfoEdit" style="display:none" class="form-stack">
            <div class="form-grid-2">
              <div class="field"><label>Voornaam</label><input id="ci_first" value="${escAttr(order.customer_first || '')}"></div>
              <div class="field"><label>Achternaam</label><input id="ci_last" value="${escAttr(order.customer_last || '')}"></div>
            </div>
            <div class="field"><label>E-mail</label><input id="ci_email" type="email" value="${escAttr(order.customer_email || '')}"></div>
            <div class="field"><label>Bedrijf</label><input id="ci_company" value="${escAttr(order.customer_company || '')}"></div>
            <div class="field"><label>BTW-nummer</label><input id="ci_vat" value="${escAttr(order.customer_vat || '')}"></div>
            <div class="field"><label>Adres</label><input id="ci_address" value="${escAttr(order.address || '')}"></div>
            <div class="form-grid-2">
              <div class="field"><label>Postcode</label><input id="ci_postcode" value="${escAttr(order.postcode || '')}"></div>
              <div class="field"><label>Stad</label><input id="ci_city" value="${escAttr(order.city || '')}"></div>
            </div>
            <div class="field"><label>Telefoon</label><input id="ci_phone" value="${escAttr(order.phone || '')}"></div>
            <div style="display:flex;gap:.5rem">
              <button class="btn btn-primary btn-sm" id="saveCustBtn">Opslaan</button>
              <button class="btn btn-ghost btn-sm" id="cancelCustBtn">Annuleren</button>
            </div>
          </div>
        </div>

        <div class="prod-subtab-panel" data-od-panel="items">
          <div style="display:flex;flex-direction:column;gap:.75rem">
            ${items.map((it, idx) => `
              <details class="order-items-details"${idx === 0 ? ' open' : ''}>
                <summary class="order-items-summary">
                  <span class="ois-label">${escText(it.product_label || 'Product')} · ${escText(it.size || '—')} · ${it.qty}x</span>
                  <span class="ois-total">${NEB.fmtEUR(it.total || 0)}</span>
                  <span class="ois-chevron">▾</span>
                </summary>
                <div class="ois-body">
                  <div class="card" style="margin:0;padding:1rem">
                    <div class="detail-grid">
                      <div class="preview-tile">
                        ${it.preview_path
                          ? `<div style="display:flex;flex-direction:column;gap:.55rem;align-items:center">
                              <img src="/${it.preview_path}" alt="">
                              <button class="btn btn-ghost btn-sm" data-sign-path="${it.preview_path}">Deellink (24u)</button>
                            </div>`
                          : `<div class="muted">Geen preview</div>`}
                      </div>
                      <div>
                        <div class="kv-list">
                          <div class="kv"><span class="kv-key">Product</span><span class="kv-val">${escText(it.product_label || 'Product')}</span></div>
                          <div class="kv"><span class="kv-key">Kleur</span><span class="kv-val">${it.color_hex ? `<span class="swatch-dot" style="background:${it.color_hex}"></span>` : ''}${escText(it.color_name || '—')}</span></div>
                          <div class="kv"><span class="kv-key">Maat</span><span class="kv-val">${escText(it.size)}</span></div>
                          <div class="kv"><span class="kv-key">Aantal</span><span class="kv-val">${it.qty}</span></div>
                          <div class="kv"><span class="kv-key">Prijs</span><span class="kv-val">${NEB.fmtEUR(it.total)}</span></div>
                        </div>
                      </div>
                    </div>
                    <div class="designs-list" style="margin-top:.75rem">
                      ${(it.designs || []).map((d, i) => `
                        <div class="design-tile">
                          <div class="preview">${d.file_path ? `<img src="/${d.file_path}" alt="">` : '<div class="muted">geen bestand</div>'}</div>
                          <h4>${escText(d.name || 'Design ' + (i + 1))}</h4>
                          <small>${escText(d.position)} · schaal ${d.scale}% · offset ${d.x_offset || 0}/${d.v_offset || 0}px</small>
                          ${d.note ? `<div class="note">"${escText(d.note)}"</div>` : ''}
                          ${d.file_path
                            ? `<div style="display:flex;gap:.45rem;flex-wrap:wrap">
                                <a class="btn btn-ghost btn-sm" href="/${d.file_path}" download>Download origineel</a>
                                <button class="btn btn-ghost btn-sm" type="button" data-sign-path="${d.file_path}">Deellink (24u)</button>
                              </div>`
                            : ''}
                        </div>
                      `).join('')}
                    </div>
                  </div>
                </div>
              </details>
            `).join('')}
          </div>
        </div>

        <div class="prod-subtab-panel" data-od-panel="docs">
          <div class="shipment-card" style="margin-bottom:.9rem">
            <div class="shipment-card-head">
              <div class="ds-title" style="margin:0">Verzending</div>
              ${order.tracking_url ? `<a class="btn btn-ghost btn-sm" href="${escAttr(order.tracking_url)}" target="_blank" rel="noopener noreferrer">Tracking openen</a>` : ''}
            </div>
            <div class="form-grid-2">
              <div class="field">
                <label>Vervoerder</label>
                <select id="shipCarrier" class="select-inline">
                  ${['POSTNL', 'BPOST', 'GLS'].map((c) => `<option value="${c}" ${String(order.shipping_carrier || '').toUpperCase() === c ? 'selected' : ''}>${c}</option>`).join('')}
                </select>
              </div>
              <div class="field">
                <label>Tracking code</label>
                <input id="shipTrackingCode" type="text" value="${escAttr(order.tracking_code || '')}" placeholder="3S.. / BAR.. / GLS..">
              </div>
            </div>
            <div class="form-grid-2" style="margin-top:.45rem">
              <div class="field">
                <label>Verzendstatus</label>
                <select id="shipStatus" class="select-inline">
                  ${['PENDING', 'LABEL_CREATED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED_ATTEMPT', 'RETURNED', 'EXCEPTION', 'UNKNOWN']
                    .map((s) => `<option value="${s}" ${String(order.shipping_status || 'UNKNOWN').toUpperCase() === s ? 'selected' : ''}>${shippingStatusLabel(s)}</option>`)
                    .join('')}
                </select>
              </div>
              <div class="field">
                <label>Laatst bijgewerkt</label>
                <input type="text" value="${order.shipping_last_update_at ? escAttr(NEB.fmtDate(order.shipping_last_update_at)) : 'Nog niet'}" readonly>
              </div>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:.6rem;flex-wrap:wrap;margin-top:.55rem">
              <small class="muted compact">${order.tracking_url ? escText(order.tracking_url) : 'Nog geen trackinglink'}</small>
              ${isArchived ? '<span class="muted compact">Order staat in archief</span>' : '<button class="btn btn-primary btn-sm" id="saveShipmentBtn">Opslaan verzending</button>'}
            </div>
            ${(shippingEvents || []).length ? `
              <div class="shipment-events">
                ${(shippingEvents || []).slice(0, 5).map((e) => `
                  <div class="shipment-event-row">
                    <span><strong>${escText(shippingStatusLabel(e.status_normalized || e.status_raw || 'UNKNOWN'))}</strong> · ${escText(String(e.carrier || '').toUpperCase())} · ${escText(e.tracking_code || '')}</span>
                    <span>${NEB.fmtDate(e.event_at || e.created_at)}</span>
                  </div>
                `).join('')}
              </div>
            ` : ''}
          </div>
          <div class="kv-list" style="margin-bottom:.9rem">
            <div class="kv"><span class="kv-key">Betaallink</span><span class="kv-val">${formatTrackingLine(trackingByType.payment_link)}</span></div>
            <div class="kv"><span class="kv-key">Offerte</span><span class="kv-val">${formatTrackingLine(trackingByType.offer)}</span></div>
            <div class="kv"><span class="kv-key">Factuur</span><span class="kv-val">${formatTrackingLine(trackingByType.invoice)}</span></div>
            <div class="kv"><span class="kv-key">Voorschotfactuur</span><span class="kv-val">${formatTrackingLine(emailTracking.find((t) => t.email_type === 'deposit_invoice') || null)}</span></div>
          </div>
          <div class="ds-title" style="margin-bottom:.5rem">Betalingen (${payments.length})</div>
          ${renderPayments(payments)}
          <div class="ds-title" style="margin-top:1rem;margin-bottom:.5rem">Voorschotfacturen (${depositInvoices.length})</div>
          <div class="kv-list">
            ${depositInvoices.length ? depositInvoices.map((d) => `
              <div class="kv">
                <span class="kv-key">${escText(d.invoice_number || ('VRK-' + d.id))}</span>
                <span class="kv-val">${NEB.fmtEUR(d.deposit_amount || 0)} · ${d.sent_at ? 'Verstuurd' : 'Niet verstuurd'}</span>
              </div>
            `).join('') : '<div class="kv"><span class="kv-key">Status</span><span class="kv-val muted">Nog geen voorschotfactuur</span></div>'}
          </div>
        </div>

        <div class="prod-subtab-panel" data-od-panel="progress">
          <div style="margin-bottom:1rem">
            <div class="ds-title" style="margin-bottom:.5rem">Status wijzigen</div>
            <div style="display:flex;gap:.5rem;flex-wrap:wrap">
              <select id="detailStatusSelect" style="flex:1;min-width:160px;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--r-btn);color:var(--text);padding:.5rem .8rem;font:inherit;font-size:.85rem">
                ${['NEW','APPROVED','APPROVED_AWAITING_PAYMENT','PAYMENT_PENDING','PAID','IN_PRODUCTION','SHIPPED','DELIVERED','CANCELLED'].map(s =>
                  `<option value="${s}"${s === order.status ? ' selected' : ''}>${labelFor(s)}</option>`
                ).join('')}
              </select>
              <button class="btn btn-primary btn-sm" id="detailStatusSaveBtn">Opslaan</button>
            </div>
            <input id="detailStatusNote" type="text" placeholder="Notitie voor klant (optioneel)" style="margin-top:.45rem;width:100%;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--r-btn);color:var(--text);padding:.5rem .8rem;font:inherit;font-size:.82rem;box-sizing:border-box">
          </div>
          <div class="tl-history" style="margin-top:1.25rem">
            <div class="ds-title" style="margin-bottom:.5rem">Activiteiten</div>
            ${(activityFeed || []).map((a) => `
              <div class="h-row">
                <span><strong>${escText(a.title || a.type || 'Event')}</strong>${a.note ? ` · ${escText(a.note)}` : ''}${a.by ? ` · <span class="muted">door ${escText(a.by)}</span>` : ''}</span>
                <span>${NEB.fmtDate(a.at)}</span>
              </div>
            `).join('') || '<p class="muted compact">Nog geen activiteiten.</p>'}
          </div>
          <div class="tl-history" style="margin-top:1.25rem">
            <div class="ds-title" style="margin-bottom:.5rem">Geschiedenis</div>
            ${history.map(h => `
              <div class="h-row">
                <span><strong>${escText(labelFor(h.status))}</strong>${h.note ? ' · ' + escText(h.note) : ''}${h.changed_by_email ? ` · <span class="muted">door ${escText(h.changed_by_email)}</span>` : ''}</span>
                <span>${NEB.fmtDate(h.created_at)}</span>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    </div>`;

    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add('show'));

    // Close handlers
    document.getElementById('closeOrderModal').addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
    modal.querySelector('#deleteOrderBtn')?.addEventListener('click', async () => {
      await deleteOrderById(id, async () => {
        closeModal();
      });
    });
    modal.querySelector('#restoreOrderBtn')?.addEventListener('click', async () => {
      await restoreOrderById(id, async () => {
        closeModal();
      });
    });

    modal.querySelectorAll('[data-od-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.odTab;
        modal.querySelectorAll('[data-od-tab]').forEach((b) => b.classList.toggle('active', b === btn));
        modal.querySelectorAll('[data-od-panel]').forEach((p) => p.classList.toggle('active', p.dataset.odPanel === tab));
      });
    });
    modal.querySelectorAll('[data-sign-path]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const fp = btn.getAttribute('data-sign-path');
        if (!fp) return;
        const old = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Link maken...';
        try {
          const data = await NEB.post('/api/uploads/sign', { path: fp, ttlSeconds: 86400 });
          const link = data.url;
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(link);
            NEB.toast('Deellink gekopieerd (24u)', 'success');
          } else {
            window.prompt('Kopieer deze deellink:', link);
          }
        } catch (err) {
          NEB.toast(err.message || 'Kon deellink niet maken', 'error');
        } finally {
          btn.disabled = false;
          btn.textContent = old;
        }
      });
    });
    modal.querySelector('#approveOrPayBtn')?.addEventListener('click', async () => {
      if (canApprove) {
        try {
          await NEB.post(`/api/admin/orders/${id}/approve`, {});
          NEB.toast('Order goedgekeurd', 'success');
          await loadOrders();
          closeModal();
          await showOrderDetail(id);
          if (confirm('Order is goedgekeurd. Wil je nu meteen de betaallink mailen?')) {
            const refreshed = await NEB.get('/api/orders/' + id);
            await openSendPaymentLinkModal(refreshed.order || order, async () => {
              await loadOrders();
              document.getElementById('orderDetailModal')?.remove();
              await showOrderDetail(id);
            });
          }
        } catch (err) {
          NEB.toast(err.message || 'Goedkeuren mislukt', 'error');
        }
        return;
      }
      await openSendPaymentLinkModal(order, async () => {
        await loadOrders();
        closeModal();
        await showOrderDetail(id);
      });
    });

    modal.querySelector('#sendOfferBtn')?.addEventListener('click', async () => {
      await openSendEmailModal(order, {
        modalId: 'sendOfferModal',
        title: 'Stuur Offerte',
        subtitle: 'Controleer het voorbeeld en verstuur daarna de offerte.',
        previewType: 'offer',
        sendEndpoint: `/api/admin/orders/${id}/send-offer`,
        sendButtonText: 'Stuur Offerte',
        payloadBuilder: (extraMessage) => ({ extraMessage })
      });
    });
    modal.querySelector('#sendInvoiceBtn')?.addEventListener('click', async () => {
      await openSendEmailModal(order, {
        modalId: 'sendInvoiceModal',
        title: 'Stuur Factuur',
        subtitle: 'Controleer het e-mailvoorbeeld en verstuur daarna de factuur.',
        previewType: 'invoice',
        sendEndpoint: `/api/admin/orders/${id}/send-invoice`,
        sendButtonText: '📧 Stuur factuur',
        payloadBuilder: (extraMessage) => ({ extraMessage })
      });
    });

    modal.querySelector('#createDepositInvoiceBtn')?.addEventListener('click', async () => {
      await openCreateDepositInvoiceModal(order, async () => {
        await loadOrders();
        closeModal();
        await showOrderDetail(id);
      });
    });

    modal.querySelector('#sendDepositInvoiceBtn')?.addEventListener('click', async () => {
      await openSendEmailModal(order, {
        modalId: 'sendDepositInvoiceModal',
        title: 'Stuur Voorschotsfactuur',
        subtitle: 'Controleer het voorbeeld en verstuur de voorschotsfactuur.',
        previewType: 'deposit_invoice',
        sendEndpoint: `/api/admin/orders/${id}/send-deposit-invoice`,
        sendButtonText: '📄 Stuur voorschotsfactuur',
        payloadBuilder: (extraMessage) => ({ extraMessage })
      });
    });

    modal.querySelector('#saveShipmentBtn')?.addEventListener('click', async () => {
      const btn = modal.querySelector('#saveShipmentBtn');
      const old = btn?.textContent || 'Opslaan verzending';
      try {
        if (btn) {
          btn.disabled = true;
          btn.textContent = 'Opslaan...';
        }
        const carrier = String(modal.querySelector('#shipCarrier')?.value || 'POSTNL').toUpperCase();
        const trackingCode = String(modal.querySelector('#shipTrackingCode')?.value || '').trim();
        const shippingStatus = String(modal.querySelector('#shipStatus')?.value || 'UNKNOWN').toUpperCase();
        if (!trackingCode) {
          NEB.toast('Tracking code is verplicht', 'error');
          return;
        }
        await NEB.post(`/api/admin/orders/${id}/shipment`, { carrier, trackingCode, shippingStatus });
        NEB.toast('Verzending opgeslagen', 'success');
        await loadOrders();
        closeModal();
        await showOrderDetail(id);
      } catch (err) {
        NEB.toast(err.message || 'Verzending opslaan mislukt', 'error');
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = old;
        }
      }
    });

    // Inline status change
    modal.querySelector('#detailStatusSaveBtn')?.addEventListener('click', async () => {
      const sel = modal.querySelector('#detailStatusSelect');
      const noteEl = modal.querySelector('#detailStatusNote');
      const newStatus = sel?.value;
      if (!newStatus) return;
      const btn = modal.querySelector('#detailStatusSaveBtn');
      btn.disabled = true; btn.textContent = 'Bezig...';
      try {
        await NEB.put(`/api/admin/orders/${id}/status`, { status: newStatus, note: noteEl?.value?.trim() || '' });
        NEB.toast('Status bijgewerkt', 'success');
        await loadOrders();
        closeModal();
        await showOrderDetail(id);
      } catch (err) {
        NEB.toast(err.message || 'Kon status niet bijwerken', 'error');
        btn.disabled = false; btn.textContent = 'Opslaan';
      }
    });

    // Edit customer info toggle
    modal.querySelector('#editCustBtn')?.addEventListener('click', () => {
      modal.querySelector('#custInfoDisplay').style.display = 'none';
      modal.querySelector('#custInfoEdit').style.display = '';
    });
    modal.querySelector('#cancelCustBtn')?.addEventListener('click', () => {
      modal.querySelector('#custInfoDisplay').style.display = '';
      modal.querySelector('#custInfoEdit').style.display = 'none';
    });
    modal.querySelector('#saveCustBtn')?.addEventListener('click', async () => {
      const btn = modal.querySelector('#saveCustBtn');
      btn.disabled = true; btn.textContent = 'Opslaan...';
      try {
        await NEB.put(`/api/admin/orders/${id}/customer`, {
          firstName: modal.querySelector('#ci_first').value.trim(),
          lastName: modal.querySelector('#ci_last').value.trim(),
          email: modal.querySelector('#ci_email').value.trim(),
          company: modal.querySelector('#ci_company').value.trim(),
          vatNumber: modal.querySelector('#ci_vat').value.trim(),
          address: modal.querySelector('#ci_address').value.trim(),
          postcode: modal.querySelector('#ci_postcode').value.trim(),
          city: modal.querySelector('#ci_city').value.trim(),
          phone: modal.querySelector('#ci_phone').value.trim()
        });
        NEB.toast('Klantgegevens opgeslagen', 'success');
        closeModal();
        await showOrderDetail(id);
      } catch (err) {
        NEB.toast(err.message || 'Kon klantgegevens niet opslaan', 'error');
        btn.disabled = false; btn.textContent = 'Opslaan';
      }
    });
  } catch (err) {
    NEB.toast(err.message, 'error');
  }
}

function renderPayments(payments) {
  if (!payments.length) {
    return `<div class="card" style="padding:1rem"><span class="muted">Nog geen betalingen geregistreerd.</span></div>`;
  }
  return `
    <div class="table-wrap" style="margin-bottom:1rem">
      <table class="tbl">
        <thead>
          <tr>
            <th>ID</th>
            <th>Provider</th>
            <th>Status</th>
            <th>Bedrag</th>
            <th>Aangemaakt</th>
            <th>Betaald op</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${payments.map(p => `
            <tr>
              <td>#${p.id}</td>
              <td>${p.provider || '—'}</td>
              <td>${paymentPill(p.status)}</td>
              <td>${NEB.fmtEUR(p.amount)} ${p.currency || ''}</td>
              <td>${NEB.fmtDate(p.created_at)}</td>
              <td>${p.paid_at ? NEB.fmtDate(p.paid_at) : '—'}</td>
              <td>
                ${p.checkout_url ? `<a class="btn btn-ghost btn-sm" href="${p.checkout_url}" target="_blank" rel="noopener noreferrer">Open link</a>` : ''}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>`;
}

function paymentPill(status) {
  const map = {
    CREATED: ['Aangemaakt', 'pill-pending'],
    PENDING: ['In behandeling', 'pill-pending'],
    PAID: ['Betaald', 'pill-paid'],
    FAILED: ['Mislukt', 'pill-cancelled']
  };
  const item = map[String(status || '').toUpperCase()] || [status || 'Onbekend', 'pill-pending'];
  return `<span class="pill ${item[1]}">${item[0]}</span>`;
}

function formatTrackingLine(entry) {
  if (!entry) return `<span class="muted compact">Nog niet verzonden</span>`;
  const opened = Number(entry.open_count || 0) > 0;
  if (opened && entry.first_opened_at) {
    return `<span class="pill pill-paid">👁 Geopend op ${NEB.fmtDate(entry.first_opened_at)} (${entry.open_count}x)</span>`;
  }
  return `<span class="pill pill-pending">Nog niet geopend</span>`;
}

async function openSendPaymentLinkModal(order, onSent) {
  const existing = document.getElementById('sendPaymentLinkModal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'sendPaymentLinkModal';
  modal.innerHTML = `
    <div class="modal-box mail-modal-box">
      <div class="mail-modal-head">
        <h2>Verstuur betaallink</h2>
        <p>Controleer en pas de mail aan vóór verzending.</p>
      </div>
      <div class="mail-modal-body">
        <div class="field">
          <label>Onderwerp</label>
          <input id="plSubject" type="text" placeholder="Onderwerp van de e-mail">
        </div>
        <div class="field">
          <label>Optioneel bericht aan klant</label>
          <textarea id="plExtraMessage" rows="3" placeholder="Bijvoorbeeld: We hebben je bestelling goedgekeurd."></textarea>
        </div>
        <label class="mail-inline-check">
          <input type="checkbox" id="plIncludeInvoice" checked> Factuur meesturen als bijlage
        </label>
        <div class="field">
          <label>E-mail voorbeeld</label>
          <div id="plPreviewWrap" class="mail-preview-wrap">
            <iframe id="plPreviewFrame" title="Betaallink preview" class="mail-preview-frame"></iframe>
          </div>
        </div>
      </div>
      <div class="mail-modal-foot">
        <button class="btn btn-ghost" id="plCancelBtn" type="button">Sla over — later versturen</button>
        <button class="btn btn-primary" id="plSendBtn" type="button">📧 Verstuur betaallink naar klant</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.classList.add('show');
  const close = () => modal.remove();
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.querySelector('#plCancelBtn')?.addEventListener('click', close);
  const previewFrame = modal.querySelector('#plPreviewFrame');
  const previewWrap = modal.querySelector('#plPreviewWrap');
  const subjectInput = modal.querySelector('#plSubject');
  const refreshPreview = async () => {
    try {
      if (previewWrap) previewWrap.style.opacity = '.55';
      const extraMessage = (modal.querySelector('#plExtraMessage')?.value || '').trim();
      const subjectOverride = (subjectInput?.value || '').trim();
      const qp = new URLSearchParams({ type: 'payment_link', extraMessage, subjectOverride });
      const out = await NEB.get(`/api/admin/orders/${order.id}/email-preview?` + qp.toString());
      if (!modal._subjectDirty && subjectInput && out?.subject) subjectInput.value = out.subject;
      if (previewFrame) previewFrame.srcdoc = out.html || '';
    } catch (err) {
      if (previewFrame) previewFrame.srcdoc = `<div style="padding:12px;font-family:Arial,sans-serif;color:#b91c1c">Preview kon niet geladen worden: ${escText(err.message || '')}</div>`;
    } finally {
      if (previewWrap) previewWrap.style.opacity = '1';
    }
  };
  modal.querySelector('#plExtraMessage')?.addEventListener('input', () => {
    clearTimeout(modal._previewTimer);
    modal._previewTimer = setTimeout(refreshPreview, 250);
  });
  subjectInput?.addEventListener('input', () => {
    modal._subjectDirty = true;
    clearTimeout(modal._previewTimer);
    modal._previewTimer = setTimeout(refreshPreview, 250);
  });
  refreshPreview();

  modal.querySelector('#plSendBtn')?.addEventListener('click', async () => {
    const btn = modal.querySelector('#plSendBtn');
    const extraMessage = (modal.querySelector('#plExtraMessage')?.value || '').trim();
    const subject = (subjectInput?.value || '').trim();
    const includeInvoice = !!modal.querySelector('#plIncludeInvoice')?.checked;
    const old = btn.textContent;
    try {
      btn.disabled = true;
      btn.textContent = 'Versturen...';
      await NEB.post(`/api/admin/orders/${order.id}/send-payment-link`, { extraMessage, includeInvoice, subject });
      NEB.toast('Betaallink verstuurd', 'success');
      close();
      if (typeof onSent === 'function') await onSent();
    } catch (err) {
      NEB.toast(err.message || 'Betaallink versturen mislukt', 'error');
      btn.disabled = false;
      btn.textContent = old || '📧 Verstuur betaallink naar klant';
    }
  });
}

async function openSendEmailModal(order, opts = {}) {
  const {
    modalId = 'genericSendMailModal',
    title = 'E-mail versturen',
    subtitle = '',
    previewType = 'invoice',
    sendEndpoint = '',
    sendButtonText = 'Versturen',
    payloadBuilder = null
  } = opts;
  const existing = document.getElementById(modalId);
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = modalId;
  modal.innerHTML = `
    <div class="modal-box mail-modal-box">
      <div class="mail-modal-head">
        <h2>${escText(title)}</h2>
        <p>${escText(subtitle || '')}</p>
      </div>
      <div class="mail-modal-body">
        <div class="field">
          <label>Onderwerp</label>
          <input id="gmSubject" type="text" placeholder="Onderwerp van de e-mail">
        </div>
        <div class="field">
          <label>Optioneel bericht aan klant</label>
          <textarea id="gmExtraMessage" rows="3" placeholder="Extra toelichting (optioneel)"></textarea>
        </div>
        <div class="field">
          <label>E-mail voorbeeld</label>
          <div id="gmPreviewWrap" class="mail-preview-wrap">
            <iframe id="gmPreviewFrame" title="E-mail preview" class="mail-preview-frame"></iframe>
          </div>
        </div>
      </div>
      <div class="mail-modal-foot">
        <button class="btn btn-ghost" id="gmCancelBtn" type="button">Annuleer</button>
        <button class="btn btn-primary" id="gmSendBtn" type="button">${escText(sendButtonText)}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.classList.add('show');
  const close = () => modal.remove();
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.querySelector('#gmCancelBtn')?.addEventListener('click', close);

  const previewFrame = modal.querySelector('#gmPreviewFrame');
  const previewWrap = modal.querySelector('#gmPreviewWrap');
  const subjectInput = modal.querySelector('#gmSubject');
  const refresh = async () => {
    try {
      if (previewWrap) previewWrap.style.opacity = '.55';
      const extraMessage = (modal.querySelector('#gmExtraMessage')?.value || '').trim();
      const subjectOverride = (subjectInput?.value || '').trim();
      const qp = new URLSearchParams({ type: String(previewType || 'invoice'), extraMessage, subjectOverride });
      const out = await NEB.get(`/api/admin/orders/${order.id}/email-preview?` + qp.toString());
      if (!modal._subjectDirty && subjectInput && out?.subject) subjectInput.value = out.subject;
      if (previewFrame) previewFrame.srcdoc = out.html || '';
    } catch (err) {
      if (previewFrame) previewFrame.srcdoc = `<div style="padding:12px;font-family:Arial,sans-serif;color:#b91c1c">Preview kon niet geladen worden: ${escText(err.message || '')}</div>`;
    } finally {
      if (previewWrap) previewWrap.style.opacity = '1';
    }
  };
  modal.querySelector('#gmExtraMessage')?.addEventListener('input', () => {
    clearTimeout(modal._previewTimer);
    modal._previewTimer = setTimeout(refresh, 250);
  });
  subjectInput?.addEventListener('input', () => {
    modal._subjectDirty = true;
    clearTimeout(modal._previewTimer);
    modal._previewTimer = setTimeout(refresh, 250);
  });
  refresh();

  modal.querySelector('#gmSendBtn')?.addEventListener('click', async () => {
    const btn = modal.querySelector('#gmSendBtn');
    const old = btn.textContent;
    try {
      btn.disabled = true;
      btn.textContent = 'Versturen...';
      const extraMessage = (modal.querySelector('#gmExtraMessage')?.value || '').trim();
      const subject = (subjectInput?.value || '').trim();
      const payload = typeof payloadBuilder === 'function'
        ? (payloadBuilder(extraMessage, subject) || {})
        : { extraMessage, subject };
      if (subject && !Object.prototype.hasOwnProperty.call(payload, 'subject')) payload.subject = subject;
      await NEB.post(sendEndpoint, payload);
      NEB.toast('E-mail verstuurd', 'success');
      close();
      await loadOrders();
      await showOrderDetail(order.id);
    } catch (err) {
      NEB.toast(err.message || 'Versturen mislukt', 'error');
      btn.disabled = false;
      btn.textContent = old || sendButtonText;
    }
  });
}

async function openCreateDepositInvoiceModal(order, onDone) {
  const existing = document.getElementById('depositInvoiceModal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'depositInvoiceModal';
  modal.innerHTML = `
    <div class="modal-box" style="max-width:560px">
      <h2 style="margin:0 0 .8rem">Maak voorschotsfactuur</h2>
      <p class="muted compact" style="margin:0 0 1rem">Ordertotaal: <strong>${NEB.fmtEUR(order.total || 0)}</strong></p>
      <div class="form-grid-2">
        <div class="field"><label>Voorschot %</label><input id="depPct" type="number" min="0.1" max="100" step="0.1" placeholder="30"></div>
        <div class="field"><label>Of bedrag (€)</label><input id="depAmount" type="number" min="0.01" step="0.01" placeholder="100.00"></div>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:.6rem;margin-top:1rem">
        <button class="btn btn-ghost" id="depCancelBtn" type="button">Annuleer</button>
        <button class="btn btn-primary" id="depCreateBtn" type="button">📄 Aanmaken</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.classList.add('show');
  const close = () => modal.remove();
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.querySelector('#depCancelBtn')?.addEventListener('click', close);
  modal.querySelector('#depCreateBtn')?.addEventListener('click', async () => {
    const btn = modal.querySelector('#depCreateBtn');
    const depositPercentage = parseFloat(modal.querySelector('#depPct')?.value || '');
    const depositAmount = parseFloat(modal.querySelector('#depAmount')?.value || '');
    if (!Number.isFinite(depositPercentage) && !Number.isFinite(depositAmount)) {
      NEB.toast('Vul een percentage of bedrag in', 'error');
      return;
    }
    const payload = {};
    if (Number.isFinite(depositAmount)) payload.depositAmount = depositAmount;
    else payload.depositPercentage = depositPercentage;
    const old = btn.textContent;
    try {
      btn.disabled = true;
      btn.textContent = 'Aanmaken...';
      await NEB.post(`/api/admin/orders/${order.id}/create-deposit-invoice`, payload);
      NEB.toast('Voorschotsfactuur aangemaakt', 'success');
      close();
      if (typeof onDone === 'function') await onDone();
    } catch (err) {
      NEB.toast(err.message || 'Aanmaken mislukt', 'error');
      btn.disabled = false;
      btn.textContent = old || '📄 Aanmaken';
    }
  });
}

function renderTimeline(status, history) {
  const toTimelineCode = (s) => {
    const raw = String(s || '').toUpperCase();
    if (raw === 'APPROVED_AWAITING_PAYMENT' || raw === 'PAYMENT_PENDING') return 'PAYMENT';
    return raw;
  };
  const FLOW = [
    { code: 'NEW', label: 'Nieuw', icon: '1' },
    { code: 'APPROVED', label: 'Goedgekeurd', icon: '2' },
    { code: 'PAYMENT', label: 'Betaling', icon: '3' },
    { code: 'PAID', label: 'Betaald', icon: '4' },
    { code: 'IN_PRODUCTION', label: 'Productie', icon: '5' },
    { code: 'SHIPPED', label: 'Verzonden', icon: '6' },
    { code: 'DELIVERED', label: 'Bezorgd', icon: '7' }
  ];
  const CHECK = '✓';
  const CANCEL_ICON = '✕';
  if (status === 'CANCELLED') {
    const cancelEv = history.find(h => h.status === 'CANCELLED');
    const lastEv = history.filter(h => h.status !== 'CANCELLED').pop();
    return `<div class="order-timeline-v">
      ${lastEv ? `<div class="tlv-step done">
        <div class="tlv-node">${CHECK}</div>
        <div class="tlv-content"><div class="tlv-label">${labelFor(lastEv.status)}</div><div class="tlv-date">${NEB.fmtDate(lastEv.created_at)}</div></div>
      </div>` : ''}
      <div class="tlv-step cancelled-step">
        <div class="tlv-node">${CANCEL_ICON}</div>
        <div class="tlv-content">
          <div class="tlv-label">Geannuleerd</div>
          ${cancelEv ? `<div class="tlv-date">${NEB.fmtDate(cancelEv.created_at)}</div>` : ''}
          ${cancelEv?.note ? `<div class="tlv-note">${escText(cancelEv.note)}</div>` : ''}
        </div>
      </div>
    </div>`;
  }
  const timelineStatus = toTimelineCode(status);
  const idx = FLOW.findIndex(s => s.code === timelineStatus);
  return `<div class="order-timeline-v">
    ${FLOW.map((s, i) => {
      const done = i < idx;
      const current = i === idx;
      const cls = done ? 'done' : (current ? 'current' : 'future');
      const ev = s.code === 'PAYMENT'
        ? history.find(h => ['APPROVED_AWAITING_PAYMENT', 'PAYMENT_PENDING'].includes(String(h.status || '').toUpperCase()))
        : history.find(h => toTimelineCode(h.status) === s.code);
      const icon = done ? CHECK : (current ? '●' : s.icon);
      return `<div class="tlv-step ${cls}">
        <div class="tlv-node">${icon}</div>
        <div class="tlv-content">
          <div class="tlv-label">${s.label}</div>
          ${ev ? `<div class="tlv-date">${NEB.fmtDate(ev.created_at)}</div>` : ''}
          ${ev?.note ? `<div class="tlv-note">${escText(ev.note)}</div>` : ''}
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

function labelFor(status) {
  const m = {
    NEW: 'Nieuw',
    APPROVED: 'Goedgekeurd',
    APPROVED_AWAITING_PAYMENT: 'Betaling',
    PAYMENT_PENDING: 'Betaling',
    PAID: 'Betaald',
    IN_PRODUCTION: 'Productie',
    SHIPPED: 'Verzonden',
    DELIVERED: 'Bezorgd',
    CANCELLED: 'Geannuleerd'
  };
  return m[status] || status;
}

// ── Notifications ─────────────────────────────────────────────────────────
let _notifTimer = null;

async function loadNotifications() {
  const panel = document.getElementById('panel-meldingen');
  if (!panel) return;
  try {
    const data = await NEB.get('/api/admin/notifications');
    renderNotifications(data);
    updateNotifBadge(data);
  } catch (err) {
    if (panel) panel.innerHTML = `<div class="card" style="padding:1.5rem"><span class="muted">Kon meldingen niet laden: ${escText(err.message)}</span></div>`;
  }
}

function updateNotifBadge(data) {
  const badge = document.getElementById('notifBadge');
  if (!badge) return;
  const count = (data.newOrders?.length || 0)
    + (data.overdueInvoices?.length || 0)
    + (data.pendingAccounts?.length || 0)
    + (data.awaitingPaymentLink?.length || 0)
    + (data.todoSignals?.reduce((sum, t) => sum + (Number(t?.count) || 0), 0) || 0);
  if (count > 0) {
    badge.textContent = count;
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

function renderNotifications(data) {
  const panel = document.getElementById('panel-meldingen');
  if (!panel) return;

  const {
    overdueInvoices = [],
    newOrders = [],
    awaitingPaymentLink = [],
    recentPayments = [],
    pendingAccounts = [],
    todoSignals = []
  } = data;

  const section = (icon, title, count, badgeClass, rows) => {
    if (!rows.length) return '';
    return `
      <div class="notif-section">
        <div class="notif-section-head">
          <span class="notif-section-icon">${icon}</span>
          <span class="notif-section-title">${title}</span>
          <span class="notif-badge-inline ${badgeClass}">${count}</span>
        </div>
        <div class="notif-cards">${rows}</div>
      </div>`;
  };

  const newOrderCards = newOrders.map(o => `
    <div class="notif-card" data-notif-order="${o.id}">
      <div class="notif-card-body">
        <div class="notif-card-title">Order #${String(o.id).padStart(4,'0')}</div>
        <div class="notif-card-sub">${escText(`${o.customer_first || ''} ${o.customer_last || ''}`.trim() || '—')} · ${NEB.fmtEUR(o.total)}</div>
        <div class="notif-card-meta">${NEB.fmtDate(o.created_at)}</div>
      </div>
      <button class="btn btn-ghost btn-sm">Bekijk →</button>
    </div>`).join('');

  const awaitCards = awaitingPaymentLink.map(o => `
    <div class="notif-card" data-notif-order="${o.id}">
      <div class="notif-card-body">
        <div class="notif-card-title">Order #${String(o.id).padStart(4,'0')}</div>
        <div class="notif-card-sub">${escText(`${o.customer_first || ''} ${o.customer_last || ''}`.trim() || '—')} · ${NEB.fmtEUR(o.total)}</div>
        <div class="notif-card-meta">${NEB.fmtDate(o.created_at)}</div>
      </div>
      <button class="btn btn-primary btn-sm" data-notif-send-link="${o.id}">Stuur betaallink</button>
    </div>`).join('');

  const overdueCards = overdueInvoices.map(i => `
    <div class="notif-card notif-card--danger" data-notif-order="${i.order_id}">
      <div class="notif-card-body">
        <div class="notif-card-title">${escText(i.invoice_number || ('Factuur #' + i.id))}</div>
        <div class="notif-card-sub">${escText(`${i.customer_first || ''} ${i.customer_last || ''}`.trim() || '—')} · ${NEB.fmtEUR(i.total)}</div>
        <div class="notif-card-meta">Vervallen op ${NEB.fmtDate(i.due_date)}</div>
      </div>
      <button class="btn btn-ghost btn-sm">Bekijk order</button>
    </div>`).join('');

  const paymentCards = recentPayments.map(p => `
    <div class="notif-card notif-card--success" data-notif-order="${p.order_id}">
      <div class="notif-card-body">
        <div class="notif-card-title">Betaling ontvangen — Order #${String(p.order_id).padStart(4,'0')}</div>
        <div class="notif-card-sub">${escText(`${p.customer_first || ''} ${p.customer_last || ''}`.trim() || '—')} · ${NEB.fmtEUR(p.amount || p.total)}</div>
        <div class="notif-card-meta">${NEB.fmtDate(p.paid_at)}</div>
      </div>
      <button class="btn btn-ghost btn-sm">Bekijk →</button>
    </div>`).join('');

  const pendingCards = pendingAccounts.map(u => `
    <div class="notif-card" data-notif-user="${u.id}">
      <div class="notif-card-body">
        <div class="notif-card-title">${escText(`${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email)}</div>
        <div class="notif-card-sub">${escText(u.email)}</div>
        <div class="notif-card-meta">Aangemeld ${NEB.fmtDate(u.created_at)}</div>
      </div>
      <button class="btn btn-primary btn-sm" data-notif-approve-user="${u.id}">Goedkeuren</button>
    </div>`).join('');

  const todoCards = (todoSignals || []).map((t) => {
    const level = String(t.level || 'info');
    const cls = level === 'warn'
      ? 'notif-card--warn'
      : level === 'danger'
        ? 'notif-card--danger'
        : 'notif-card--info';
    return `
      <div class="notif-card ${cls}">
        <div class="notif-card-body">
          <div class="notif-card-title">${escText(t.title || 'Actiepunt')}</div>
          <div class="notif-card-sub">${escText(t.detail || '')}</div>
        </div>
        <span class="notif-badge-inline ${level === 'danger' ? 'notif-badge-danger' : (level === 'warn' ? 'notif-badge-warn' : 'notif-badge-new')}">${Number(t.count || 0)}</span>
      </div>`;
  }).join('');

  const totalCount = newOrders.length + awaitingPaymentLink.length + overdueInvoices.length + recentPayments.length + pendingAccounts.length + todoSignals.length;

  panel.innerHTML = `
    <div class="page-head" style="padding-bottom:.5rem">
      <h2 style="margin:0;font-size:1.15rem;font-weight:700">Meldingen</h2>
      <p class="muted compact" style="margin:.25rem 0 0">${totalCount ? `${totalCount} melding${totalCount !== 1 ? 'en' : ''} vereisen aandacht` : 'Alles is up-to-date.'}</p>
    </div>
    ${section('🆕', 'Nieuwe bestellingen', newOrders.length, 'notif-badge-new', newOrderCards)}
    ${section('⏳', 'Goedgekeurd — betaallink nodig', awaitingPaymentLink.length, 'notif-badge-warn', awaitCards)}
    ${section('🔴', 'Openstaande facturen', overdueInvoices.length, 'notif-badge-danger', overdueCards)}
    ${section('💰', 'Recente betalingen (7 dagen)', recentPayments.length, 'notif-badge-success', paymentCards)}
    ${section('👤', 'Accounts in afwachting', pendingAccounts.length, 'notif-badge-warn', pendingCards)}
    ${section('🧩', 'Admin actiepunten', todoSignals.length, 'notif-badge-new', todoCards)}
    ${!totalCount ? '<div class="card" style="padding:2rem;text-align:center"><span style="font-size:2rem">✅</span><p class="muted">Geen openstaande meldingen.</p></div>' : ''}
  `;

  // Bind click handlers for order cards
  panel.querySelectorAll('[data-notif-order]').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.matches('[data-notif-send-link]')) return; // handled separately
      const orderId = Number(card.dataset.notifOrder);
      document.querySelector('.tab[data-tab="orders"]')?.click();
      showOrderDetail(orderId);
    });
  });

  // Bind send-payment-link buttons
  panel.querySelectorAll('[data-notif-send-link]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const orderId = Number(btn.dataset.notifSendLink);
      try {
        const { order } = await NEB.get('/api/orders/' + orderId);
        await openSendPaymentLinkModal(order, async () => {
          await loadNotifications();
        });
      } catch (err) { NEB.toast(err.message, 'error'); }
    });
  });

  // Bind approve-user buttons
  panel.querySelectorAll('[data-notif-approve-user]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const uid = Number(btn.dataset.notifApproveUser);
      try {
        await NEB.put(`/api/admin/users/${uid}`, { status: 'ACTIVE' });
        NEB.toast('Account goedgekeurd', 'success');
        await loadNotifications();
        await loadUsers();
      } catch (err) { NEB.toast(err.message, 'error'); }
    });
  });

  // Bind user cards
  panel.querySelectorAll('[data-notif-user]').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.matches('[data-notif-approve-user]')) return;
      showUserDetail(Number(card.dataset.notifUser));
    });
  });
}

// ── Owner audit log ───────────────────────────────────────────────────────
async function loadAudit() {
  if (CURRENT_USER.role !== 'OWNER') return;
  const { page, limit, q, action } = AUDIT_STATE;
  const params = new URLSearchParams({ page, limit, q, action });
  const data = await NEB.get('/api/admin/audit?' + params.toString());

  const actionSelect = document.getElementById('auditAction');
  if (actionSelect) {
    const current = actionSelect.value;
    actionSelect.innerHTML = `<option value="">Alle acties</option>${(data.actions || []).map(a =>
      `<option value="${escAttr(a.action)}">${escText(a.action)} (${a.count})</option>`
    ).join('')}`;
    actionSelect.value = action || current || '';
  }

  const wrap = document.getElementById('auditWrap');
  if (!data.logs?.length) {
    wrap.innerHTML = `<div class="card empty-state"><h3>Geen audit entries gevonden</h3><p>Pas je filter aan of voer eerst wijzigingen uit.</p></div>`;
    document.getElementById('auditPager').innerHTML = '';
    return;
  }

  wrap.innerHTML = `
    <div class="table-wrap">
      <table class="tbl">
        <thead>
          <tr>
            <th>Datum</th>
            <th>Gebruiker</th>
            <th>Actie</th>
            <th>Entiteit</th>
            <th>Samenvatting</th>
          </tr>
        </thead>
        <tbody>
          ${(data.logs || []).map(row => {
            const actor = row.actor_email || (row.actor_user_id ? `user#${row.actor_user_id}` : 'Systeem');
            const entity = row.entity_id ? `${row.entity_type}:${row.entity_id}` : row.entity_type;
            const details = formatAuditDetails(row.details);
            return `
              <tr>
                <td>${NEB.fmtDate(row.created_at)}</td>
                <td>${escText(actor)}</td>
                <td><span class="pill pill-user">${escText(row.action)}</span></td>
                <td>${escText(entity || '—')}</td>
                <td>
                  <div>${escText(row.summary || '')}</div>
                  ${details ? `<details class="audit-details"><summary>Toon details</summary><pre>${details}</pre></details>` : ''}
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>`;

  const pager = document.getElementById('auditPager');
  if (data.pages > 1) {
    let buttons = '';
    for (let i = 1; i <= data.pages; i++) {
      buttons += `<button data-audit-page="${i}" class="${i === data.page ? 'active' : ''}">${i}</button>`;
    }
    pager.innerHTML = `
      <button data-audit-page="${Math.max(1, data.page - 1)}" ${data.page === 1 ? 'disabled' : ''}>‹</button>
      ${buttons}
      <button data-audit-page="${Math.min(data.pages, data.page + 1)}" ${data.page === data.pages ? 'disabled' : ''}>›</button>`;
    pager.onclick = (e) => {
      const p = e.target.closest('[data-audit-page]')?.dataset.auditPage;
      if (!p) return;
      AUDIT_STATE.page = Number(p);
      loadAudit();
    };
  } else {
    pager.innerHTML = '';
  }
}

// ── Users (CRM) ───────────────────────────────────────────────────────────
let _usersList = [];

async function loadUsers(opts = {}) {
  if (CURRENT_USER.role !== 'OWNER') return;
  const q = opts.q || '';
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (opts.tag) params.set('tag', opts.tag);
  if (opts.newsletter) params.set('newsletter', '1');
  if (opts.status) params.set('status', opts.status);
  const { users } = await NEB.get('/api/admin/users?' + params.toString());
  _usersList = users;
  const pending = users.filter(u => u.status === 'PENDING');
  const others = users.filter(u => u.status !== 'PENDING');

  const pendingWrap = document.getElementById('pendingWrap');
  pendingWrap.innerHTML = pending.length ? `
    <div class="card">
      <div class="card-head">
        <div>
          <h2 class="card-title">Wacht op goedkeuring (${pending.length})</h2>
          <p class="card-sub">Nieuwe registraties die nog niet kunnen inloggen.</p>
        </div>
      </div>
      <div class="table-wrap" style="border-radius:14px">
        <table class="tbl">
          <thead><tr><th>Naam</th><th>E-mail</th><th>Datum</th><th></th></tr></thead>
          <tbody>
            ${pending.map(u => `
              <tr>
                <td>${escText((u.first_name || '') + ' ' + (u.last_name || ''))}</td>
                <td>${escText(u.email)}</td>
                <td>${NEB.fmtDate(u.created_at)}</td>
                <td><div class="row-actions">
                  <button class="btn btn-primary btn-sm" data-approve="${u.id}">Goedkeuren</button>
                  <button class="btn btn-danger btn-sm" data-block="${u.id}">Blokkeren</button>
                </div></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>` : '';

  const usersWrap = document.getElementById('usersWrap');
  usersWrap.innerHTML = `
    <div class="card">
      <div class="users-toolbar">
        <div style="display:flex;align-items:center;gap:.55rem;flex-wrap:wrap;flex:1;min-width:0">
          <span class="users-count-label">Alle accounts</span>
          <span class="users-count-badge">${others.length}</span>
        </div>
        <div style="display:flex;gap:.4rem;flex-wrap:wrap;align-items:center">
          <input type="search" id="userSearch" placeholder="Zoek…" value="${escAttr(q)}" class="users-search">
          <div class="users-filter-group">
            <button class="users-filter-btn ${!opts.status && !opts.newsletter ? 'active' : ''}" data-userfilter="">Alle</button>
            <button class="users-filter-btn ${opts.status === 'ACTIVE' ? 'active' : ''}" data-userfilter="ACTIVE">Actief</button>
            <button class="users-filter-btn ${opts.status === 'BLOCKED' ? 'active' : ''}" data-userfilter="BLOCKED">Geblokkeerd</button>
            <button class="users-filter-btn ${opts.newsletter ? 'active' : ''}" data-userfilter-newsletter="1">📧 Newsletter</button>
          </div>
        </div>
      </div>
      <div class="user-list">
        ${others.length ? others.map(u => {
          const name = ((u.first_name || '') + ' ' + (u.last_name || '')).trim() || '—';
          const tags = (() => { try { return JSON.parse(u.tags || '[]'); } catch { return []; } })();
          return `
          <div class="user-row">
            <div class="user-row-avatar">${(name[0] || '?').toUpperCase()}</div>
            <div class="user-row-info">
              <div class="user-row-name">${escText(name)}${tags.length ? ' ' + tags.map(t => `<span class="pill pill-neutral" style="font-size:.62rem;padding:.08rem .38rem;vertical-align:middle">${escText(t)}</span>`).join('') : ''}</div>
              <div class="user-row-meta">
                <a href="mailto:${escAttr(u.email)}" style="color:var(--text-2)">${escText(u.email)}</a>
                ${u.company ? `· <span>${escText(u.company)}</span>` : ''}
                · <span>${NEB.fmtDate(u.created_at)}</span>
                ${u.order_count ? `· <span>${u.order_count} order${u.order_count !== 1 ? 's' : ''}</span>` : ''}
              </div>
            </div>
            <div class="user-row-pills">
              ${u.email_verified ? '<span class="pill pill-paid">Geverifieerd</span>' : '<span class="pill pill-cancelled">Niet geverifieerd</span>'}
              ${u.newsletter_opt_in ? '<span class="pill pill-neutral" title="Nieuwsbrief">Nieuwsbrief</span>' : ''}
            </div>
            <div class="user-row-selects">
              <select class="select-inline" data-role="${u.id}" ${u.id === CURRENT_USER.id ? 'disabled' : ''}>
                ${ROLE_CHOICES.map(r => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}
              </select>
              <select class="select-inline" data-userstatus="${u.id}" ${u.id === CURRENT_USER.id ? 'disabled' : ''}>
                ${STATUS_USER_CHOICES.map(([v, l]) => `<option value="${v}" ${v === u.status ? 'selected' : ''}>${l}</option>`).join('')}
              </select>
            </div>
            <div class="user-row-actions">
              <button class="btn btn-ghost btn-sm" data-viewuser="${u.id}">Profiel</button>
              ${u.id !== CURRENT_USER.id ? `<button class="btn btn-danger btn-sm" data-deluser="${u.id}" title="Verwijder">✕</button>` : ''}
            </div>
          </div>`;
        }).join('') : `<div class="user-row-empty">Geen accounts gevonden.</div>`}
      </div>
    </div>
    <div id="userDetailWrap"></div>`;

  // Load newsletter section async
  loadNewsletterSection();

  const panel = document.getElementById('panel-users');
  if (!panel._usersBound) {
    panel._usersBound = true;
    panel.addEventListener('click', async (e) => {
      const approveId = e.target.dataset?.approve;
      const blockId = e.target.dataset?.block;
      const delId = e.target.dataset?.deluser;
      const viewId = e.target.dataset?.viewuser;
      const filterStatus = e.target.dataset?.userfilter;
      const filterNewsletter = e.target.dataset?.userfilterNewsletter;
      if (approveId) {
        try { await NEB.put(`/api/admin/users/${approveId}`, { status: 'ACTIVE' }); NEB.toast('Goedgekeurd', 'success'); await loadUsers(); NEB.paintAdminBadges(); } catch (err) { NEB.toast(err.message, 'error'); }
        return;
      }
      if (blockId) {
        try { await NEB.put(`/api/admin/users/${blockId}`, { status: 'BLOCKED' }); NEB.toast('Geblokkeerd'); await loadUsers(); } catch (err) { NEB.toast(err.message, 'error'); }
        return;
      }
      if (delId) {
        if (!confirm('Account permanent verwijderen?')) return;
        try { await NEB.del(`/api/admin/users/${delId}`); NEB.toast('Verwijderd'); await loadUsers(); NEB.paintAdminBadges(); } catch (err) { NEB.toast(err.message, 'error'); }
        return;
      }
      if (viewId) { showUserDetail(Number(viewId)); return; }
      if (filterStatus !== undefined) {
        const search = document.getElementById('userSearch')?.value || '';
        await loadUsers({ q: search, status: filterStatus || '' });
        return;
      }
      if (filterNewsletter) {
        const search = document.getElementById('userSearch')?.value || '';
        await loadUsers({ q: search, newsletter: '1' });
        return;
      }
    });
    panel.addEventListener('keydown', async (e) => {
      if (e.target.id === 'userSearch' && e.key === 'Enter') {
        await loadUsers({ q: e.target.value.trim() });
      }
    });
    panel.addEventListener('input', async (e) => {
      if (e.target.id === 'userSearch') {
        clearTimeout(panel._searchTimer);
        panel._searchTimer = setTimeout(() => loadUsers({ q: e.target.value.trim() }), 350);
      }
    });
  }
  panel.onchange = async (e) => {
    const roleId = e.target.dataset?.role;
    const statusId = e.target.dataset?.userstatus;
    try {
      if (roleId) await NEB.put(`/api/admin/users/${roleId}`, { role: e.target.value });
      if (statusId) await NEB.put(`/api/admin/users/${statusId}`, { status: e.target.value });
      NEB.toast('Bijgewerkt', 'success');
    } catch (err) { NEB.toast(err.message, 'error'); }
  };
}

// ── Newsletter section ────────────────────────────────────────────────────
async function loadNewsletterSection() {
  let wrap = document.getElementById('newsletterWrap');
  if (!wrap) {
    // Create and insert if not present
    const parent = document.getElementById('usersWrap')?.parentNode;
    if (!parent) return;
    wrap = document.createElement('div');
    wrap.id = 'newsletterWrap';
    wrap.style.marginTop = '1.5rem';
    parent.appendChild(wrap);
  }
  try {
    const { subscribers, total } = await NEB.get('/api/admin/users/newsletter');
    renderNewsletterSection(subscribers, total, wrap);
  } catch (err) {
    wrap.innerHTML = `<div class="card" style="padding:1rem"><span class="muted">Kon nieuwsbrief niet laden: ${escText(err.message)}</span></div>`;
  }
}

function renderNewsletterSection(subscribers, total, wrap) {
  const count = subscribers.length;
  const rate = total > 0 ? Math.round((count / total) * 100) : 0;
  const q = String(NEWSLETTER_STATE.q || '').trim().toLowerCase();
  const filtered = q
    ? subscribers.filter((u) => {
      const name = `${u.first_name || ''} ${u.last_name || ''}`.trim().toLowerCase();
      const email = String(u.email || '').toLowerCase();
      return name.includes(q) || email.includes(q);
    })
    : subscribers;

  wrap.innerHTML = `
    <div class="invoice-section-header">
      <span class="invoice-section-icon">📧</span>
      <div class="invoice-section-title-wrap">
        <span class="invoice-section-title">Nieuwsbrief</span>
        <span class="invoice-section-sub">${count} abonnee${count !== 1 ? 's' : ''} · ${rate}% opt-in</span>
      </div>
      <div style="display:flex;gap:.5rem">
        <a href="/api/admin/users/newsletter.csv" class="btn btn-ghost btn-sm">CSV exporteren</a>
        <button class="btn btn-primary btn-sm" id="sendNewsletterBtn">✉️ Verstuur nieuwsbrief</button>
      </div>
    </div>
    <div class="card" style="padding:1rem 1.1rem">
      <div style="display:flex;gap:.55rem;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:.8rem">
        <input type="search" id="newsletterSearch" value="${escAttr(NEWSLETTER_STATE.q || '')}" placeholder="Zoek op naam of e-mail" style="max-width:320px;background:var(--bg-input);border:1px solid var(--border);border-radius:999px;color:var(--text);padding:.42rem .78rem;font:inherit;font-size:.8rem">
        <span class="muted compact">${filtered.length} zichtbaar</span>
      </div>
      ${filtered.length ? `
        <div class="table-wrap">
          <table class="tbl">
            <thead><tr><th>Naam</th><th>E-mail</th><th>Aangemeld</th><th></th><th></th></tr></thead>
            <tbody>
              ${filtered.slice(0, 80).map(u => `
                <tr>
                  <td>${escText(`${u.first_name || ''} ${u.last_name || ''}`.trim() || '—')}</td>
                  <td><a href="mailto:${escAttr(u.email)}" style="color:var(--text-2);font-size:.82rem">${escText(u.email)}</a></td>
                  <td style="font-size:.78rem;color:var(--text-2)">${NEB.fmtDate(u.created_at)}</td>
                  <td><button class="btn btn-ghost btn-sm" data-newsletter-off="${u.id}">Uitschrijven</button></td>
                  <td><button class="btn btn-ghost btn-sm" data-viewuser="${u.id}">Profiel</button></td>
                </tr>
              `).join('')}
              ${filtered.length > 80 ? `<tr><td colspan="5" class="tbl-empty">… en ${filtered.length - 80} meer (gebruik CSV export voor volledig overzicht)</td></tr>` : ''}
            </tbody>
          </table>
        </div>` : '<p class="muted compact" style="margin:.5rem 0">Geen abonnees voor deze filter.</p>'}
    </div>`;

  wrap.querySelector('#sendNewsletterBtn')?.addEventListener('click', () => {
    openNewsletterModal(count);
  });

  wrap.querySelector('#newsletterSearch')?.addEventListener('input', (e) => {
    NEWSLETTER_STATE.q = e.target.value || '';
    renderNewsletterSection(subscribers, total, wrap);
  });

  // Profiel buttons in newsletter list
  wrap.querySelectorAll('[data-viewuser]').forEach(btn => {
    btn.addEventListener('click', () => showUserDetail(Number(btn.dataset.viewuser)));
  });

  wrap.querySelectorAll('[data-newsletter-off]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const uid = Number(btn.dataset.newsletterOff || 0);
      if (!uid) return;
      if (!confirm('Deze gebruiker uitschrijven van de nieuwsbrief?')) return;
      const old = btn.textContent;
      try {
        btn.disabled = true;
        btn.textContent = 'Opslaan...';
        await NEB.put(`/api/admin/users/${uid}`, { newsletterOptIn: 0 });
        NEB.toast('Gebruiker uitgeschreven', 'success');
        await loadUsers();
      } catch (err) {
        NEB.toast(err.message || 'Uitschrijven mislukt', 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = old || 'Uitschrijven';
      }
    });
  });
}

function openNewsletterModal(subscriberCount) {
  document.getElementById('newsletterModal')?.remove();
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'newsletterModal';
  modal.innerHTML = `
    <div class="modal-box" style="max-width:620px">
      <div class="order-modal-header">
        <div>
          <h2 style="margin:0;font-size:1.1rem;font-weight:700">Nieuwsbrief versturen</h2>
          <p style="margin:.2rem 0 0;font-size:.82rem;color:var(--text-muted)">Wordt verstuurd naar ${subscriberCount} abonnee${subscriberCount !== 1 ? 's' : ''}</p>
        </div>
        <button id="closeNewsletterModal" class="btn btn-ghost btn-sm" style="font-size:1rem;padding:.35rem .65rem">✕</button>
      </div>
      <div style="padding:1.25rem 1.4rem">
        <div class="field" style="margin-bottom:.85rem">
          <label style="font-size:.83rem;font-weight:600;display:block;margin-bottom:.35rem">Onderwerp</label>
          <input id="nlSubject" type="text" placeholder="Onderwerp van de e-mail" style="width:100%;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--r-btn);color:var(--text);padding:.5rem .8rem;font:inherit;font-size:.88rem;box-sizing:border-box">
        </div>
        <div class="field" style="margin-bottom:1rem">
          <label style="font-size:.83rem;font-weight:600;display:block;margin-bottom:.35rem">Inhoud (HTML toegestaan)</label>
          <textarea id="nlBody" rows="10" placeholder="<p>Beste klant,</p><p>...</p>" style="width:100%;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--r-md);color:var(--text);padding:.6rem .75rem;font:inherit;font-size:.84rem;resize:vertical;box-sizing:border-box"></textarea>
        </div>
        <div style="display:flex;gap:.5rem;justify-content:flex-end">
          <button class="btn btn-ghost btn-sm" id="closeNewsletterModal2">Annuleren</button>
          <button class="btn btn-primary btn-sm" id="sendNewsletterConfirmBtn">✉️ Verstuur naar ${subscriberCount} abonnee${subscriberCount !== 1 ? 's' : ''}</button>
        </div>
        <div id="nlResult" style="margin-top:.75rem"></div>
      </div>
    </div>`;

  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add('show'));

  const close = () => { modal.classList.remove('show'); setTimeout(() => modal.remove(), 250); };
  modal.querySelector('#closeNewsletterModal').addEventListener('click', close);
  modal.querySelector('#closeNewsletterModal2').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  modal.querySelector('#sendNewsletterConfirmBtn').addEventListener('click', async () => {
    const subject = modal.querySelector('#nlSubject').value.trim();
    const html = modal.querySelector('#nlBody').value.trim();
    const btn = modal.querySelector('#sendNewsletterConfirmBtn');
    const result = modal.querySelector('#nlResult');
    if (!subject || !html) { result.innerHTML = '<span class="muted" style="color:var(--danger)">Vul onderwerp en inhoud in.</span>'; return; }
    btn.disabled = true; btn.textContent = 'Versturen…';
    try {
      const r = await NEB.post('/api/admin/newsletter/send', { subject, html });
      result.innerHTML = `<span class="pill pill-paid">✓ ${r.sent} verstuurd${r.failed ? ` · ${r.failed} mislukt` : ''}</span>`;
      NEB.toast(`Nieuwsbrief verstuurd (${r.sent})`, 'success');
      setTimeout(close, 2000);
    } catch (err) {
      result.innerHTML = `<span style="color:var(--danger)">${escText(err.message)}</span>`;
      btn.disabled = false; btn.textContent = `✉️ Verstuur naar ${subscriberCount} abonnees`;
    }
  });
}

async function showUserDetail(userId) {
  // Remove any existing user detail modal
  document.getElementById('userDetailModal')?.remove();

  // Show loading modal immediately
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'userDetailModal';
  modal.innerHTML = `<div class="modal-box user-modal-box"><div style="padding:2.5rem;text-align:center"><span class="muted">Laden…</span></div></div>`;
  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add('show'));

  const closeModal = () => { modal.classList.remove('show'); setTimeout(() => modal.remove(), 250); };
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

  try {
    const { user: u, orders } = await NEB.get(`/api/admin/users/${userId}`);
    const tags = (() => { try { return JSON.parse(u.tags || '[]'); } catch { return []; } })();
    const name = ((u.first_name || '') + ' ' + (u.last_name || '')).trim() || u.email;

    modal.innerHTML = `
      <div class="modal-box user-modal-box">
        <div class="user-modal-header">
          <div>
            <h2 style="margin:0;font-size:1.1rem;font-weight:700">${escText(name)}</h2>
            <p style="margin:.2rem 0 0;font-size:.82rem;color:var(--text-muted)">${escText(u.email)} · lid sinds ${NEB.fmtDate(u.created_at)}</p>
          </div>
          <button class="btn btn-ghost btn-sm" id="closeUserModal" style="font-size:1rem;padding:.35rem .65rem">✕</button>
        </div>
        <div class="user-modal-body">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.5rem" class="order-detail-grid">
            <div>
              <div class="ds-title" style="margin-bottom:.5rem">Profiel</div>
              <div class="kv-list" style="margin-bottom:1.25rem">
                <div class="kv"><span class="kv-key">Naam</span><span class="kv-val">${escText(name)}</span></div>
                <div class="kv"><span class="kv-key">E-mail</span><span class="kv-val">${escText(u.email)}</span></div>
                <div class="kv"><span class="kv-key">Telefoon</span><span class="kv-val">${escText(u.phone || '—')}</span></div>
                <div class="kv"><span class="kv-key">Bedrijf</span><span class="kv-val">${escText(u.company || '—')}</span></div>
                <div class="kv"><span class="kv-key">BTW-nr</span><span class="kv-val">${escText(u.vat_number || '—')}</span></div>
                <div class="kv"><span class="kv-key">Adres</span><span class="kv-val">${escText([u.address, [u.postcode, u.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') || '—')}</span></div>
              </div>
              <div class="ds-title" style="margin-bottom:.5rem">Beveiliging</div>
              <div class="kv-list" style="margin-bottom:1.25rem">
                <div class="kv"><span class="kv-key">Rol</span><span class="kv-val">
                  <select class="select-inline" id="udRoleSelect" ${u.id === CURRENT_USER.id ? 'disabled' : ''}>
                    ${ROLE_CHOICES.map(r => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}
                  </select>
                </span></div>
                <div class="kv"><span class="kv-key">Status</span><span class="kv-val">
                  <select class="select-inline" id="udStatusSelect" ${u.id === CURRENT_USER.id ? 'disabled' : ''}>
                    ${STATUS_USER_CHOICES.map(([v, l]) => `<option value="${v}" ${v === u.status ? 'selected' : ''}>${l}</option>`).join('')}
                  </select>
                </span></div>
                <div class="kv"><span class="kv-key">E-mailverificatie</span><span class="kv-val">${u.email_verified ? '<span class="pill pill-paid">✓ Geverifieerd</span>' : '<span class="pill pill-cancelled">✗ Niet geverifieerd</span>'}</span></div>
                <div class="kv"><span class="kv-key">2FA</span><span class="kv-val">${u.totp_enabled ? '<span class="pill pill-paid">✓ Ingeschakeld</span>' : '<span class="muted compact">Uitgeschakeld</span>'}</span></div>
                <div class="kv"><span class="kv-key">Laatste login</span><span class="kv-val">${u.last_login_at ? NEB.fmtDate(u.last_login_at) : '—'}</span></div>
              </div>
              <div style="display:flex;gap:.5rem;flex-wrap:wrap">
                ${u.id !== CURRENT_USER.id ? `<button class="btn btn-ghost btn-sm" id="udSaveRoleStatus">Rol/status opslaan</button>` : ''}
                ${!u.email_verified ? `<button class="btn btn-ghost btn-sm" id="udResendVerification">Verificatiemail sturen</button>` : ''}
              </div>
            </div>
            <div>
              <div class="ds-title" style="margin-bottom:.5rem">Tags</div>
              <div id="udTagsWrap" style="display:flex;flex-wrap:wrap;gap:.35rem;margin-bottom:.65rem">
                ${tags.map((t, i) => `<span class="pill pill-neutral" style="cursor:pointer" data-rmtag="${i}">${escText(t)} ×</span>`).join('')}
              </div>
              <div style="display:flex;gap:.5rem;margin-bottom:1.25rem">
                <input id="udNewTag" placeholder="Nieuwe tag (bv. VIP)" style="flex:1;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--r-btn);color:var(--text);padding:.42rem .75rem;font:inherit;font-size:.84rem">
                <button class="btn btn-ghost btn-sm" id="udAddTag">+ Tag</button>
              </div>
              <div class="ds-title" style="margin-bottom:.5rem">Nieuwsbrief</div>
              <div style="display:flex;align-items:center;gap:.65rem;margin-bottom:1.25rem;flex-wrap:wrap">
                <label style="display:flex;align-items:center;gap:.5rem;font-size:.88rem;cursor:pointer;flex:1;min-width:0">
                  <input type="checkbox" id="udNewsletter" ${u.newsletter_opt_in ? 'checked' : ''}> Ingeschreven voor nieuwsbrief
                </label>
                <span id="udNewsletterStatus" style="font-size:.75rem;color:var(--text-2)"></span>
              </div>
              <div class="ds-title" style="margin-bottom:.5rem">Interne notities <span class="muted compact">(niet zichtbaar voor klant)</span></div>
              <textarea id="udNotes" rows="4" style="width:100%;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--r-md);color:var(--text);padding:.6rem .75rem;font:inherit;font-size:.84rem;resize:vertical;box-sizing:border-box">${escText(u.internal_notes || '')}</textarea>
              <div style="margin-top:.5rem;display:flex;gap:.5rem">
                <button class="btn btn-primary btn-sm" id="udSaveCrm">CRM opslaan</button>
              </div>
              <div class="ds-title" style="margin-top:1.25rem;margin-bottom:.5rem">Ordergeschiedenis</div>
              ${orders.length ? orders.slice(0, 10).map(o => `
                <div class="h-row" style="cursor:pointer" data-open-order="${o.id}">
                  <span><strong>#${String(o.id).padStart(4,'0')}</strong> ${NEB.statusPill(o.status)}</span>
                  <span>${NEB.fmtEUR(o.total)} · ${NEB.fmtDate(o.created_at)}</span>
                </div>
              `).join('') : '<span class="muted compact">Nog geen bestellingen.</span>'}
            </div>
          </div>
        </div>
      </div>`;

    let currentTags = [...tags];

    modal.querySelector('#closeUserModal')?.addEventListener('click', closeModal);
    modal.querySelector('#udSaveRoleStatus')?.addEventListener('click', async () => {
      const role = modal.querySelector('#udRoleSelect')?.value;
      const status = modal.querySelector('#udStatusSelect')?.value;
      try {
        await NEB.put(`/api/admin/users/${userId}`, { role, status });
        NEB.toast('Rol/status bijgewerkt', 'success');
        await loadUsers();
        closeModal();
        await showUserDetail(userId);
      } catch (err) { NEB.toast(err.message, 'error'); }
    });
    modal.querySelector('#udResendVerification')?.addEventListener('click', async () => {
      try {
        await NEB.put(`/api/admin/users/${userId}`, { resendVerification: true });
        NEB.toast('Verificatiemail verzonden', 'success');
      } catch (err) { NEB.toast(err.message, 'error'); }
    });
    // Newsletter checkbox — auto-saves immediately on toggle
    modal.querySelector('#udNewsletter')?.addEventListener('change', async (e) => {
      const cb = e.target;
      const statusEl = modal.querySelector('#udNewsletterStatus');
      const val = cb.checked ? 1 : 0;
      cb.disabled = true;
      if (statusEl) statusEl.textContent = 'Opslaan…';
      try {
        await NEB.put(`/api/admin/users/${userId}`, { newsletterOptIn: val });
        if (statusEl) statusEl.textContent = val ? '✓ Ingeschreven' : '✓ Uitgeschreven';
        setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2500);
        await loadNewsletterSection();
      } catch (err) {
        cb.checked = !cb.checked; // revert
        if (statusEl) statusEl.textContent = '✗ Mislukt';
        NEB.toast(err.message, 'error');
      } finally {
        cb.disabled = false;
      }
    });
    modal.querySelector('#udAddTag')?.addEventListener('click', () => {
      const inp = modal.querySelector('#udNewTag');
      const val = inp?.value.trim().slice(0, 40);
      if (!val || currentTags.includes(val)) return;
      currentTags.push(val);
      inp.value = '';
      const tagsWrap = modal.querySelector('#udTagsWrap');
      if (tagsWrap) tagsWrap.innerHTML = currentTags.map((t, i) => `<span class="pill pill-neutral" style="cursor:pointer" data-rmtag="${i}">${escText(t)} ×</span>`).join('');
    });
    modal.querySelector('#udTagsWrap')?.addEventListener('click', (e) => {
      const rmIdx = e.target.dataset?.rmtag;
      if (rmIdx == null) return;
      currentTags.splice(Number(rmIdx), 1);
      modal.querySelector('#udTagsWrap').innerHTML = currentTags.map((t, i) => `<span class="pill pill-neutral" style="cursor:pointer" data-rmtag="${i}">${escText(t)} ×</span>`).join('');
    });
    modal.querySelector('#udSaveCrm')?.addEventListener('click', async () => {
      const btn = modal.querySelector('#udSaveCrm');
      btn.disabled = true; btn.textContent = 'Opslaan...';
      try {
        await NEB.put(`/api/admin/users/${userId}`, {
          tags: currentTags,
          internalNotes: modal.querySelector('#udNotes')?.value || ''
        });
        NEB.toast('CRM-gegevens opgeslagen', 'success');
        await loadUsers();
      } catch (err) { NEB.toast(err.message, 'error'); } finally {
        btn.disabled = false; btn.textContent = 'CRM opslaan';
      }
    });
    modal.querySelectorAll('[data-open-order]').forEach(row => {
      row.addEventListener('click', () => {
        closeModal();
        document.querySelector('.tab[data-tab="orders"]')?.click();
        showOrderDetail(Number(row.dataset.openOrder));
      });
    });
  } catch (err) {
    modal.innerHTML = `<div class="modal-box user-modal-box"><div style="padding:2rem;text-align:center"><span class="muted">Kon profiel niet laden: ${escText(err.message)}</span></div></div>`;
  }
}

// ── Products tab helpers ──────────────────────────────────────────────────
function renderProductCard(p, i) {
  const src = (p.mockupPath || '').replace(/^\/+/, '');
  const thumb = src
    ? `<img src="/${escAttr(src)}" class="prod-card-img" alt="${escAttr(p.name)}" loading="lazy" onerror="this.onerror=null;this.src='/assets/tshirt_mockup.png';">`
    : `<div class="prod-card-img prod-card-img--empty">📦</div>`;
  const priceLabel = p.basePrice != null ? NEB.fmtEUR(p.basePrice) : `×${Number(p.priceMultiplier || 1).toFixed(2)}`;
  const cc = (p.colorHexes || []).length;
  const sc = (p.sizes || []).length;
  return `
    <div class="prod-card${p.enabled === false ? ' prod-card--disabled' : ''}">
      <div class="prod-card-thumb">
        ${thumb}
        ${p.isDefault ? '<span class="prod-card-badge">Default</span>' : ''}
        ${p.enabled === false ? '<span class="prod-card-badge prod-card-badge--off">Inactief</span>' : ''}
      </div>
      <div class="prod-card-body">
        <div class="prod-card-name">${escText(p.name)}</div>
        <div class="prod-card-meta">#${Number(p.sortOrder || 0)} · ${priceLabel} · ${cc} kleur${cc !== 1 ? 'en' : ''} · ${sc} maat${sc !== 1 ? 'en' : ''}</div>
      </div>
      <button class="btn btn-ghost btn-sm prod-card-edit" data-edit-product="${i}" type="button">Bewerk ›</button>
    </div>`;
}

function renderProductsTabPanel(products, c) {
  const productCards = products.map((p, i) => renderProductCard(p, i)).join('');

  const colorSwatches = (c.colors || []).map((col, i) => `
    <div class="color-swatch-item" data-color-row="${i}">
      <div class="color-ball" style="background:${escAttr(col.hex)}" title="${escAttr(col.hex)}"></div>
      <div class="color-swatch-info">
        <input class="select-inline" data-cf="name" value="${escAttr(col.name)}" placeholder="Naam">
        <input class="select-inline" data-cf="hex" value="${escAttr(col.hex)}" placeholder="#rrggbb" style="font-family:monospace;max-width:96px">
      </div>
      <label class="color-swatch-active">
        <input type="checkbox" data-cf="enabled" ${col.enabled !== false ? 'checked' : ''}> Actief
      </label>
      <button class="btn btn-danger btn-sm" data-removecolor="${i}" type="button">×</button>
    </div>`).join('');

  const sizes = c.sizes || [];
  const sizeRowsHtml = sizes.map(s => `
    <tr>
      <td><strong>${escText(s)}</strong></td>
      <td><div style="display:flex;align-items:center;gap:.3rem">
        <input type="number" step="0.01" min="0" class="select-inline" value="${(c.pricing?.sizeUpcharge?.[s] || 0).toFixed(2)}" data-size-price="${escAttr(s)}" style="width:80px;text-align:right">
        <span class="muted">€</span></div></td>
      <td><button class="btn btn-danger btn-sm" data-removesize="${escAttr(s)}" type="button">×</button></td>
    </tr>`).join('');

  return `
    <div class="stab-panel" data-stab="producten">
      <div class="prod-subtab-bar">
        <button class="prod-subtab active" data-prod-subtab="producten" type="button">📦 Producten</button>
        <button class="prod-subtab" data-prod-subtab="kleuren" type="button">🎨 Kleuren</button>
        <button class="prod-subtab" data-prod-subtab="maten" type="button">📐 Maten &amp; Prijzen</button>
      </div>

      <div class="prod-subtab-panel active" data-prod-subtab-panel="producten">
        <div class="settings-section">
          <h3>Productcatalogus</h3>
          <p class="muted compact" style="margin:-.5rem 0 1.2rem">Klik op <strong>Bewerk</strong> om prijs, kleuren, maten en mockup per product in te stellen.</p>
          <div class="prod-card-grid">${productCards || '<p class="muted">Nog geen producten.</p>'}</div>
          <button class="btn btn-ghost btn-sm" id="addProduct" style="margin-top:1.25rem" type="button">+ Nieuw product</button>
        </div>
      </div>

      <div class="prod-subtab-panel" data-prod-subtab-panel="kleuren">
        <div class="settings-section">
          <h3>Kleurenpalet</h3>
          <p class="muted compact" style="margin:-.5rem 0 1rem">Klanten zien alleen actieve kleuren. Gebruik hex-waarden (#rrggbb).</p>
          <div class="color-swatch-grid" id="colorRows">${colorSwatches}</div>
          <div class="row-add" style="margin-top:1rem">
            <input id="newColorName" placeholder="Naam (bv. Marine)">
            <input id="newColorHex" placeholder="#001f3f" style="font-family:monospace">
            <button class="btn btn-ghost btn-sm" id="addColor" type="button">+ Kleur</button>
          </div>
        </div>
      </div>

      <div class="prod-subtab-panel" data-prod-subtab-panel="maten">
        <div class="settings-section">
          <h3>Globale prijsinstellingen</h3>
          <p class="muted compact" style="margin:-.5rem 0 1rem">Per-product prijzen overschrijven deze waarden. Terugvalwaarden worden gebruikt als een product geen eigen prijs heeft.</p>
          <div class="form-grid-2">
            <div class="field"><label>Terugval basisprijs (€)</label><input type="number" step="0.01" min="0" id="basePrice" value="${(c.pricing?.basePrice || 0).toFixed(2)}"></div>
            <div class="field"><label>Globale extra design opslag (€)</label><input type="number" step="0.01" min="0" id="extraFee" value="${(c.pricing?.extraDesignFee || 0).toFixed(2)}"></div>
          </div>
        </div>
        <div class="settings-section">
          <h3>Maten &amp; opslagen</h3>
          <p class="muted compact" style="margin:-.5rem 0 1rem">Maten worden automatisch in juiste volgorde gesorteerd. Opslag is het extra bedrag bovenop de basisprijs.</p>
          ${sizes.length > 0 ? `<table class="size-price-table">
            <thead><tr><th>Maat</th><th>Opslag</th><th></th></tr></thead>
            <tbody>${sizeRowsHtml}</tbody>
          </table>` : '<p class="muted" style="margin-bottom:.75rem">Nog geen maten.</p>'}
          <div class="row-add" style="margin-top:.75rem">
            <input id="newSize" placeholder="Maat (bv. XXXL)" style="max-width:140px">
            <input id="newSizeUp" type="number" step="0.01" placeholder="Opslag (€)" style="max-width:120px">
            <button class="btn btn-ghost btn-sm" id="addSize" type="button">+ Maat</button>
          </div>
        </div>
      </div>
    </div><!-- /stab producten -->`;
}

function openProductModal(productIdx, draft, globalCfg, rerenderFn, persistFn = null) {
  const isNew = productIdx === -1;
  const p = isNew ? {
    id: '', name: '', description: '', basePrice: null, extraDesignFee: null,
    priceMultiplier: 1, extraDesignFeeMultiplier: 1,
    mockupPath: '', colorHexes: [], sizes: [], colorData: {}, colorPrices: {}, sizePrices: {},
    enabled: true, isDefault: false, sortOrder: (draft.products || []).length * 10 + 10
  } : JSON.parse(JSON.stringify(draft.products[productIdx]));

  const normalizeHex = (hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    return m ? `#${m[1].toLowerCase()}` : '';
  };
  const globalColors = (globalCfg.colors || []).map((col) => ({
    ...col,
    hex: normalizeHex(col?.hex || '')
  })).filter((col) => col.hex);
  const globalSizes = globalCfg.sizes || [];
  const colorDataDraft = JSON.parse(JSON.stringify(p.colorData || {}));

  const colorModalRows = globalColors.map(col => {
    const hex = normalizeHex(col.hex);
    const selectedSet = new Set((p.colorHexes || []).map(normalizeHex).filter(Boolean));
    const checked = selectedSet.has(hex);
    const priceUp = (p.colorPrices || {})[hex] ?? ((colorDataDraft || {})[hex]?.priceUpcharge ?? '');
    const mockupPath = (colorDataDraft || {})[hex]?.mockupPath || '';
    const mockupThumb = mockupPath
      ? `<img src="/${escAttr(mockupPath)}" style="width:32px;height:32px;object-fit:cover;border-radius:4px;border:1px solid var(--border)" alt="">`
      : `<div style="width:32px;height:32px;border-radius:4px;border:1px dashed var(--border)"></div>`;
    return `
      <div class="prod-modal-color-row" data-modal-color="${escAttr(hex)}">
        <input type="checkbox" class="pm-color-enabled" ${checked ? 'checked' : ''}>
        <div class="color-ball" style="background:${escAttr(hex)};width:22px;height:22px;min-width:22px" title="${escAttr(col.name)}"></div>
        <span class="pm-color-name">${escText(col.name)}</span>
        <input type="number" step="0.01" min="0" class="select-inline pm-color-price" value="${priceUp !== '' ? priceUp : ''}" placeholder="Opslag €" style="width:90px" title="Extra prijsopslag voor deze kleur">
        <div class="pm-color-mockup-wrap">
          ${mockupThumb}
          <button type="button" class="btn btn-ghost btn-sm pm-color-mockup-btn" data-modal-color-mockup="${escAttr(hex)}" title="Upload kleurspecifieke mockup">📷</button>
          ${mockupPath ? `<button type="button" class="btn btn-danger btn-sm" data-modal-color-mockup-del="${escAttr(hex)}" title="Verwijder kleurspecifieke mockup">×</button>` : ''}
          <input type="file" class="pm-color-mockup-file" data-modal-color-file="${escAttr(hex)}" accept="image/*" hidden>
        </div>
      </div>`;
  }).join('');

  const sizeModalRows = globalSizes.map(s => {
    const prodSizes = Array.isArray(p.sizes) ? p.sizes : [];
    const sizeSpec = prodSizes.find((sz) => String(typeof sz === 'string' ? sz : (sz.code || '')).toUpperCase() === String(s).toUpperCase());
    const checked = !!sizeSpec || prodSizes.map((sz) => typeof sz === 'string' ? sz : sz.code).includes(String(s));
    const widthMm = Number(sizeSpec?.widthMm || sizeSpec?.width || 0) || 0;
    const heightMm = Number(sizeSpec?.heightMm || sizeSpec?.height || 0) || 0;
    const cmText = (widthMm > 0 && heightMm > 0) ? `${(widthMm / 10).toFixed(1)} × ${(heightMm / 10).toFixed(1)} cm` : 'maat niet ingesteld';
    const sizePrice = (p.sizePrices || {})[s];
    return `
      <div class="prod-modal-size-row">
        <input type="checkbox" class="pm-size-enabled" data-modal-size="${escAttr(s)}" ${checked ? 'checked' : ''}>
        <span class="pm-size-label">${escText(s)}</span>
        <input type="number" step="0.01" min="0" class="select-inline pm-size-price" value="${sizePrice != null ? sizePrice : ''}" placeholder="Opslag €" style="width:90px" data-modal-size-price="${escAttr(s)}" title="Productspecifieke maat-opslag">
        <span class="muted compact">€ extra</span>
        <input type="number" min="10" max="20000" step="1" class="select-inline pm-size-mm" value="${widthMm || ''}" data-modal-size-width="${escAttr(s)}" placeholder="breedte mm" style="width:95px">
        <input type="number" min="10" max="20000" step="1" class="select-inline pm-size-mm" value="${heightMm || ''}" data-modal-size-height="${escAttr(s)}" placeholder="hoogte mm" style="width:95px">
        <span class="muted compact" data-modal-size-cm="${escAttr(s)}">${escText(cmText)}</span>
      </div>`;
  }).join('');

  document.getElementById('prodEditModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'prodEditModal';
  modal.className = 'modal-overlay';
  const mockupSrc = (p.mockupPath || '').replace(/^\/+/, '');
  modal.innerHTML = `
    <div class="modal-box prod-modal-box">
      <div class="prod-modal-header">
        <h2>${isNew ? 'Nieuw product' : `Bewerk: ${escText(p.name)}`}</h2>
        <button type="button" class="btn btn-ghost btn-sm" id="prodModalClose">✕</button>
      </div>
      <div class="prod-modal-wizard" id="prodModalWizardBar" hidden></div>
      <div class="prod-modal-body">
        <div class="prod-modal-section">
          <h4 class="prod-modal-section-title">Basis</h4>
          <div class="form-grid-2">
            <div class="field"><label>Naam</label><input id="pmName" value="${escAttr(p.name)}" placeholder="T-shirt"></div>
            <div class="field"><label>ID / slug <span class="muted compact">(auto)</span></label><input id="pmId" value="${escAttr(p.id)}" placeholder="tshirt" style="font-family:monospace"></div>
            <div class="field"><label>Volgorde</label><input id="pmSortOrder" type="number" min="0" max="9999" step="1" value="${escAttr(p.sortOrder != null ? p.sortOrder : 10)}" placeholder="10"></div>
          </div>
          <div class="field" style="margin-top:.75rem"><label>Beschrijving</label><textarea id="pmDesc" rows="2">${escText(p.description || '')}</textarea></div>
          <div style="display:flex;gap:1.5rem;margin-top:.75rem;align-items:center;flex-wrap:wrap">
            <label style="display:flex;align-items:center;gap:.4rem;font-size:.9rem;text-transform:none;letter-spacing:0;color:var(--text)">
              <input type="checkbox" id="pmEnabled" ${p.enabled !== false ? 'checked' : ''}> Actief
            </label>
            <label style="display:flex;align-items:center;gap:.4rem;font-size:.9rem;text-transform:none;letter-spacing:0;color:var(--text)">
              <input type="radio" name="pmDefaultProd" id="pmDefault" ${p.isDefault ? 'checked' : ''}> Default product
            </label>
          </div>
        </div>
        <div class="prod-modal-section">
          <h4 class="prod-modal-section-title">Prijs</h4>
          <div class="form-grid-2">
            <div class="field"><label>Basisprijs (€)</label><input type="number" step="0.01" min="0" id="pmBasePrice" value="${p.basePrice != null ? p.basePrice : ''}" placeholder="34.95"></div>
            <div class="field"><label>Extra design opslag (€)</label><input type="number" step="0.01" min="0" id="pmExtraFee" value="${p.extraDesignFee != null ? p.extraDesignFee : ''}" placeholder="7.50"></div>
          </div>
          <p class="muted compact" style="margin-top:.5rem">Leeg laten → terugvalwaarde uit globale instellingen.</p>
        </div>
        <div class="prod-modal-section">
          <h4 class="prod-modal-section-title">Mockup afbeelding</h4>
          <div style="display:flex;align-items:center;gap:1rem">
            <div id="pmMockupThumb">
              ${mockupSrc ? `<img src="/${escAttr(mockupSrc)}" style="width:64px;height:64px;object-fit:cover;border-radius:8px;border:1px solid var(--border)" alt="" onerror="this.onerror=null;this.src='/assets/tshirt_mockup.png';">` : `<div style="width:64px;height:64px;border-radius:8px;border:2px dashed var(--border);display:flex;align-items:center;justify-content:center;font-size:1.4rem">📦</div>`}
            </div>
            <div style="flex:1">
              <input id="pmMockupPath" class="select-inline" value="${escAttr(p.mockupPath || '')}" placeholder="assets/tshirt_mockup.png" style="width:100%;margin-bottom:.4rem">
              <button type="button" class="btn btn-ghost btn-sm" id="pmMockupUploadBtn">📷 Upload mockup</button>
              <input type="file" id="pmMockupFile" accept="image/*" hidden>
            </div>
          </div>
        </div>
        ${globalColors.length > 0 ? `
        <div class="prod-modal-section">
          <h4 class="prod-modal-section-title">Kleuren voor dit product</h4>
          <p class="muted compact" style="margin:-.5rem 0 .75rem">Vink aan welke kleuren beschikbaar zijn. Stel optioneel een prijsopslag en kleurspecifieke mockup in.</p>
          <div class="prod-modal-color-list">${colorModalRows}</div>
        </div>` : ''}
        ${globalSizes.length > 0 ? `
        <div class="prod-modal-section">
          <h4 class="prod-modal-section-title">Maten voor dit product</h4>
          <p class="muted compact" style="margin:-.5rem 0 .75rem">Vink aan welke maten beschikbaar zijn. Stel optioneel een productspecifieke maat-opslag in (overschrijft globale waarde).</p>
          <div class="prod-modal-size-list">${sizeModalRows}</div>
        </div>` : ''}
      </div>
      <div class="prod-modal-footer">
        ${isNew ? '' : `<button type="button" class="btn btn-danger" id="prodModalDelete">Verwijder product</button>`}
        <div class="prod-modal-footer-actions" style="${isNew ? 'margin-left:auto' : ''}">
          <button type="button" class="btn btn-ghost" id="prodModalPrev" hidden>Vorige</button>
          <button type="button" class="btn btn-primary" id="prodModalNext" hidden>Volgende</button>
          <button type="button" class="btn btn-ghost" id="prodModalCancel">Annuleer</button>
          <button type="button" class="btn btn-primary" id="prodModalSave">${isNew ? 'Product aanmaken' : 'Opslaan'}</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.classList.add('show');

  const closeModal = () => modal.remove();
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
  modal.querySelector('#prodModalClose').addEventListener('click', closeModal);
  modal.querySelector('#prodModalCancel').addEventListener('click', closeModal);

  const sections = Array.from(modal.querySelectorAll('.prod-modal-section'));
  const wizardBar = modal.querySelector('#prodModalWizardBar');
  const prevBtn = modal.querySelector('#prodModalPrev');
  const nextBtn = modal.querySelector('#prodModalNext');
  const saveBtn = modal.querySelector('#prodModalSave');
  let stepIdx = 0;

  const stepTitleMap = {
    basis: '1. Basis',
    prijs: '2. Prijs',
    mockup: '3. Mockup',
    kleuren: '4. Kleuren',
    maten: '5. Maten'
  };
  const getStepLabel = (section, idx) => {
    const raw = String(section.querySelector('.prod-modal-section-title')?.textContent || '').trim().toLowerCase();
    if (raw.startsWith('basis')) return stepTitleMap.basis;
    if (raw.startsWith('prijs')) return stepTitleMap.prijs;
    if (raw.startsWith('mockup')) return stepTitleMap.mockup;
    if (raw.startsWith('kleuren')) return stepTitleMap.kleuren;
    if (raw.startsWith('maten')) return stepTitleMap.maten;
    return `${idx + 1}. Stap`;
  };

  if (sections.length > 1) {
    wizardBar.hidden = false;
    wizardBar.className = 'prod-modal-wizard prod-subtab-bar';
    wizardBar.innerHTML = sections
      .map((section, idx) => `<button type="button" class="prod-subtab${idx === 0 ? ' active' : ''}" data-pm-step="${idx}">${getStepLabel(section, idx)}</button>`)
      .join('');
    prevBtn.hidden = false;
    nextBtn.hidden = false;

    const showStep = (idx) => {
      stepIdx = Math.max(0, Math.min(sections.length - 1, idx));
      sections.forEach((section, i) => {
        section.hidden = i !== stepIdx;
      });
      wizardBar.querySelectorAll('[data-pm-step]').forEach((btn) => {
        btn.classList.toggle('active', Number(btn.dataset.pmStep) === stepIdx);
      });
      prevBtn.disabled = stepIdx === 0;
      nextBtn.hidden = stepIdx >= sections.length - 1;
      saveBtn.hidden = stepIdx < sections.length - 1;
    };

    wizardBar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pm-step]');
      if (!btn) return;
      showStep(Number(btn.dataset.pmStep));
    });
    prevBtn.addEventListener('click', () => showStep(stepIdx - 1));
    nextBtn.addEventListener('click', () => {
      if (stepIdx === 0 && !(modal.querySelector('#pmName')?.value || '').trim()) {
        NEB.toast('Naam is verplicht', 'error');
        modal.querySelector('#pmName')?.focus();
        return;
      }
      showStep(stepIdx + 1);
    });
    showStep(0);
  }

  if (!isNew) {
    modal.querySelector('#prodModalDelete').addEventListener('click', async () => {
      if (!confirm(`Product "${p.name}" definitief verwijderen?`)) return;
      draft.products = normalizeProducts((draft.products || []).filter((_, i) => i !== productIdx));
      if (typeof persistFn === 'function') {
        try {
          await persistFn('Product verwijderd');
        } catch {
          return;
        }
      }
      closeModal();
      rerenderFn();
    });
  }

  modal.querySelector('#pmMockupUploadBtn').addEventListener('click', () => modal.querySelector('#pmMockupFile').click());
  modal.querySelector('#pmMockupFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append('mockup', file, file.name);
    const btn = modal.querySelector('#pmMockupUploadBtn');
    try {
      if (btn) { btn.disabled = true; btn.textContent = 'Upload...'; }
      const out = await NEB.json('/api/admin/products/mockup', { method: 'POST', body: form });
      if (modal.querySelector('#pmMockupPath')) modal.querySelector('#pmMockupPath').value = out.path || '';
      const thumb = modal.querySelector('#pmMockupThumb');
      if (thumb && out.path) thumb.innerHTML = `<img src="/${escAttr(out.path)}" style="width:64px;height:64px;object-fit:cover;border-radius:8px;border:1px solid var(--border)" alt="">`;
      NEB.toast('Mockup geüpload', 'success');
    } catch (err) { NEB.toast(err.message || 'Mockup upload mislukt', 'error'); }
    finally { if (btn) { btn.disabled = false; btn.textContent = '📷 Upload mockup'; } e.target.value = ''; }
  });

  modal.addEventListener('click', async e => {
    const uploadBtn = e.target.closest('[data-modal-color-mockup]');
    const delBtn = e.target.closest('[data-modal-color-mockup-del]');
    if (uploadBtn) {
      const hex = uploadBtn.dataset.modalColorMockup;
      modal.querySelector(`[data-modal-color-file="${CSS.escape(hex)}"]`)?.click();
      return;
    }
    if (delBtn) {
      const hex = normalizeHex(delBtn.dataset.modalColorMockupDel);
      const prodId = !isNew ? draft.products?.[productIdx]?.id : null;
      if (!prodId) return;
      try {
        await NEB.json(`/api/admin/products/${encodeURIComponent(prodId)}/colors/${encodeURIComponent(hex)}/mockup`, { method: 'DELETE' });
        colorDataDraft[hex] = { ...(colorDataDraft[hex] || {}), mockupPath: '' };
        if (draft.products?.[productIdx]) {
          const next = { ...(draft.products[productIdx].colorData || {}) };
          next[hex] = { ...(next[hex] || {}), mockupPath: '' };
          draft.products[productIdx].colorData = next;
        }
        const row = modal.querySelector(`[data-modal-color="${CSS.escape(hex)}"]`);
        if (row) {
          const wrap = row.querySelector('.pm-color-mockup-wrap');
          if (wrap) {
            wrap.querySelector('img')?.remove();
            delBtn.remove();
            const emptyDiv = document.createElement('div');
            emptyDiv.style.cssText = 'width:32px;height:32px;border-radius:4px;border:1px dashed var(--border)';
            wrap.insertBefore(emptyDiv, wrap.firstChild);
          }
        }
        NEB.toast('Kleur mockup verwijderd', 'success');
      } catch (err) { NEB.toast(err.message || 'Verwijderen mislukt', 'error'); }
    }
  });

  modal.addEventListener('change', async e => {
    const fileInput = e.target.closest('[data-modal-color-file]');
    if (!fileInput) return;
    const hex = normalizeHex(fileInput.dataset.modalColorFile);
    const file = e.target.files?.[0];
    if (!file) return;
    if (isNew) { NEB.toast('Sla het product eerst op om kleur-mockups te uploaden', 'info'); e.target.value = ''; return; }
    const prodId = draft.products?.[productIdx]?.id;
    if (!prodId) { NEB.toast('Sla het product eerst op', 'error'); e.target.value = ''; return; }
    const form = new FormData();
    form.append('mockup', file, file.name);
    const uploadBtn = modal.querySelector(`[data-modal-color-mockup="${CSS.escape(hex)}"]`);
    try {
      if (uploadBtn) { uploadBtn.disabled = true; uploadBtn.textContent = '...'; }
      const out = await NEB.json(`/api/admin/products/${encodeURIComponent(prodId)}/colors/${encodeURIComponent(hex)}/mockup`, { method: 'POST', body: form });
      const newPath = out.mockupPath || out.path || '';
      if (newPath) {
        colorDataDraft[hex] = { ...(colorDataDraft[hex] || {}), mockupPath: newPath };
        if (draft.products?.[productIdx]) {
          const next = { ...(draft.products[productIdx].colorData || {}) };
          next[hex] = { ...(next[hex] || {}), mockupPath: newPath };
          draft.products[productIdx].colorData = next;
        }
        const row = modal.querySelector(`[data-modal-color="${CSS.escape(hex)}"]`);
        const enabledCheck = row?.querySelector('.pm-color-enabled');
        if (enabledCheck && !enabledCheck.checked) enabledCheck.checked = true;
        const wrap = row?.querySelector('.pm-color-mockup-wrap');
        if (wrap) {
          wrap.querySelector('div')?.remove();
          wrap.querySelector('img')?.remove();
          const img = document.createElement('img');
          img.src = `/${newPath}`;
          img.style.cssText = 'width:32px;height:32px;object-fit:cover;border-radius:4px;border:1px solid var(--border)';
          wrap.insertBefore(img, wrap.firstChild);
        }
      }
      NEB.toast('Kleur mockup geüpload', 'success');
    } catch (err) { NEB.toast(err.message || 'Upload mislukt', 'error'); }
    finally { if (uploadBtn) { uploadBtn.disabled = false; uploadBtn.textContent = '📷'; } e.target.value = ''; }
  });

  modal.addEventListener('input', (e) => {
    const widthInput = e.target.closest('[data-modal-size-width]');
    const heightInput = e.target.closest('[data-modal-size-height]');
    const code = widthInput?.dataset.modalSizeWidth || heightInput?.dataset.modalSizeHeight;
    if (!code) return;
    const w = parseInt(modal.querySelector(`[data-modal-size-width="${CSS.escape(code)}"]`)?.value || '0', 10) || 0;
    const h = parseInt(modal.querySelector(`[data-modal-size-height="${CSS.escape(code)}"]`)?.value || '0', 10) || 0;
    const label = modal.querySelector(`[data-modal-size-cm="${CSS.escape(code)}"]`);
    if (!label) return;
    if (w > 0 && h > 0) label.textContent = `${(w / 10).toFixed(1)} × ${(h / 10).toFixed(1)} cm`;
    else label.textContent = 'maat niet ingesteld';
  });

  modal.querySelector('#prodModalSave').addEventListener('click', async () => {
    const name = (modal.querySelector('#pmName')?.value || '').trim();
    if (!name) { NEB.toast('Naam is verplicht', 'error'); return; }

    const selectedColors = [];
    const colorPrices = {};
    modal.querySelectorAll('[data-modal-color]').forEach(row => {
      const hex = normalizeHex(row.dataset.modalColor);
      if (!hex) return;
      if (row.querySelector('.pm-color-enabled')?.checked) selectedColors.push(hex);
      const pv = parseFloat(row.querySelector('.pm-color-price')?.value || '');
      if (Number.isFinite(pv) && pv > 0) colorPrices[hex] = pv;
      colorDataDraft[hex] = {
        ...(colorDataDraft[hex] || {}),
        priceUpcharge: Number.isFinite(pv) ? Math.max(0, pv) : Number(colorDataDraft[hex]?.priceUpcharge || 0)
      };
    });

    const selectedSizes = [];
    const sizePrices = {};
    const fallbackSizeMm = {
      XS: [460, 660], S: [480, 680], M: [520, 710], L: [560, 740], XL: [600, 770], XXL: [640, 800]
    };
    modal.querySelectorAll('[data-modal-size]').forEach(cb => {
      if (!cb.checked) return;
      const code = cb.dataset.modalSize;
      let widthMm = parseInt(modal.querySelector(`[data-modal-size-width="${CSS.escape(code)}"]`)?.value || '0', 10) || 0;
      let heightMm = parseInt(modal.querySelector(`[data-modal-size-height="${CSS.escape(code)}"]`)?.value || '0', 10) || 0;
      if (widthMm < 10 || heightMm < 10) {
        const fb = fallbackSizeMm[String(code || '').toUpperCase()];
        if (fb) {
          widthMm = fb[0];
          heightMm = fb[1];
        }
      }
      selectedSizes.push({
        code,
        widthMm: Math.max(10, Math.min(20000, widthMm || 0)),
        heightMm: Math.max(10, Math.min(20000, heightMm || 0))
      });
    });
    modal.querySelectorAll('[data-modal-size-price]').forEach(inp => {
      const v = parseFloat(inp.value || '');
      if (Number.isFinite(v)) sizePrices[inp.dataset.modalSizePrice] = v;
    });

    const basePriceRaw = parseFloat(modal.querySelector('#pmBasePrice')?.value || '');
    const extraFeeRaw = parseFloat(modal.querySelector('#pmExtraFee')?.value || '');
    const sortOrderRaw = parseInt(modal.querySelector('#pmSortOrder')?.value || '10', 10);

    const updated = {
      ...(isNew ? {} : draft.products[productIdx]),
      name,
      id: slugifyProductId((modal.querySelector('#pmId')?.value || '').trim() || name),
      description: (modal.querySelector('#pmDesc')?.value || '').trim(),
      enabled: !!modal.querySelector('#pmEnabled')?.checked,
      isDefault: !!modal.querySelector('#pmDefault')?.checked,
      basePrice: Number.isFinite(basePriceRaw) ? basePriceRaw : null,
      extraDesignFee: Number.isFinite(extraFeeRaw) ? extraFeeRaw : null,
      sortOrder: Number.isFinite(sortOrderRaw) ? Math.max(0, Math.min(9999, sortOrderRaw)) : 10,
      mockupPath: (modal.querySelector('#pmMockupPath')?.value || '').trim() || 'assets/tshirt_mockup.png',
      colorHexes: selectedColors,
      colorPrices,
      sizePrices,
      sizes: selectedSizes,
      colorData: colorDataDraft,
      priceMultiplier: isNew ? 1 : (draft.products[productIdx]?.priceMultiplier || 1),
      extraDesignFeeMultiplier: isNew ? 1 : (draft.products[productIdx]?.extraDesignFeeMultiplier || 1),
    };

    if (updated.isDefault) {
      (draft.products || []).forEach((pp, i) => { if (i !== productIdx) pp.isDefault = false; });
    }

    if (isNew) {
      draft.products = normalizeProducts([...(draft.products || []), updated]);
    } else {
      draft.products[productIdx] = updated;
      draft.products = normalizeProducts(draft.products);
    }

    const saveBtn = modal.querySelector('#prodModalSave');
    const oldText = saveBtn?.textContent || (isNew ? 'Product aanmaken' : 'Opslaan');
    try {
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Opslaan...';
      }
      if (typeof persistFn === 'function') {
        await persistFn(isNew ? 'Product aangemaakt' : 'Product opgeslagen');
      } else {
        NEB.toast(isNew ? 'Product aangemaakt (lokaal concept)' : 'Product opgeslagen (lokaal concept)', 'success');
      }
    } catch {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = oldText;
      }
      return;
    }

    closeModal();
    rerenderFn();
  });
}

// ── Settings ─────────────────────────────────────────────────────────────
async function loadStripeStatus() {
  const statusBar = document.getElementById('stripeStatusBar');
  const webhookUrlEl = document.getElementById('stripeWebhookUrl');
  if (!statusBar) return;
  try {
    const data = await NEB.get('/api/admin/config/stripe');
    const connected = !!data.secretKeySet;
    const fromEnv = !!data.fromEnv;
    const baseUrl = data.appBaseUrl || window.location.origin;
    if (webhookUrlEl) webhookUrlEl.textContent = `${baseUrl}/api/stripe/webhook`;
    statusBar.innerHTML = `
      <span class="stripe-badge ${connected ? 'connected' : 'disconnected'}">
        ${connected ? '✓ Verbonden' : '✕ Niet geconfigureerd'}
      </span>
      ${fromEnv ? '<span class="muted compact" style="margin-left:.6rem">Via omgevingsvariabele (kan niet worden bewerkt)</span>' : ''}
      ${data.appBaseUrl ? `<span class="muted compact" style="margin-left:.6rem">URL: ${escText(data.appBaseUrl)}</span>` : ''}`;
    if (fromEnv) {
      const inputs = document.querySelectorAll('#stripeSecretKey,#stripeWebhookSecret,#stripeBaseUrl');
      inputs.forEach(el => { el.disabled = true; el.placeholder = 'Ingesteld via omgevingsvariabele'; });
      document.getElementById('stripesSaveBtn')?.setAttribute('disabled', '');
    }
  } catch {
    if (statusBar) statusBar.innerHTML = '<span class="stripe-badge disconnected">✕ Status onbekend</span>';
  }
}

async function loadSettings() {
  if (CURRENT_USER.role !== 'OWNER') return;
  const cfg = await NEB.config();
  const wrap = document.getElementById('settingsWrap');
  wrap.innerHTML = renderSettings(cfg);
  bindSettings(cfg);
  applySettingsSubTab(CURRENT_SETTINGS_STAB);
  loadStripeStatus();
}

function renderSettings(c) {
  const email = c.email || {};
  const smtp = c.smtp || {};
  const theme = c.theme || {};
  const conversion = c.conversion || {};
  const company = c.company || {};
  const documents = c.documents || {};
  const invoiceDoc = documents.invoice || {};
  const packingDoc = documents.packingSlip || {};
  const templates = email.templates || {};
  const products = normalizeProducts(c.products);
  const themeHeadingFont = String(theme.headingFont || 'POPPINS').toUpperCase();
  const themeBodyFont = String(theme.bodyFont || 'POPPINS').toUpperCase();
  const themeButtonStyle = String(theme.buttonStyle || 'ROUNDED').toUpperCase();
  const themeSectionTone = String(theme.sectionTone || 'MUTED').toUpperCase();
  const themeInvoiceOpenBg = String(theme.invoiceOpenBg || '#1d4ed8');
  const themeInvoiceOpenText = String(theme.invoiceOpenText || '#eff6ff');
  const themeInvoiceDueBg = String(theme.invoiceDueBg || '#f59e0b');
  const themeInvoiceDueText = String(theme.invoiceDueText || '#111827');
  const convVariant = String(conversion.ctaVariant || 'SOFT').toUpperCase() === 'STRONG' ? 'STRONG' : 'SOFT';
  // sizeRows moved to renderProductsTabPanel()

  // colorRows moved to renderProductsTabPanel()

  const reviewRows = (c.reviews || []).map((r, i) => `
    <div class="color-edit-row" style="grid-template-columns:48px 1fr 2fr auto" data-review-row="${i}">
      <div class="swatch" style="background:var(--bg-2);display:flex;align-items:center;justify-content:center;font-weight:700;color:var(--text)">${r.initials || '?'}</div>
      <input class="select-inline" data-rf="name" value="${escAttr(r.name || '')}" placeholder="Naam">
      <input class="select-inline" data-rf="text" value="${escAttr(r.text || '')}" placeholder="Review tekst">
      <button class="btn btn-danger btn-sm" data-removereview="${i}">Verwijder</button>
    </div>`).join('');

  // productRows replaced by renderProductsTabPanel(products, c)

  const firstTmplKey = EMAIL_TEMPLATES[0].key;
  const templateTabBar = EMAIL_TEMPLATES.map(({ key, label }, i) =>
    `<button class="tmpl-tab${i === 0 ? ' active' : ''}" data-tmpl-tab="${key}">${label}</button>`
  ).join('');
  const templatePanels = EMAIL_TEMPLATES.map(({ key, label }, i) => {
    const t = templates[key] || {};
    const preview = renderTemplatePreviewFrame(t, c);
    const PLACEHOLDERS = ['{{orderId}}','{{customerName}}','{{orderTotal}}','{{paymentUrl}}','{{paymentExpiresAt}}','{{invoiceNumber}}','{{invoiceDueDate}}','{{invoiceStatusLabel}}','{{dashboardUrl}}','{{loginUrl}}','{{verificationUrl}}','{{companyName}}','{{orderStatusLabel}}','{{brandName}}'];
    return `
      <div class="tmpl-panel${i === 0 ? ' active' : ''}" data-tmpl-panel="${key}">
        <div class="tmpl-version-bar">
          <span class="tmpl-version-pill" id="tmplStatus_${key}">Opgeslagen</span>
          <div class="tmpl-version-actions">
            <button class="btn btn-ghost btn-sm" data-toggle-diff="${key}">Toon diff</button>
            <button class="btn btn-ghost btn-sm" data-restore-template="${key}" disabled>Herstel</button>
            <button class="btn btn-ghost btn-sm" data-test-template="${key}">Testmail sturen</button>
          </div>
        </div>
        <div class="form-stack">
          <div class="field">
            <label>Onderwerpregel</label>
            <input id="tmplSubject_${key}" value="${escAttr(t.subject || '')}" placeholder="Onderwerp van de e-mail">
          </div>
          <div class="field">
            <label>HTML template <span class="muted compact">(placeholders hieronder klikken om in te voegen)</span></label>
            <div style="display:flex;flex-wrap:wrap;gap:.3rem;margin-bottom:.5rem">
              ${PLACEHOLDERS.map(p => `<button type="button" class="pill pill-neutral" style="cursor:pointer;font-size:.68rem;font-family:monospace" data-insert-placeholder="${escAttr(p)}" data-tmpl-key="${key}">${escText(p)}</button>`).join('')}
            </div>
            <textarea id="tmplHtml_${key}" rows="10" style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.78rem">${escText(t.html || '')}</textarea>
          </div>
          <div class="mail-preview-grid" id="tmplPreview_${key}">
            <div class="mail-preview-col">
              <div class="mail-preview-label">Desktop preview</div>
              <div class="mail-preview-canvas desktop">${preview}</div>
            </div>
            <div class="mail-preview-col">
              <div class="mail-preview-label">Mobiel preview</div>
              <div class="mail-preview-canvas mobile">${preview}</div>
            </div>
          </div>
          <div class="tmpl-diff-wrap" id="tmplDiff_${key}" hidden></div>
        </div>
      </div>
    `;
  }).join('');
  const templateRows = `
    <div class="tmpl-tab-bar">${templateTabBar}</div>
    ${templatePanels}`;
  const themePresetKey = String(theme.themePreset || 'CUSTOM').toUpperCase();
  const presetCards = Object.entries(THEME_PRESET_META).map(([key, meta]) => {
    const values = THEME_PRESETS[key] || {};
    const active = themePresetKey === key;
    return `
      <button type="button" class="theme-preset-card${active ? ' active' : ''}" data-theme-preset-card="${key}">
        <div class="theme-preset-swatches">
          <span style="background:${escAttr(values.accentColor || '#ffffff')}"></span>
          <span style="background:${escAttr(values.accentColor2 || '#bdbdbd')}"></span>
        </div>
        <div class="theme-preset-copy">
          <strong>${escText(meta.label)}</strong>
          <span>${escText(meta.note)}</span>
        </div>
        <div class="theme-preset-mini">
          <span class="theme-preset-chip">${escText(values.headingFont || 'POPPINS')}</span>
          <span class="theme-preset-demo-btn">${key === 'NEUTRAL' ? 'Editorial' : key === 'BLUE' ? 'Studio' : 'Atelier'}</span>
        </div>
      </button>
    `;
  }).join('');

  return `
    <div class="stab-panel active" data-stab="algemeen">
    <div class="settings-section">
      <h3>Merk & hero</h3>
      <div class="form-stack">
        <div class="form-grid-2">
          <div class="field"><label>Merk naam</label><input id="brandName" value="${escAttr(c.brand?.name || '')}"></div>
          <div class="field"><label>Tagline</label><input id="brandTag" value="${escAttr(c.brand?.tagline || '')}"></div>
        </div>
        <div class="field"><label>Hero badge</label><input id="heroBadge" value="${escAttr(c.hero?.badge || '')}"></div>
        <div class="form-grid-2">
          <div class="field"><label>Titel regel 1</label><input id="heroT1" value="${escAttr(c.hero?.title1 || '')}"></div>
          <div class="field"><label>Titel regel 2 (gekleurd)</label><input id="heroT2" value="${escAttr(c.hero?.title2 || '')}"></div>
        </div>
        <div class="field"><label>Subtitel</label><textarea id="heroSub" rows="2">${escText(c.hero?.subtitle || '')}</textarea></div>
        <div class="field"><label>CTA tekst</label><input id="heroCta" value="${escAttr(c.hero?.cta || '')}"></div>
      </div>
    </div>

    <div class="settings-section">
      <h3>Verzending &amp; levering</h3>
      <p class="muted compact" style="margin:-.5rem 0 1rem">Basisprijs en design-opslag zijn per product instelbaar via de tab <strong>Producten &amp; Stijl → Maten &amp; Prijzen</strong>.</p>
      <div class="form-grid-2">
        <div class="field"><label>Verzendkost (€)</label><input type="number" step="0.01" min="0" id="shippingCost" value="${c.pricing?.shippingCost ?? 0}"></div>
        <div class="field"><label>Gratis verzending vanaf (€)</label><input type="number" step="0.01" min="0" id="shippingFreeThreshold" value="${c.pricing?.shippingFreeThreshold ?? 0}"></div>
        <div class="field"><label>Levertijd tekst</label><input id="deliveryText" value="${escAttr(c.pricing?.deliveryText || '')}"></div>
        <div class="field"><label style="display:flex;align-items:center;gap:.5rem;text-transform:none;letter-spacing:0;font-size:.92rem;color:var(--text);margin-top:1.6rem">
          <input type="checkbox" id="shippingFree" ${c.pricing?.shippingFree ? 'checked' : ''}> Gratis verzending inschakelen
        </label></div>
      </div>
    </div>

    <div class="settings-section">
      <h3>SEO &amp; social</h3>
      <p class="muted compact" style="margin:-.5rem 0 1rem">Wordt gebruikt voor homepage meta tags, Open Graph en JSON-LD.</p>
      <div class="form-stack">
        <div class="field"><label>Meta description</label><textarea id="seoMetaDescription" rows="2">${escText(c.seo?.metaDescription || '')}</textarea></div>
        <div class="field"><label>OG titel</label><input id="seoOgTitle" value="${escAttr(c.seo?.ogTitle || '')}"></div>
        <div class="field"><label>OG beschrijving</label><textarea id="seoOgDescription" rows="2">${escText(c.seo?.ogDescription || '')}</textarea></div>
        <div class="field"><label>OG image pad</label><input id="seoOgImagePath" value="${escAttr(c.seo?.ogImagePath || '')}" placeholder="assets/og-image.png"></div>
      </div>
    </div>

    <div class="settings-section">
      <h3>Bedrijfsgegevens</h3>
      <p class="muted compact" style="margin:-.5rem 0 1rem">Gebruik deze gegevens in factuur-PDF en orderbon-PDF.</p>
      <div class="form-grid-2">
        <div class="field"><label>Bedrijfsnaam (juridisch)</label><input id="companyLegalName" value="${escAttr(company.legalName || '')}"></div>
        <div class="field"><label>Factuur prefix</label><input id="companyInvoicePrefix" value="${escAttr(company.invoicePrefix || 'INV')}" placeholder="INV"></div>
        <div class="field"><label>BTW nummer</label><input id="companyVatNumber" value="${escAttr(company.vatNumber || '')}" placeholder="BE0123.456.789"></div>
        <div class="field"><label>Land</label><input id="companyCountry" value="${escAttr(company.country || 'BE')}"></div>
        <div class="field"><label>Adres</label><input id="companyAddress" value="${escAttr(company.address || '')}"></div>
        <div class="field"><label>Postcode</label><input id="companyPostcode" value="${escAttr(company.postcode || '')}"></div>
        <div class="field"><label>Stad</label><input id="companyCity" value="${escAttr(company.city || '')}"></div>
        <div class="field"><label>Support telefoon</label><input id="companySupportPhone" value="${escAttr(company.supportPhone || '')}"></div>
        <div class="field" style="grid-column:1 / span 2"><label>Support e-mail</label><input id="companySupportEmail" value="${escAttr(company.supportEmail || '')}" placeholder="support@jouwdomein.be"></div>
      </div>
    </div>
    </div><!-- /stab algemeen -->

    <div class="stab-panel" data-stab="thema">
    <div class="settings-section">
      <h3>Branding &amp; thema</h3>
      <p class="muted compact" style="margin:-.5rem 0 1rem">Kleuren, typografie en buttons worden op alle pagina's toegepast.</p>
      <div class="theme-preset-grid">
        ${presetCards}
      </div>
      <div class="form-grid-2">
        <div class="field"><label>Logo symbool</label><input id="themeLogoMark" value="${escAttr(theme.logoMark || '✦')}" maxlength="2" placeholder="✦"></div>
        <div class="field"><label>Thema preset</label>
          <div style="display:flex;gap:.5rem">
            <select id="themePreset" style="flex:1">
              <option value="CUSTOM" ${String(theme.themePreset || 'CUSTOM').toUpperCase() === 'CUSTOM' ? 'selected' : ''}>Custom</option>
              <option value="GREEN" ${String(theme.themePreset || '').toUpperCase() === 'GREEN' ? 'selected' : ''}>Green</option>
              <option value="BLUE" ${String(theme.themePreset || '').toUpperCase() === 'BLUE' ? 'selected' : ''}>Blue</option>
              <option value="NEUTRAL" ${String(theme.themePreset || '').toUpperCase() === 'NEUTRAL' ? 'selected' : ''}>Neutral</option>
            </select>
            <button class="btn btn-ghost btn-sm" id="applyThemePresetBtn" type="button">Toepassen</button>
          </div>
        </div>
        <div class="field"><label>Button stijl</label>
          <select id="themeButtonStyle">
            <option value="ROUNDED" ${themeButtonStyle === 'ROUNDED' ? 'selected' : ''}>Rounded</option>
            <option value="PILL" ${themeButtonStyle === 'PILL' ? 'selected' : ''}>Pill</option>
            <option value="SHARP" ${themeButtonStyle === 'SHARP' ? 'selected' : ''}>Sharp</option>
          </select>
        </div>
        <div class="field"><label>Accentkleur</label><input type="color" id="themeAccentColor" value="${escAttr(theme.accentColor || '#ffffff')}"></div>
        <div class="field"><label>Accent gradient kleur 2</label><input type="color" id="themeAccentColor2" value="${escAttr(theme.accentColor2 || '#bdbdbd')}"></div>
        <div class="field"><label>Heading font</label>
          <select id="themeHeadingFont">
            <option value="POPPINS" ${themeHeadingFont === 'POPPINS' ? 'selected' : ''}>Poppins (aanbevolen)</option>
            <option value="SPACE_GROTESK" ${themeHeadingFont === 'SPACE_GROTESK' ? 'selected' : ''}>Space Grotesk</option>
            <option value="INTER" ${themeHeadingFont === 'INTER' ? 'selected' : ''}>Inter</option>
            <option value="SYSTEM" ${themeHeadingFont === 'SYSTEM' ? 'selected' : ''}>System</option>
            <option value="SERIF" ${themeHeadingFont === 'SERIF' ? 'selected' : ''}>Serif</option>
          </select>
        </div>
        <div class="field"><label>Body font</label>
          <select id="themeBodyFont">
            <option value="POPPINS" ${themeBodyFont === 'POPPINS' ? 'selected' : ''}>Poppins (aanbevolen)</option>
            <option value="INTER" ${themeBodyFont === 'INTER' ? 'selected' : ''}>Inter</option>
            <option value="SPACE_GROTESK" ${themeBodyFont === 'SPACE_GROTESK' ? 'selected' : ''}>Space Grotesk</option>
            <option value="SYSTEM" ${themeBodyFont === 'SYSTEM' ? 'selected' : ''}>System</option>
            <option value="SERIF" ${themeBodyFont === 'SERIF' ? 'selected' : ''}>Serif</option>
          </select>
        </div>
        <div class="field"><label>Section achtergrond</label>
          <select id="themeSectionTone">
            <option value="MUTED" ${themeSectionTone === 'MUTED' ? 'selected' : ''}>Subtiel</option>
            <option value="FLAT" ${themeSectionTone === 'FLAT' ? 'selected' : ''}>Vlak</option>
            <option value="BOLD" ${themeSectionTone === 'BOLD' ? 'selected' : ''}>Sterker contrast</option>
          </select>
        </div>
      </div>
      <div class="form-grid-2" style="margin-top:.85rem">
        <div class="field">
          <label>Logo asset pad</label>
          <input id="themeLogoPath" value="${escAttr(theme.logoPath || '')}" placeholder="assets/branding/logo.png">
        </div>
        <div class="field">
          <label>Favicon asset pad</label>
          <input id="themeFaviconPath" value="${escAttr(theme.faviconPath || '')}" placeholder="assets/branding/favicon.png">
        </div>
      </div>
      <div class="form-grid-2" style="margin-top:.85rem">
        <div class="field">
          <label>Factuur open badge (achtergrond)</label>
          <input type="color" id="themeInvoiceOpenBg" value="${escAttr(themeInvoiceOpenBg)}">
        </div>
        <div class="field">
          <label>Factuur open badge (tekst)</label>
          <input type="color" id="themeInvoiceOpenText" value="${escAttr(themeInvoiceOpenText)}">
        </div>
        <div class="field">
          <label>Vervalt badge (achtergrond)</label>
          <input type="color" id="themeInvoiceDueBg" value="${escAttr(themeInvoiceDueBg)}">
        </div>
        <div class="field">
          <label>Vervalt badge (tekst)</label>
          <input type="color" id="themeInvoiceDueText" value="${escAttr(themeInvoiceDueText)}">
        </div>
      </div>
      <div style="display:flex;gap:.55rem;flex-wrap:wrap;margin-top:.7rem">
        <button class="btn btn-ghost btn-sm" id="uploadLogoBtn" type="button">Upload logo</button>
        <button class="btn btn-ghost btn-sm" id="uploadFaviconBtn" type="button">Upload favicon</button>
        <input type="file" id="uploadLogoFile" accept="image/*,.svg,.png,.jpg,.jpeg,.webp" hidden>
        <input type="file" id="uploadFaviconFile" accept="image/*,.svg,.png,.ico" hidden>
      </div>
      <div class="brand-asset-previews">
        <div class="brand-asset-preview-card">
          <span class="muted compact">Logo preview</span>
          ${theme.logoPath ? `<img src="/${String(theme.logoPath).replace(/^\/+/, '')}" alt="Logo preview" onerror="this.onerror=null;this.replaceWith(Object.assign(document.createElement('div'),{className:'brand-asset-placeholder',textContent:'Geen logo geüpload'}));">` : '<div class="brand-asset-placeholder">Geen logo geüpload</div>'}
        </div>
        <div class="brand-asset-preview-card">
          <span class="muted compact">Favicon preview</span>
          ${theme.faviconPath ? `<img src="/${String(theme.faviconPath).replace(/^\/+/, '')}" alt="Favicon preview" class="favicon-preview" onerror="this.onerror=null;this.replaceWith(Object.assign(document.createElement('div'),{className:'brand-asset-placeholder',textContent:'Geen favicon geüpload'}));">` : '<div class="brand-asset-placeholder">Geen favicon geüpload</div>'}
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h3>Hero video (optioneel)</h3>
      <p class="muted compact" style="margin:-.5rem 0 1rem">YouTube-link invullen om de hero-sectie van de homepage een geluidsloze achtergrondvideo te geven. Wordt automatisch privacy-enhanced (youtube-nocookie.com). Laat leeg voor de standaard gradient-achtergrond.</p>
      <div class="field">
        <label>YouTube URL</label>
        <input id="heroVideoUrl" value="${escAttr(c.hero?.videoUrl || '')}" placeholder="https://www.youtube.com/watch?v=...">
        <span class="hint">Alleen de video-ID wordt opgeslagen — bijv. <code>dQw4w9WgXcQ</code>.</span>
      </div>
      <div class="form-grid-2" style="margin-top:.65rem">
        <div class="field">
          <label>Overlay kleur</label>
          <input type="color" id="heroVideoOverlayColor" value="${escAttr(c.hero?.videoOverlayColor || '#000000')}">
        </div>
        <div class="field">
          <label>Overlay opacity (0 - 0.9)</label>
          <input type="number" id="heroVideoOverlayOpacity" min="0" max="0.9" step="0.05" value="${escAttr(c.hero?.videoOverlayOpacity ?? 0.55)}">
        </div>
        <div class="field">
          <label>Video blur (px)</label>
          <input type="number" id="heroVideoBlurPx" min="0" max="8" step="1" value="${escAttr(c.hero?.videoBlurPx ?? 0)}">
        </div>
      </div>
    </div>
    </div><!-- /stab thema -->

    <div class="stab-panel" data-stab="documenten">
    <div class="settings-section">
      <h3>Factuur template</h3>
      <div class="form-grid-2">
        <div class="field"><label>Titel</label><input id="docInvoiceTitle" value="${escAttr(invoiceDoc.title || 'Factuur')}"></div>
        <div class="field"><label>Betaaltermijn (dagen)</label><input type="number" min="0" max="90" id="docInvoiceTermsDays" value="${escAttr(invoiceDoc.paymentTermsDays ?? 0)}"></div>
        <div class="field"><label>Factuurnummer jaarmodus</label>
          <select id="docInvoiceYearMode">
            <option value="ORDER_YEAR" ${String(invoiceDoc.numberYearMode || 'ORDER_YEAR').toUpperCase() === 'ORDER_YEAR' ? 'selected' : ''}>Jaar van orderdatum</option>
            <option value="ISSUE_YEAR" ${String(invoiceDoc.numberYearMode || 'ORDER_YEAR').toUpperCase() === 'ISSUE_YEAR' ? 'selected' : ''}>Jaar van factuurdatum</option>
          </select>
        </div>
        <div class="field"><label>Nummer padding</label><input type="number" min="4" max="10" id="docInvoicePadLength" value="${escAttr(invoiceDoc.numberPadLength ?? 6)}"></div>
      </div>
      <div class="form-stack" style="margin-top:.75rem">
        <div class="field"><label>Intro tekst</label><textarea id="docInvoiceIntro" rows="2">${escText(invoiceDoc.intro || '')}</textarea></div>
        <div class="field"><label>Footer tekst</label><textarea id="docInvoiceFooter" rows="2">${escText(invoiceDoc.footer || '')}</textarea></div>
        <div class="field"><label>Juridische disclaimer</label><textarea id="docInvoiceLegalDisclaimer" rows="3">${escText(invoiceDoc.legalDisclaimer || '')}</textarea></div>
        <div class="form-grid-2">
          <label style="display:flex;align-items:center;gap:.5rem;text-transform:none;letter-spacing:0;font-size:.92rem;color:var(--text)">
            <input type="checkbox" id="docInvoiceReminderEnabled" ${invoiceDoc.reminderEnabled !== false ? 'checked' : ''}> Herinneringsmails actief
          </label>
          <div class="field"><label>Interval (uren)</label><input type="number" min="1" max="240" id="docInvoiceReminderInterval" value="${escAttr(invoiceDoc.reminderIntervalHours ?? 24)}"></div>
          <div class="field"><label>Max reminders</label><input type="number" min="1" max="20" id="docInvoiceReminderMax" value="${escAttr(invoiceDoc.reminderMaxCount ?? 5)}"></div>
        </div>
        <label style="display:flex;align-items:center;gap:.5rem;text-transform:none;letter-spacing:0;font-size:.92rem;color:var(--text)">
          <input type="checkbox" id="docInvoiceShowSupport" ${invoiceDoc.showSupportContacts !== false ? 'checked' : ''}> Supportcontact tonen op factuur
        </label>
      </div>
    </div>
    <div class="settings-section">
      <h3>Orderbon template</h3>
      <div class="form-stack">
        <div class="field"><label>Titel</label><input id="docPackingTitle" value="${escAttr(packingDoc.title || 'Orderbon')}"></div>
        <div class="field"><label>Intro tekst</label><textarea id="docPackingIntro" rows="2">${escText(packingDoc.intro || '')}</textarea></div>
        <div class="field"><label>Footer tekst</label><textarea id="docPackingFooter" rows="2">${escText(packingDoc.footer || '')}</textarea></div>
        <label style="display:flex;align-items:center;gap:.5rem;text-transform:none;letter-spacing:0;font-size:.92rem;color:var(--text)">
          <input type="checkbox" id="docPackingShowPaths" ${packingDoc.showFilePaths !== false ? 'checked' : ''}> Bestandspaden tonen op orderbon
        </label>
      </div>
    </div>
    </div><!-- /stab documenten -->

    ${renderProductsTabPanel(products, c)}

    <div class="stab-panel" data-stab="email">
    <div class="settings-section">
      <h3>SMTP server</h3>
      <p class="muted compact" style="margin:-.5rem 0 1rem">SMTP-instellingen worden gebruikt voor alle uitgaande e-mails. Omgevingsvariabelen (SMTP_HOST etc.) hebben voorrang.</p>
      ${smtp.host ? '' : '<div class="theme-warning">SMTP is momenteel niet geconfigureerd. Testmails en ordermeldingen worden nu overgeslagen.</div>'}
      <div class="form-grid-2">
        <div class="field"><label>SMTP host</label><input id="smtpHost" value="${escAttr(smtp.host || '')}" placeholder="smtp.gmail.com"></div>
        <div class="field"><label>SMTP poort</label><input type="number" id="smtpPort" value="${escAttr(smtp.port || 587)}" placeholder="587"></div>
        <div class="field"><label>Gebruikersnaam</label><input id="smtpUser" value="${escAttr(smtp.user || '')}" placeholder="jouw@email.be" autocomplete="off"></div>
        <div class="field"><label>Wachtwoord / app-wachtwoord</label><input type="password" id="smtpPass" value="${escAttr(smtp.pass || '')}" autocomplete="new-password" placeholder="••••••••"></div>
        <div class="field"><label style="display:flex;align-items:center;gap:.5rem;text-transform:none;letter-spacing:0;font-size:.92rem;color:var(--text);margin-top:1.4rem">
          <input type="checkbox" id="smtpSecure" ${smtp.secure ? 'checked' : ''}> SSL/TLS (poort 465)
        </label></div>
      </div>
      <div class="form-grid-2" style="margin-top:.75rem">
        <div class="field"><label>Afzender naam</label><input id="smtpFromName" value="${escAttr(smtp.fromName || email.fromName || '')}" placeholder="Mijn Winkel"></div>
        <div class="field"><label>Afzender e-mailadres</label><input id="smtpFromAddress" value="${escAttr(smtp.fromAddress || email.fromAddress || '')}" placeholder="noreply@jouwdomein.be"></div>
      </div>
      <div style="display:flex;gap:.5rem;margin-top:.75rem;align-items:center">
        <button class="btn btn-ghost btn-sm" id="smtpTestBtn" type="button">Verstuur test-e-mail</button>
        <input id="smtpTestTo" value="${escAttr(CURRENT_USER?.email || '')}" placeholder="naam@domein.be" style="flex:1;max-width:280px">
        <span class="muted compact" id="smtpTestResult"></span>
      </div>
    </div>
    <div class="settings-section">
      <h3>E-mail afzender &amp; reply-to</h3>
      <div class="form-grid-2">
        <div class="field"><label>Afzender naam (template)</label><input id="emailFromName" value="${escAttr(email.fromName || '')}"></div>
        <div class="field"><label>Afzender e-mail (template)</label><input id="emailFromAddress" value="${escAttr(email.fromAddress || '')}"></div>
        <div class="field"><label>Reply-to e-mail</label><input id="emailReplyTo" value="${escAttr(email.replyTo || '')}"></div>
        <div class="field"><label>Testmail naar</label><input id="emailTestTo" value="${escAttr(CURRENT_USER?.email || '')}" placeholder="naam@domein.be"></div>
      </div>
    </div>
    </div><!-- /stab email -->

    <div class="stab-panel" data-stab="email-templates">
    <div class="settings-section">
      <h3>E-mail templates</h3>
      <p class="muted compact" style="margin:-.5rem 0 1rem">Placeholders: {{orderId}}, {{customerName}}, {{orderTotal}}, {{paymentUrl}}, {{paymentExpiresAt}}, {{invoiceNumber}}, {{invoiceDueDate}}, {{invoiceStatusLabel}}, {{dashboardUrl}}, {{loginUrl}}, {{companyName}}, {{orderStatusLabel}}, {{brandName}}, {{brandLogoUrl}}, {{brandFaviconUrl}}, {{brandAccentColor}}.</p>
      ${templateRows}
    </div>
    </div><!-- /stab email-templates -->

    <div class="stab-panel" data-stab="conversie">
    <div class="settings-section">
      <h3>Conversie &amp; checkout copy</h3>
      <p class="muted compact" style="margin:-.5rem 0 1rem">A/B-ready CTA-teksten, urgency en social-proof voor designer + winkelmand.</p>
      <div class="form-grid-2">
        <div class="field">
          <label>CTA variant (standaard)</label>
          <select id="convCtaVariant">
            <option value="SOFT" ${convVariant === 'SOFT' ? 'selected' : ''}>Soft (laagdrempelig)</option>
            <option value="STRONG" ${convVariant === 'STRONG' ? 'selected' : ''}>Strong (urgency)</option>
          </select>
        </div>
        <div class="field">
          <label>Designer stap 2 CTA</label>
          <input id="convDesignerStep2Cta" value="${escAttr(conversion.designerStep2Cta || 'Naar overzicht')}">
        </div>
        <div class="field">
          <label>Designer stap 3 CTA (soft)</label>
          <input id="convDesignerStep3Soft" value="${escAttr(conversion.designerStep3CtaSoft || 'Toevoegen naar winkelmand')}">
        </div>
        <div class="field">
          <label>Designer stap 3 CTA (strong)</label>
          <input id="convDesignerStep3Strong" value="${escAttr(conversion.designerStep3CtaStrong || 'Toevoegen naar winkelmand')}">
        </div>
        <div class="field">
          <label>Winkelmand CTA (soft)</label>
          <input id="convCartSoft" value="${escAttr(conversion.cartCtaSoft || 'Bestelling plaatsen (nog niet betalen)')}">
        </div>
        <div class="field">
          <label>Winkelmand CTA (strong)</label>
          <input id="convCartStrong" value="${escAttr(conversion.cartCtaStrong || 'Bestelling plaatsen')}">
        </div>
      </div>
      <div class="form-grid-2" style="margin-top:.8rem">
        <div class="field"><label style="display:flex;align-items:center;gap:.5rem;text-transform:none;letter-spacing:0">
          <input type="checkbox" id="convUrgencyEnabled" ${conversion.urgencyEnabled ? 'checked' : ''}> Urgency melding tonen
        </label></div>
        <div class="field"><label style="display:flex;align-items:center;gap:.5rem;text-transform:none;letter-spacing:0">
          <input type="checkbox" id="convSocialEnabled" ${conversion.socialProofEnabled !== false ? 'checked' : ''}> Social proof tonen
        </label></div>
        <div class="field">
          <label>Urgency tekst</label>
          <input id="convUrgencyText" value="${escAttr(conversion.urgencyText || 'Beperkte productiecapaciteit deze week.')}">
        </div>
        <div class="field">
          <label>Social proof tekst</label>
          <input id="convSocialText" value="${escAttr(conversion.socialProofText || 'Gemiddelde goedkeuring op werkdagen: binnen 2 uur.')}">
        </div>
      </div>
      <div class="field" style="margin-top:.75rem">
        <label>Checkout noot (onder CTA)</label>
        <textarea id="convCheckoutNote" rows="2">${escText(conversion.checkoutNote || 'Na goedkeuring ontvang je je beveiligde betaallink per e-mail.')}</textarea>
      </div>
    </div>
    <div class="settings-section">
      <h3>Reviews</h3>
      <div id="reviewRows">${reviewRows}</div>
      <div class="row-add" style="grid-template-columns:80px 1fr 2fr auto">
        <input id="newReviewInit" placeholder="Init.">
        <input id="newReviewName" placeholder="Naam">
        <input id="newReviewText" placeholder="Review tekst">
        <button class="btn btn-ghost btn-sm" id="addReview">+ Review</button>
      </div>
    </div>
    </div><!-- /stab conversie -->

    <div class="stab-panel" data-stab="betalingen">
    <div class="settings-section">
      <h3>Stripe betalingen</h3>
      <p class="muted compact" style="margin:-.5rem 0 1rem">Configureer Stripe voor beveiligde online betalingen. Sleutels worden versleuteld opgeslagen. Omgevingsvariabelen (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET) hebben altijd voorrang.</p>
      <div id="stripeStatusBar" style="margin-bottom:1rem"></div>
      <div class="form-stack">
        <div class="field">
          <label>Secret Key</label>
          <div style="display:flex;gap:.5rem">
            <input type="password" id="stripeSecretKey" placeholder="sk_live_… of sk_test_…" autocomplete="off" style="flex:1;font-family:monospace">
            <button type="button" class="btn btn-ghost btn-sm" id="stripeSecretToggle" style="flex-shrink:0">Toon</button>
          </div>
          <span class="hint">Gebruik sk_test_ voor tests, sk_live_ voor productie.</span>
        </div>
        <div class="field">
          <label>Webhook Secret</label>
          <div style="display:flex;gap:.5rem">
            <input type="password" id="stripeWebhookSecret" placeholder="whsec_…" autocomplete="off" style="flex:1;font-family:monospace">
            <button type="button" class="btn btn-ghost btn-sm" id="stripeWebhookToggle" style="flex-shrink:0">Toon</button>
          </div>
          <span class="hint">Webhook URL voor je Stripe-dashboard: <code id="stripeWebhookUrl" style="font-size:.78rem"></code></span>
        </div>
        <div class="field">
          <label>App basis-URL <span class="muted compact">(voor betaallinks)</span></label>
          <input id="stripeBaseUrl" placeholder="https://jouwdomein.be" autocomplete="off">
        </div>
        <div style="display:flex;gap:.65rem;flex-wrap:wrap;align-items:center;margin-top:.25rem">
          <button class="btn btn-primary btn-sm" id="stripesSaveBtn" type="button">Opslaan</button>
          <button class="btn btn-ghost btn-sm" id="stripesTestBtn" type="button">Verbinding testen</button>
          <span class="muted compact" id="stripeTestResult"></span>
        </div>
      </div>
    </div>
    <div class="settings-section">
      <h3>Webhook instellen in Stripe</h3>
      <p class="muted compact" style="margin:-.5rem 0 .75rem">Voeg in je <a href="https://dashboard.stripe.com/webhooks" target="_blank" rel="noopener">Stripe-dashboard → Webhooks</a> een nieuw eindpunt toe met de bovenstaande URL. Selecteer minimaal deze events:</p>
      <ul class="muted compact" style="margin:0 0 0 1.2rem;line-height:2">
        <li><code>checkout.session.completed</code></li>
        <li><code>checkout.session.expired</code></li>
        <li><code>payment_intent.payment_failed</code></li>
      </ul>
    </div>
    </div><!-- /stab betalingen -->

    <div style="display:flex;gap:.6rem;justify-content:flex-end;margin-top:1.5rem;padding-top:1rem;border-top:1px solid var(--border)">
      <button class="btn btn-ghost" id="resetCfg">Annuleer</button>
      <button class="btn btn-primary" id="saveCfg">Opslaan</button>
    </div>`;
}

function bindSettings(cfg) {
  const draft = JSON.parse(JSON.stringify(cfg));
  draft.products = normalizeProducts(draft.products);
  let savedSnapshot = JSON.parse(JSON.stringify(cfg));
  savedSnapshot.products = normalizeProducts(savedSnapshot.products);
  const diffOpen = {};
  EMAIL_TEMPLATES.forEach(({ key }) => { diffOpen[key] = false; });
  const wrap = document.getElementById('settingsWrap');
  if (wrap._settingsClickHandler) wrap.removeEventListener('click', wrap._settingsClickHandler);
  if (wrap._settingsInputHandler) wrap.removeEventListener('input', wrap._settingsInputHandler);
  if (wrap._settingsChangeHandler) wrap.removeEventListener('change', wrap._settingsChangeHandler);

  const persistDraftFromModal = async (successMsg = 'Instellingen opgeslagen') => {
    captureFlatFields();
    await NEB.put('/api/admin/config', draft);
    savedSnapshot = JSON.parse(JSON.stringify(draft));
    savedSnapshot.products = normalizeProducts(savedSnapshot.products);
    updateAllTemplateVersionUI();
    NEB.toast(successMsg, 'success');
  };
  const applyThemePresetToDraft = (preset) => {
    const key = String(preset || '').toUpperCase();
    const values = THEME_PRESETS[key];
    if (!values) return false;
    draft.theme = draft.theme || {};
    Object.assign(draft.theme, values, { themePreset: key });
    return true;
  };

  const clickHandler = async (e) => {
    const t = e.target;
    const removeColor = t.dataset?.removecolor;
    const removeSize = t.dataset?.removesize;
    const removeReview = t.dataset?.removereview;
    const removeProduct = t.dataset?.removeproduct;
    const testTemplate = t.dataset?.testTemplate;
    const restoreTemplate = t.dataset?.restoreTemplate;
    const toggleDiff = t.dataset?.toggleDiff;
    if (removeColor != null) { draft.colors.splice(Number(removeColor), 1); rerender(); return; }
    if (removeSize) {
      draft.sizes = (draft.sizes || []).filter(s => s !== removeSize);
      delete draft.pricing.sizeUpcharge?.[removeSize];
      rerender(); return;
    }
    if (removeReview != null) { draft.reviews.splice(Number(removeReview), 1); rerender(); return; }
    if (removeProduct != null) {
      draft.products = normalizeProducts((draft.products || []).filter((_p, idx) => idx !== Number(removeProduct)));
      rerender();
      return;
    }
    // "+" Nieuw product button → open empty modal
    if (t.closest?.('#addProduct')) {
      openProductModal(-1, draft, draft, rerender, persistDraftFromModal);
      return;
    }
    if (t.id === 'uploadLogoBtn') {
      wrap.querySelector('#uploadLogoFile')?.click();
      return;
    }
    if (t.id === 'uploadFaviconBtn') {
      wrap.querySelector('#uploadFaviconFile')?.click();
      return;
    }
    const presetCard = t.closest?.('[data-theme-preset-card]');
    if (presetCard?.dataset?.themePresetCard) {
      const preset = String(presetCard.dataset.themePresetCard || 'CUSTOM').toUpperCase();
      if (!applyThemePresetToDraft(preset)) {
        NEB.toast('Onbekende preset', 'error');
        return;
      }
      rerender();
      NEB.toast(`Thema preset ${preset} toegepast`, 'success');
      return;
    }
    if (t.id === 'applyThemePresetBtn') {
      const preset = String(wrap.querySelector('#themePreset')?.value || 'CUSTOM').toUpperCase();
      if (preset === 'CUSTOM') {
        draft.theme = draft.theme || {};
        draft.theme.themePreset = 'CUSTOM';
      } else if (!applyThemePresetToDraft(preset)) {
        NEB.toast('Onbekende preset', 'error');
        return;
      }
      rerender();
      NEB.toast(`Thema preset ${preset} toegepast`, 'success');
      return;
    }
    // Product sub-tab switching (inside producten stab panel)
    const prodSubtab = t.closest?.('[data-prod-subtab]');
    if (prodSubtab?.dataset?.prodSubtab) {
      const tab = prodSubtab.dataset.prodSubtab;
      const subTabRoot = prodSubtab.closest('.stab-panel[data-stab="producten"]') || wrap;
      subTabRoot.querySelectorAll('[data-prod-subtab]').forEach((b) => {
        b.classList.toggle('active', b.dataset.prodSubtab === tab);
      });
      subTabRoot.querySelectorAll('[data-prod-subtab-panel]').forEach((p) => {
        p.classList.toggle('active', p.dataset.prodSubtabPanel === tab);
      });
      return;
    }
    // Open product edit modal
    const editProdBtn = t.closest?.('[data-edit-product]');
    if (editProdBtn?.dataset?.editProduct != null) {
      const idx = Number(editProdBtn.dataset.editProduct);
      openProductModal(idx, draft, draft, rerender, persistDraftFromModal);
      return;
    }
    if (t.id === 'smtpTestBtn') {
      captureFlatFields();
      const to = (wrap.querySelector('#smtpTestTo')?.value || '').trim();
      if (!to) { NEB.toast('Vul eerst een test e-mailadres in', 'error'); return; }
      const result = wrap.querySelector('#smtpTestResult');
      const btn = t.closest('button');
      const oldTxt = btn?.textContent;
      try {
        if (btn) { btn.disabled = true; btn.textContent = 'Versturen...'; }
        if (result) result.textContent = 'Config opslaan...';
        await NEB.put('/api/admin/config', draft);
        if (result) result.textContent = 'Testmail versturen...';
        const out = await NEB.post('/api/admin/email/test', { templateKey: 'orderPlaced', to });
        if (out?.info?.skipped === 'smtp_not_configured') {
          if (result) result.textContent = 'SMTP ontbreekt';
          NEB.toast('SMTP is nog niet geconfigureerd', 'error');
        } else {
          if (result) result.textContent = 'Testmail verstuurd';
          NEB.toast('SMTP testmail verstuurd', 'success');
        }
      } catch (err) {
        if (result) result.textContent = 'Mislukt';
        NEB.toast(err.message || 'SMTP test mislukt', 'error');
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = oldTxt || 'Verstuur test-e-mail'; }
      }
      return;
    }

    if (t.closest?.('#addColor')) {
      const name = wrap.querySelector('#newColorName').value.trim();
      const hex = wrap.querySelector('#newColorHex').value.trim();
      if (!name || !/^#[0-9a-fA-F]{6}$/.test(hex)) { NEB.toast('Geldige naam en hex (bv. #ff0000) nodig', 'error'); return; }
      draft.colors.push({ name, hex, enabled: true });
      rerender();
      return;
    }
    if (t.closest?.('#addSize')) {
      const size = wrap.querySelector('#newSize').value.trim().toUpperCase();
      const up = parseFloat(wrap.querySelector('#newSizeUp').value || '0');
      if (!size) return;
      if (!draft.sizes.includes(size)) draft.sizes.push(size);
      draft.pricing.sizeUpcharge = draft.pricing.sizeUpcharge || {};
      draft.pricing.sizeUpcharge[size] = up;
      rerender();
      return;
    }
    if (t.closest?.('#addReview')) {
      const initials = wrap.querySelector('#newReviewInit').value.trim().toUpperCase().slice(0, 3);
      const name = wrap.querySelector('#newReviewName').value.trim();
      const text = wrap.querySelector('#newReviewText').value.trim();
      if (!name || !text) return;
      draft.reviews.push({ initials: initials || name[0].toUpperCase(), name, text });
      rerender();
      return;
    }
    // addProduct is now handled by the modal (see above)
    if (restoreTemplate) {
      const key = String(restoreTemplate);
      const savedTemplate = savedSnapshot.email?.templates?.[key] || { subject: '', html: '' };
      draft.email = draft.email || {};
      draft.email.templates = draft.email.templates || {};
      draft.email.templates[key] = {
        ...draft.email.templates[key],
        subject: savedTemplate.subject || '',
        html: savedTemplate.html || ''
      };
      const subjectEl = wrap.querySelector(`#tmplSubject_${key}`);
      const htmlEl = wrap.querySelector(`#tmplHtml_${key}`);
      if (subjectEl) subjectEl.value = draft.email.templates[key].subject;
      if (htmlEl) htmlEl.value = draft.email.templates[key].html;
      refreshTemplatePreview(key);
      updateTemplateVersionUI(key);
      NEB.toast('Template hersteld naar laatst opgeslagen versie', 'success');
      return;
    }
    if (toggleDiff) {
      const key = String(toggleDiff);
      diffOpen[key] = !diffOpen[key];
      updateTemplateVersionUI(key);
      return;
    }
    // Template tab switching
    const tmplTab = t.dataset?.tmplTab;
    if (tmplTab) {
      wrap.querySelectorAll('.tmpl-tab').forEach(b => b.classList.toggle('active', b.dataset.tmplTab === tmplTab));
      wrap.querySelectorAll('.tmpl-panel').forEach(p => p.classList.toggle('active', p.dataset.tmplPanel === tmplTab));
      return;
    }
    // Placeholder chip insertion
    const insertPh = t.dataset?.insertPlaceholder;
    const tmplKey = t.dataset?.tmplKey;
    if (insertPh && tmplKey) {
      const ta = wrap.querySelector(`#tmplHtml_${tmplKey}`);
      if (!ta) return;
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? ta.value.length;
      ta.value = ta.value.slice(0, start) + insertPh + ta.value.slice(end);
      ta.selectionStart = ta.selectionEnd = start + insertPh.length;
      ta.focus();
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    if (testTemplate) {
      captureFlatFields();
      const to = (wrap.querySelector('#emailTestTo')?.value || '').trim();
      if (!to) { NEB.toast('Vul eerst een test e-mail in', 'error'); return; }
      const btn = t.closest('button');
      const oldTxt = btn?.textContent;
      try {
        if (btn) { btn.disabled = true; btn.textContent = 'Versturen...'; }
        await NEB.put('/api/admin/config', draft);
        const out = await NEB.post('/api/admin/email/test', { templateKey: testTemplate, to });
        if (out?.info?.skipped === 'smtp_not_configured') {
          NEB.toast('SMTP is nog niet geconfigureerd', 'error');
        } else {
          NEB.toast('Testmail verstuurd', 'success');
        }
      } catch (err) {
        NEB.toast(err.message || 'Testmail mislukt', 'error');
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = oldTxt || 'Testmail sturen'; }
      }
      return;
    }
    if (t.id === 'stripeSecretToggle') {
      const inp = wrap.querySelector('#stripeSecretKey');
      if (!inp) return;
      inp.type = inp.type === 'password' ? 'text' : 'password';
      t.textContent = inp.type === 'password' ? 'Toon' : 'Verberg';
      return;
    }
    if (t.id === 'stripeWebhookToggle') {
      const inp = wrap.querySelector('#stripeWebhookSecret');
      if (!inp) return;
      inp.type = inp.type === 'password' ? 'text' : 'password';
      t.textContent = inp.type === 'password' ? 'Toon' : 'Verberg';
      return;
    }
    if (t.id === 'stripesSaveBtn') {
      const sk = wrap.querySelector('#stripeSecretKey')?.value.trim() || '';
      const ws = wrap.querySelector('#stripeWebhookSecret')?.value.trim() || '';
      const bu = wrap.querySelector('#stripeBaseUrl')?.value.trim() || '';
      const btn = t.closest('button');
      const old = btn?.textContent;
      try {
        if (btn) { btn.disabled = true; btn.textContent = 'Opslaan...'; }
        await NEB.put('/api/admin/config/stripe', { secretKey: sk, webhookSecret: ws, appBaseUrl: bu });
        NEB.toast('Stripe-instellingen opgeslagen', 'success');
        await loadStripeStatus();
      } catch (err) {
        NEB.toast(err.message || 'Kon instellingen niet opslaan', 'error');
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = old; }
      }
      return;
    }
    if (t.id === 'stripesTestBtn') {
      const btn = t.closest('button');
      const result = wrap.querySelector('#stripeTestResult');
      const old = btn?.textContent;
      try {
        if (btn) { btn.disabled = true; btn.textContent = 'Testen...'; }
        if (result) result.textContent = '';
        await NEB.get('/api/admin/config/stripe/test');
        if (result) result.textContent = '✓ Verbonden';
        NEB.toast('Stripe verbinding OK', 'success');
      } catch (err) {
        if (result) result.textContent = '✕ Mislukt: ' + (err.message || 'onbekende fout');
        NEB.toast(err.message || 'Stripe test mislukt', 'error');
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = old; }
      }
      return;
    }
    if (t.id === 'saveCfg') save();
    if (t.id === 'resetCfg') loadSettings();
  };

  const inputHandler = async (e) => {
    const colorRow = e.target.closest('[data-color-row]');
    const reviewRow = e.target.closest('[data-review-row]');
    const productRow = e.target.closest('[data-product-row]');
    const id = e.target.id || '';
    if (id === 'uploadLogoFile' || id === 'uploadFaviconFile') {
      const kind = id === 'uploadLogoFile' ? 'logo' : 'favicon';
      const file = e.target.files?.[0];
      if (!file) return;
      captureFlatFields();
      const form = new FormData();
      form.append('kind', kind);
      form.append('asset', file, file.name || `${kind}.png`);
      const triggerBtn = wrap.querySelector(kind === 'logo' ? '#uploadLogoBtn' : '#uploadFaviconBtn');
      const oldLabel = triggerBtn?.textContent;
      try {
        if (triggerBtn) {
          triggerBtn.disabled = true;
          triggerBtn.textContent = kind === 'logo' ? 'Logo uploaden...' : 'Favicon uploaden...';
        }
        const out = await NEB.json('/api/admin/branding/upload', { method: 'POST', body: form });
        draft.theme = draft.theme || {};
        if (kind === 'logo') draft.theme.logoPath = out.path || '';
        else draft.theme.faviconPath = out.path || '';
        NEB.toast(`${kind === 'logo' ? 'Logo' : 'Favicon'} geüpload`, 'success');
        rerender();
      } catch (err) {
        NEB.toast(err.message || 'Upload mislukt', 'error');
      } finally {
        if (triggerBtn) {
          triggerBtn.disabled = false;
          triggerBtn.textContent = oldLabel || (kind === 'logo' ? 'Upload logo' : 'Upload favicon');
        }
        e.target.value = '';
      }
      return;
    }
    // Product mockup uploads are now handled inside openProductModal
    // Inline size price editing (size-price-table)
    const sizePriceInput = e.target.closest('[data-size-price]');
    if (sizePriceInput) {
      const size = sizePriceInput.dataset.sizePrice;
      const val = parseFloat(sizePriceInput.value || '0') || 0;
      draft.pricing = draft.pricing || {};
      draft.pricing.sizeUpcharge = draft.pricing.sizeUpcharge || {};
      draft.pricing.sizeUpcharge[size] = val;
      return;
    }
    const subjectMatch = id.match(/^tmplSubject_(.+)$/);
    const htmlMatch = id.match(/^tmplHtml_(.+)$/);
    if (colorRow) {
      const idx = Number(colorRow.dataset.colorRow);
      const f = e.target.dataset.cf;
      if (f === 'enabled') draft.colors[idx].enabled = e.target.checked;
      else draft.colors[idx][f] = e.target.value;
    } else if (reviewRow) {
      const idx = Number(reviewRow.dataset.reviewRow);
      draft.reviews[idx][e.target.dataset.rf] = e.target.value;
    } else if (subjectMatch || htmlMatch) {
      const key = (subjectMatch?.[1] || htmlMatch?.[1] || '').trim();
      if (!key) return;
      draft.email = draft.email || {};
      draft.email.templates = draft.email.templates || {};
      draft.email.templates[key] = draft.email.templates[key] || {};
      if (subjectMatch) draft.email.templates[key].subject = e.target.value;
      if (htmlMatch) draft.email.templates[key].html = e.target.value;
      refreshTemplatePreview(key);
      updateTemplateVersionUI(key);
    }
  };

  wrap._settingsClickHandler = clickHandler;
  wrap._settingsInputHandler = inputHandler;
  wrap._settingsChangeHandler = inputHandler;
  wrap.addEventListener('click', clickHandler);
  wrap.addEventListener('input', inputHandler);
  wrap.addEventListener('change', inputHandler);
  updateAllTemplateVersionUI();

  function rerender() {
    captureFlatFields();
    wrap.innerHTML = renderSettings(draft);
    bindSettings(draft);
    applySettingsSubTab(CURRENT_SETTINGS_STAB);
  }

  function captureFlatFields() {
    draft.brand = draft.brand || {};
    draft.brand.name = wrap.querySelector('#brandName')?.value || draft.brand.name;
    draft.brand.tagline = wrap.querySelector('#brandTag')?.value || draft.brand.tagline;
    draft.hero = draft.hero || {};
    draft.hero.badge = wrap.querySelector('#heroBadge')?.value || draft.hero.badge;
    draft.hero.title1 = wrap.querySelector('#heroT1')?.value || draft.hero.title1;
    draft.hero.title2 = wrap.querySelector('#heroT2')?.value || draft.hero.title2;
    draft.hero.subtitle = wrap.querySelector('#heroSub')?.value || draft.hero.subtitle;
    draft.hero.cta = wrap.querySelector('#heroCta')?.value || draft.hero.cta;
    draft.hero.videoUrl = (wrap.querySelector('#heroVideoUrl')?.value || draft.hero.videoUrl || '').trim();
    const heroOverlayColorRaw = String(wrap.querySelector('#heroVideoOverlayColor')?.value || draft.hero.videoOverlayColor || '#000000').trim();
    draft.hero.videoOverlayColor = /^#[0-9a-fA-F]{6}$/.test(heroOverlayColorRaw) ? heroOverlayColorRaw.toLowerCase() : '#000000';
    draft.hero.videoOverlayOpacity = parseFloat(wrap.querySelector('#heroVideoOverlayOpacity')?.value || draft.hero.videoOverlayOpacity || '0.55');
    if (!Number.isFinite(draft.hero.videoOverlayOpacity)) draft.hero.videoOverlayOpacity = 0.55;
    draft.hero.videoOverlayOpacity = Math.max(0, Math.min(0.9, draft.hero.videoOverlayOpacity));
    draft.hero.videoBlurPx = parseInt(wrap.querySelector('#heroVideoBlurPx')?.value || draft.hero.videoBlurPx || '0', 10);
    if (!Number.isFinite(draft.hero.videoBlurPx)) draft.hero.videoBlurPx = 0;
    draft.hero.videoBlurPx = Math.max(0, Math.min(8, draft.hero.videoBlurPx));
    draft.seo = draft.seo || {};
    draft.seo.metaDescription = String(wrap.querySelector('#seoMetaDescription')?.value || draft.seo.metaDescription || '').trim().slice(0, 320);
    draft.seo.ogTitle = String(wrap.querySelector('#seoOgTitle')?.value || draft.seo.ogTitle || '').trim().slice(0, 120);
    draft.seo.ogDescription = String(wrap.querySelector('#seoOgDescription')?.value || draft.seo.ogDescription || '').trim().slice(0, 320);
    const rawOgImage = String(wrap.querySelector('#seoOgImagePath')?.value || draft.seo.ogImagePath || '').trim();
    draft.seo.ogImagePath = /^https?:\/\//i.test(rawOgImage) ? rawOgImage.replace(/\s+/g, '') : rawOgImage.replace(/^\/+/, '');
    draft.theme = draft.theme || {};
    draft.theme.themePreset = String(wrap.querySelector('#themePreset')?.value || draft.theme.themePreset || 'CUSTOM').toUpperCase();
    draft.theme.logoMark = (wrap.querySelector('#themeLogoMark')?.value || draft.theme.logoMark || '✦').slice(0, 2);
    draft.theme.accentColor = wrap.querySelector('#themeAccentColor')?.value || draft.theme.accentColor || '#ffffff';
    draft.theme.accentColor2 = wrap.querySelector('#themeAccentColor2')?.value || draft.theme.accentColor2 || '#bdbdbd';
    draft.theme.headingFont = wrap.querySelector('#themeHeadingFont')?.value || draft.theme.headingFont || 'POPPINS';
    draft.theme.bodyFont = wrap.querySelector('#themeBodyFont')?.value || draft.theme.bodyFont || 'POPPINS';
    draft.theme.buttonStyle = wrap.querySelector('#themeButtonStyle')?.value || draft.theme.buttonStyle || 'ROUNDED';
    draft.theme.sectionTone = wrap.querySelector('#themeSectionTone')?.value || draft.theme.sectionTone || 'MUTED';
    draft.theme.invoiceOpenBg = wrap.querySelector('#themeInvoiceOpenBg')?.value || draft.theme.invoiceOpenBg || '#1d4ed8';
    draft.theme.invoiceOpenText = wrap.querySelector('#themeInvoiceOpenText')?.value || draft.theme.invoiceOpenText || '#eff6ff';
    draft.theme.invoiceDueBg = wrap.querySelector('#themeInvoiceDueBg')?.value || draft.theme.invoiceDueBg || '#f59e0b';
    draft.theme.invoiceDueText = wrap.querySelector('#themeInvoiceDueText')?.value || draft.theme.invoiceDueText || '#111827';
    draft.theme.logoPath = (wrap.querySelector('#themeLogoPath')?.value || draft.theme.logoPath || '').trim();
    draft.theme.faviconPath = (wrap.querySelector('#themeFaviconPath')?.value || draft.theme.faviconPath || '').trim();
    draft.pricing = draft.pricing || {};
    draft.pricing.basePrice = parseFloat(wrap.querySelector('#basePrice')?.value || '0');
    draft.pricing.extraDesignFee = parseFloat(wrap.querySelector('#extraFee')?.value || '0');
    draft.pricing.shippingCost = Math.max(0, parseFloat(wrap.querySelector('#shippingCost')?.value || '0') || 0);
    draft.pricing.shippingFreeThreshold = Math.max(0, parseFloat(wrap.querySelector('#shippingFreeThreshold')?.value || '0') || 0);
    draft.pricing.deliveryText = wrap.querySelector('#deliveryText')?.value || draft.pricing.deliveryText;
    draft.pricing.shippingFree = !!wrap.querySelector('#shippingFree')?.checked;
    draft.company = draft.company || {};
    draft.company.legalName = wrap.querySelector('#companyLegalName')?.value || draft.company.legalName || '';
    draft.company.invoicePrefix = wrap.querySelector('#companyInvoicePrefix')?.value || draft.company.invoicePrefix || 'INV';
    draft.company.vatNumber = wrap.querySelector('#companyVatNumber')?.value || draft.company.vatNumber || '';
    draft.company.address = wrap.querySelector('#companyAddress')?.value || draft.company.address || '';
    draft.company.postcode = wrap.querySelector('#companyPostcode')?.value || draft.company.postcode || '';
    draft.company.city = wrap.querySelector('#companyCity')?.value || draft.company.city || '';
    draft.company.country = wrap.querySelector('#companyCountry')?.value || draft.company.country || 'BE';
    draft.company.supportEmail = wrap.querySelector('#companySupportEmail')?.value || draft.company.supportEmail || '';
    draft.company.supportPhone = wrap.querySelector('#companySupportPhone')?.value || draft.company.supportPhone || '';
    draft.documents = draft.documents || {};
    draft.documents.invoice = draft.documents.invoice || {};
    draft.documents.invoice.title = wrap.querySelector('#docInvoiceTitle')?.value || draft.documents.invoice.title || 'Factuur';
    draft.documents.invoice.intro = wrap.querySelector('#docInvoiceIntro')?.value || draft.documents.invoice.intro || '';
    draft.documents.invoice.paymentTermsDays = Math.max(0, parseInt(wrap.querySelector('#docInvoiceTermsDays')?.value || '0', 10) || 0);
    draft.documents.invoice.numberYearMode = wrap.querySelector('#docInvoiceYearMode')?.value || draft.documents.invoice.numberYearMode || 'ORDER_YEAR';
    draft.documents.invoice.numberPadLength = Math.max(4, parseInt(wrap.querySelector('#docInvoicePadLength')?.value || '6', 10) || 6);
    draft.documents.invoice.footer = wrap.querySelector('#docInvoiceFooter')?.value || draft.documents.invoice.footer || '';
    draft.documents.invoice.legalDisclaimer = wrap.querySelector('#docInvoiceLegalDisclaimer')?.value || draft.documents.invoice.legalDisclaimer || '';
    draft.documents.invoice.reminderEnabled = !!wrap.querySelector('#docInvoiceReminderEnabled')?.checked;
    draft.documents.invoice.reminderIntervalHours = Math.max(1, parseInt(wrap.querySelector('#docInvoiceReminderInterval')?.value || '24', 10) || 24);
    draft.documents.invoice.reminderMaxCount = Math.max(1, parseInt(wrap.querySelector('#docInvoiceReminderMax')?.value || '5', 10) || 5);
    draft.documents.invoice.showSupportContacts = !!wrap.querySelector('#docInvoiceShowSupport')?.checked;
    draft.documents.packingSlip = draft.documents.packingSlip || {};
    draft.documents.packingSlip.title = wrap.querySelector('#docPackingTitle')?.value || draft.documents.packingSlip.title || 'Orderbon';
    draft.documents.packingSlip.intro = wrap.querySelector('#docPackingIntro')?.value || draft.documents.packingSlip.intro || '';
    draft.documents.packingSlip.footer = wrap.querySelector('#docPackingFooter')?.value || draft.documents.packingSlip.footer || '';
    draft.documents.packingSlip.showFilePaths = !!wrap.querySelector('#docPackingShowPaths')?.checked;
    draft.conversion = draft.conversion || {};
    draft.conversion.ctaVariant = wrap.querySelector('#convCtaVariant')?.value || draft.conversion.ctaVariant || 'SOFT';
    draft.conversion.designerStep2Cta = wrap.querySelector('#convDesignerStep2Cta')?.value || draft.conversion.designerStep2Cta || 'Naar overzicht';
    draft.conversion.designerStep3CtaSoft = wrap.querySelector('#convDesignerStep3Soft')?.value || draft.conversion.designerStep3CtaSoft || 'Toevoegen naar winkelmand';
    draft.conversion.designerStep3CtaStrong = wrap.querySelector('#convDesignerStep3Strong')?.value || draft.conversion.designerStep3CtaStrong || 'Toevoegen naar winkelmand';
    draft.conversion.cartCtaSoft = wrap.querySelector('#convCartSoft')?.value || draft.conversion.cartCtaSoft || 'Bestelling plaatsen (nog niet betalen)';
    draft.conversion.cartCtaStrong = wrap.querySelector('#convCartStrong')?.value || draft.conversion.cartCtaStrong || 'Bestelling plaatsen';
    draft.conversion.urgencyEnabled = !!wrap.querySelector('#convUrgencyEnabled')?.checked;
    draft.conversion.socialProofEnabled = !!wrap.querySelector('#convSocialEnabled')?.checked;
    draft.conversion.urgencyText = wrap.querySelector('#convUrgencyText')?.value || draft.conversion.urgencyText || 'Beperkte productiecapaciteit deze week.';
    draft.conversion.socialProofText = wrap.querySelector('#convSocialText')?.value || draft.conversion.socialProofText || 'Gemiddelde goedkeuring op werkdagen: binnen 2 uur.';
    draft.conversion.checkoutNote = wrap.querySelector('#convCheckoutNote')?.value || draft.conversion.checkoutNote || 'Na goedkeuring ontvang je je beveiligde betaallink per e-mail.';
    draft.products = normalizeProducts((draft.products || []).map((p, idx) => ({
      ...p,
      id: slugifyProductId(p.id || p.name || `product-${idx + 1}`, `product-${idx + 1}`),
      name: String(p.name || `Product ${idx + 1}`).trim(),
      description: String(p.description || ''),
      mockupPath: String(p.mockupPath || 'assets/tshirt_mockup.png').trim() || 'assets/tshirt_mockup.png',
      priceMultiplier: Math.max(0.1, Number(p.priceMultiplier) || 1),
      extraDesignFeeMultiplier: Math.max(0, Number(p.extraDesignFeeMultiplier) || 1),
      sizes: Array.isArray(p.sizes) ? p.sizes : [],
      colorHexes: Array.isArray(p.colorHexes) ? p.colorHexes : [],
      enabled: p.enabled !== false
    })));
    draft.email = draft.email || {};
    draft.smtp = draft.smtp || {};
    draft.smtp.host = wrap.querySelector('#smtpHost')?.value || draft.smtp.host || '';
    draft.smtp.port = parseInt(wrap.querySelector('#smtpPort')?.value || draft.smtp.port || '587', 10) || 587;
    const smtpUserInput = (wrap.querySelector('#smtpUser')?.value || '').trim();
    const smtpPassInput = wrap.querySelector('#smtpPass')?.value || '';
    if (smtpUserInput) draft.smtp.user = smtpUserInput;
    else delete draft.smtp.user;
    if (smtpPassInput) draft.smtp.pass = smtpPassInput;
    else delete draft.smtp.pass;
    draft.smtp.secure = !!wrap.querySelector('#smtpSecure')?.checked;
    draft.smtp.fromName = wrap.querySelector('#smtpFromName')?.value || draft.smtp.fromName || '';
    draft.smtp.fromAddress = wrap.querySelector('#smtpFromAddress')?.value || draft.smtp.fromAddress || '';
    draft.email.fromName = wrap.querySelector('#emailFromName')?.value || draft.email.fromName || '';
    draft.email.fromAddress = wrap.querySelector('#emailFromAddress')?.value || draft.email.fromAddress || '';
    draft.email.replyTo = wrap.querySelector('#emailReplyTo')?.value || draft.email.replyTo || '';
    draft.email.templates = draft.email.templates || {};
    EMAIL_TEMPLATES.forEach(({ key }) => {
      draft.email.templates[key] = draft.email.templates[key] || {};
      draft.email.templates[key].subject =
        wrap.querySelector(`#tmplSubject_${key}`)?.value ?? draft.email.templates[key].subject ?? '';
      draft.email.templates[key].html =
        wrap.querySelector(`#tmplHtml_${key}`)?.value ?? draft.email.templates[key].html ?? '';
    });
  }

  function refreshTemplatePreview(key) {
    const slot = wrap.querySelector(`#tmplPreview_${key}`);
    if (!slot) return;
    const template = draft.email?.templates?.[key] || {};
    const frame = renderTemplatePreviewFrame(template, draft);
    slot.innerHTML = `
      <div class="mail-preview-col">
        <div class="mail-preview-label">Desktop preview</div>
        <div class="mail-preview-canvas desktop">${frame}</div>
      </div>
      <div class="mail-preview-col">
        <div class="mail-preview-label">Mobiel preview</div>
        <div class="mail-preview-canvas mobile">${frame}</div>
      </div>
    `;
  }

  function getTemplateState(source, key) {
    return {
      subject: source?.email?.templates?.[key]?.subject || '',
      html: source?.email?.templates?.[key]?.html || ''
    };
  }

  function updateTemplateVersionUI(key) {
    const statusEl = wrap.querySelector(`#tmplStatus_${key}`);
    const diffEl = wrap.querySelector(`#tmplDiff_${key}`);
    const restoreBtn = wrap.querySelector(`[data-restore-template="${key}"]`);
    const toggleBtn = wrap.querySelector(`[data-toggle-diff="${key}"]`);
    if (!statusEl || !diffEl || !restoreBtn || !toggleBtn) return;

    const savedTemplate = getTemplateState(savedSnapshot, key);
    const currentTemplate = getTemplateState(draft, key);
    const changed = templateChanged(currentTemplate, savedTemplate);

    statusEl.textContent = changed ? 'Gewijzigd' : 'Opgeslagen';
    statusEl.className = `tmpl-version-pill ${changed ? 'dirty' : 'clean'}`;
    restoreBtn.disabled = !changed;

    toggleBtn.textContent = diffOpen[key] ? 'Verberg diff' : 'Toon diff';
    diffEl.hidden = !diffOpen[key];
    if (diffOpen[key]) {
      diffEl.innerHTML = renderTemplateDiffHtml(savedTemplate, currentTemplate);
    }
  }

  function updateAllTemplateVersionUI() {
    EMAIL_TEMPLATES.forEach(({ key }) => updateTemplateVersionUI(key));
  }

  async function save() {
    captureFlatFields();
    try {
      await NEB.put('/api/admin/config', draft);
      savedSnapshot = JSON.parse(JSON.stringify(draft));
      updateAllTemplateVersionUI();
      NEB.toast('Instellingen opgeslagen', 'success');
    } catch (err) { NEB.toast(err.message, 'error'); }
  }
}
