// ========================================
// NEBULOUS - T-Shirt Designer App (Mockup + Theme)
// ========================================
function _nebInitWhenReady() {
    if (window.NEB_READY) {
        window.NEB_READY.then(_nebMain);
    } else {
        _nebMain();
    }
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _nebInitWhenReady);
} else {
    _nebInitWhenReady();
}
function _nebMain() {

    // ── Pre-fill order form for logged-in users ──
    const _u = window.NEB_USER;
    if (_u) {
        const setIfEmpty = (id, v) => {
            const el = document.getElementById(id);
            if (el && !el.value && v) el.value = v;
        };
        setIfEmpty('firstName', _u.firstName);
        setIfEmpty('lastName', _u.lastName);
        setIfEmpty('email', _u.email);
    }

    // ── State ──
    const state = {
        step: 1,
        color: '#f2f2f2',
        colorName: 'Wit',
        productId: 'tshirt',
        productName: 'Product',
        productMockupPath: 'assets/tshirt_mockup.png',
        productPriceMultiplier: 1,
        productExtraFeeMultiplier: 1,
        // Defaults for new layers
        position: 'center',
        scale: 100,
        size: 'M',
        qty: 1,
        price: 34.95,
        vOffset: 0,
        theme: 'dark',
        // Multiple designs (layers)
        layers: [],
        activeLayerId: null
    };
    const DESIGNER_DRAFT_KEY = 'neb_designer_draft_v1';
    const ALLOWED_POSITIONS = new Set(['top', 'center', 'bottom', 'full', 'leftchest', 'rightchest']);
    let restoringDraft = false;

    // Automatic placement tweaks per size (subtle, realistic changes).
    // Values are in percentage points applied to the base position map.
    const sizeAdjust = {
        XS:  { top: -1.4, w: -3.5 },
        S:   { top: -0.9, w: -1.8 },
        M:   { top: -0.3, w:  0.0 },
        L:   { top:  0.4, w:  2.2 },
        XL:  { top:  0.9, w:  4.4 },
        XXL: { top:  1.4, w:  6.8 }
    };

    function getSizeAdj() {
        return sizeAdjust[state.size] || sizeAdjust.M;
    }

    function clamp(n, min, max, fallback) {
        const v = Number(n);
        if (!Number.isFinite(v)) return fallback;
        return Math.max(min, Math.min(max, v));
    }

    function sanitizeLayerDraft(raw, index) {
        if (!raw || typeof raw !== 'object') return null;
        const position = ALLOWED_POSITIONS.has(raw.position) ? raw.position : 'center';
        const name = String(raw.name || `Design ${index + 1}`).slice(0, 120);
        return {
            id: String(raw.id || uid()),
            name,
            bytes: clamp(raw.bytes, 0, 50 * 1024 * 1024, 0),
            position,
            scale: Math.round(clamp(raw.scale, 10, 300, 100)),
            vOffset: Math.round(clamp(raw.vOffset, -1000, 1000, 0)),
            xOffset: Math.round(clamp(raw.xOffset, -1000, 1000, 0)),
            note: String(raw.note || '').slice(0, 2000),
            file: null,
            dataUrl: null,
            img: null,
            canvas: null,
            needsFile: true
        };
    }

    function buildDesignerDraft() {
        return {
            version: 1,
            savedAt: new Date().toISOString(),
            step: state.step,
            color: state.color,
            colorName: state.colorName,
            productId: state.productId,
            size: state.size,
            qty: state.qty,
            activeLayerId: state.activeLayerId,
            layers: (state.layers || []).map(l => ({
                id: l.id,
                name: l.name,
                bytes: l.bytes || 0,
                position: l.position || 'center',
                scale: Number(l.scale) || 100,
                vOffset: Number(l.vOffset) || 0,
                xOffset: Number(l.xOffset) || 0,
                note: l.note || ''
            }))
        };
    }

    function saveDesignerDraft() {
        try {
            sessionStorage.setItem(DESIGNER_DRAFT_KEY, JSON.stringify(buildDesignerDraft()));
        } catch {}
    }

    function clearDesignerDraft() {
        try { sessionStorage.removeItem(DESIGNER_DRAFT_KEY); } catch {}
    }

    function touchDesignerDraft() {
        if (restoringDraft) return;
        saveDesignerDraft();
    }

    function missingThumbDataUrl() {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">
<rect width="160" height="160" fill="#0f172a"/>
<rect x="12" y="12" width="136" height="136" fill="none" stroke="#334155" stroke-width="2" stroke-dasharray="6 6"/>
<path d="M56 86l16 16 30-32 18 19" fill="none" stroke="#64748b" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="60" cy="54" r="8" fill="#64748b"/>
<text x="80" y="128" text-anchor="middle" fill="#94a3b8" font-size="11" font-family="Arial, sans-serif">Re-upload nodig</text>
</svg>`;
        return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    }


    // ── DOM helpers ──
    const $ = (s) => document.querySelector(s);
    const $$ = (s) => document.querySelectorAll(s);

    const cursorGlow = $('#cursorGlow');
    const particles = $('#particles');

    const uploadZone = $('#uploadZone');
    const fileInput = $('#fileInput');
    const uploadList = $('#uploadList');
    const btnAddMoreFiles = $('#btnAddMoreFiles');
    const step2LayerList = $('#step2LayerList');

    const panelUpload = $('#panelUpload');
    const panelCustomize = $('#panelCustomize');
    const panelOrder = $('#panelOrder');

    // Per-item remarks (Step 2)
    const remarksInput = $('#remarksInput');

    // Modal PDF download
    const downloadPdfBtn = $('#downloadPdfBtn');

    const btnNext = $('#btnNext');
    const btnNextText = $('#btnNextText');
    const btnBack = $('#btnBack');

    const tshirt3d = $('#tshirt3d');
    const canvasHint = $('#canvasHint');
    const previewCanvas = $('#previewCanvas');

    const designImage = $('#designImage'); // fallback raster overlay (kept hidden)
    const layerStack = $('#layerStack');
    const designPlaceholder = $('#designPlaceholder');
    const mockupBase = $('#mockupBase');
    const shirtTintOverlay = $('#shirtTintOverlay');

    const colorName = $('#colorName');
    const sizeSelector = $('#sizeSelector');
    const sizeMeta = $('#sizeMeta');
    const productSelector = $('#productSelector');
    const productCards = $('#productCards');
    const productDescription = $('#productDescription');
    const productPriceHint = $('#productPriceHint');
    const activeProductBadge = $('#activeProductBadge');
    const scaleRange = $('#scaleRange');
    const scaleVal = $('#scaleVal');
    const vOffsetRange = $('#vOffsetRange');
    const vOffsetVal = $('#vOffsetVal');
    const xOffsetRange = $('#xOffsetRange');
    const xOffsetVal = $('#xOffsetVal');

    const btnResetActive = $('#btnResetActive');

    const navBasePrice = $('#navBasePrice');

    const activeDesignLabel = $('#activeDesignLabel');

    const qtyValue = $('#qtyValue');

    const toast = $('#toast');
    const toastMsg = $('#toastMsg');
    const modalOverlay = $('#modalOverlay');
    const modalClose = $('#modalClose');
    const btnPreviewProduct = $('#btnPreviewProduct');
    const productPreviewOverlay = $('#productPreviewOverlay');
    const productPreviewModal = $('#productPreviewModal');
    const productPreviewMeta = $('#productPreviewMeta');
    const btnPreviewClose = $('#btnPreviewClose');
    const btnPreviewFullscreen = $('#btnPreviewFullscreen');
    const productPreviewTshirt = $('#productPreviewTshirt');
    const productPreviewMockupBase = $('#productPreviewMockupBase');
    const productPreviewTint = $('#productPreviewTint');
    const productPreviewPlaceholder = $('#productPreviewPlaceholder');
    const productPreviewLayerStack = $('#productPreviewLayerStack');
    const designerUrgencyCard = $('#designerUrgencyCard');
    const designerUrgencyText = $('#designerUrgencyText');
    const designerSocialCard = $('#designerSocialCard');
    const designerSocialText = $('#designerSocialText');
    let previewRefreshRaf = 0;

    // Theme toggle
    const themeDarkBtn = $('#themeDark');
    const themeLightBtn = $('#themeLight');

    const isMobileLayout = window.matchMedia('(max-width: 700px)').matches;
    const isCoarsePointer = window.matchMedia('(pointer: coarse)').matches;
    if (canvasHint && (isMobileLayout || isCoarsePointer)) {
        canvasHint.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>
            Swipe om te draaien
        `;
    }

    // ── Theme init ──
    const savedTheme = localStorage.getItem('neb_theme');
    if (savedTheme === 'light' || savedTheme === 'dark') {
        state.theme = savedTheme;
    }
    applyTheme(state.theme);

    themeDarkBtn?.addEventListener('click', () => {
        state.theme = 'dark';
        applyTheme('dark');
        localStorage.setItem('neb_theme', 'dark');
    });
    themeLightBtn?.addEventListener('click', () => {
        state.theme = 'light';
        applyTheme('light');
        localStorage.setItem('neb_theme', 'light');
    });

    function applyTheme(theme) {
        document.body.classList.toggle('theme-light', theme === 'light');
        themeDarkBtn?.classList.toggle('active', theme === 'dark');
        themeLightBtn?.classList.toggle('active', theme === 'light');
        // Ensure UI pieces that depend on theme stay readable
        updateActiveDesignLabel();
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    }

    function getCatalogProducts() {
        const cfgProducts = Array.isArray(_cfg().products) ? _cfg().products : [];
        const enabled = cfgProducts.filter(p => p && p.enabled !== false);
        if (enabled.length) return enabled;
        return [{
            id: 'tshirt',
            name: 'Product',
            description: 'Professioneel marketingmateriaal',
            mockupPath: 'assets/tshirt_mockup.png',
            priceMultiplier: 1,
            extraDesignFeeMultiplier: 1,
            isDefault: true
        }];
    }

    function getSelectedProduct() {
        const products = getCatalogProducts();
        return products.find(p => String(p.id) === String(state.productId))
            || products.find(p => p.isDefault)
            || products[0];
    }

    function normalizeSizeCode(raw) {
        return String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
    }

    function normalizeSizeEntry(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const code = normalizeSizeCode(raw.code || raw.size);
        if (!code) return null;
        const widthMm = Math.max(0, Math.round(Number(raw.widthMm || raw.width || raw.w) || 0));
        const heightMm = Math.max(0, Math.round(Number(raw.heightMm || raw.height || raw.h) || 0));
        return { code, widthMm, heightMm };
    }

    function getProductSizes(product) {
        const defaultSizeMm = {
            XS: [460, 660],
            S: [480, 680],
            M: [520, 710],
            L: [560, 740],
            XL: [600, 770],
            XXL: [640, 800]
        };
        const raw = Array.isArray(product?.sizes) ? product.sizes : [];
        const parsed = raw.map(normalizeSizeEntry).filter(Boolean);
        if (parsed.length) return parsed;
        const fallback = Array.isArray(_cfg().sizes) ? _cfg().sizes : [];
        return fallback.map((s) => {
            const code = normalizeSizeCode(s);
            const mm = defaultSizeMm[code] || [0, 0];
            return { code, widthMm: mm[0], heightMm: mm[1] };
        }).filter((s) => s.code);
    }

    function formatSizeMetaText(sizeEntry) {
        const w = Number(sizeEntry?.widthMm || 0);
        const h = Number(sizeEntry?.heightMm || 0);
        if (!w || !h) return '';
        const wc = (w / 10).toFixed(1).replace(/\.0$/, '');
        const hc = (h / 10).toFixed(1).replace(/\.0$/, '');
        return `${wc} x ${hc} cm · ${w} x ${h} mm`;
    }

    function renderSizeMeta(product) {
        if (!sizeMeta) return;
        const current = getProductSizes(product).find((s) => s.code === normalizeSizeCode(state.size));
        const txt = formatSizeMetaText(current);
        sizeMeta.textContent = txt || 'Afmeting niet ingesteld voor deze maat.';
    }

    function renderProductSizes(product) {
        if (!sizeSelector) return;
        const sizes = getProductSizes(product);
        if (!sizes.length) return;
        const wanted = normalizeSizeCode(state.size);
        const hasWanted = sizes.some((s) => s.code === wanted);
        const middle = sizes.find((s) => s.code === 'M');
        const nextActive = hasWanted ? wanted : (middle?.code || sizes[0].code);
        state.size = nextActive;
        sizeSelector.innerHTML = sizes.map((s) => `
            <button class="size-btn ${s.code === nextActive ? 'active' : ''}" data-size="${escapeHtml(s.code)}">${escapeHtml(s.code)}</button>
        `).join('');
        renderSizeMeta(product);
    }

    function syncShirtTintMask() {
        if (!shirtTintOverlay || !mockupBase) return;
        const src = String(mockupBase.getAttribute('src') || '').trim().replace(/^\/+/, '');
        if (!src) return;
        shirtTintOverlay.style.setProperty('--mockup-mask-url', `url("${src}")`);
    }

    function updateMockupImageSource() {
        if (!mockupBase) return;
        const nextPath = String(state.productMockupPath || '').trim().replace(/^\/+/, '');
        if (!nextPath) return;
        const currentPath = String(mockupBase.getAttribute('src') || '').trim().replace(/^\/+/, '');
        if (currentPath === nextPath) {
            syncShirtTintMask();
            return;
        }
        mockupBase.onerror = () => {
            mockupBase.onerror = null;
            mockupBase.src = 'assets/tshirt_mockup.png';
            state.productMockupPath = 'assets/tshirt_mockup.png';
            syncShirtTintMask();
            updateShirtColor();
        };
        mockupBase.onload = () => {
            mockupBase.onload = null;
            syncShirtTintMask();
            updateShirtColor();
        };
        mockupBase.src = nextPath;
    }

    function applySelectedProduct(product, opts = {}) {
        const p = product || getSelectedProduct();
        state.productId = String(p?.id || 'tshirt');
        state.productName = String(p?.name || 'Product');
        state.productMockupPath = String(p?.mockupPath || 'assets/tshirt_mockup.png');
        state.productPriceMultiplier = Math.max(0.1, Number(p?.priceMultiplier) || 1);
        state.productExtraFeeMultiplier = Math.max(0, Number(p?.extraDesignFeeMultiplier) || 1);
        // Prijsmatrix per product
        state.productBasePrice = (p?.basePrice != null && p.basePrice >= 0) ? Number(p.basePrice) : null;
        state.productExtraDesignFee = (p?.extraDesignFee != null && p.extraDesignFee >= 0) ? Number(p.extraDesignFee) : null;
        state.productColorPrices = (p?.colorPrices && typeof p.colorPrices === 'object') ? p.colorPrices : {};
        state.productSizePrices = (p?.sizePrices && typeof p.sizePrices === 'object') ? p.sizePrices : {};
        state.productColorData = (p?.colorData && typeof p.colorData === 'object') ? p.colorData : {};
        if (productSelector && productSelector.value !== state.productId) {
            productSelector.value = state.productId;
        }
        productCards?.querySelectorAll('.product-card').forEach((el) => {
            el.classList.toggle('active', String(el.dataset.productId || '') === state.productId);
            el.setAttribute('aria-checked', String(String(el.dataset.productId || '') === state.productId));
        });
        if (productDescription) {
            const desc = String(p?.description || '').trim();
            productDescription.textContent = desc || 'Kies het materiaal waarvoor je dit ontwerp wil gebruiken.';
        }
        if (productPriceHint) {
            const fromPrice = state.productBasePrice != null
                ? state.productBasePrice
                : Number(_cfg().pricing?.basePrice || 0) * Math.max(0.1, Number(state.productPriceMultiplier) || 1);
            productPriceHint.textContent = `Vanaf ${fmtEUR(Math.max(0, fromPrice))} per stuk`;
        }
        renderProductSizes(p);
        applyProductColorScope(p, { preferWhite: !!opts.preferWhite });
        updateActiveProductBadge(p);
        if (!opts.skipMockupUpdate) updateMockupImageSource();
        state.layers.forEach(updateLayerPosition);
        updateShirtColor();
        updatePricingUI();
        touchDesignerDraft();
    }

    function updateActiveProductBadge(product) {
        if (!activeProductBadge) return;
        const p = product || getSelectedProduct();
        const name = String(p?.name || state.productName || 'Product');
        const path = String(p?.mockupPath || state.productMockupPath || 'assets/tshirt_mockup.png').trim().replace(/^\/+/, '');
        const src = '/' + (path || 'assets/tshirt_mockup.png');
        activeProductBadge.innerHTML = `
            <img class="apb-thumb" src="${escapeHtml(src)}" alt="${escapeHtml(name)}" onerror="this.onerror=null;this.src='/assets/tshirt_mockup.png';">
            <div class="apb-copy">
                <span class="apb-label">Geselecteerd product</span>
                <strong class="apb-name">${escapeHtml(name)}</strong>
            </div>
        `;
    }

    function renderProductSelector() {
        if (!productSelector) return;
        const products = getCatalogProducts();
        const safePath = (raw) => {
            const p = String(raw || '').trim();
            return p ? '/' + p.replace(/^\/+/, '') : '/assets/tshirt_mockup.png';
        };
        productSelector.innerHTML = products.map((p) => {
            const priceMul = Number(p.priceMultiplier) || 1;
            const label = `${p.name}${priceMul !== 1 ? ` (x${priceMul.toFixed(2)})` : ''}`;
            return `<option value="${escapeHtml(String(p.id || ''))}">${escapeHtml(label)}</option>`;
        }).join('');
        if (productCards) {
            productCards.innerHTML = products.map((p) => {
                const id = escapeHtml(String(p.id || ''));
                const mul = Math.max(0.1, Number(p.priceMultiplier) || 1);
                const price = Math.max(0, Number(_cfg().pricing?.basePrice || 0) * mul);
                return `
                    <button class="product-card" type="button" data-product-id="${id}" role="radio" aria-checked="false" title="${escapeHtml(String(p.name || 'Product'))}">
                        <span class="pc-media"><img src="${escapeHtml(safePath(p.mockupPath))}" alt="${escapeHtml(String(p.name || 'Product'))}" onerror="this.onerror=null;this.src='/assets/tshirt_mockup.png';"></span>
                        <span class="pc-name">${escapeHtml(String(p.name || 'Product'))}</span>
                        <span class="pc-meta">${escapeHtml(fmtEUR(price))}${mul !== 1 ? ` · x${mul.toFixed(2)}` : ''}</span>
                    </button>
                `;
            }).join('');
            productCards.addEventListener('click', (e) => {
                const btn = e.target.closest('.product-card[data-product-id]');
                if (!btn) return;
                const chosen = products.find(p => String(p.id) === String(btn.dataset.productId)) || products[0];
                applySelectedProduct(chosen);
            });
        }

        const active = products.find(p => String(p.id) === String(state.productId))
            || products.find(p => p.isDefault)
            || products[0];
        applySelectedProduct(active, { skipMockupUpdate: true, preferWhite: true });
        productSelector.addEventListener('change', () => {
            const chosen = products.find(p => String(p.id) === String(productSelector.value)) || products[0];
            applySelectedProduct(chosen);
        });
    }

    // ── Cursor glow (optional, if element exists) ──
    if (cursorGlow) {
        let mx = 0, my = 0, gx = 0, gy = 0;
        document.addEventListener('mousemove', e => { mx = e.clientX; my = e.clientY; }, { passive: true });
        (function glowLoop() {
            gx += (mx - gx) * 0.06;
            gy += (my - gy) * 0.06;
            cursorGlow.style.left = gx + 'px';
            cursorGlow.style.top = gy + 'px';
            requestAnimationFrame(glowLoop);
        })();
    }

    // ── Particles (optional) ──
    if (particles) {
        const particleCount = (isMobileLayout || isCoarsePointer) ? 10 : 24;
        for (let i = 0; i < particleCount; i++) {
            const p = document.createElement('div');
            p.classList.add('particle');
            p.style.left = Math.random() * 100 + '%';
            p.style.animationDuration = (Math.random() * 18 + 12) + 's';
            p.style.animationDelay = (Math.random() * 12) + 's';
            const s = Math.random() * 2.5 + 1;
            p.style.width = s + 'px';
            p.style.height = s + 'px';
            const colors = ['rgba(255,255,255,.10)', 'rgba(255,255,255,.06)', 'rgba(255,255,255,.14)'];
            p.style.background = colors[Math.floor(Math.random() * colors.length)];
            particles.appendChild(p);
        }
    }

    // ── File Upload ──
    uploadZone?.addEventListener('click', () => fileInput.click());
    uploadZone?.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('dragover'); });
    uploadZone?.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
    uploadZone?.addEventListener('drop', e => {
        e.preventDefault();
        uploadZone.classList.remove('dragover');
        if (e.dataTransfer.files?.length) handleFiles(Array.from(e.dataTransfer.files));
    });
    fileInput?.addEventListener('change', () => {
        if (fileInput.files?.length) handleFiles(Array.from(fileInput.files));
        // allow re-selecting the same file again
        fileInput.value = '';
    });
    btnAddMoreFiles?.addEventListener('click', () => fileInput?.click());
    renderStep2LayerList();

    let isProcessingFiles = false;
    async function handleFiles(files) {
        if (isProcessingFiles) return showToast('Upload bezig, even wachten...');
        const valid = files.filter(f => f && f.type && f.type.startsWith('image/'));
        if (!valid.length) return showToast('Alleen afbeeldingen toegestaan');

        const tooBig = valid.find(f => f.size > 10 * 1024 * 1024);
        if (tooBig) return showToast('Bestand te groot (max 10MB)');
        isProcessingFiles = true;
        try {
            for (const file of valid) {
                await addLayerFromFile(file);
            }
        } finally {
            isProcessingFiles = false;
        }
    }

    function formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }


    // ── Layered mockup renderer (multiple uploads) ──
    function uid() {
        return 'l' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(2, 6);
    }

    function loadDesignImage(dataUrl) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = dataUrl;
        });
    }

    async function addLayerFromFile(file) {
            const objectUrl = URL.createObjectURL(file);
            let img;
            try {
                img = await loadDesignImage(objectUrl);
            } catch {
                URL.revokeObjectURL(objectUrl);
                showToast('Kon afbeelding niet laden');
                return;
            }

            const missingActive = getActiveLayer();
            if (missingActive?.needsFile) {
                missingActive.file = file;
                missingActive.dataUrl = '';
                missingActive.img = img;
                missingActive.bytes = file.size;
                missingActive.name = file.name || missingActive.name;
                missingActive.needsFile = false;

                if (!missingActive.canvas) {
                    const canvas = document.createElement('canvas');
                    canvas.className = 'design-canvas';
                    canvas.setAttribute('aria-label', `Design preview: ${missingActive.name}`);
                    canvas.dataset.layerId = missingActive.id;
                    missingActive.canvas = canvas;
                    layerStack?.appendChild(canvas);
                }

                renderLayer(missingActive);
                uploadList?.querySelector(`.upload-item[data-layer-id="${missingActive.id}"]`)?.remove();
                addLayerListItem(missingActive);
                setActiveLayer(missingActive.id);
                updatePricingUI();
                touchDesignerDraft();
                showToast('Design opnieuw gekoppeld');
                URL.revokeObjectURL(objectUrl);
                return;
            }

            const id = uid();

            const layer = {
                id,
                name: file.name,
                bytes: file.size,
                file,
                dataUrl: '',
                img,
                needsFile: false,
                position: 'center',
                scale: 100,
                vOffset: 0,
                xOffset: 0,
                note: ''
            };

            // Create canvas element for this layer
            const canvas = document.createElement('canvas');
            canvas.className = 'design-canvas';
            canvas.setAttribute('aria-label', `Design preview: ${layer.name}`);
            canvas.dataset.layerId = id;
            layer.canvas = canvas;
            layerStack?.appendChild(canvas);

            state.layers.push(layer);
            if (designPlaceholder) designPlaceholder.style.display = 'none';
            if (uploadList) uploadList.hidden = false;

            renderLayer(layer);
            addLayerListItem(layer);
            setActiveLayer(id);

            updatePricingUI();

            // Enable next
            btnNext.disabled = state.layers.length === 0;
            btnNextText.textContent = state.layers.length ? 'Ga verder' : 'Upload eerst je design';
            touchDesignerDraft();
            showToast('Design toegevoegd!');
            URL.revokeObjectURL(objectUrl);
    }

    // ── Pricing (config-driven) ──
    function _cfg() { return window.NEB_CONFIG || {}; }
    function _conv() { return _cfg().conversion || {}; }
    function ctaVariant() {
        return String(_conv().ctaVariant || 'SOFT').toUpperCase() === 'STRONG' ? 'STRONG' : 'SOFT';
    }
    function step2CtaLabel() {
        return String(_conv().designerStep2Cta || 'Naar overzicht').trim() || 'Naar overzicht';
    }
    function step3CtaLabel() {
        return 'Toevoegen naar winkelmand';
    }
    function applyConversionCards() {
        const conv = _conv();
        if (designerUrgencyCard) {
            const enabled = !!conv.urgencyEnabled;
            designerUrgencyCard.hidden = !enabled;
            if (enabled && designerUrgencyText) {
                designerUrgencyText.textContent = String(conv.urgencyText || 'Beperkte productiecapaciteit deze week.');
            }
        }
        if (designerSocialCard) {
            const enabled = conv.socialProofEnabled !== false;
            designerSocialCard.hidden = !enabled;
            if (enabled && designerSocialText) {
                designerSocialText.textContent = String(conv.socialProofText || 'Gemiddelde goedkeuring op werkdagen: binnen 2 uur.');
            }
        }
    }
    function calcExtraDesignFee() {
        // Per-product fee heeft voorrang; daarna globale fee × multiplier
        const fee = state.productExtraDesignFee != null
            ? state.productExtraDesignFee
            : Number(_cfg().pricing?.extraDesignFee ?? 5) * Math.max(0, Number(state.productExtraFeeMultiplier) || 1);
        const extraCount = Math.max(0, (state.layers?.length || 0) - 1);
        return extraCount * fee;
    }
    function calcSizeUpcharge() {
        // Per-product sizePrices heeft voorrang; daarna globale sizeUpcharge
        const color = String(state.color || '').toLowerCase();
        const sizeMap = state.productSizePrices || {};
        const size = String(state.size || '').toUpperCase();
        const sizeUp = sizeMap[size] != null ? sizeMap[size] : Number((_cfg().pricing?.sizeUpcharge || {})[state.size] || 0);
        // Kleur-opslag: colorPrices op product of colorData.priceUpcharge
        const colorMap = state.productColorPrices || {};
        const colorData = (state.productColorData || {})[color] || {};
        const colorUp = colorMap[color] != null ? colorMap[color] : (colorData.priceUpcharge || 0);
        return sizeUp + colorUp;
    }
    function calcBasePrice() {
        if (state.productBasePrice != null) return state.productBasePrice;
        const base = Number(_cfg().pricing?.basePrice ?? state.price);
        return base * Math.max(0.1, Number(state.productPriceMultiplier) || 1);
    }
    function calcUnitPrice() {
        return calcBasePrice() + calcSizeUpcharge() + calcExtraDesignFee();
    }

    function fmtEUR(n) {
        return '\u20AC' + n.toFixed(2).replace('.', ',');
    }

    function updatePricingUI() {
        const unit = calcUnitPrice();
        if (navBasePrice) navBasePrice.textContent = fmtEUR(unit);
        if (state.step === 3) updateOrderSummary();
    }

    function renderLayer(layer) {
        if (!layer?.canvas || !layer.img) return;

        const SIZE = 1024;
        const c = layer.canvas;
        if (c.width !== SIZE) {
            c.width = SIZE;
            c.height = SIZE;
        }
        const ctx = c.getContext('2d');
        if (!ctx) return;

        ctx.clearRect(0, 0, SIZE, SIZE);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.filter = 'none';
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        // Fit uploaded image into a padded box (contain)
        const pad = Math.round(SIZE * 0.10);
        const boxW = SIZE - pad * 2;
        const boxH = SIZE - pad * 2;

        const img = layer.img;
        const scale = Math.min(boxW / img.width, boxH / img.height);
        const dw = Math.round(img.width * scale);
        const dh = Math.round(img.height * scale);
        const dx = Math.round((SIZE - dw) / 2);
        const dy = Math.round((SIZE - dh) / 2);

        ctx.drawImage(img, dx, dy, dw, dh);
    }

    function addLayerListItem(layer) {
        if (!uploadList) return;

        const item = document.createElement('div');
        item.className = 'upload-item';
        item.dataset.layerId = layer.id;

        const thumbWrap = document.createElement('div');
        thumbWrap.className = 'preview-img-wrap';
        const imgEl = document.createElement('img');
        imgEl.src = layer.dataUrl || missingThumbDataUrl();
        imgEl.alt = layer.name;
        thumbWrap.appendChild(imgEl);

        const info = document.createElement('div');
        info.className = 'preview-info';
        const name = document.createElement('span');
        name.className = 'preview-name';
        name.textContent = layer.name;
        const size = document.createElement('span');
        size.className = 'preview-size';
        const w = layer.img?.naturalWidth || 0;
        const h = layer.img?.naturalHeight || 0;
        if (layer.needsFile) {
            size.textContent = 'Bestand ontbreekt na refresh · upload opnieuw';
            size.style.color = '#fbbf24';
        } else {
            size.textContent = `${formatSize(layer.bytes)} · ${w}×${h}`;
        }
        info.appendChild(name);
        info.appendChild(size);
        if (!layer.needsFile && w && (w < 800 || h < 800)) {
            const warn = document.createElement('span');
            warn.className = 'preview-size';
            warn.style.color = '#fcd34d';
            warn.textContent = '⚠ Lage resolutie — print kan pixelig zijn';
            info.appendChild(warn);
        }

        const rm = document.createElement('button');
        rm.className = 'remove-btn';
        rm.type = 'button';
        rm.title = 'Verwijder ontwerp';
        rm.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

        rm.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            removeLayer(layer.id);
        });

        item.addEventListener('click', () => setActiveLayer(layer.id));

        item.appendChild(thumbWrap);
        item.appendChild(info);
        item.appendChild(rm);
        uploadList.appendChild(item);
        renderStep2LayerList();
    }

    function renderStep2LayerList() {
        if (!step2LayerList) return;
        if (!state.layers.length) {
            step2LayerList.innerHTML = '<span class="muted compact">Nog geen designs toegevoegd</span>';
            return;
        }
        step2LayerList.innerHTML = state.layers.map((layer) => {
            const active = layer.id === state.activeLayerId ? ' active' : '';
            const safeName = escapeHtml(String(layer.name || 'Design'));
            const thumbSrc = escapeHtml(String(layer.dataUrl || missingThumbDataUrl()));
            return `<button type="button" class="s2-layer-chip${active}" data-layer-id="${escapeHtml(layer.id)}" title="${safeName}">
                <img class="thumb" src="${thumbSrc}" alt="${safeName}">
                <span class="x" data-remove-layer="${escapeHtml(layer.id)}">×</span>
            </button>`;
        }).join('');
    }

    step2LayerList?.addEventListener('click', (e) => {
        const removeId = e.target?.dataset?.removeLayer;
        if (removeId) {
            e.preventDefault();
            e.stopPropagation();
            removeLayer(removeId);
            return;
        }
        const chip = e.target.closest?.('[data-layer-id]');
        if (!chip) return;
        setActiveLayer(String(chip.dataset.layerId || ''));
    });

    function setActiveLayer(id) {
        state.activeLayerId = id;
        updateActiveUI();
        touchDesignerDraft();
    }

    function getActiveLayer() {
        return state.layers.find(l => l.id === state.activeLayerId) || null;
    }

    // ── Per-item remarks (stored per uploaded design) ──
    remarksInput?.addEventListener('input', () => {
        const layer = getActiveLayer();
        if (!layer) return;
        layer.note = (remarksInput.value || '').slice(0, 2000);
        touchDesignerDraft();
    });

    function updateActiveDesignLabel() {
        const layer = getActiveLayer();
        if (!activeDesignLabel) return;
        const strong = activeDesignLabel.querySelector('strong');
        if (strong) strong.textContent = layer ? layer.name : '—';
    }

    function updateDragHint() {
        const dh = $('#designDragHint');
        if (!dh) return;
        const show = state.step === 2 && state.layers.length > 0;
        dh.classList.toggle('hidden', !show);
    }

    function updateActiveUI() {
        // Highlight list
        uploadList?.querySelectorAll('.upload-item')?.forEach(el => {
            el.classList.toggle('active', el.dataset.layerId === state.activeLayerId);
        });
        renderStep2LayerList();

        const layer = getActiveLayer();
        updateActiveDesignLabel();

        // Active canvas ring indicator
        layerStack?.querySelectorAll('.design-canvas').forEach(c => delete c.dataset.active);
        if (layer?.canvas) layer.canvas.dataset.active = 'true';

        // Sync sliders + buttons
        if (layer) {
            // Position buttons
            posBtns.forEach(b => b.classList.toggle('active', b.dataset.pos === layer.position));

            if (scaleRange) scaleRange.value = String(layer.scale);
            if (scaleVal) scaleVal.textContent = layer.scale + '%';

            if (vOffsetRange) vOffsetRange.value = String(layer.vOffset);
            if (vOffsetVal) vOffsetVal.textContent = layer.vOffset + 'px';

            if (xOffsetRange) xOffsetRange.value = String(layer.xOffset || 0);
            if (xOffsetVal) xOffsetVal.textContent = (layer.xOffset || 0) + 'px';

            updateLayerPosition(layer);
        }

        // Per-item remarks
        if (remarksInput) {
            if (layer) {
                remarksInput.disabled = false;
                remarksInput.value = layer.note || '';
            } else {
                remarksInput.disabled = true;
                remarksInput.value = '';
            }
        }

        // Next button
        btnNext.disabled = state.layers.length === 0;
        btnNextText.textContent = state.layers.length
            ? (state.step === 3 ? step3CtaLabel() : (state.step === 2 ? step2CtaLabel() : 'Ga verder'))
            : 'Upload eerst je design';

        updatePricingUI();
        updateDragHint();
        schedulePreviewModalRefresh();
    }

    function removeLayer(id) {
        const idx = state.layers.findIndex(l => l.id === id);
        if (idx === -1) return;
        const layer = state.layers[idx];

        // Remove canvas
        layer.canvas?.remove();

        // Remove list item
        uploadList?.querySelector(`.upload-item[data-layer-id="${id}"]`)?.remove();

        state.layers.splice(idx, 1);

        // Active fallback
        if (state.activeLayerId === id) {
            state.activeLayerId = state.layers[0]?.id || null;
        }

        if (state.layers.length === 0) {
            if (uploadList) uploadList.hidden = true;
            if (designPlaceholder) designPlaceholder.style.display = '';
        }

        updateActiveUI();
        updatePricingUI();
        touchDesignerDraft();
        showToast('Ontwerp verwijderd');
    }

    function restoreDesignerDraft() {
        let parsed = null;
        try {
            parsed = JSON.parse(sessionStorage.getItem(DESIGNER_DRAFT_KEY) || 'null');
        } catch {
            parsed = null;
        }
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.layers)) return false;

        restoringDraft = true;
        state.color = String(parsed.color || state.color);
        state.colorName = String(parsed.colorName || state.colorName);
        state.productId = String(parsed.productId || state.productId || 'tshirt');
        state.size = String(parsed.size || state.size);
        state.qty = Math.round(clamp(parsed.qty, 1, 99, state.qty));

        const layerDrafts = parsed.layers
            .map((l, idx) => sanitizeLayerDraft(l, idx))
            .filter(Boolean);

        if (!layerDrafts.length) {
            restoringDraft = false;
            return false;
        }

        state.layers = [];
        state.activeLayerId = null;
        if (uploadList) uploadList.innerHTML = '';
        layerStack?.querySelectorAll('.design-canvas').forEach(el => el.remove());

        layerDrafts.forEach(layer => {
            state.layers.push(layer);
            addLayerListItem(layer);
        });

        if (designPlaceholder) designPlaceholder.style.display = 'none';
        if (uploadList) uploadList.hidden = false;

        const wantedId = String(parsed.activeLayerId || '');
        const active = state.layers.find(l => l.id === wantedId) || state.layers[0];
        state.activeLayerId = active?.id || null;

        applyPreferredStartColor(true);
        qtyValue.textContent = String(state.qty);
        applySelectedProduct(getSelectedProduct(), { skipMockupUpdate: true });

        updateShirtColor();
        updateActiveUI();
        // Altijd terugkeren naar Step 1 — designs zijn niet herstelbaar na navigatie
        goToStep(1);
        restoringDraft = false;
        updatePricingUI();
        return true;
    }

    // ── Step Navigation ──
    const panels = [panelUpload, panelCustomize, panelOrder];
    const steps = $$('.step');

    function goToStep(n) {
        state.step = n;
        document.body.classList.toggle('designer-step-2', n === 2);
        panels.forEach((p, i) => p.classList.toggle('hidden', i !== n - 1));
        steps.forEach((s, i) => {
            s.classList.toggle('active', i === n - 1);
            s.classList.toggle('done', i < n - 1);
        });

        btnBack.classList.toggle('hidden', n === 1);

        if (n === 1) {
            btnNext.disabled = state.layers.length === 0;
            btnNextText.textContent = state.layers.length ? 'Ga verder' : 'Upload eerst je design';
        } else if (n === 2) {
            btnNext.disabled = false;
            btnNextText.textContent = step2CtaLabel();
        } else if (n === 3) {
            updateOrderSummary();
            btnNext.disabled = false;
            btnNextText.textContent = step3CtaLabel();
        }
        updateDragHint();
        touchDesignerDraft();
    }

    btnNext?.addEventListener('click', () => {
        if (state.step === 1 && state.layers.length) {
            goToStep(2);
        } else if (state.step === 2) {
            goToStep(3);
        } else if (state.step === 3) {
            placeOrder();
        }
    });

    btnBack?.addEventListener('click', () => {
        if (state.step > 1) goToStep(state.step - 1);
    });

    // ── Shirt shade selection (realistic tint overlay) ──
    const colorSwatches = $$('.color-swatch');
    const baseShadeFilters = {
        '#0b0b0b': 'brightness(0.88) contrast(1.08)',
        '#6b6b6b': 'brightness(0.97) contrast(1.02)',
        '#f2f2f2': 'brightness(1.0) contrast(1.0)',
        '#ffffff':  'brightness(1.0) contrast(1.0)'
    };

    function normalizeHex6(raw) {
        const m = /^#?([a-f\d]{6})$/i.exec(String(raw || '').trim());
        return m ? `#${m[1].toLowerCase()}` : '';
    }

    function getVisibleSwatches() {
        return Array.from(colorSwatches).filter(sw => !sw.hidden && !sw.disabled);
    }

    function getProductColorHexes(product) {
        const src = Array.isArray(product?.colorHexes) ? product.colorHexes : [];
        const out = new Set();
        src.forEach((hex) => {
            const normalized = normalizeHex6(hex);
            if (normalized) out.add(normalized);
        });
        return out;
    }

    function chooseFallbackSwatch(visibleSwatches) {
        const light = visibleSwatches.find(sw => isVeryLightHex(sw.dataset.color));
        return light || visibleSwatches[0] || null;
    }

    function applyProductColorScope(product, opts = {}) {
        if (!colorSwatches.length) return;
        const allowedHexes = getProductColorHexes(product);
        let visibleCount = 0;

        colorSwatches.forEach((sw) => {
            const hex = normalizeHex6(sw.dataset.color);
            const allowed = !allowedHexes.size || (hex && allowedHexes.has(hex));
            sw.hidden = !allowed;
            sw.disabled = !allowed;
            if (allowed) visibleCount += 1;
        });

        if (!visibleCount) {
            colorSwatches.forEach((sw) => {
                sw.hidden = false;
                sw.disabled = false;
            });
        }

        const visibleSwatches = getVisibleSwatches();
        let active = null;
        if (opts.preferWhite) {
            active = chooseFallbackSwatch(visibleSwatches);
        } else {
            const preferredHex = normalizeHex6(state.color);
            active = visibleSwatches.find(sw => normalizeHex6(sw.dataset.color) === preferredHex)
                || chooseFallbackSwatch(visibleSwatches);
        }

        colorSwatches.forEach((sw) => sw.classList.toggle('active', sw === active));
        if (active) {
            state.color = normalizeHex6(active.dataset.color) || '#f2f2f2';
            state.colorName = String(active.dataset.name || 'Wit');
            if (colorName) colorName.textContent = state.colorName;
        }
    }

    colorSwatches.forEach(sw => {
        const hex = String(sw.dataset.color || '').trim();
        const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        if (m) {
            const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
            const yiq = (r * 299 + g * 587 + b * 114) / 1000;
            if (yiq > 210) sw.classList.add('is-light-swatch');
        }
        sw.addEventListener('click', () => {
            if (sw.disabled || sw.hidden) return;
            colorSwatches.forEach(s => s.classList.remove('active'));
            sw.classList.add('active');
            state.color = normalizeHex6(sw.dataset.color) || '#f2f2f2';
            state.colorName = sw.dataset.name;
            if (colorName) colorName.textContent = state.colorName;
            updateShirtColor();
            touchDesignerDraft();
        });
    });

    function isVeryLightHex(hex) {
        const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || '').trim());
        if (!m) return false;
        const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
        const yiq = (r * 299 + g * 587 + b * 114) / 1000;
        return yiq > 210;
    }

    function applyPreferredStartColor(force = false) {
        const visibleSwatches = getVisibleSwatches();
        const preferred = visibleSwatches.find(sw => isVeryLightHex(sw.dataset.color)) || visibleSwatches[0];
        if (!preferred) return;
        if (!force && state.color) return;
        const chosenHex = normalizeHex6(preferred.dataset.color) || '#f2f2f2';
        state.color = chosenHex;
        state.colorName = String(preferred.dataset.name || 'Wit');
        if (colorName) colorName.textContent = state.colorName;
        colorSwatches.forEach(s => s.classList.toggle('active', s === preferred));
        updateShirtColor();
    }

    function computeShirtTintOpacity(colorHex, hsl) {
        if (!hsl) return 0;
        const key = String(colorHex || '').toLowerCase();
        const isAlmostWhite = hsl.l > 0.92 && hsl.s < 0.12;
        const isDark = hsl.l < 0.22;
        const saturationFactor = 0.22 + (hsl.s * 0.45);
        const darknessFactor = 1 - hsl.l;
        let opacity = 0.12 + (darknessFactor * 0.38) + (saturationFactor * 0.22);

        if (isAlmostWhite) opacity = 0.03;
        if (isDark) opacity = Math.min(0.76, opacity + 0.1);
        if (key === '#0b0b0b') opacity = 0.64;
        if (key === '#6b6b6b') opacity = 0.34;
        if (key === '#f2f2f2' || key === '#ffffff') opacity = 0;
        return Math.max(0, Math.min(0.8, opacity));
    }

    function updateShirtColor() {
        const colorHex = String(state.color || '').toLowerCase();
        const rgb = hexToRgb(colorHex);
        const hsl = rgb ? rgbToHsl(rgb.r, rgb.g, rgb.b) : null;
        const baseFilter = baseShadeFilters[colorHex] || 'brightness(1) contrast(1)';

        if (mockupBase) {
            // Kleurspecifieke mockup: als het product een eigen afbeelding heeft voor deze kleur, gebruik die
            const colorMockupPath = (state.productColorData || {})[colorHex]?.mockupPath;
            const activeMockup = colorMockupPath ? `/${colorMockupPath}` : `/${state.productMockupPath || 'assets/tshirt_mockup.png'}`;
            if (mockupBase.getAttribute('data-current-src') !== activeMockup) {
                mockupBase.src = activeMockup;
                mockupBase.setAttribute('data-current-src', activeMockup);
            }

            const isWhiteTone = colorHex === '#f2f2f2' || colorHex === '#ffffff';
            const shadow = isWhiteTone
                ? 'drop-shadow(0 14px 34px rgba(0,0,0,.20))'
                : 'drop-shadow(0 20px 50px rgba(0,0,0,.45))';
            // Als kleurspecifieke mockup: geen kleurfilter nodig (afbeelding is al de juiste kleur)
            const filterStr = colorMockupPath ? shadow : `${shadow} ${baseFilter}`;
            mockupBase.style.filter = filterStr;
        }

        if (!shirtTintOverlay) return;
        // Geen tint overlay bij kleurspecifieke mockup
        const hasColorMockup = !!(state.productColorData || {})[colorHex]?.mockupPath;
        if (hasColorMockup || !rgb || !hsl) {
            shirtTintOverlay.style.opacity = '0';
            schedulePreviewModalRefresh();
            return;
        }
        syncShirtTintMask();
        shirtTintOverlay.style.backgroundColor = colorHex;
        shirtTintOverlay.style.opacity = String(computeShirtTintOpacity(colorHex, hsl));
        updatePricingUI();
        schedulePreviewModalRefresh();
    }
    function hexToRgb(hex) {
        const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
        return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null;
    }
    function rgbToHsl(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        let h = 0, s = 0, l = (mx + mn) / 2;
        if (mx !== mn) {
            const d = mx - mn;
            s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
            switch (mx) {
                case r: h = (g - b) / d + (g < b ? 6 : 0); break;
                case g: h = (b - r) / d + 2; break;
                case b: h = (r - g) / d + 4; break;
            }
            h *= 60;
        }
        return { h, s, l };
    }
    syncShirtTintMask();
    updateShirtColor();

    // ── Position (incl. borst links/rechts) ──
    const posBtns = $$('.pos-btn');

    // positions are percentages relative to the mockup container
    const positionMap = {
        // Percentages relative to mockup container.
        // 'top' moved slightly down for a more realistic chest placement.
        top:       { left: 50, top: 31, w: 22 },
        center:    { left: 50, top: 44, w: 28 },
        bottom:    { left: 50, top: 60, w: 24 },
        full:      { left: 50, top: 46, w: 44 },

        // Refined chest placements (a bit closer to the sleeve seams + slightly lower)
        leftchest: { left: 41.5, top: 35, w: 13.5 },
        rightchest:{ left: 58.5, top: 35, w: 13.5 }
    };

    posBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const layer = getActiveLayer();
            if (!layer) return showToast('Upload eerst je design');
            layer.position = btn.dataset.pos;
            updateLayerPosition(layer);
            updateActiveUI();
            touchDesignerDraft();
        });
    });

    function updateLayerPosition(layer) {
        const layout = getLayerLayout(layer, 1);

        // Position this layer canvas
        if (layer.canvas) {
            layer.canvas.style.left = layout.leftPct + '%';
            layer.canvas.style.top = layout.topPct + '%';
            layer.canvas.style.width = layout.widthPct + '%';
            layer.canvas.style.height = 'auto';
            layer.canvas.style.transform = layout.transform;
        }

        // Placeholder follows the active layer mapping
        if (designPlaceholder && state.layers.length === 0) {
            designPlaceholder.style.left = layout.leftPct + '%';
            designPlaceholder.style.top = layout.topPct + '%';
            designPlaceholder.style.width = layout.widthPct + '%';
            designPlaceholder.style.transform = layout.transform;
        }
        schedulePreviewModalRefresh();
    }
    function normalizeOffsetScale(offsetScale = 1) {
        if (offsetScale && typeof offsetScale === 'object') {
            return {
                x: Number(offsetScale.x) || 1,
                y: Number(offsetScale.y) || 1
            };
        }
        const scalar = Number(offsetScale) || 1;
        return { x: scalar, y: scalar };
    }

    function getLayerLayout(layer, offsetScale = 1) {
        const pos = positionMap[layer.position] || positionMap.center;
        const scaleFactor = (layer.scale || 100) / 100;
        const adj = getSizeAdj();
        const topPct = pos.top + (adj.top || 0);
        const widthPct = Math.max(8, (pos.w + (adj.w || 0)) * scaleFactor);
        const scale = normalizeOffsetScale(offsetScale);
        const xPx = Math.round((layer.xOffset || 0) * scale.x);
        const yPx = Math.round((layer.vOffset || 0) * scale.y);
        const transform = `translate(-50%,-50%) translateX(${xPx}px) translateY(${yPx}px)`;
        return { leftPct: pos.left, topPct, widthPct, xPx, yPx, transform };
    }

    function getLiveLayerMetrics(layer) {
        const sourceRect = tshirt3d?.getBoundingClientRect();
        const layerRect = layer?.canvas?.getBoundingClientRect();
        if (!sourceRect || !layerRect || !sourceRect.width || !sourceRect.height) return null;
        return {
            left: layerRect.left - sourceRect.left,
            top: layerRect.top - sourceRect.top,
            width: layerRect.width,
            height: layerRect.height,
            sourceWidth: sourceRect.width,
            sourceHeight: sourceRect.height
        };
    }

    // ── Vertical fine-tuning ──
    vOffsetRange?.addEventListener('input', () => {
        const layer = getActiveLayer();
        if (!layer) return;
        layer.vOffset = parseInt(vOffsetRange.value, 10) || 0;
        if (vOffsetVal) vOffsetVal.textContent = layer.vOffset + 'px';
        updateLayerPosition(layer);
        touchDesignerDraft();
    });

    // ── Horizontal fine-tuning ──
    xOffsetRange?.addEventListener('input', () => {
        const layer = getActiveLayer();
        if (!layer) return;
        layer.xOffset = parseInt(xOffsetRange.value, 10) || 0;
        if (xOffsetVal) xOffsetVal.textContent = layer.xOffset + 'px';
        updateLayerPosition(layer);
        touchDesignerDraft();
    });

    // ── Scale ──
    scaleRange?.addEventListener('input', () => {
        const layer = getActiveLayer();
        if (!layer) return;
        layer.scale = parseInt(scaleRange.value, 10);
        scaleVal.textContent = layer.scale + '%';
        updateLayerPosition(layer);
        renderLayer(layer);
        touchDesignerDraft();
    });

    // ── Reset active design ──
    btnResetActive?.addEventListener('click', () => {
        const layer = getActiveLayer();
        if (!layer) return;
        layer.scale = 100;
        layer.vOffset = 0;
        layer.xOffset = 0;
        if (scaleRange) scaleRange.value = '100';
        if (scaleVal) scaleVal.textContent = '100%';
        if (vOffsetRange) vOffsetRange.value = '0';
        if (vOffsetVal) vOffsetVal.textContent = '0px';
        if (xOffsetRange) xOffsetRange.value = '0';
        if (xOffsetVal) xOffsetVal.textContent = '0px';
        updateLayerPosition(layer);
        renderLayer(layer);
        touchDesignerDraft();
        showToast('Actief ontwerp gereset');
    });

    // ── Size ──
    sizeSelector?.addEventListener('click', (e) => {
        const btn = e.target.closest('.size-btn[data-size]');
        if (!btn) return;
        sizeSelector.querySelectorAll('.size-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.size = normalizeSizeCode(btn.dataset.size);
        renderSizeMeta(getSelectedProduct());
        // Reposition all layers based on size adjustments
        state.layers.forEach(updateLayerPosition);
        updatePricingUI();
        touchDesignerDraft();
    });

    // ── Quantity ──
    $('#qtyMinus')?.addEventListener('click', () => {
        if (state.qty > 1) {
            state.qty--;
            qtyValue.textContent = state.qty;
            if (state.step === 3) updateOrderSummary();
            touchDesignerDraft();
        }
    });
    $('#qtyPlus')?.addEventListener('click', () => {
        if (state.qty < 99) {
            state.qty++;
            qtyValue.textContent = state.qty;
            if (state.step === 3) updateOrderSummary();
            touchDesignerDraft();
        }
    });

    // ── Order Summary ──
    function updateOrderSummary() {
        $('#orderColor').textContent = state.colorName;
        const orderProduct = $('#orderProduct');
        if (orderProduct) orderProduct.textContent = state.productName;
        $('#orderSize').textContent = state.size;
        $('#orderQty').textContent = state.qty;

        const extraFee = calcExtraDesignFee();
        const unit = calcUnitPrice();
        const subtotal = unit * state.qty;

        const extrasRow = $('#orderExtrasRow');
        const extrasEl = $('#orderExtras');
        if (extrasRow && extrasEl) {
            if (extraFee > 0) {
                extrasRow.style.display = '';
                extrasEl.textContent = fmtEUR(extraFee);
            } else {
                extrasRow.style.display = 'none';
                extrasEl.textContent = fmtEUR(0);
            }
        }

        $('#orderSubtotal').textContent = fmtEUR(subtotal);
        $('#orderTotal').textContent = fmtEUR(subtotal);
        schedulePreviewModalRefresh();
    }

    function isProductPreviewOpen() {
        return !!productPreviewOverlay?.classList.contains('show');
    }

    function schedulePreviewModalRefresh() {
        if (!isProductPreviewOpen()) return;
        if (previewRefreshRaf) return;
        previewRefreshRaf = window.requestAnimationFrame(() => {
            previewRefreshRaf = 0;
            refreshPreviewModal();
        });
    }

    function refreshPreviewMeta() {
        if (!productPreviewMeta) return;
        const chips = [
            `<span><strong>Product</strong>${escapeHtml(state.productName || 'Product')}</span>`,
            `<span><strong>Kleur</strong>${escapeHtml(state.colorName || 'Wit')}</span>`,
            `<span><strong>Maat</strong>${escapeHtml(state.size || 'M')}</span>`,
            `<span><strong>Aantal</strong>${escapeHtml(String(state.qty || 1))}</span>`
        ];
        productPreviewMeta.innerHTML = chips.join('');
    }

    function refreshPreviewLayers() {
        if (!productPreviewLayerStack) return;
        productPreviewLayerStack.innerHTML = '';

        const hasLayers = Array.isArray(state.layers) && state.layers.length > 0;
        if (productPreviewPlaceholder) {
            productPreviewPlaceholder.style.display = hasLayers ? 'none' : '';
        }
        if (!hasLayers) return;

        state.layers.forEach((layer) => {
            if (!layer?.canvas) return;
            const source = layer.canvas;
            const clone = document.createElement('canvas');
            clone.className = 'design-canvas preview-modal-layer';
            clone.width = source.width || 1024;
            clone.height = source.height || 1024;
            const ctx = clone.getContext('2d');
            if (ctx) ctx.drawImage(source, 0, 0);
            clone.style.left = source.style.left || '50%';
            clone.style.top = source.style.top || '44%';
            clone.style.width = source.style.width || '28%';
            clone.style.height = source.style.height || 'auto';
            clone.style.transform = source.style.transform || 'translate(-50%,-50%)';
            if (layer.id === state.activeLayerId) clone.dataset.active = 'true';
            productPreviewLayerStack.appendChild(clone);
        });
    }

    function refreshPreviewModal() {
        if (!productPreviewModal || !isProductPreviewOpen()) return;
        refreshPreviewMeta();

        if (productPreviewMockupBase && mockupBase) {
            productPreviewMockupBase.src = mockupBase.currentSrc || mockupBase.src;
            productPreviewMockupBase.style.filter = mockupBase.style.filter || '';
        }
        if (productPreviewTint && shirtTintOverlay) {
            productPreviewTint.style.backgroundColor = shirtTintOverlay.style.backgroundColor || '';
            productPreviewTint.style.opacity = shirtTintOverlay.style.opacity || '0';
            const maskUrl = shirtTintOverlay.style.getPropertyValue('--mockup-mask-url');
            if (maskUrl) productPreviewTint.style.setProperty('--mockup-mask-url', maskUrl);
        }
        if (productPreviewTshirt && tshirt3d) {
            const sourceRect = tshirt3d.getBoundingClientRect();
            const targetRect = productPreviewCanvas?.getBoundingClientRect();
            const fitScale = (sourceRect.width && sourceRect.height && targetRect?.width && targetRect?.height)
                ? Math.min((targetRect.width * 0.82) / sourceRect.width, (targetRect.height * 0.82) / sourceRect.height)
                : 1;
            const baseTransform = tshirt3d.style.transform && tshirt3d.style.transform !== 'none'
                ? tshirt3d.style.transform
                : 'perspective(1000px) rotateX(0deg) rotateY(0deg)';
            productPreviewTshirt.style.width = Math.round(sourceRect.width) + 'px';
            productPreviewTshirt.style.height = Math.round(sourceRect.height) + 'px';
            productPreviewTshirt.style.transform = `${baseTransform} scale(${Number.isFinite(fitScale) ? fitScale : 1})`;
            productPreviewTshirt.style.transformOrigin = 'center center';
        }
        refreshPreviewLayers();
    }

    function updatePreviewFullscreenButton() {
        if (!btnPreviewFullscreen || !productPreviewModal) return;
        const isFullscreen = !!document.fullscreenElement && (document.fullscreenElement === productPreviewModal || productPreviewModal.contains(document.fullscreenElement));
        btnPreviewFullscreen.textContent = isFullscreen ? 'Verlaat fullscreen' : 'Volledig scherm';
    }

    function openProductPreviewModal() {
        if (!productPreviewOverlay) return;
        productPreviewOverlay.classList.add('show');
        productPreviewOverlay.setAttribute('aria-hidden', 'false');
        document.body.classList.add('has-preview-modal');
        refreshPreviewModal();
        updatePreviewFullscreenButton();
    }

    async function closeProductPreviewModal() {
        if (!productPreviewOverlay) return;
        if (document.fullscreenElement && productPreviewModal && (document.fullscreenElement === productPreviewModal || productPreviewModal.contains(document.fullscreenElement))) {
            try { await document.exitFullscreen(); } catch {}
        }
        productPreviewOverlay.classList.remove('show');
        productPreviewOverlay.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('has-preview-modal');
        if (previewRefreshRaf) {
            cancelAnimationFrame(previewRefreshRaf);
            previewRefreshRaf = 0;
        }
    }

    async function togglePreviewFullscreen() {
        if (!productPreviewModal) return;
        const canFullscreen = !!document.fullscreenEnabled && typeof productPreviewModal.requestFullscreen === 'function';
        if (!canFullscreen) {
            showToast('Fullscreen is niet beschikbaar op dit toestel');
            return;
        }
        const isFullscreen = !!document.fullscreenElement && (document.fullscreenElement === productPreviewModal || productPreviewModal.contains(document.fullscreenElement));
        try {
            if (isFullscreen) {
                await document.exitFullscreen();
            } else {
                await productPreviewModal.requestFullscreen();
            }
        } catch {
            showToast('Fullscreen kon niet gestart worden');
        }
    }

    // ── Place Order ──
    
    // ── PDF export (client-side) ──
    async function renderCompositeDataUrl() {
        // Render the current mockup + all placed layers to a single PNG (dataURL).
        if (!mockupBase) throw new Error('Mockup ontbreekt');
        const baseW = mockupBase.naturalWidth || 1200;
        const baseH = mockupBase.naturalHeight || 1200;

        const out = document.createElement('canvas');
        out.width = baseW;
        out.height = baseH;
        const ctx = out.getContext('2d');

        // Draw base mockup with realistic tinting (same as live preview)
        const colorHex = String(state.color || '').toLowerCase();
        const baseFilter = baseShadeFilters[colorHex] || 'brightness(1) contrast(1)';
        const rgb = hexToRgb(colorHex);
        const hsl = rgb ? rgbToHsl(rgb.r, rgb.g, rgb.b) : null;
        ctx.save();
        ctx.filter = baseFilter;
        ctx.drawImage(mockupBase, 0, 0, baseW, baseH);
        ctx.restore();

        const tintOpacity = computeShirtTintOpacity(colorHex, hsl);
        if (tintOpacity > 0 && rgb) {
            const tintCanvas = document.createElement('canvas');
            tintCanvas.width = baseW;
            tintCanvas.height = baseH;
            const tintCtx = tintCanvas.getContext('2d');
            if (tintCtx) {
                tintCtx.drawImage(mockupBase, 0, 0, baseW, baseH);
                tintCtx.globalCompositeOperation = 'source-in';
                tintCtx.fillStyle = colorHex;
                tintCtx.fillRect(0, 0, baseW, baseH);
                ctx.save();
                ctx.globalCompositeOperation = 'multiply';
                ctx.globalAlpha = tintOpacity;
                ctx.drawImage(tintCanvas, 0, 0, baseW, baseH);
                ctx.restore();
            }
        }

        // Convert UI px offsets to natural image px offsets
        const rect = tshirt3d?.getBoundingClientRect();
        const scalePx = rect && rect.width && rect.height
            ? { x: baseW / rect.width, y: baseH / rect.height }
            : 1;

        // Draw each design layer in the same order as the live preview
        for (const layer of (state.layers || [])) {
            // Use the already-rendered layer canvas (1024x1024)
            if (layer.canvas) {
                const liveMetrics = getLiveLayerMetrics(layer);
                if (liveMetrics) {
                    ctx.drawImage(
                        layer.canvas,
                        liveMetrics.left * scalePx.x,
                        liveMetrics.top * scalePx.y,
                        liveMetrics.width * scalePx.x,
                        liveMetrics.height * scalePx.y
                    );
                    continue;
                }
                const layout = getLayerLayout(layer, scalePx);
                const w = baseW * (layout.widthPct / 100);
                const sourceWidth = layer.canvas.width || 1;
                const sourceHeight = layer.canvas.height || sourceWidth;
                const h = w * (sourceHeight / Math.max(1, sourceWidth));
                const cx = baseW * (layout.leftPct / 100);
                const cy = baseH * (layout.topPct / 100);
                const x = (cx - w / 2) + layout.xPx;
                const y = (cy - h / 2) + layout.yPx;
                ctx.drawImage(layer.canvas, x, y, w, h);
            } else if (layer.img) {
                const layout = getLayerLayout(layer, scalePx);
                const w = baseW * (layout.widthPct / 100);
                const sourceWidth = layer.img.naturalWidth || layer.img.width || 1;
                const sourceHeight = layer.img.naturalHeight || layer.img.height || sourceWidth;
                const h = w * (sourceHeight / Math.max(1, sourceWidth));
                const cx = baseW * (layout.leftPct / 100);
                const cy = baseH * (layout.topPct / 100);
                const x = (cx - w / 2) + layout.xPx;
                const y = (cy - h / 2) + layout.yPx;
                ctx.drawImage(layer.img, x, y, w, h);
            }
        }

        return out.toDataURL('image/png', 1.0);
    }

    function buildOrderPayload() {
        return {
            createdAt: new Date().toISOString(),
            customer: {
                firstName: ($('#firstName')?.value || '').trim(),
                lastName: ($('#lastName')?.value || '').trim(),
                email: ($('#email')?.value || '').trim(),
                address: ($('#address')?.value || '').trim(),
                postcode: ($('#postcode')?.value || '').trim(),
                city: ($('#city')?.value || '').trim()
            },
            product: {
                productType: state.productId,
                productName: state.productName,
                color: state.colorName,
                size: state.size,
                qty: state.qty,
                unitPrice: calcUnitPrice(),
                extras: calcExtraDesignFee(),
                total: calcUnitPrice() * state.qty
            },
            designs: (state.layers || []).map(l => ({
                id: l.id,
                name: l.name,
                bytes: l.bytes,
                position: l.position,
                scale: l.scale,
                vOffset: l.vOffset,
                xOffset: l.xOffset || 0,
                note: l.note || '',
                dataUrl: l.dataUrl
            }))
        };
    }

    async function generateOrderPdfBlob(payload) {
        const jspdf = window.jspdf;
        if (!jspdf?.jsPDF) throw new Error('jsPDF niet geladen');
        const { jsPDF } = jspdf;

        const doc = new jsPDF({ unit: 'pt', format: 'a4' });

        const margin = 40;
        let y = 52;

        // Header
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(18);
        doc.text('Bestellingsoverzicht', margin, y);
        y += 18;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        doc.text(`Aangemaakt: ${new Date(payload.createdAt).toLocaleString()}`, margin, y);
        y += 18;

        // Customer block
        doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
        doc.text('Klantgegevens', margin, y); y += 14;
        doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
        const c = payload.customer;
        const custLines = [
            `${c.firstName} ${c.lastName}`.trim(),
            c.email,
            `${c.address}`.trim(),
            `${c.postcode} ${c.city}`.trim()
        ].filter(Boolean);
        custLines.forEach(line => { doc.text(line, margin, y); y += 14; });
        y += 10;

        // Product block
        doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
        doc.text('Product', margin, y); y += 14;
        doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
        const p = payload.product;
        const prodLines = [
            `Type: ${p.productName || 'Product'}`,
            `Kleur: ${p.color}`,
            `Maat: ${p.size}`,
            `Aantal: ${p.qty}`,
            `Prijs/stuk: ${fmtEUR(p.unitPrice)}`,
            p.extras ? `Extra designs: ${fmtEUR(p.extras)}` : null,
            `Totaal: ${fmtEUR(p.total)}`
        ].filter(Boolean);
        prodLines.forEach(line => { doc.text(line, margin, y); y += 14; });
        y += 10;

        // Preview image
        const composite = await renderCompositeDataUrl();
        const pageW = doc.internal.pageSize.getWidth();
        const maxW = pageW - margin * 2;
        const imgW = Math.min(360, maxW);
        const imgH = imgW * 1.0;
        doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
        doc.text('Voorbeeld (exacte plaatsing)', margin, y); y += 10;
        doc.addImage(composite, 'PNG', margin, y, imgW, imgH);
        y += imgH + 18;

        // Designs list
        doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
        doc.text('Uploads', margin, y); y += 14;
        doc.setFont('helvetica', 'normal'); doc.setFontSize(10);

        payload.designs.forEach((d, i) => {
            const line = `${i + 1}. ${d.name} — positie: ${d.position}, grootte: ${d.scale}%`;
            doc.text(line, margin, y); y += 14;
            if (d.note) {
                const noteLines = doc.splitTextToSize(`Opmerking: ${d.note}`, pageW - margin * 2);
                noteLines.forEach(l => { doc.text(l, margin, y); y += 12; });
                y += 4;
            }
        });

        // Each upload on its own page with preview
        for (const d of payload.designs) {
            doc.addPage();
            let yy = 52;
            doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
            doc.text(d.name, margin, yy); yy += 18;

            doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
            doc.text(`Positie: ${d.position}`, margin, yy); yy += 14;
            doc.text(`Grootte: ${d.scale}%`, margin, yy); yy += 14;
            if (d.note) {
                const noteLines = doc.splitTextToSize(`Opmerking: ${d.note}`, pageW - margin * 2);
                noteLines.forEach(l => { doc.text(l, margin, yy); yy += 12; });
                yy += 6;
            }

            const imgMaxW = pageW - margin * 2;
            const imgSize = Math.min(420, imgMaxW);
            if (d.dataUrl) {
                // PNG/JPG/SVG dataURL: jsPDF handles base64 images
                doc.addImage(d.dataUrl, 'PNG', margin, yy, imgSize, imgSize);
            }
        }

        return doc.output('blob');
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

async function placeOrder() {
        if (!window.NEB_USER) {
            showToast('Log eerst in om toe te voegen aan winkelmand');
            setTimeout(() => { location.href = '/login?next=' + encodeURIComponent('/'); }, 700);
            return;
        }
        if (!state.layers?.length) return showToast('Upload eerst je design');
        if (state.layers.some(l => !l.file || l.needsFile)) {
            showToast('Na refresh moet je je design-bestanden opnieuw uploaden');
            goToStep(1);
            return;
        }

        let previewDataUrl = null;
        try { previewDataUrl = await renderCompositeDataUrl(); } catch (e) { console.warn('preview render failed', e); }

        const product = {
            productType: state.productId,
            productName: state.productName,
            productMockupPath: state.productMockupPath,
            productPriceMultiplier: state.productPriceMultiplier,
            productExtraFeeMultiplier: state.productExtraFeeMultiplier,
            colorName: state.colorName, colorHex: state.color,
            size: state.size, qty: state.qty,
            unitPrice: calcUnitPrice(),
            extras: calcExtraDesignFee(),
            total: calcUnitPrice() * state.qty
        };
        const designs = (state.layers || []).map(l => ({
            id: l.id,
            name: l.name, position: l.position, scale: l.scale,
            vOffset: l.vOffset, xOffset: l.xOffset || 0,
            note: l.note || ''
        }));

        const formData = new FormData();
        formData.append('product', JSON.stringify(product));
        formData.append('designs', JSON.stringify(designs));
        formData.append('notes', ($('#remarksInput')?.value || '').trim());
        if (previewDataUrl) {
            const previewBlob = dataUrlToBlob(previewDataUrl);
            if (previewBlob) formData.append('preview', previewBlob, 'preview.png');
        }
        (state.layers || []).forEach((l, idx) => {
            if (l.file) {
                formData.append('designFileLayerIds', l.id);
                formData.append('designFiles', l.file, l.file.name || `design-${idx + 1}.png`);
            }
        });

        const btnNext = $('#btnNext');
        if (btnNext) { btnNext.disabled = true; const t = $('#btnNextText'); if (t) t.textContent = 'Toevoegen...'; }

        try {
            const res = await NEB.post('/api/cart', formData);
            const txt = document.getElementById('modalOrderText');
            if (txt) txt.innerHTML = `Item <strong>#${res.itemId}</strong> staat klaar in je winkelmand (${res.count} item${res.count === 1 ? '' : 's'}).`;
            await NEB.paintCart();
            NEB.bumpCart();
            clearDesignerDraft();
        } catch (err) {
            if (err.status === 401) {
                showToast('Sessie verlopen — opnieuw inloggen');
                setTimeout(() => { location.href = '/login?next=' + encodeURIComponent('/'); }, 700);
                return;
            }
            showToast(err.message || 'Toevoegen mislukt');
            if (btnNext) { btnNext.disabled = false; const t = $('#btnNextText'); if (t) t.textContent = step3CtaLabel(); }
            return;
        }
        if (btnNext) { btnNext.disabled = false; const t = $('#btnNextText'); if (t) t.textContent = step3CtaLabel(); }
        modalOverlay.classList.add('show');
    }

    function dataUrlToBlob(dataUrl) {
        const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
        if (!m) return null;
        const mime = m[1] || 'application/octet-stream';
        const binary = atob(m[2]);
        const len = binary.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
        return new Blob([bytes], { type: mime });
    }

    modalClose?.addEventListener('click', () => {
        modalOverlay.classList.remove('show');
        goToStep(1);
        // Reset uploads
        state.layers.slice().forEach(l => removeLayer(l.id));
        state.qty = 1;
        qtyValue.textContent = 1;
        if (downloadPdfBtn) {
            downloadPdfBtn.disabled = false;
            const span = downloadPdfBtn.querySelector('span');
            if (span) span.textContent = 'Download PDF';
        }
        clearDesignerDraft();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    modalOverlay?.addEventListener('click', (e) => {
        if (e.target === modalOverlay) modalClose.click();
    });
    btnPreviewProduct?.addEventListener('click', openProductPreviewModal);
    btnPreviewClose?.addEventListener('click', () => { closeProductPreviewModal(); });
    btnPreviewFullscreen?.addEventListener('click', () => { togglePreviewFullscreen(); });
    productPreviewOverlay?.addEventListener('click', (e) => {
        if (e.target === productPreviewOverlay) closeProductPreviewModal();
    });
    document.addEventListener('fullscreenchange', () => {
        updatePreviewFullscreenButton();
        schedulePreviewModalRefresh();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isProductPreviewOpen()) closeProductPreviewModal();
    });

    // ── Drag: design placement + 3D rotation ──
    let isDragging = false;        // 3D shirt rotation
    let isDesignDragging = false;  // logo/design placement drag
    let dragStartX = 0, dragStartY = 0;
    let rotX = 0, rotY = 0, curRotX = 0, curRotY = 0;
    let designDragStartV = 0, designDragStartX = 0;

    // Return the active design layer if the pointer is within its bounding box
    function getDesignAtPoint(clientX, clientY) {
        if (!state.layers.length) return null;
        const layer = getActiveLayer();
        if (!layer?.canvas) return null;
        const rect = layer.canvas.getBoundingClientRect();
        const pad = 22;
        if (clientX >= rect.left - pad && clientX <= rect.right + pad &&
            clientY >= rect.top - pad && clientY <= rect.bottom + pad) {
            return layer;
        }
        return null;
    }

    // Update cursor based on hover position (step 2 only)
    previewCanvas?.addEventListener('mousemove', (e) => {
        if (isDragging || isDesignDragging) return;
        if (state.step === 2 && state.layers.length) {
            const hit = getDesignAtPoint(e.clientX, e.clientY);
            previewCanvas.style.cursor = hit ? 'grab' : 'grab';
            previewCanvas.classList.toggle('can-drag-design', !!hit);
        } else {
            previewCanvas.classList.remove('can-drag-design');
        }
    }, { passive: true });

    previewCanvas?.addEventListener('mouseleave', () => {
        previewCanvas.classList.remove('can-drag-design');
    });

    previewCanvas?.addEventListener('mousedown', (e) => {
        // Design drag takes priority in step 2 when layers exist
        if (state.step === 2 && state.layers.length) {
            const layer = getDesignAtPoint(e.clientX, e.clientY);
            if (layer) {
                isDesignDragging = true;
                dragStartX = e.clientX;
                dragStartY = e.clientY;
                designDragStartV = layer.vOffset || 0;
                designDragStartX = layer.xOffset || 0;
                previewCanvas.style.cursor = 'grabbing';
                previewCanvas.classList.add('is-dragging-design');
                return;
            }
        }
        // Otherwise: 3D shirt rotation
        isDragging = true;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        tshirt3d.style.animation = 'none';
        canvasHint?.classList.add('hidden');
    });

    document.addEventListener('mousemove', (e) => {
        if (isDesignDragging) {
            const layer = getActiveLayer();
            if (!layer) return;
            const dx = e.clientX - dragStartX;
            const dy = e.clientY - dragStartY;
            layer.xOffset = Math.round(Math.max(-200, Math.min(200, designDragStartX + dx)));
            layer.vOffset = Math.round(Math.max(-200, Math.min(200, designDragStartV + dy)));
            if (xOffsetRange) xOffsetRange.value = String(Math.max(-100, Math.min(100, layer.xOffset)));
            if (xOffsetVal) xOffsetVal.textContent = layer.xOffset + 'px';
            if (vOffsetRange) vOffsetRange.value = String(Math.max(-100, Math.min(100, layer.vOffset)));
            if (vOffsetVal) vOffsetVal.textContent = layer.vOffset + 'px';
            updateLayerPosition(layer);
            return;
        }
        if (!isDragging) return;
        const dx = (e.clientX - dragStartX) * 0.25;
        const dy = (e.clientY - dragStartY) * 0.12;
        curRotY = rotY + dx;
        curRotX = Math.max(-12, Math.min(12, rotX - dy));
        tshirt3d.style.transform = `perspective(1000px) rotateX(${curRotX}deg) rotateY(${curRotY}deg)`;
    }, { passive: true });

    document.addEventListener('mouseup', () => {
        if (isDesignDragging) {
            isDesignDragging = false;
            previewCanvas.style.cursor = 'grab';
            previewCanvas.classList.remove('is-dragging-design');
            touchDesignerDraft();
            return;
        }
        if (isDragging) {
            isDragging = false;
            rotX = curRotX;
            rotY = curRotY;
        }
    });

    // Touch: design drag + 3D rotation
    previewCanvas?.addEventListener('touchstart', (e) => {
        const touch = e.touches[0];
        if (state.step === 2 && state.layers.length) {
            const layer = getDesignAtPoint(touch.clientX, touch.clientY);
            if (layer) {
                isDesignDragging = true;
                dragStartX = touch.clientX;
                dragStartY = touch.clientY;
                designDragStartV = layer.vOffset || 0;
                designDragStartX = layer.xOffset || 0;
                return;
            }
        }
        isDragging = true;
        dragStartX = touch.clientX;
        dragStartY = touch.clientY;
        tshirt3d.style.animation = 'none';
        canvasHint?.classList.add('hidden');
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
        if (isDesignDragging) {
            const touch = e.touches[0];
            const layer = getActiveLayer();
            if (!layer) return;
            const dx = touch.clientX - dragStartX;
            const dy = touch.clientY - dragStartY;
            layer.xOffset = Math.round(Math.max(-200, Math.min(200, designDragStartX + dx)));
            layer.vOffset = Math.round(Math.max(-200, Math.min(200, designDragStartV + dy)));
            if (xOffsetRange) xOffsetRange.value = String(Math.max(-100, Math.min(100, layer.xOffset)));
            if (xOffsetVal) xOffsetVal.textContent = layer.xOffset + 'px';
            if (vOffsetRange) vOffsetRange.value = String(Math.max(-100, Math.min(100, layer.vOffset)));
            if (vOffsetVal) vOffsetVal.textContent = layer.vOffset + 'px';
            updateLayerPosition(layer);
            return;
        }
        if (!isDragging) return;
        const touch = e.touches[0];
        const dx = (touch.clientX - dragStartX) * 0.25;
        const dy = (touch.clientY - dragStartY) * 0.12;
        curRotY = rotY + dx;
        curRotX = Math.max(-12, Math.min(12, rotX - dy));
        tshirt3d.style.transform = `perspective(1000px) rotateX(${curRotX}deg) rotateY(${curRotY}deg)`;
    }, { passive: true });

    document.addEventListener('touchend', () => {
        if (isDesignDragging) {
            isDesignDragging = false;
            touchDesignerDraft();
            return;
        }
        if (isDragging) {
            isDragging = false;
            rotX = curRotX;
            rotY = curRotY;
        }
    });

    // ── Toast ──
    let toastTimer;
    function showToast(msg) {
        toastMsg.textContent = msg;
        toast.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
    }

    // ── Scroll Reveal ──
    const revealEls = $$('.how-card, .feature-card, .review-card, .section-title, .section-eyebrow');
    const revealObs = new IntersectionObserver((entries) => {
        entries.forEach((entry, i) => {
            if (entry.isIntersecting) {
                setTimeout(() => entry.target.classList.add('reveal', 'visible'), i * 60);
                revealObs.unobserve(entry.target);
            }
        });
    }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });
    revealEls.forEach(el => { el.classList.add('reveal'); revealObs.observe(el); });

    // ── Active nav link on scroll ──
    const sections = $$('section[id]');
    const navLinks = $$('.nav-link');
    window.addEventListener('scroll', () => {
        const scrollY = window.scrollY + 100;
        sections.forEach(sec => {
            const top = sec.offsetTop;
            const height = sec.offsetHeight;
            const id = sec.getAttribute('id');
            if (scrollY >= top && scrollY < top + height) {
                navLinks.forEach(l => l.classList.remove('active'));
                const active = $(`.nav-link[href="#${id}"]`);
                if (active) active.classList.add('active');
            }
        });
    }, { passive: true });

    // ── Homepage product picker ──
    function renderHomepageProducts() {
        const container = $('#homepageProducts');
        if (!container) return;
        const products = getCatalogProducts();
        const cfg = _cfg();
        const globalBasePrice = Number(cfg.pricing?.basePrice || 34.95);
        const safePath = (raw) => {
            const p = String(raw || '').trim();
            return p ? '/' + p.replace(/^\/+/, '') : '/assets/tshirt_mockup.png';
        };
        container.innerHTML = products.map(p => {
            const mul = Math.max(0.1, Number(p.priceMultiplier) || 1);
            const fromPrice = p.basePrice != null ? p.basePrice : globalBasePrice * mul;
            const id = escapeHtml(String(p.id || ''));
            const desc = String(p.description || 'Premium kwaliteit bedrukking.').trim();
            return `<button class="hp-product-card reveal" data-product-id="${id}" type="button">
                <div class="hp-pc-media"><img src="${escapeHtml(safePath(p.mockupPath))}" alt="${escapeHtml(String(p.name || ''))}" onerror="this.onerror=null;this.src='/assets/tshirt_mockup.png';"></div>
                <div class="hp-pc-body">
                    <h3 class="hp-pc-name">${escapeHtml(String(p.name || 'Product'))}</h3>
                    <p class="hp-pc-desc">${escapeHtml(desc)}</p>
                    <div class="hp-pc-footer">
                        <span class="hp-pc-price">Vanaf ${fmtEUR(fromPrice)}</span>
                        <span class="hp-pc-cta">Ontwerp nu
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="5 12 19 12"/><polyline points="12 5 19 12 12 19"/></svg>
                        </span>
                    </div>
                </div>
            </button>`;
        }).join('');

        // Scroll reveal for new cards
        container.querySelectorAll('.reveal').forEach(el => {
            el.classList.add('reveal');
            revealObs?.observe(el);
        });

        container.addEventListener('click', (e) => {
            const card = e.target.closest('.hp-product-card[data-product-id]');
            if (!card) return;
            const productId = card.dataset.productId;
            const product = products.find(p => String(p.id) === productId) || products[0];
            applySelectedProduct(product);
            const designerEl = document.getElementById('designer');
            if (designerEl) {
                const navH = document.querySelector('.nav')?.offsetHeight || 72;
                const y = designerEl.getBoundingClientRect().top + window.scrollY - navH - 16;
                window.scrollTo({ top: y, behavior: 'smooth' });
            }
        });
    }

    // Wis draft bij navigeren weg van de pagina zodat gebruiker altijd op Step 1 start
    window.addEventListener('pagehide', () => clearDesignerDraft());

    // Initial position / draft restore
    renderHomepageProducts();
    applyConversionCards();
    applyPreferredStartColor(true);
    // Altijd starten op Step 1 — draft enkel herstellen voor product/kleur/maat, niet voor step
    if (!restoreDesignerDraft()) {
        applySelectedProduct(getSelectedProduct(), { preferWhite: true });
    }
    updatePricingUI();
}
