// ==========================================================================
// NEBULOUS — shared client helpers (auth, nav, API, toast)
// ==========================================================================

if (window.location.protocol === 'file:') {
  const pathRaw = String(window.location.pathname || '').replace(/\/+$/, '');
  const m = pathRaw.match(/\/public\/([^/]+?)(?:\.html)?$/i);
  let slug = (m && m[1] ? m[1] : '').toLowerCase();
  if (!slug) {
    const last = pathRaw.split('/').filter(Boolean).pop() || 'index';
    slug = last.replace(/\.html$/i, '').toLowerCase();
  }
  const target = slug === 'index' ? '/' : `/${slug}`;
  window.location.replace(`http://localhost:3737${target}`);
}

const NEB = (() => {
  const HEX6_RE = /^#([0-9a-fA-F]{6})$/;
  const FONT_MAP = {
    POPPINS: "'Poppins', -apple-system, BlinkMacSystemFont, sans-serif",
    INTER: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    SPACE_GROTESK: "'Space Grotesk', 'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    SYSTEM: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    SERIF: "Georgia, 'Times New Roman', Times, serif"
  };

  function normalizeHex(raw, fallback) {
    const s = String(raw || '').trim();
    if (HEX6_RE.test(s)) return s.toLowerCase();
    return fallback;
  }
  function toAssetUrl(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s;
    return '/' + s.replace(/^\/+/, '');
  }
  function hexToRgb(hex) {
    const h = normalizeHex(hex, '#ffffff').slice(1);
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16)
    };
  }
  function rgba(hex, alpha) {
    const { r, g, b } = hexToRgb(hex);
    const a = Math.max(0, Math.min(1, Number(alpha) || 0));
    return `rgba(${r},${g},${b},${a})`;
  }
  function mixHex(aHex, bHex, ratio) {
    const a = Math.max(0, Math.min(1, Number(ratio) || 0));
    const c1 = hexToRgb(aHex);
    const c2 = hexToRgb(bHex);
    const r = Math.round(c1.r + (c2.r - c1.r) * a);
    const g = Math.round(c1.g + (c2.g - c1.g) * a);
    const b = Math.round(c1.b + (c2.b - c1.b) * a);
    return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
  }
  function isLightHex(hex) {
    const { r, g, b } = hexToRgb(hex);
    const yiq = (r * 299 + g * 587 + b * 114) / 1000;
    return yiq >= 162;
  }

  const json = (path, opts = {}) => {
    if (window.location.protocol === 'file:' && String(path || '').startsWith('/')) {
      const err = new Error('Lokale file-modus gedetecteerd. Open via http://localhost:3737 zodat API-calls werken.');
      err.status = 0;
      err.data = { error: err.message, hint: 'Gebruik localhost i.p.v. file:// URL' };
      return Promise.reject(err);
    }
    const isFormData = (typeof FormData !== 'undefined') && (opts.body instanceof FormData);
    const headers = { ...(opts.headers || {}) };
    let body = opts.body;
    if (!isFormData && body && typeof body !== 'string') {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      body = JSON.stringify(body);
    }
    return fetch(path, {
      credentials: 'same-origin',
      ...opts,
      headers,
      body
    }).then(async r => {
      const ct = r.headers.get('content-type') || '';
      const data = ct.includes('application/json') ? await r.json() : await r.text();
      if (!r.ok) {
        const err = new Error((data && data.error) || `HTTP ${r.status}`);
        err.status = r.status;
        err.data = data;
        throw err;
      }
      return data;
    });
  };

  return {
    json,
    get: (p) => json(p),
    post: (p, body) => json(p, { method: 'POST', body }),
    put: (p, body) => json(p, { method: 'PUT', body }),
    del: (p) => json(p, { method: 'DELETE' }),

    me: () => json('/api/auth/me').then(d => d.user),
    config: () => json('/api/config'),

    fmtEUR: (n) => '€' + (Number(n) || 0).toFixed(2).replace('.', ','),
    fmtDate: (s) => {
      if (!s) return '';
      const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
      return d.toLocaleString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    },

    statusPill(status) {
      const map = {
        NEW: ['Nieuw', 'pill-new'],
        APPROVED: ['Goedgekeurd', 'pill-pending'],
        APPROVED_AWAITING_PAYMENT: ['Goedgekeurd (betaallink volgt)', 'pill-pending'],
        PAYMENT_PENDING: ['Betaling in behandeling', 'pill-pending'],
        PAID: ['Betaald', 'pill-paid'],
        IN_PRODUCTION: ['In productie', 'pill-prod'],
        SHIPPED: ['Verzonden', 'pill-shipped'],
        DELIVERED: ['Bezorgd', 'pill-delivered'],
        CANCELLED: ['Geannuleerd', 'pill-cancelled'],
        PENDING: ['Wacht op goedkeuring', 'pill-pending'],
        ACTIVE: ['Actief', 'pill-active'],
        BLOCKED: ['Geblokkeerd', 'pill-blocked']
      };
      const [label, cls] = map[status] || [status, ''];
      return `<span class="pill ${cls}">${label}</span>`;
    },

    invoiceStatusPill(invoice) {
      const status = String(invoice?.status || '').toUpperCase();
      const overdue = !!invoice?.overdue;
      const map = {
        CONCEPT: ['Factuur concept', 'pill-invoice-concept'],
        DEFINITIVE: overdue
          ? ['Factuur overdue', 'pill-invoice-overdue']
          : ['Factuur open', 'pill-invoice-open'],
        PAID: ['Factuur betaald', 'pill-invoice-paid'],
        VOID: ['Factuur geannuleerd', 'pill-invoice-void']
      };
      const [label, cls] = map[status] || ['Factuur onbekend', 'pill-invoice-concept'];
      return `<span class="pill ${cls}">${label}</span>`;
    },

    invoiceDuePill(invoice) {
      if (!invoice?.due_date || String(invoice?.status || '').toUpperCase() !== 'DEFINITIVE') return '';
      const due = new Date(String(invoice.due_date).includes('T') ? invoice.due_date : `${invoice.due_date}Z`);
      if (!Number.isFinite(due.getTime())) return '';
      if (invoice?.overdue) return `<span class="pill pill-invoice-overdue">Vervallen ${this.fmtDate(invoice.due_date)}</span>`;
      return `<span class="pill pill-invoice-due">Vervalt ${this.fmtDate(invoice.due_date)}</span>`;
    },

    rolePill(role) {
      const map = { OWNER: 'pill-owner', ADMIN: 'pill-admin', USER: 'pill-user' };
      return `<span class="pill ${map[role] || ''}">${role}</span>`;
    },

    toast(msg, kind = '') {
      let el = document.querySelector('.neb-toast');
      if (!el) {
        el = document.createElement('div');
        el.className = 'neb-toast';
        Object.assign(el.style, {
          position: 'fixed', bottom: '24px', right: '24px',
          background: 'var(--bg-card)', color: 'var(--text)',
          border: '1px solid var(--border)', borderRadius: '12px',
          padding: '12px 18px', fontSize: '.9rem', zIndex: 9999,
          boxShadow: '0 10px 30px rgba(0,0,0,.4)', opacity: '0',
          transition: 'opacity .25s, transform .25s', transform: 'translateY(8px)'
        });
        document.body.appendChild(el);
      }
      el.textContent = msg;
      el.style.borderColor = kind === 'error' ? 'rgba(239,68,68,.5)' : kind === 'success' ? 'rgba(34,197,94,.5)' : 'var(--border)';
      el.style.opacity = '1';
      el.style.transform = 'translateY(0)';
      clearTimeout(el._t);
      el._t = setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(8px)'; }, 2600);
    },

    initials(user) {
      if (!user) return '?';
      const s = ((user.firstName || '') + ' ' + (user.lastName || '')).trim();
      if (s) return s.split(' ').slice(0, 2).map(p => p[0] || '').join('').toUpperCase();
      return (user.email || '?')[0].toUpperCase();
    },

    async paintNav(opts = {}) {
      const slot = document.querySelector('[data-nav-user]');
      if (!slot) return;
      const user = window.NEB_USER || await this.me().catch(() => null);
      if (!user) {
        slot.innerHTML = `
          <a class="nav-link-cta" href="/login">Inloggen</a>
          <a class="nav-link-cta nav-link-solid" href="/register">Registreren</a>`;
        return;
      }
      const isStaff = user.role === 'OWNER' || user.role === 'ADMIN';
      slot.innerHTML = `
        <div class="nav-user-menu" id="navUserMenu">
          <a class="nav-user" href="#" data-toggle>
            <span class="nav-user-avatar">${this.initials(user)}</span>
            <span>${(user.firstName || user.email).slice(0, 20)}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
          </a>
          <div class="menu">
            <a href="/dashboard">Mijn bestellingen <span class="role-badge">${user.role}</span></a>
            <a href="/cart">Winkelmand</a>
            <a href="/account">Account</a>
            ${isStaff ? `
            <div class="divider"></div>
            <a href="/admin">Bestellingen</a>
            <a href="/admin?tab=users">Klanten</a>
            <a href="/admin?tab=settings">Instellingen</a>` : ''}
            <div class="divider"></div>
            <a href="/designer">Designer</a>
            <div class="divider"></div>
            <button type="button" data-logout>Uitloggen</button>
          </div>
        </div>`;
      const menu = slot.querySelector('#navUserMenu');
      menu.querySelector('[data-toggle]').addEventListener('click', (e) => {
        e.preventDefault();
        menu.classList.toggle('open');
      });
      document.addEventListener('click', (e) => {
        if (!menu.contains(e.target)) menu.classList.remove('open');
      });
      menu.querySelector('[data-logout]').addEventListener('click', async () => {
        await this.post('/api/auth/logout');
        location.href = '/login';
      });
      this.paintCart();
      return user;
    },

    async requireAuth(roles = null) {
      const user = await this.me().catch(() => null);
      if (!user) { location.href = '/login?next=' + encodeURIComponent(location.pathname); return null; }
      if (roles && !roles.includes(user.role)) { location.href = '/dashboard'; return null; }
      return user;
    },

    initTheme() {
      document.body.classList.remove('theme-light');
      try { localStorage.removeItem('neb_theme'); } catch {}
    },

    setTheme() {
      document.body.classList.remove('theme-light');
      try { localStorage.removeItem('neb_theme'); } catch {}
      if (window.NEB_CONFIG) this.applyBranding(window.NEB_CONFIG);
    },

    applyHeroVideo(cfg = {}) {
      const hero = cfg?.hero || {};
      const wrap = document.getElementById('heroVideoWrap');
      const frame = document.getElementById('heroVideoFrame');
      if (!wrap || !frame) return;
      const url = String(hero.videoUrl || '').trim();
      if (!url) { wrap.hidden = true; return; }
      const ytMatch = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([A-Za-z0-9_-]{11})/);
      const videoId = ytMatch ? ytMatch[1] : (/^[A-Za-z0-9_-]{11}$/.test(url) ? url : null);
      if (!videoId) { wrap.hidden = true; return; }
      frame.src = `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&mute=1&loop=1&controls=0&disablekb=1&modestbranding=1&playlist=${videoId}`;
      wrap.hidden = false;
      // Zet CSS-variabelen voor overlay kleur en opacity
      const overlayColor = String(hero.videoOverlayColor || '#000000').trim();
      const hex = overlayColor.replace('#', '');
      const r = parseInt(hex.slice(0, 2), 16) || 0;
      const g = parseInt(hex.slice(2, 4), 16) || 0;
      const b = parseInt(hex.slice(4, 6), 16) || 0;
      const opacity = Math.min(0.95, Math.max(0, Number(hero.videoOverlayOpacity ?? 0.55)));
      const blur = Math.min(20, Math.max(0, Number(hero.videoBlurPx || 0)));
      const root = document.documentElement;
      root.style.setProperty('--hero-video-overlay-rgb', `${r},${g},${b}`);
      root.style.setProperty('--hero-video-overlay-opacity', String(opacity));
      root.style.setProperty('--hero-video-overlay-opacity-end', String(Math.max(0, opacity - 0.2)));
      root.style.setProperty('--hero-video-blur', `${blur}px`);
      // Hero tekst uit config toepassen
      const t1 = document.getElementById('heroTitle1');
      const t2 = document.getElementById('heroTitle2');
      const sub = document.getElementById('heroSubtitle');
      if (t1 && hero.title1) t1.textContent = hero.title1;
      if (t2 && hero.title2) t2.textContent = hero.title2;
      if (sub && hero.subtitle) sub.textContent = hero.subtitle;
    },

    applyBranding(cfg = {}) {
      const theme = cfg?.theme || {};
      const root = document.documentElement;
      const body = document.body;
      const setVar = (name, value) => {
        root.style.setProperty(name, value);
        body?.style.setProperty(name, value);
      };

      const accent = normalizeHex(theme.accentColor, '#ffffff');
      const accent2 = normalizeHex(theme.accentColor2, '#bdbdbd');
      const invoiceOpenBg = normalizeHex(theme.invoiceOpenBg, '#1d4ed8');
      const invoiceOpenText = normalizeHex(theme.invoiceOpenText, '#eff6ff');
      const invoiceDueBg = normalizeHex(theme.invoiceDueBg, '#f59e0b');
      const invoiceDueText = normalizeHex(theme.invoiceDueText, '#111827');
      const onAccent = isLightHex(accent) ? '#0b0b0b' : '#ffffff';
      const buttonStyle = String(theme.buttonStyle || 'ROUNDED').toUpperCase();
      const sectionTone = String(theme.sectionTone || 'MUTED').toUpperCase();
      const headingFont = FONT_MAP[String(theme.headingFont || 'POPPINS').toUpperCase()] || FONT_MAP.POPPINS;
      const bodyFont = FONT_MAP[String(theme.bodyFont || 'POPPINS').toUpperCase()] || FONT_MAP.POPPINS;

      const btnRadius = buttonStyle === 'PILL' ? '999px' : buttonStyle === 'SHARP' ? '8px' : '12px';
      const hover = mixHex(accent, isLightHex(accent) ? '#000000' : '#ffffff', 0.12);
      const sectionBg = sectionTone === 'FLAT'
        ? 'var(--bg)'
        : sectionTone === 'BOLD'
          ? rgba(accent, 0.1)
          : rgba(accent, 0.06);

      setVar('--font-heading', headingFont);
      setVar('--font-body', bodyFont);
      setVar('--brand-accent', accent);
      setVar('--brand-accent-2', accent2);
      setVar('--brand-on-accent', onAccent);
      setVar('--brand-gradient', `linear-gradient(135deg, ${accent}, ${accent2})`);
      setVar('--accent-soft', rgba(accent, 0.18));
      setVar('--btn-bg', accent);
      setVar('--btn-fg', onAccent);
      setVar('--btn-bg-hover', hover);
      setVar('--r-btn', btnRadius);
      setVar('--section-bg', sectionBg);
      setVar('--orb-1-color', rgba(accent, 0.55));
      setVar('--orb-2-color', rgba(accent2, 0.55));
      setVar('--orb-3-color', rgba(mixHex(accent, accent2, 0.5), 0.55));
      setVar('--invoice-open-bg', invoiceOpenBg);
      setVar('--invoice-open-text', invoiceOpenText);
      setVar('--invoice-open-border', rgba(invoiceOpenBg, 0.6));
      setVar('--invoice-due-bg', invoiceDueBg);
      setVar('--invoice-due-text', invoiceDueText);
      setVar('--invoice-due-border', rgba(invoiceDueBg, 0.55));

      const logoMark = String(theme.logoMark || '✦').trim().slice(0, 2) || '✦';
      const logoSrc = toAssetUrl(theme.logoPath || '');
      document.querySelectorAll('.logo-mark').forEach(el => {
        if (logoSrc) {
          el.classList.add('has-logo-image');
          el.innerHTML = `<img src="${logoSrc}" alt="${cfg?.brand?.name || 'Logo'}">`;
          const img = el.querySelector('img');
          if (img) {
            img.onerror = () => {
              el.classList.remove('has-logo-image');
              el.textContent = logoMark;
            };
          }
        } else {
          el.classList.remove('has-logo-image');
          el.textContent = logoMark;
        }
      });
      if (cfg?.brand?.name) {
        document.querySelectorAll('.logo span:last-child, .auth-logo span:last-child').forEach(el => {
          el.textContent = cfg.brand.name;
        });
      }

      const faviconHref = toAssetUrl(theme.faviconPath || '');
      if (faviconHref) {
        let faviconLink = document.querySelector('link#neb-favicon');
        if (!faviconLink) {
          faviconLink = document.createElement('link');
          faviconLink.id = 'neb-favicon';
          faviconLink.rel = 'icon';
          faviconLink.type = 'image/png';
          document.head.appendChild(faviconLink);
        }
        faviconLink.href = faviconHref;
      }
    },

    paintThemeSwitch() {
      const slot = document.querySelector('[data-theme-switch]');
      if (!slot) return;
      slot.innerHTML = '';
      this.setTheme('dark');
    },

    async paintCart() {
      const slot = document.querySelector('[data-cart-icon]');
      if (!slot) return;
      const user = window.NEB_USER || await this.me().catch(() => null);
      if (!user) { slot.innerHTML = ''; return; }
      let count = 0;
      try {
        const { items } = await this.get('/api/cart');
        count = (items || []).reduce((s, i) => s + (i.qty || 0), 0);
      } catch {}
      slot.innerHTML = `
        <a class="nav-cart" href="/cart" title="Winkelmand" aria-label="Winkelmand">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 002 1.61h9.72a2 2 0 002-1.61L23 6H6"/></svg>
          ${count ? `<span class="cart-badge" id="navCartBadge">${count}</span>` : ''}
        </a>`;
    },

    async paintAdminBadges() {
      try {
        const b = await this.get('/api/admin/badges');
        const ord = document.querySelector('.tab[data-tab="orders"]');
        const usr = document.querySelector('.tab[data-tab="users"]');
        if (ord) { if (b.newOrders) ord.dataset.badge = b.newOrders; else ord.removeAttribute('data-badge'); }
        if (usr) { if (b.pending) usr.dataset.badge = b.pending; else usr.removeAttribute('data-badge'); }
        const navAdmin = document.querySelector('.nav-link[href="/admin"]');
        if (navAdmin) {
          const total = (b.newOrders || 0) + (b.pending || 0);
          if (total) navAdmin.dataset.badge = total; else navAdmin.removeAttribute('data-badge');
        }
      } catch {}
    },

    bumpCart() {
      const el = document.getElementById('navCartBadge');
      if (!el) return;
      el.classList.add('bump');
      setTimeout(() => el.classList.remove('bump'), 350);
    }
  };
})();

document.addEventListener('DOMContentLoaded', () => {
  NEB.initTheme();
  NEB.paintThemeSwitch();
  const existingCfg = window.NEB_CONFIG;
  if (existingCfg) {
    NEB.applyBranding(existingCfg);
    NEB.applyHeroVideo(existingCfg);
  } else {
    NEB.config()
      .then((cfg) => {
        window.NEB_CONFIG = cfg || {};
        NEB.applyBranding(cfg || {});
        NEB.applyHeroVideo(cfg || {});
      })
      .catch(() => {});
  }
});
