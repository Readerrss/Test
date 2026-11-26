(() => {
'use strict';

if (typeof CanvasRenderingContext2D !== 'undefined' && !CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function(x, y, w, h, r) {
        const rad = Math.min(Array.isArray(r) ? r[0] : (r || 0), Math.abs(w) * 0.5, Math.abs(h) * 0.5);
        this.moveTo(x + rad, y);
        this.arcTo(x + w, y, x + w, y + h, rad);
        this.arcTo(x + w, y + h, x, y + h, rad);
        this.arcTo(x, y + h, x, y, rad);
        this.arcTo(x, y, x + w, y, rad);
        this.closePath();
        return this;
    };
}

function colorWithAlpha(col, alpha) {
    const s = String(col || '#38bdf8').trim();
    const a = Math.max(0, Math.min(1, Number(alpha) || 0));
    if (s.startsWith('#')) {
        let hex = s.slice(1);
        if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
        if (hex.length >= 6) {
            const r = parseInt(hex.slice(0, 2), 16) || 0;
            const g = parseInt(hex.slice(2, 4), 16) || 0;
            const b = parseInt(hex.slice(4, 6), 16) || 0;
            return `rgba(${r},${g},${b},${a})`;
        }
    }
    if (s.startsWith('hsl(')) return s.replace(/^hsl\(/, 'hsla(').replace(/\)$/, `,${a})`);
    if (s.startsWith('hsla(')) return s.replace(/,[^,]+\)$/, `,${a})`);
    if (s.startsWith('rgb(')) return s.replace(/^rgb\(/, 'rgba(').replace(/\)$/, `,${a})`);
    if (s.startsWith('rgba(')) return s.replace(/,[^,]+\)$/, `,${a})`);
    return `rgba(56,189,248,${a})`;
}

// =========================================================================
// 1. DATABASE KEYS, FIREBASE 24/7 CONFIG & INDEXEDDB LOCAL ENGINE
// =========================================================================
// PASTE YOUR FIREBASE REALTIME DATABASE URL BELOW (e.g. "https://your-project-default-rtdb.firebaseio.com")
const FIREBASE_DB_URL = 'https://galaxy-racer-1a578-default-rtdb.asia-southeast1.firebasedatabase.app';

const FB_BASE_URL = FIREBASE_DB_URL ? FIREBASE_DB_URL.trim().replace(/\/+$/, '') + '/roadsense_v4' : '';

const STORAGE_ACCOUNTS_KEY   = 'roadsense_v4_accounts';
const STORAGE_ACTIVE_UID_KEY = 'roadsense_v4_active_uid';
const STORAGE_LAST_OUT_KEY   = 'roadsense_v4_last_logout_uid';
const STORAGE_SYNC_META_KEY  = 'roadsense_v4_sync_meta';
const STORAGE_V4_RESET_DONE  = 'roadsense_v4_clean_reset_done';
const STORAGE_GLOBAL_CFG_KEY = 'roadsense_v4_global_settings';
const STORAGE_SEASON_KEY     = 'roadsense_v4_season_state';
const STORAGE_LB_ALL_KEY     = 'roadsense_v4_lb_alltime';
const STORAGE_LB_SEASON_KEY  = 'roadsense_v4_lb_season';
const STORAGE_ALLTIME_CHAMP  = 'roadsense_v4_alltime_champ_uid';
const LOCAL_IDB_NAME         = 'RoadSenseLocalDB_v4';
const LOCAL_IDB_VERSION      = 2;

const CANONICAL_DEV_UID = '84729160538274195';
const DEFAULT_DEV_NAME  = 'Unknown';
const DEFAULT_DEV_TAG   = '0000';
const CLIENT_ID         = 'c_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now().toString(36);

const SEASON_ACTIVE_MS = 3 * 24 * 60 * 60 * 1000;
const SEASON_GAP_MS    = 1 * 24 * 60 * 60 * 1000;
const SEASON_CYCLE_MS  = SEASON_ACTIVE_MS + SEASON_GAP_MS;

function lsGet(k, fb = null) { try { const v = localStorage.getItem(k); return v === null ? fb : v; } catch (e) { return fb; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); idbMirrorSet(k, v); return true; } catch (e) { idbMirrorSet(k, v); return false; } }
function lsRemove(k) { try { localStorage.removeItem(k); idbMirrorDelete(k); } catch (e) {} }
function lsGetJson(k, fb) { try { const r = localStorage.getItem(k); if (!r) return fb; const p = JSON.parse(r); return p == null ? fb : p; } catch (e) { return fb; } }

// Unified IndexedDB Engine: Stores both Custom Audio Songs ('songs') AND Local Database Mirror ('kv')
let localIdbPromise = null;
function openLocalIDB() {
    if (!('indexedDB' in window)) return Promise.reject(new Error('IndexedDB unavailable'));
    if (localIdbPromise) return localIdbPromise;
    localIdbPromise = new Promise((res, rej) => {
        const req = indexedDB.open(LOCAL_IDB_NAME, LOCAL_IDB_VERSION);
        req.onupgradeneeded = e => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('songs')) db.createObjectStore('songs', { keyPath: 'uid' });
            if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
        };
        req.onsuccess = () => res(req.result);
        req.onerror = () => { localIdbPromise = null; rej(req.error); };
        req.onblocked = () => { localIdbPromise = null; rej(new Error('IDB blocked')); };
    });
    return localIdbPromise;
}

function idbMirrorSet(key, val) {
    openLocalIDB().then(db => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put({ key, val, ts: Date.now() });
    }).catch(() => {});
}

function idbMirrorDelete(key) {
    openLocalIDB().then(db => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').delete(key);
    }).catch(() => {});
}

async function restoreFromIndexedDBIfNeeded() {
    try {
        const db = await openLocalIDB();
        const allKv = await new Promise(res => {
            const req = db.transaction('kv', 'readonly').objectStore('kv').getAll();
            req.onsuccess = () => res(req.result || []);
            req.onerror = () => res([]);
        });
        let restored = false;
        allKv.forEach(item => {
            if (!item || !item.key || !item.val) return;
            const cur = lsGet(item.key, null);
            if (!cur || (item.key === STORAGE_ACCOUNTS_KEY && cur === '{}')) {
                try { localStorage.setItem(item.key, item.val); restored = true; } catch (e) {}
            }
        });
        if (restored) {
            const accs = lsGetJson(STORAGE_ACCOUNTS_KEY, null);
            if (accs && typeof accs === 'object') {
                Object.entries(accs).forEach(([u, a]) => {
                    const norm = normalizeAccountRecord(a, u);
                    if (norm && !accountsCache[u]) accountsCache[u] = norm;
                });
                validateAndSanitizeDatabase();
                refreshAllLiveViews();
            }
        }
    } catch (e) {}
}

(function purgeLegacyV3DataOnce() {
    if (lsGet(STORAGE_V4_RESET_DONE, '') === '1') return;
    ['roadsense_v3_accounts','roadsense_v3_dev_uid','roadsense_v3_active_uid','roadsense_v3_last_logout_uid','roadsense_v3_first_boot_done','roadsense_v3_global_settings','roadsense_v3_season_state','roadsense_v3_lb_alltime','roadsense_v3_lb_season','roadsense_v3_alltime_champ_uid'].forEach(lsRemove);
    try { if ('indexedDB' in window && indexedDB.deleteDatabase) indexedDB.deleteDatabase('RoadSenseCustomSongsDB_v3'); } catch (e) {}
    lsSet(STORAGE_V4_RESET_DONE, '1');
})();

// =========================================================================
// 2. ALL-IN-ONE CHROMA & FX SKIN DEFINITIONS
// =========================================================================
const SEASON_FX_SKINS = [
    { id: 'standard',     name: 'Standard Overdrive', desc: 'Custom colors with Mach shock-ring Nitro afterburner.', tier: 'permanent', allInOne: false, cardClass: '' },
    { id: 'void_chroma',  name: 'Void Prismatic FX',  desc: 'ALL-IN-ONE full-spectrum chroma chassis, rails, EMP & Hyper-Void Singularity afterburner.', tier: 'alltime1', allInOne: true, cardClass: 'skin-card-void' },
    { id: 'aether_helix', name: 'Aether Ribbon',      desc: 'ALL-IN-ONE cryo-aurora chroma body, rails, EMP & twin-helix plasma streams.', tier: 'top5', allInOne: true, cardClass: 'skin-card-aether' },
    { id: 'solar_crown',  name: 'Solar Crown',        desc: 'ALL-IN-ONE molten solar-gold chroma body, rails, EMP & Mach shock-diamond flare.', tier: 'top5', allInOne: true, cardClass: 'skin-card-solar' },
    { id: 'chrono_arc',   name: 'Chrono Arc',         desc: 'ALL-IN-ONE quantum-emerald chroma body, rails, EMP & chronometric ion warp rings.', tier: 'top5', allInOne: true, cardClass: 'skin-card-chrono' }
];
const SEASONAL_TOP5_SKIN_CYCLE = ['aether_helix', 'solar_crown', 'chrono_arc'];
function getSeasonFeaturedSkin(sNum) {
    const id = SEASONAL_TOP5_SKIN_CYCLE[(Math.max(1, sNum) - 1) % SEASONAL_TOP5_SKIN_CYCLE.length];
    return SEASON_FX_SKINS.find(s => s.id === id) || SEASON_FX_SKINS[2];
}

function getSkinChromaPalette(skinId, cust, now) {
    if (skinId === 'void_chroma') {
        const h1 = (now * 0.14) % 360, h2 = (h1 + 118) % 360, h3 = (h1 + 235) % 360;
        return {
            isAllInOne: true,
            primaryGlow: `hsl(${h1},100%,60%)`, secondaryGlow: `hsl(${h2},100%,64%)`, tertiaryGlow: `hsl(${h3},100%,68%)`,
            bodyTint: `hsla(${h1},95%,54%,0.44)`, bodyMidTint: `hsla(${h2},95%,48%,0.34)`,
            canopyTop: `hsl(${h2},96%,72%)`, canopyMid: `hsla(${h3},85%,24%,0.92)`,
            tailColor: `hsl(${h1},100%,62%)`, railColor: `hsl(${h1},100%,60%)`, railFill: `hsla(${h1},95%,58%,0.14)`,
            empPrimary: `hsl(${h1},100%,60%)`, empSecondary: `hsl(${h2},100%,66%)`, empFlash: `hsla(${h2},95%,58%,0.30)`,
            underglow: `hsla(${h1},100%,58%,0.46)`, radarDot: `hsl(${h1},100%,64%)`
        };
    }
    if (skinId === 'aether_helix') {
        const w = Math.sin(now * 0.0032), h1 = 186 + w * 34, h2 = 258 - w * 32;
        return {
            isAllInOne: true,
            primaryGlow: `hsl(${h1},98%,62%)`, secondaryGlow: `hsl(${h2},96%,70%)`, tertiaryGlow: '#e0f2fe',
            bodyTint: `hsla(${h1},90%,48%,0.40)`, bodyMidTint: `hsla(${h2},86%,44%,0.32)`,
            canopyTop: `hsl(${h1},100%,78%)`, canopyMid: `hsla(${h2},75%,22%,0.92)`,
            tailColor: `hsl(${h2},100%,68%)`, railColor: `hsl(${h1},98%,62%)`, railFill: `hsla(${h1},92%,56%,0.13)`,
            empPrimary: `hsl(${h1},100%,62%)`, empSecondary: `hsl(${h2},98%,72%)`, empFlash: `hsla(${h1},95%,60%,0.26)`,
            underglow: `hsla(${h1},95%,58%,0.42)`, radarDot: `hsl(${h1},100%,66%)`
        };
    }
    if (skinId === 'solar_crown') {
        const w = Math.sin(now * 0.0036), h1 = 38 + w * 18, h2 = 6 + (1 - w) * 14;
        return {
            isAllInOne: true,
            primaryGlow: `hsl(${h1},100%,58%)`, secondaryGlow: `hsl(${h2},100%,58%)`, tertiaryGlow: '#fef9c3',
            bodyTint: `hsla(${h1},96%,48%,0.42)`, bodyMidTint: `hsla(${h2},92%,40%,0.32)`,
            canopyTop: `hsl(${h1},100%,76%)`, canopyMid: `hsla(${h2},82%,20%,0.92)`,
            tailColor: `hsl(${h2},100%,56%)`, railColor: `hsl(${h1},100%,58%)`, railFill: `hsla(${h1},96%,54%,0.13)`,
            empPrimary: `hsl(${h1},100%,58%)`, empSecondary: `hsl(${h2},100%,60%)`, empFlash: `hsla(${h1},100%,56%,0.25)`,
            underglow: `hsla(${h1},100%,54%,0.42)`, radarDot: `hsl(${h1},100%,62%)`
        };
    }
    if (skinId === 'chrono_arc') {
        const w = Math.sin(now * 0.0038), h1 = 152 + w * 24, h2 = 172 - w * 26;
        return {
            isAllInOne: true,
            primaryGlow: `hsl(${h1},96%,54%)`, secondaryGlow: `hsl(${h2},100%,64%)`, tertiaryGlow: '#d1fae5',
            bodyTint: `hsla(${h1},92%,42%,0.40)`, bodyMidTint: `hsla(${h2},88%,38%,0.30)`,
            canopyTop: `hsl(${h2},100%,74%)`, canopyMid: `hsla(${h1},78%,16%,0.92)`,
            tailColor: `hsl(${h1},100%,56%)`, railColor: `hsl(${h1},96%,54%)`, railFill: `hsla(${h1},94%,50%,0.13)`,
            empPrimary: `hsl(${h1},98%,55%)`, empSecondary: `hsl(${h2},100%,68%)`, empFlash: `hsla(${h1},95%,52%,0.25)`,
            underglow: `hsla(${h1},95%,52%,0.42)`, radarDot: `hsl(${h1},100%,60%)`
        };
    }
    const sec = (cust && cust.bodySecondary) || '#38bdf8', emp = (cust && cust.empColor) || '#38bdf8', can = (cust && cust.canopyColor) || '#7dd3fc';
    return {
        isAllInOne: false,
        primaryGlow: sec, secondaryGlow: emp, tertiaryGlow: '#e0f2fe',
        bodyTint: colorWithAlpha(sec, 0.28), bodyMidTint: '#090d16',
        canopyTop: can, canopyMid: '#0f172a',
        tailColor: '#f43f5e', railColor: emp, railFill: colorWithAlpha(emp, 0.12),
        empPrimary: emp, empSecondary: '#e0f2fe', empFlash: emp,
        underglow: colorWithAlpha(sec, 0.34), radarDot: sec
    };
}

// =========================================================================
// 3. CANVAS, HARDWARE & HELPERS
// =========================================================================
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d', { alpha: false });
const radarCanvas = document.getElementById('miniRadarCanvas');
const rCtx = radarCanvas.getContext('2d');
const garageCanvas = document.getElementById('garagePreviewCanvas');
const gCtx = garageCanvas ? garageCanvas.getContext('2d') : null;

const LANES = [-2, -1, 0, 1, 2];
const LANE_WIDTH_M = 3.5;
const EGO_Z_REAR = 1.24, EGO_Z_CENTER = 1.48, EGO_Z_FRONT = 1.78, EGO_HALF_LANE_W = 0.33;
const EPOCH_250_INDEX = 13;
const EPOCH_250_LENGTH_M = 800;

let isMobileHardware = false, isHudHidden = false, isBootSplashDismissed = false;
let hasTrustedGesture = false, isPortalExiting = false, mainMenuSplashGuardUntil = 0;
let currentSettingsTab = 'game', currentLbTab = 'season', lbDevManageMode = false;
let devGodModeActive = false, awaitingRebindAction = null;
let garageNitroPreviewOn = true, garageEmpPreviewRadius = 0;
let devRevealAllIds = false;
const devRowRevealSet = new Set();
let menuCruiseDist = 0;
let colorSyncDebounceTimer = null;

const revealState = { menuTag: false, menuUid: false, prevTag: false, prevUid: false, profTag: false, profUid: false };

const domCache = {};
function setTextCached(id, val) {
    const s = String(val);
    if (domCache[id] === s) return;
    domCache[id] = s;
    const el = document.getElementById(id);
    if (el) el.innerText = s;
}
function setWidthCached(id, wStr) {
    const k = id + '_w';
    if (domCache[k] === wStr) return;
    domCache[k] = wStr;
    const el = document.getElementById(id);
    if (el) el.style.width = wStr;
}
function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function formatUidSpaced(uid) {
    const s = String(uid || '').replace(/\D/g, '');
    return s.length !== 17 ? s : `${s.slice(0, 4)} ${s.slice(4, 8)} ${s.slice(8, 12)} ${s.slice(12)}`;
}
function showToast(msg, tone = 'info') {
    const box = document.getElementById('toastContainer');
    if (!box) return;
    const el = document.createElement('div');
    el.className = `toast-pill mono ${tone === 'ok' ? 'toast-ok' : (tone === 'err' ? 'toast-err' : '')}`;
    el.innerText = msg;
    box.appendChild(el);
    while (box.children.length > 3) box.removeChild(box.firstChild);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.25s ease'; setTimeout(() => el.remove(), 260); }, 2500);
}

function copyTextReliable(text) {
    const str = String(text || '');
    if (!str) return Promise.resolve(false);
    const execFallback = () => {
        try {
            const ta = document.createElement('textarea');
            ta.value = str; ta.setAttribute('readonly', '');
            ta.style.position = 'fixed'; ta.style.top = '0'; ta.style.left = '0';
            ta.style.opacity = '0'; ta.style.pointerEvents = 'none';
            document.body.appendChild(ta);
            ta.focus(); ta.select(); ta.setSelectionRange(0, str.length);
            const ok = document.execCommand('copy');
            document.body.removeChild(ta);
            return Boolean(ok);
        } catch (e) { return false; }
    };
    if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(str).then(() => true).catch(() => execFallback());
    }
    return Promise.resolve(execFallback());
}

function copyUidDirect(uid, btnId) {
    if (!uid) { showToast('No UID to copy.', 'err'); return; }
    const btn = btnId ? document.getElementById(btnId) : null;
    const orig = btn ? btn.innerText : '';
    copyTextReliable(uid).then(ok => {
        if (ok) {
            if (btn) { btn.innerText = '✓ Copied'; setTimeout(() => { if (document.getElementById(btnId)) btn.innerText = orig; }, 1400); }
            showToast(`Copied UID: ${uid}`, 'ok'); playSfx('pickup');
        } else { showToast('Copy blocked by browser.', 'err'); playSfx('hit'); }
    });
}
function copyCurrentAccountUid(btnId) { copyUidDirect(activeAccount ? activeAccount.uid : '', btnId); }
function copyPrevAccountUid(btnId) { copyUidDirect(lastLoggedOutUid || '', btnId); }

let confirmModalResolver = null;
function askConfirm({ title, body, okLabel = 'Confirm', danger = true }) {
    return new Promise(resolve => {
        confirmModalResolver = resolve;
        document.getElementById('confirmModalTitle').innerText = title || 'Confirm';
        document.getElementById('confirmModalBody').innerText = body || '';
        const okBtn = document.getElementById('confirmModalOkBtn');
        okBtn.innerText = okLabel;
        okBtn.className = danger ? 'btn btn-sm btn-danger' : 'btn btn-sm btn-sky active';
        document.getElementById('confirmModal').style.display = 'flex';
        syncCursorVisibility();
    });
}
function resolveConfirmModal(accepted) {
    document.getElementById('confirmModal').style.display = 'none';
    const r = confirmModalResolver;
    confirmModalResolver = null;
    syncCursorVisibility();
    if (r) r(Boolean(accepted));
}

function detectDeviceHardware() {
    const uaMob = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    isMobileHardware = Boolean(uaMob || coarse);
    document.body.classList.toggle('is-mobile', isMobileHardware);
    document.body.classList.toggle('is-pc', !isMobileHardware);
    const ch = document.getElementById('ctrlPlatformHeaderLabel');
    if (ch) ch.innerText = isMobileHardware ? 'MOBILE CONTROLS' : 'KEYBOARD CONTROLS';
}

// =========================================================================
// 4. GLOBAL SETTINGS
// =========================================================================
const DIFFICULTY_PRESETS = {
    easy:   { label: 'Easy',     speedMul: 0.72, spawnMeters: 32.0, hitboxScale: 0.78, scoreMul: 1.0, nitroRegen: 6.8, empRegen: 4.8, pickupSpacing: 21.0, pickupScale: 1.00 },
    normal: { label: 'Normal',   speedMul: 0.84, spawnMeters: 26.5, hitboxScale: 0.84, scoreMul: 1.2, nitroRegen: 4.2, empRegen: 3.0, pickupSpacing: 25.0, pickupScale: 0.86 },
    hard:   { label: 'Hard',     speedMul: 0.95, spawnMeters: 22.5, hitboxScale: 0.89, scoreMul: 1.5, nitroRegen: 2.3, empRegen: 1.6, pickupSpacing: 29.0, pickupScale: 0.74 },
    void:   { label: 'Void Max', speedMul: 1.06, spawnMeters: 19.0, hitboxScale: 0.93, scoreMul: 2.0, nitroRegen: 1.1, empRegen: 0.7, pickupSpacing: 34.0, pickupScale: 0.62 }
};

const GRAPHICS_PRESETS = {
    low:    { title: 'Low',    resScale: 0.75, roadSlices: 18, particles: 0.25, bloom: false, shake: false, transitions: true, scanlines: false, pillars: false, reflections: false, speedLines: false, hudBoxes: true, legacyModels: false },
    medium: { title: 'Medium', resScale: 1.00, roadSlices: 26, particles: 0.65, bloom: true,  shake: true,  transitions: true, scanlines: false, pillars: true,  reflections: false, speedLines: false, hudBoxes: true, legacyModels: false },
    high:   { title: 'High',   resScale: 1.25, roadSlices: 36, particles: 1.00, bloom: true,  shake: true,  transitions: true, scanlines: false, pillars: true,  reflections: true,  speedLines: true,  hudBoxes: true, legacyModels: false },
    ultra:  { title: 'Ultra',  resScale: 1.50, roadSlices: 48, particles: 1.50, bloom: true,  shake: true,  transitions: true, scanlines: false, pillars: true,  reflections: true,  speedLines: true,  hudBoxes: true, legacyModels: false }
};

const GFX_TOGGLE_META = [
    { k: 'bloom', lbl: '💡 Glow' }, { k: 'shake', lbl: '📳 Shake' }, { k: 'transitions', lbl: '🌀 FX Anim' },
    { k: 'scanlines', lbl: '📺 Scanline' }, { k: 'pillars', lbl: '🏛️ Sky Art' }, { k: 'reflections', lbl: '✨ Road Sheen' },
    { k: 'speedLines', lbl: '💨 Warp Lines' }, { k: 'hudBoxes', lbl: '📦 YOLO Boxes' }, { k: 'legacyModels', lbl: '👾 Legacy' }
];

const OPTIC_FILTER_META = [
    { k: 'filter-standard',  lbl: 'Standard',     atmo: '' },
    { k: 'filter-bw',        lbl: 'B&W Noir',     atmo: '' },
    { k: 'filter-negative',  lbl: 'Negative',     atmo: '' },
    { k: 'filter-warm',      lbl: 'Warm',         atmo: 'atmo-warm' },
    { k: 'filter-vintage',   lbl: 'Vintage',      atmo: 'atmo-vintage' },
    { k: 'filter-cinematic', lbl: 'Cinematic',    atmo: 'atmo-cinematic' },
    { k: 'filter-nightvis',  lbl: 'Night Vision', atmo: 'atmo-nightvis' },
    { k: 'filter-blueprint', lbl: 'Blueprint',    atmo: 'atmo-blueprint' }
];
const VALID_FILTERS = new Set(OPTIC_FILTER_META.map(f => f.k));

function getDefaultGlobalSettings() {
    return {
        difficulty: 'easy', autoCycleBiomes: true, selectedBiomeIdx: 0,
        audio: { master: 0.95, music: 0.90, menuMusic: 0.85, engine: 0.80, sfx: 0.92, uiClick: 0.85, ostMode: 'synth' },
        controls: {
            mobileMode: 'buttons', doubleTapNitro: true, invertGyro: false, gyroSensitivity: 0.65,
            binds: { left: ['a', 'arrowleft'], right: ['d', 'arrowright'], nitro: ['shift', 'w', 'arrowup'], brake: ['s', 'arrowdown'], emp: [' ', 'e'], hideui: ['h'] }
        },
        graphics: {
            preset: 'medium', filter: 'filter-standard', resScale: 1.00, roadSlices: 26, particles: 0.65,
            bloom: true, shake: true, transitions: true, scanlines: false, pillars: true, reflections: false, speedLines: false, hudBoxes: true, legacyModels: false
        }
    };
}

let globalSettings = (() => {
    const def = getDefaultGlobalSettings();
    const r = lsGetJson(STORAGE_GLOBAL_CFG_KEY, null);
    if (!r || typeof r !== 'object') return def;
    return {
        difficulty: DIFFICULTY_PRESETS[r.difficulty] ? r.difficulty : def.difficulty,
        autoCycleBiomes: r.autoCycleBiomes !== undefined ? Boolean(r.autoCycleBiomes) : true,
        selectedBiomeIdx: Math.max(0, Math.min(13, parseInt(r.selectedBiomeIdx, 10) || 0)),
        audio: { ...def.audio, ...(r.audio || {}) },
        controls: { ...def.controls, ...(r.controls || {}), binds: { ...def.controls.binds, ...((r.controls && r.controls.binds) || {}) } },
        graphics: { ...def.graphics, ...(r.graphics || {}) }
    };
})();
function saveGlobalSettings() { lsSet(STORAGE_GLOBAL_CFG_KEY, JSON.stringify(globalSettings)); }

// =========================================================================
// 5. 14 VIBRANT DIMENSIONS & VEHICLE PRESETS
// =========================================================================
const BIOME_THEMES = [
    { label: '🌌 Cyber Void',         unlockEpoch: 1,   horizonType: 'cyber',     skyTop: '#03050a', skyBot: '#0d1b38', roadDark: '#0b0e17', roadLight: '#111624', curb: '#38bdf8', sun: '#38bdf8', weather: 'none' },
    { label: '🌧️ Monsoon Glare',      unlockEpoch: 10,  horizonType: 'monsoon',   skyTop: '#04080e', skyBot: '#132a2e', roadDark: '#080d12', roadLight: '#0e161f', curb: '#10b981', sun: '#10b981', weather: 'rain' },
    { label: '🔥 Solar Overdrive',    unlockEpoch: 20,  horizonType: 'solar',     skyTop: '#14040d', skyBot: '#3b0d24', roadDark: '#140914', roadLight: '#1d0e1e', curb: '#f59e0b', sun: '#f97316', weather: 'embers' },
    { label: '❄️ Cryo-Singularity',   unlockEpoch: 30,  horizonType: 'cryo',      skyTop: '#020b18', skyBot: '#0c3559', roadDark: '#0a1626', roadLight: '#102138', curb: '#7dd3fc', sun: '#e0f2fe', weather: 'snow' },
    { label: '☣️ Bio-Luminescent',    unlockEpoch: 40,  horizonType: 'bio',       skyTop: '#021008', skyBot: '#0a2e1c', roadDark: '#07140e', roadLight: '#0c2117', curb: '#4ade80', sun: '#22c55e', weather: 'spores' },
    { label: '🩸 Crimson Eclipse',    unlockEpoch: 50,  horizonType: 'eclipse',   skyTop: '#090204', skyBot: '#2d0610', roadDark: '#120508', roadLight: '#1c090e', curb: '#f43f5e', sun: '#e11d48', weather: 'embers' },
    { label: '⚡ Tachyon Storm',      unlockEpoch: 60,  horizonType: 'tachyon',   skyTop: '#090418', skyBot: '#261054', roadDark: '#0e081c', roadLight: '#160d2b', curb: '#c084fc', sun: '#eab308', weather: 'rain' },
    { label: '🏜️ Dune Mirage 2077',   unlockEpoch: 70,  horizonType: 'dune',      skyTop: '#1c0d02', skyBot: '#452108', roadDark: '#1a1109', roadLight: '#26190d', curb: '#fbbf24', sun: '#f59e0b', weather: 'spores' },
    { label: '🌸 Neo-Tokyo Sakura',   unlockEpoch: 80,  horizonType: 'sakura',    skyTop: '#0d0417', skyBot: '#2e0c38', roadDark: '#12091c', roadLight: '#1b0e29', curb: '#f472b6', sun: '#ec4899', weather: 'petals' },
    { label: '🟢 Matrix Kernel',      unlockEpoch: 90,  horizonType: 'matrix',    skyTop: '#000802', skyBot: '#03220a', roadDark: '#020d05', roadLight: '#05180a', curb: '#22c55e', sun: '#4ade80', weather: 'matrix' },
    { label: '🪐 Saturn Orbit',       unlockEpoch: 100, horizonType: 'saturn',    skyTop: '#020308', skyBot: '#111833', roadDark: '#080b14', roadLight: '#101526', curb: '#818cf8', sun: '#6366f1', weather: 'none' },
    { label: '🌋 Magma Caldera',      unlockEpoch: 110, horizonType: 'magma',     skyTop: '#140300', skyBot: '#3d0e02', roadDark: '#170704', roadLight: '#240c06', curb: '#fb923c', sun: '#ef4444', weather: 'embers' },
    { label: '⚪ Astral Monolith',    unlockEpoch: 120, horizonType: 'astral',    skyTop: '#090b10', skyBot: '#1e2433', roadDark: '#0e1117', roadLight: '#171b24', curb: '#e2e8f0', sun: '#f8fafc', weather: 'snow' },
    { label: '✨ Cosmic Singularity', unlockEpoch: 251, horizonType: 'cosmic250', isEpoch250Special: true, skyTop: '#02000a', skyBot: '#14042d', roadDark: '#070214', roadLight: '#12052c', curb: '#00f5d4', sun: '#ff007f', weather: 'cosmic' }
];
let biomeIdx = 0;

const DEFAULT_VEHICLE_CUST = {
    bodyPrimary: '#1e293b', bodySecondary: '#38bdf8', canopyColor: '#7dd3fc',
    empColor: '#38bdf8', boostColor: '#fbbf24', nitroSkin: 'standard'
};
const GARAGE_PRESETS = {
    steel:    { bodyPrimary: '#1e293b', bodySecondary: '#38bdf8', canopyColor: '#7dd3fc', empColor: '#38bdf8', boostColor: '#fbbf24' },
    cobalt:   { bodyPrimary: '#0f2544', bodySecondary: '#38bdf8', canopyColor: '#bae6fd', empColor: '#00f5d4', boostColor: '#38bdf8' },
    crimson:  { bodyPrimary: '#360f18', bodySecondary: '#f43f5e', canopyColor: '#fda4af', empColor: '#ef4444', boostColor: '#fb923c' },
    emerald:  { bodyPrimary: '#0b3024', bodySecondary: '#10b981', canopyColor: '#a7f3d0', empColor: '#10b981', boostColor: '#34d399' },
    solar:    { bodyPrimary: '#33220a', bodySecondary: '#f59e0b', canopyColor: '#fde68a', empColor: '#f59e0b', boostColor: '#f97316' },
    amethyst: { bodyPrimary: '#271242', bodySecondary: '#c084fc', canopyColor: '#e9d5ff', empColor: '#a855f7', boostColor: '#c084fc' }
};
const COLOR_SWATCHES = {
    bodyPrimary:   ['#1e293b', '#1a2236', '#0f2544', '#360f18', '#0b3024', '#33220a', '#271242', '#0f172a'],
    bodySecondary: ['#38bdf8', '#00f5d4', '#10b981', '#f59e0b', '#f43f5e', '#c084fc', '#e2e8f0', '#fb923c'],
    canopyColor:   ['#7dd3fc', '#c77dff', '#a7f3d0', '#fde68a', '#fda4af', '#e9d5ff', '#bae6fd', '#0f172a'],
    empColor:      ['#38bdf8', '#00f5d4', '#10b981', '#c084fc', '#f59e0b', '#f43f5e', '#ffffff', '#60a5fa'],
    boostColor:    ['#fbbf24', '#f97316', '#38bdf8', '#00f5d4', '#10b981', '#f43f5e', '#c084fc', '#f8fafc']
};

// =========================================================================
// 6. ACCOUNT DB + CRDT TOMBSTONES + HYBRID FIREBASE/INDEXEDDB SYNC
// =========================================================================
let accountsCache = (() => {
    const p = lsGetJson(STORAGE_ACCOUNTS_KEY, {});
    return (p && typeof p === 'object' && !Array.isArray(p)) ? p : {};
})();

let syncMeta = (() => {
    const def = { wipeAllAccountsTs: 0, wipeAllScoresTs: 0, wipeAllAccountsVer: 0, wipeAllScoresVer: 0, deletedUids: {}, resetScoreTs: {}, resetScoreVer: {} };
    const r = lsGetJson(STORAGE_SYNC_META_KEY, null);
    if (!r || typeof r !== 'object') return def;
    return {
        wipeAllAccountsTs: Number(r.wipeAllAccountsTs) || 0,
        wipeAllScoresTs: Number(r.wipeAllScoresTs) || 0,
        wipeAllAccountsVer: Number(r.wipeAllAccountsVer) || 0,
        wipeAllScoresVer: Number(r.wipeAllScoresVer) || 0,
        deletedUids: (r.deletedUids && typeof r.deletedUids === 'object') ? r.deletedUids : {},
        resetScoreTs: (r.resetScoreTs && typeof r.resetScoreTs === 'object') ? r.resetScoreTs : {},
        resetScoreVer: (r.resetScoreVer && typeof r.resetScoreVer === 'object') ? r.resetScoreVer : {}
    };
})();
function saveSyncMeta() { lsSet(STORAGE_SYNC_META_KEY, JSON.stringify(syncMeta)); }
function saveAccountsCache() { lsSet(STORAGE_ACCOUNTS_KEY, JSON.stringify(accountsCache)); }

function normalizeAccountRecord(acc, uidKey) {
    if (!acc || typeof acc !== 'object') return null;
    const uid = /^\d{17}$/.test(String(acc.uid || uidKey)) ? String(acc.uid || uidKey) : null;
    if (!uid) return null;
    const st = (acc.stats && typeof acc.stats === 'object') ? acc.stats : {};
    const cust = (acc.custom && typeof acc.custom === 'object') ? acc.custom : {};
    return {
        uid,
        name: String(acc.name || 'Pilot').trim().slice(0, 28) || 'Pilot',
        tag: String(acc.tag || '0000').trim().slice(0, 10) || '0000',
        isDev: uid === CANONICAL_DEV_UID,
        createdAt: Number(acc.createdAt) || Date.now(),
        updatedAt: Number(acc.updatedAt) || Number(acc.createdAt) || Date.now(),
        accVer: typeof acc.accVer === 'number' ? acc.accVer : (syncMeta.wipeAllAccountsVer || 0),
        scoreVer: typeof acc.scoreVer === 'number' ? acc.scoreVer : (syncMeta.wipeAllScoresVer || 0),
        indivScoreVer: typeof acc.indivScoreVer === 'number' ? acc.indivScoreVer : ((syncMeta.resetScoreVer && syncMeta.resetScoreVer[uid]) || 0),
        editVer: typeof acc.editVer === 'number' ? acc.editVer : 1,
        stats: {
            allTimeBest: Math.max(0, Number(st.allTimeBest) || 0),
            bestEpoch: Math.max(1, Number(st.bestEpoch) || 1),
            totalFlashes: Math.max(0, Number(st.totalFlashes) || 0),
            totalRuns: Math.max(0, Number(st.totalRuns) || 0),
            completedEpoch250: Boolean(st.completedEpoch250),
            seasonScores: (st.seasonScores && typeof st.seasonScores === 'object') ? st.seasonScores : {}
        },
        custom: { ...DEFAULT_VEHICLE_CUST, ...cust },
        seasonalSkins: Array.isArray(acc.seasonalSkins) ? acc.seasonalSkins : [],
        inbox: Array.isArray(acc.inbox) ? acc.inbox : []
    };
}

function generateUnique17DigitUid() {
    for (let attempt = 0; attempt < 300; attempt++) {
        let uid = String(1 + Math.floor(Math.random() * 9));
        if (window.crypto && window.crypto.getRandomValues) {
            const b = new Uint8Array(16);
            window.crypto.getRandomValues(b);
            for (let i = 0; i < 16; i++) uid += String(b[i] % 10);
        } else {
            for (let i = 0; i < 16; i++) uid += String(Math.floor(Math.random() * 10));
        }
        if (uid !== CANONICAL_DEV_UID && !accountsCache[uid]) return uid;
    }
    return String(Date.now()).padEnd(17, '9').slice(0, 17);
}

function makeAccountObj({ uid, name, tag, isDev = false }) {
    const now = Date.now();
    return {
        uid, name: name.trim(), tag: tag.trim(), isDev: uid === CANONICAL_DEV_UID,
        createdAt: now, updatedAt: now,
        accVer: syncMeta.wipeAllAccountsVer || 0,
        scoreVer: syncMeta.wipeAllScoresVer || 0,
        indivScoreVer: (syncMeta.resetScoreVer && syncMeta.resetScoreVer[uid]) || 0,
        editVer: 1,
        stats: { allTimeBest: 0, bestEpoch: 1, totalFlashes: 0, totalRuns: 0, completedEpoch250: false, seasonScores: {} },
        custom: isDev
            ? { bodyPrimary: '#1a2236', bodySecondary: '#00f5d4', canopyColor: '#c77dff', empColor: '#00f5d4', boostColor: '#ff007f', nitroSkin: 'void_chroma' }
            : { ...DEFAULT_VEHICLE_CUST },
        seasonalSkins: [], inbox: []
    };
}

function packAccountForSync(acc) {
    return {
        uid: acc.uid, name: acc.name, tag: acc.tag, isDev: acc.isDev,
        createdAt: acc.createdAt, updatedAt: acc.updatedAt || Date.now(),
        accVer: typeof acc.accVer === 'number' ? acc.accVer : syncMeta.wipeAllAccountsVer,
        scoreVer: typeof acc.scoreVer === 'number' ? acc.scoreVer : syncMeta.wipeAllScoresVer,
        indivScoreVer: typeof acc.indivScoreVer === 'number' ? acc.indivScoreVer : (syncMeta.resetScoreVer[acc.uid] || 0),
        editVer: typeof acc.editVer === 'number' ? acc.editVer : 1,
        stats: acc.stats, custom: acc.custom,
        seasonalSkins: (acc.seasonalSkins || []).slice(-6)
    };
}

let activeAccount = null;
let lastLoggedOutUid = lsGet(STORAGE_LAST_OUT_KEY, '') || '';

function validateAndSanitizeDatabase() {
    const clean = {};
    Object.entries(accountsCache).forEach(([k, v]) => {
        const norm = normalizeAccountRecord(v, k);
        if (norm) clean[norm.uid] = norm;
    });
    accountsCache = clean;
    if (!accountsCache[CANONICAL_DEV_UID]) {
        accountsCache[CANONICAL_DEV_UID] = makeAccountObj({ uid: CANONICAL_DEV_UID, name: DEFAULT_DEV_NAME, tag: DEFAULT_DEV_TAG, isDev: true });
        pushMail(accountsCache[CANONICAL_DEV_UID], {
            title: 'Dev Root Ready (IndexedDB + Firebase 24/7)',
            sender: 'SYSTEM',
            body: 'Your unique 17-digit Dev UID is synced across all browsers.\nNames & IDs are completely unrestricted for all players.'
        });
    }
    Object.values(accountsCache).forEach(acc => { acc.isDev = (acc.uid === CANONICAL_DEV_UID); });
    if (lastLoggedOutUid && !accountsCache[lastLoggedOutUid]) { lastLoggedOutUid = ''; lsRemove(STORAGE_LAST_OUT_KEY); }
    saveAccountsCache();
}

let seasonStateCache = (() => {
    const s = lsGetJson(STORAGE_SEASON_KEY, null);
    if (s && s.originTs) return s;
    const fresh = { originTs: Date.now(), devOffsetMs: 0, lastAnnouncedSeason: 0, lastFinalizedSeason: 0 };
    lsSet(STORAGE_SEASON_KEY, JSON.stringify(fresh));
    return fresh;
})();
function saveSeasonState() { lsSet(STORAGE_SEASON_KEY, JSON.stringify(seasonStateCache)); }

let lbAllCache = (() => {
    const a = lsGetJson(STORAGE_LB_ALL_KEY, []);
    return Array.isArray(a) ? a.filter(e => e && e.uid && Number(e.score) > 0) : [];
})();
let lbSeasonCache = (() => {
    const o = lsGetJson(STORAGE_LB_SEASON_KEY, {});
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
})();
function saveLbAll() { lsSet(STORAGE_LB_ALL_KEY, JSON.stringify(lbAllCache.slice(0, 100))); }
function saveLbSeason() { lsSet(STORAGE_LB_SEASON_KEY, JSON.stringify(lbSeasonCache)); }
function getSeasonLbFor(sNum) {
    const arr = Array.isArray(lbSeasonCache[sNum]) ? lbSeasonCache[sNum] : [];
    return arr.filter(e => e && e.uid && Number(e.score) > 0).sort((a, b) => b.score - a.score);
}

let seasonStatusCache = computeSeasonStatus();
function computeSeasonStatus() {
    const nowMs = Date.now() + (Number(seasonStateCache.devOffsetMs) || 0);
    const elapsed = Math.max(0, nowMs - seasonStateCache.originTs);
    const seasonNum = Math.floor(elapsed / SEASON_CYCLE_MS) + 1;
    const within = elapsed % SEASON_CYCLE_MS;
    const isGap = within >= SEASON_ACTIVE_MS;
    const remainingMs = isGap ? (SEASON_CYCLE_MS - within) : (SEASON_ACTIVE_MS - within);
    return { seasonNum, phase: isGap ? 'GAP' : 'ACTIVE', remainingMs, featuredSkin: getSeasonFeaturedSkin(seasonNum), nextSeasonNum: seasonNum + 1 };
}

// =========================================================================
// 7. QUOTA-SAFE FIREBASE 24/7 + INDEXEDDB + LOCAL BROADCAST SYNC ENGINE
// =========================================================================
let localBc = null;
try { if ('BroadcastChannel' in window) localBc = new BroadcastChannel('roadsense_v4_rt_v12'); } catch (e) { localBc = null; }

let rtEventSource = null, rtReconnectTimer = null, rtPollTimer = null;
let isPullingCloud = false, lastSeenPulsePid = '';
const seenPacketIds = new Set();

function ensureSyncMetaVersions() {
    if (typeof syncMeta.wipeAllAccountsVer !== 'number') syncMeta.wipeAllAccountsVer = 0;
    if (typeof syncMeta.wipeAllScoresVer !== 'number') syncMeta.wipeAllScoresVer = 0;
    if (!syncMeta.resetScoreVer || typeof syncMeta.resetScoreVer !== 'object') syncMeta.resetScoreVer = {};
    if (!syncMeta.deletedUids || typeof syncMeta.deletedUids !== 'object') syncMeta.deletedUids = {};
}
ensureSyncMetaVersions();

function setRealtimeStatusUI(state) {
    const text = state === 'live' ? '🟢 LIVE DB' : (state === 'syncing' ? '🟡 SYNC' : '🔵 LOCAL IDB');
    const cls = state === 'live' ? 'badge badge-emerald mono' : (state === 'syncing' ? 'badge badge-amber mono' : 'badge badge-sky mono');
    ['rtSyncStatusBadge', 'devRtBadge'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.innerText = text; el.className = cls; }
    });
}

function refreshAllLiveViews() {
    reconcileAllTimeChampion();
    updateTopLeaderBanner();
    refreshMenuAccountUI();
    refreshInboxBadgeUI();
    if (document.getElementById('leaderboardModal').style.display === 'flex') renderLeaderboardList();
    if (document.getElementById('inboxModal').style.display === 'flex') renderInboxList();
    if (document.getElementById('pauseSettingsModal').style.display === 'flex') {
        if (currentSettingsTab === 'dev') renderDevAccountsList();
        if (currentSettingsTab === 'garage') buildGarageUI();
    }
}

// Low-bandwidth Firebase REST helper
async function fbRequest(path, method = 'GET', bodyObj = null, timeoutMs = 4500) {
    if (!FB_BASE_URL) return null;
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const opts = { method, signal: ctrl.signal, cache: 'no-store' };
        if (bodyObj !== null) {
            opts.headers = { 'Content-Type': 'application/json' };
            opts.body = JSON.stringify(bodyObj);
        }
        const res = await fetch(`${FB_BASE_URL}${path}.json`, opts);
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        return null;
    } finally {
        clearTimeout(tid);
    }
}

// Publishes delta changes to Firebase (only ~300 bytes per action!) + Local BroadcastChannel
async function publishRealtimeEvent(op, data = {}) {
    ensureSyncMetaVersions();
    const pid = CLIENT_ID + '_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e5).toString(36);
    seenPacketIds.add(pid);
    lastSeenPulsePid = pid;
    if (seenPacketIds.size > 2000) seenPacketIds.clear();

    if (op === 'score_reset_all') {
        syncMeta.wipeAllScoresVer += 1;
        Object.values(accountsCache).forEach(a => { a.scoreVer = syncMeta.wipeAllScoresVer; });
        saveSyncMeta(); saveAccountsCache();
    } else if (op === 'acc_delete_all') {
        syncMeta.wipeAllAccountsVer += 1;
        syncMeta.deletedUids = {};
        saveSyncMeta();
    } else if (op === 'score_reset' && data.uid) {
        syncMeta.resetScoreVer[data.uid] = (Number(syncMeta.resetScoreVer[data.uid]) || 0) + 1;
        if (accountsCache[data.uid]) {
            accountsCache[data.uid].indivScoreVer = syncMeta.resetScoreVer[data.uid];
            saveAccountsCache();
        }
        saveSyncMeta();
    } else if (op === 'acc_delete' && data.uid && data.uid !== CANONICAL_DEV_UID) {
        syncMeta.deletedUids[data.uid] = true;
        saveSyncMeta();
    } else if (op === 'acc_upsert' && data.acc && data.acc.uid) {
        const u = data.acc.uid;
        if (accountsCache[u]) {
            accountsCache[u].accVer = syncMeta.wipeAllAccountsVer;
            accountsCache[u].scoreVer = syncMeta.wipeAllScoresVer;
            accountsCache[u].indivScoreVer = syncMeta.resetScoreVer[u] || 0;
            accountsCache[u].editVer = (Number(accountsCache[u].editVer) || 0) + 1;
            saveAccountsCache();
        }
    } else if (op === 'score_record' && data.entry && data.entry.uid) {
        const u = data.entry.uid;
        if (accountsCache[u]) {
            accountsCache[u].accVer = syncMeta.wipeAllAccountsVer;
            accountsCache[u].scoreVer = syncMeta.wipeAllScoresVer;
            accountsCache[u].indivScoreVer = syncMeta.resetScoreVer[u] || 0;
            accountsCache[u].editVer = (Number(accountsCache[u].editVer) || 0) + 1;
            saveAccountsCache();
        }
    }

    // 1. Instant Same-Browser Tab Sync via BroadcastChannel
    const localPacket = {
        type: 'rs_sync_v12', pid, sender: CLIENT_ID, op,
        meta: {
            wipeAllAccountsVer: syncMeta.wipeAllAccountsVer,
            wipeAllScoresVer: syncMeta.wipeAllScoresVer,
            resetScoreVer: syncMeta.resetScoreVer,
            deletedUids: syncMeta.deletedUids
        },
        seasonState: seasonStateCache,
        accounts: data.acc ? [packAccountForSync(accountsCache[data.acc.uid] || data.acc)] : [],
        ...data
    };
    if (localBc) { try { localBc.postMessage(localPacket); } catch (e) {} }

    // 2. Quota-Safe Delta Sync to Firebase 24/7 Cloud DB
    if (!FB_BASE_URL) {
        setRealtimeStatusUI('local');
        return;
    }

    try {
        if (op === 'acc_upsert' && data.acc && data.acc.uid) {
            const packed = packAccountForSync(accountsCache[data.acc.uid] || data.acc);
            await fbRequest(`/accounts/${packed.uid}`, 'PUT', packed);
            await fbRequest('/pulse', 'PUT', { pid, op, uid: packed.uid, ts: Date.now() });
        } else if (op === 'score_record' && data.entry && data.entry.uid) {
            const u = data.entry.uid;
            if (accountsCache[u]) await fbRequest(`/accounts/${u}`, 'PUT', packAccountForSync(accountsCache[u]));
            await fbRequest(`/leaderboards/alltime/${u}`, 'PUT', data.entry);
            if (data.sNum && data.sScore > 0) {
                await fbRequest(`/leaderboards/season/${data.sNum}/${u}`, 'PUT', { ...data.entry, score: data.sScore });
            }
            await fbRequest('/pulse', 'PUT', { pid, op, uid: u, sNum: data.sNum || 0, sScore: data.sScore || 0, ts: Date.now() });
        } else if (op === 'acc_delete' && data.uid) {
            await fbRequest(`/accounts/${data.uid}`, 'DELETE');
            await fbRequest(`/leaderboards/alltime/${data.uid}`, 'DELETE');
            await fbRequest(`/meta/deletedUids/${data.uid}`, 'PUT', true);
            await fbRequest('/pulse', 'PUT', { pid, op, uid: data.uid, ts: Date.now() });
        } else if (op === 'score_reset' && data.uid) {
            const u = data.uid;
            await fbRequest(`/leaderboards/alltime/${u}`, 'DELETE');
            await fbRequest(`/leaderboards/season/${seasonStatusCache.seasonNum}/${u}`, 'DELETE');
            if (accountsCache[u]) await fbRequest(`/accounts/${u}`, 'PUT', packAccountForSync(accountsCache[u]));
            await fbRequest(`/meta/resetScoreVer/${u}`, 'PUT', syncMeta.resetScoreVer[u]);
            await fbRequest('/pulse', 'PUT', { pid, op, uid: u, ts: Date.now() });
        } else if (op === 'score_reset_all') {
            await fbRequest('/leaderboards', 'DELETE');
            await fbRequest('/meta/wipeAllScoresVer', 'PUT', syncMeta.wipeAllScoresVer);
            await fbRequest('/pulse', 'PUT', { pid, op, wipeAllScoresVer: syncMeta.wipeAllScoresVer, ts: Date.now() });
        } else if (op === 'acc_delete_all') {
            const devPacked = packAccountForSync(accountsCache[CANONICAL_DEV_UID]);
            await fbRequest('/accounts', 'PUT', { [CANONICAL_DEV_UID]: devPacked });
            await fbRequest('/leaderboards', 'DELETE');
            await fbRequest('/meta/wipeAllAccountsVer', 'PUT', syncMeta.wipeAllAccountsVer);
            await fbRequest('/meta/deletedUids', 'DELETE');
            await fbRequest('/pulse', 'PUT', { pid, op, wipeAllAccountsVer: syncMeta.wipeAllAccountsVer, ts: Date.now() });
        } else if (op === 'mail_broadcast' && data.mail) {
            await fbRequest('/meta/latestMail', 'PUT', data.mail);
            await fbRequest('/pulse', 'PUT', { pid, op, mail: data.mail, ts: Date.now() });
        } else if (op === 'season_sync') {
            await fbRequest('/meta/seasonState', 'PUT', seasonStateCache);
            await fbRequest('/pulse', 'PUT', { pid, op, seasonState: seasonStateCache, ts: Date.now() });
        }
        setRealtimeStatusUI('live');
    } catch (e) {}
}

function mergeSingleAccountRecord(rawAcc, fromReplay = false) {
    if (!rawAcc || !rawAcc.uid) return false;
    ensureSyncMetaVersions();
    const u = rawAcc.uid;
    const remAccVer = typeof rawAcc.accVer === 'number' ? rawAcc.accVer : 0;

    if (u !== CANONICAL_DEV_UID) {
        if (remAccVer < syncMeta.wipeAllAccountsVer) return false;
        if (syncMeta.deletedUids[u]) return false;
    }

    const inc = normalizeAccountRecord(rawAcc, u);
    if (!inc) return false;

    const remScoreVer = typeof rawAcc.scoreVer === 'number' ? rawAcc.scoreVer : 0;
    const remIndivVer = typeof rawAcc.indivScoreVer === 'number' ? rawAcc.indivScoreVer : 0;
    const curIndivVer = Number(syncMeta.resetScoreVer[u]) || 0;
    const scoresValid = (remScoreVer >= syncMeta.wipeAllScoresVer) && (remIndivVer >= curIndivVer);

    if (!scoresValid) {
        inc.stats.allTimeBest = 0;
        inc.stats.bestEpoch = 1;
        inc.stats.totalFlashes = 0;
        inc.stats.seasonScores = {};
    }

    const cur = accountsCache[u];
    const remEditVer = Number(rawAcc.editVer) || 1;
    const curEditVer = cur ? (Number(cur.editVer) || 0) : 0;

    if (!cur) {
        inc.accVer = syncMeta.wipeAllAccountsVer;
        inc.scoreVer = syncMeta.wipeAllScoresVer;
        inc.indivScoreVer = curIndivVer;
        inc.editVer = remEditVer;
        accountsCache[u] = inc;
    } else {
        if (remEditVer >= curEditVer) {
            cur.name = inc.name;
            cur.tag = inc.tag;
            cur.custom = { ...cur.custom, ...inc.custom };
            cur.editVer = remEditVer;
        }
        if (scoresValid) {
            if (inc.stats.allTimeBest > (cur.stats.allTimeBest || 0)) cur.stats.allTimeBest = inc.stats.allTimeBest;
            cur.stats.bestEpoch = Math.max(cur.stats.bestEpoch || 1, inc.stats.bestEpoch || 1);
            cur.stats.totalFlashes = Math.max(cur.stats.totalFlashes || 0, inc.stats.totalFlashes || 0);
            cur.stats.totalRuns = Math.max(cur.stats.totalRuns || 0, inc.stats.totalRuns || 0);
            cur.stats.completedEpoch250 = Boolean(cur.stats.completedEpoch250 || inc.stats.completedEpoch250);
            const curS = cur.stats.seasonScores || {}, incS = inc.stats.seasonScores || {};
            Object.keys(incS).forEach(k => { curS[k] = Math.max(Number(curS[k]) || 0, Number(incS[k]) || 0); });
            cur.stats.seasonScores = curS;
        }
        cur.accVer = syncMeta.wipeAllAccountsVer;
        cur.scoreVer = syncMeta.wipeAllScoresVer;
        cur.indivScoreVer = curIndivVer;
        if (activeAccount && activeAccount.uid === u) activeAccount = cur;
        syncAccountMetaInLeaderboards(cur);
    }

    const finalAcc = accountsCache[u];
    if (scoresValid && finalAcc && finalAcc.stats.allTimeBest > 0) {
        const sNum = seasonStatusCache.seasonNum;
        const sScore = (finalAcc.stats.seasonScores && finalAcc.stats.seasonScores[sNum]) || 0;
        mergeScoreEntryLocally({
            uid: finalAcc.uid, name: finalAcc.name, tag: finalAcc.tag, isDev: finalAcc.isDev,
            score: finalAcc.stats.allTimeBest, epoch: finalAcc.stats.bestEpoch,
            accent: finalAcc.custom.bodySecondary, skinId: finalAcc.custom.nitroSkin,
            isPrism: finalAcc.custom.nitroSkin === 'void_chroma', ts: Date.now()
        }, sNum, sScore);
    }
    saveAccountsCache();
    return true;
}

function applyIncomingRealtimeEvent(pkt, fromReplay = false) {
    if (!pkt || typeof pkt !== 'object') return;
    if (pkt.pid) {
        if (seenPacketIds.has(pkt.pid)) return;
        seenPacketIds.add(pkt.pid);
    }

    ensureSyncMetaVersions();
    let changed = false;
    const remMeta = pkt.meta || {};

    if (Number(remMeta.wipeAllAccountsVer) > syncMeta.wipeAllAccountsVer) {
        syncMeta.wipeAllAccountsVer = Number(remMeta.wipeAllAccountsVer);
        syncMeta.deletedUids = {};
        saveSyncMeta();
        applyDeleteAllNonDevLocally(0, !fromReplay, true);
        changed = true;
    }

    if (Number(remMeta.wipeAllScoresVer) > syncMeta.wipeAllScoresVer) {
        syncMeta.wipeAllScoresVer = Number(remMeta.wipeAllScoresVer);
        saveSyncMeta();
        applyResetAllScoresLocally();
        Object.values(accountsCache).forEach(a => { a.scoreVer = syncMeta.wipeAllScoresVer; });
        saveAccountsCache();
        changed = true;
        if (!fromReplay) showToast('⚡ Live DB: All scores reset.');
    }

    if (remMeta.deletedUids && typeof remMeta.deletedUids === 'object') {
        Object.keys(remMeta.deletedUids).forEach(u => {
            if (u !== CANONICAL_DEV_UID && remMeta.deletedUids[u] && !syncMeta.deletedUids[u]) {
                syncMeta.deletedUids[u] = true;
                saveSyncMeta();
                applyAccountDeleteLocally(u, !fromReplay);
                changed = true;
            }
        });
    }

    if (remMeta.resetScoreVer && typeof remMeta.resetScoreVer === 'object') {
        Object.entries(remMeta.resetScoreVer).forEach(([u, ver]) => {
            const remV = Number(ver) || 0, curV = Number(syncMeta.resetScoreVer[u]) || 0;
            if (remV > curV) {
                syncMeta.resetScoreVer[u] = remV;
                saveSyncMeta();
                applyScoreResetLocally(u);
                if (accountsCache[u]) { accountsCache[u].indivScoreVer = remV; saveAccountsCache(); }
                changed = true;
                if (!fromReplay) showToast('⚡ Live DB: Pilot score reset.');
            }
        });
    }

    if (Array.isArray(pkt.accounts)) {
        pkt.accounts.forEach(rawAcc => {
            if (mergeSingleAccountRecord(rawAcc, fromReplay)) changed = true;
        });
    }

    if (pkt.op === 'mail_broadcast' && pkt.mail && pkt.mail.title && pkt.mail.body) {
        Object.values(accountsCache).forEach(acc => {
            if (!(acc.inbox || []).some(m => m.id === pkt.mail.id)) {
                acc.inbox.unshift({ ...pkt.mail, read: false });
                if (acc.inbox.length > 50) acc.inbox.length = 50;
            }
        });
        saveAccountsCache();
        changed = true;
        if (!fromReplay && activeAccount) showToast(`📬 New Mail: ${pkt.mail.title}`, 'ok');
    }

    if (pkt.seasonState && Number(pkt.seasonState.devOffsetMs) > (Number(seasonStateCache.devOffsetMs) || 0)) {
        seasonStateCache.originTs = Number(pkt.seasonState.originTs) || seasonStateCache.originTs;
        seasonStateCache.devOffsetMs = Number(pkt.seasonState.devOffsetMs) || 0;
        saveSeasonState();
        syncSeasonLifecycle();
        changed = true;
    }

    if (changed) refreshAllLiveViews();
}

// Handles a tiny 80-byte Firebase Pulse notification by fetching ONLY the delta that changed!
async function handleFirebasePulse(pulse) {
    if (!pulse || !pulse.pid || pulse.pid === lastSeenPulsePid || seenPacketIds.has(pulse.pid)) return;
    lastSeenPulsePid = pulse.pid;
    seenPacketIds.add(pulse.pid);

    const op = pulse.op;
    if ((op === 'acc_upsert' || op === 'score_record') && pulse.uid) {
        const remAcc = await fbRequest(`/accounts/${pulse.uid}`, 'GET');
        if (remAcc && mergeSingleAccountRecord(remAcc, false)) refreshAllLiveViews();
    } else if (op === 'acc_delete' && pulse.uid) {
        syncMeta.deletedUids[pulse.uid] = true;
        saveSyncMeta();
        applyAccountDeleteLocally(pulse.uid, true);
        refreshAllLiveViews();
    } else if (op === 'score_reset' && pulse.uid) {
        syncMeta.resetScoreVer[pulse.uid] = (Number(syncMeta.resetScoreVer[pulse.uid]) || 0) + 1;
        saveSyncMeta();
        applyScoreResetLocally(pulse.uid);
        refreshAllLiveViews();
    } else if (op === 'score_reset_all') {
        if (Number(pulse.wipeAllScoresVer) > syncMeta.wipeAllScoresVer) {
            syncMeta.wipeAllScoresVer = Number(pulse.wipeAllScoresVer);
            saveSyncMeta();
        }
        applyResetAllScoresLocally();
        refreshAllLiveViews();
        showToast('⚡ Live DB: All scores reset.');
    } else if (op === 'acc_delete_all') {
        if (Number(pulse.wipeAllAccountsVer) > syncMeta.wipeAllAccountsVer) {
            syncMeta.wipeAllAccountsVer = Number(pulse.wipeAllAccountsVer);
            syncMeta.deletedUids = {};
            saveSyncMeta();
        }
        applyDeleteAllNonDevLocally(0, true, true);
        refreshAllLiveViews();
    } else if (op === 'mail_broadcast' && pulse.mail) {
        applyIncomingRealtimeEvent({ type: 'rs_sync_v12', pid: pulse.pid, op: 'mail_broadcast', mail: pulse.mail }, false);
    } else if (op === 'season_sync' && pulse.seasonState) {
        applyIncomingRealtimeEvent({ type: 'rs_sync_v12', pid: pulse.pid, op: 'season_sync', seasonState: pulse.seasonState }, false);
    }
}

function mergeScoreEntryLocally(entry, sNum, sScore) {
    const scoreVal = Number(entry.score) || 0;
    if (scoreVal > 0) {
        const ai = lbAllCache.findIndex(e => e.uid === entry.uid);
        if (ai >= 0) {
            if (scoreVal > lbAllCache[ai].score) { lbAllCache[ai].score = scoreVal; lbAllCache[ai].epoch = Math.max(lbAllCache[ai].epoch || 1, entry.epoch || 1); }
            lbAllCache[ai].name = entry.name; lbAllCache[ai].tag = entry.tag; lbAllCache[ai].accent = entry.accent; lbAllCache[ai].isPrism = entry.isPrism;
        } else lbAllCache.push({ ...entry });
        lbAllCache.sort((a, b) => b.score - a.score); saveLbAll();
    }
    const seasonPts = Number(sScore) || 0;
    if (sNum && seasonPts > 0) {
        const list = Array.isArray(lbSeasonCache[sNum]) ? lbSeasonCache[sNum] : [];
        const si = list.findIndex(e => e.uid === entry.uid);
        if (si >= 0) {
            if (seasonPts > list[si].score) { list[si].score = seasonPts; list[si].epoch = Math.max(list[si].epoch || 1, entry.epoch || 1); }
            list[si].name = entry.name; list[si].tag = entry.tag; list[si].accent = entry.accent; list[si].isPrism = entry.isPrism;
        } else list.push({ ...entry, score: seasonPts });
        list.sort((a, b) => b.score - a.score); lbSeasonCache[sNum] = list.slice(0, 100); saveLbSeason();
    }
}

function applyScoreResetLocally(uid) {
    removeUidFromLeaderboards(uid);
    if (accountsCache[uid]) {
        accountsCache[uid].stats.allTimeBest = 0; accountsCache[uid].stats.bestEpoch = 1;
        accountsCache[uid].stats.totalFlashes = 0; accountsCache[uid].stats.seasonScores = {};
        saveAccountsCache();
    }
}
function applyResetAllScoresLocally() {
    lbAllCache = []; lbSeasonCache = {}; saveLbAll(); saveLbSeason();
    Object.values(accountsCache).forEach(a => { a.stats.allTimeBest = 0; a.stats.bestEpoch = 1; a.stats.totalFlashes = 0; a.stats.seasonScores = {}; });
    saveAccountsCache(); reconcileAllTimeChampion();
}
function applyAccountDeleteLocally(uid, notify) {
    if (!uid || uid === CANONICAL_DEV_UID) return;
    const existed = accountsCache[uid];
    delete accountsCache[uid]; saveAccountsCache();
    removeUidFromLeaderboards(uid); deleteCustomSongByUid(uid);
    if (lastLoggedOutUid === uid) { lastLoggedOutUid = ''; lsRemove(STORAGE_LAST_OUT_KEY); }
    if (activeAccount && activeAccount.uid === uid) {
        activeAccount = null; lsRemove(STORAGE_ACTIVE_UID_KEY); resetAllRevealStates();
        document.getElementById('pauseSettingsModal').style.display = 'none';
        returnToMainMenu(); showAuthFeedback('Your account was deleted.', false);
    } else if (notify && existed && activeAccount && activeAccount.isDev) showToast(`⚡ Live DB: Deleted "${existed.name}"`);
}
function applyDeleteAllNonDevLocally(wipeTs, notify, forceAll = true) {
    let removed = 0;
    Object.values(accountsCache).forEach(a => {
        if (!a.isDev && (forceAll || a.createdAt <= wipeTs)) {
            delete accountsCache[a.uid]; removeUidFromLeaderboards(a.uid); deleteCustomSongByUid(a.uid);
            if (lastLoggedOutUid === a.uid) { lastLoggedOutUid = ''; lsRemove(STORAGE_LAST_OUT_KEY); }
            if (activeAccount && activeAccount.uid === a.uid) {
                activeAccount = null; lsRemove(STORAGE_ACTIVE_UID_KEY); resetAllRevealStates();
                document.getElementById('pauseSettingsModal').style.display = 'none';
                returnToMainMenu(); showAuthFeedback('All player accounts were reset by Dev.', false);
            }
            removed++;
        }
    });
    saveAccountsCache();
    if (notify && removed > 0) showToast(`⚡ Live DB: Wiped ${removed} player account(s).`);
}

// Initial Bootstrap Pull from Firebase (runs once on boot or manual sync)
async function pullCloudHistoryAndSync(sendPushAfter = false) {
    if (!FB_BASE_URL) {
        setRealtimeStatusUI('local');
        return;
    }
    if (isPullingCloud || document.hidden || isPortalExiting) return;
    isPullingCloud = true;
    try {
        const snap = await fbRequest('', 'GET', null, 6000);
        if (snap && typeof snap === 'object') {
            if (snap.pulse && snap.pulse.pid) {
                lastSeenPulsePid = snap.pulse.pid;
                seenPacketIds.add(snap.pulse.pid);
            }
            const remAccounts = snap.accounts && typeof snap.accounts === 'object' ? Object.values(snap.accounts) : [];
            const remMeta = snap.meta || {};
            applyIncomingRealtimeEvent({
                type: 'rs_sync_v12',
                pid: 'boot_' + Date.now(),
                op: remMeta.latestMail ? 'mail_broadcast' : 'state_sync',
                meta: remMeta,
                seasonState: remMeta.seasonState || null,
                mail: remMeta.latestMail || null,
                accounts: remAccounts
            }, true);
        }
        setRealtimeStatusUI('live');
        if (sendPushAfter && activeAccount) {
            await fbRequest(`/accounts/${activeAccount.uid}`, 'PUT', packAccountForSync(activeAccount));
        }
    } catch (e) {
        setRealtimeStatusUI('local');
    } finally {
        isPullingCloud = false;
    }
}

// Connects to Firebase's tiny 80-byte /pulse.json via SSE stream + quota-safe fallback check
function connectRealtimeStream() {
    if (isPortalExiting) return;
    if (!FB_BASE_URL) {
        setRealtimeStatusUI('local');
        return;
    }
    if (!rtPollTimer) {
        rtPollTimer = setInterval(async () => {
            if (isPortalExiting || document.hidden || !FB_BASE_URL) return;
            const pulse = await fbRequest('/pulse', 'GET', null, 3000);
            if (pulse && pulse.pid && pulse.pid !== lastSeenPulsePid) {
                await handleFirebasePulse(pulse);
            }
        }, 10000);
    }
    if (typeof EventSource === 'undefined') return;
    if (rtEventSource) { try { rtEventSource.close(); } catch (e) {} rtEventSource = null; }
    try {
        rtEventSource = new EventSource(`${FB_BASE_URL}/pulse.json`);
        rtEventSource.onopen = () => setRealtimeStatusUI('live');
        rtEventSource.addEventListener('put', ev => {
            try {
                const payload = JSON.parse(ev.data);
                if (payload && payload.data) handleFirebasePulse(payload.data);
            } catch (e) {}
        });
        rtEventSource.onerror = () => {
            try { rtEventSource.close(); } catch (e) {}
            rtEventSource = null;
            if (rtReconnectTimer) clearTimeout(rtReconnectTimer);
            rtReconnectTimer = setTimeout(connectRealtimeStream, 8000);
        };
    } catch (e) {}
}

function forceManualCloudSync() {
    pullCloudHistoryAndSync(true);
    showToast(FB_BASE_URL ? 'Syncing Firebase 24/7 DB...' : 'Synced Local IndexedDB.', 'info');
    playSfx('uiClick');
}

if (localBc) localBc.onmessage = ev => { if (ev && ev.data) applyIncomingRealtimeEvent(ev.data, false); };

window.addEventListener('storage', ev => {
    if (!ev || !ev.key) return;
    if ([STORAGE_ACCOUNTS_KEY, STORAGE_LB_ALL_KEY, STORAGE_LB_SEASON_KEY, STORAGE_SYNC_META_KEY].includes(ev.key)) {
        const freshAcc = lsGetJson(STORAGE_ACCOUNTS_KEY, null);
        if (freshAcc && typeof freshAcc === 'object') {
            accountsCache = freshAcc; validateAndSanitizeDatabase();
            if (activeAccount) {
                if (accountsCache[activeAccount.uid]) activeAccount = accountsCache[activeAccount.uid];
                else { activeAccount = null; lsRemove(STORAGE_ACTIVE_UID_KEY); returnToMainMenu(); }
            }
        }
        const freshAll = lsGetJson(STORAGE_LB_ALL_KEY, null); if (Array.isArray(freshAll)) lbAllCache = freshAll;
        const freshSea = lsGetJson(STORAGE_LB_SEASON_KEY, null); if (freshSea && typeof freshSea === 'object') lbSeasonCache = freshSea;
        refreshAllLiveViews();
    }
});

// =========================================================================
// 8. ALL-TIME #1 CHAMPION, SEASON LIFECYCLE & LEADERBOARD RECORDING
// =========================================================================
function getAllTimeTop1Uid() {
    lbAllCache.sort((a, b) => b.score - a.score);
    const top = lbAllCache[0];
    return (top && Number(top.score) > 0) ? top.uid : null;
}
function hasNitroSkinUnlocked(acc, skinId) {
    if (skinId === 'standard') return true;
    if (!acc) return false;
    if (acc.isDev) return true;
    if (skinId === 'void_chroma') { const top1Uid = getAllTimeTop1Uid(); return Boolean(top1Uid && top1Uid === acc.uid); }
    const st = seasonStatusCache;
    return (acc.seasonalSkins || []).some(sk =>
        sk.skinId === skinId && sk.claimed && !sk.expired &&
        ((st.phase === 'ACTIVE' && sk.validForSeason === st.seasonNum) || (st.phase === 'GAP' && sk.validForSeason === st.seasonNum + 1))
    );
}
function getSkinStatusLabel(acc, skinId) {
    if (skinId === 'standard') return 'Permanent';
    if (acc && acc.isDev) return 'Dev Unlimited';
    if (skinId === 'void_chroma') return hasNitroSkinUnlocked(acc, 'void_chroma') ? '👑 All-Time #1 Active' : 'All-Time #1 Exclusive';
    if (!acc) return 'Top 5 Season Reward';
    const st = seasonStatusCache;
    const sk = (acc.seasonalSkins || []).find(x => x.skinId === skinId && x.claimed && !x.expired && ((st.phase === 'ACTIVE' && x.validForSeason === st.seasonNum) || (st.phase === 'GAP' && x.validForSeason === st.seasonNum + 1)));
    return sk ? `Active • Expires End of S${sk.validForSeason}` : 'Top 5 Season Reward';
}
function reconcileAllTimeChampion() {
    const newChampUid = getAllTimeTop1Uid(), prevChampUid = lsGet(STORAGE_ALLTIME_CHAMP, '') || '';
    let mod = false;
    if (newChampUid !== prevChampUid) {
        if (prevChampUid && accountsCache[prevChampUid] && !accountsCache[prevChampUid].isDev) {
            const pAcc = accountsCache[prevChampUid];
            if (pAcc.custom.nitroSkin === 'void_chroma') pAcc.custom.nitroSkin = 'standard';
            pushMail(pAcc, { title: 'All-Time #1 Crown Claimed by Rival', sender: 'SYSTEM', body: 'Another pilot took #1 on the All-Time leaderboard. Reclaim #1 All-Time to re-unlock Void Prismatic FX!' });
            mod = true;
        }
        if (newChampUid && accountsCache[newChampUid]) {
            pushMail(accountsCache[newChampUid], { title: '👑 All-Time #1: Void Prismatic FX Unlocked!', sender: 'HALL OF FAME', body: 'You hold #1 on the All-Time leaderboard! Void Prismatic FX (All-in-One Chroma + Singularity Afterburner) is now unlocked in your Garage.' });
            mod = true;
        }
        if (newChampUid) lsSet(STORAGE_ALLTIME_CHAMP, newChampUid); else lsRemove(STORAGE_ALLTIME_CHAMP);
    }
    Object.values(accountsCache).forEach(acc => {
        if (!acc.isDev && acc.custom.nitroSkin === 'void_chroma' && acc.uid !== newChampUid) { acc.custom.nitroSkin = 'standard'; mod = true; }
    });
    if (mod) saveAccountsCache();
}
function formatCountdown(ms) {
    const sec = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (d > 0) return `${d}d ${String(h).padStart(2, '0')}h`;
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
    return `${m}m ${String(s).padStart(2, '0')}s`;
}
function pushMail(acc, { title, sender = 'SYSTEM', body, reward = null, id = null }) {
    if (!acc) return;
    if (!Array.isArray(acc.inbox)) acc.inbox = [];
    const mid = id || ('m_' + Date.now() + '_' + Math.floor(Math.random() * 1e6));
    acc.inbox.unshift({ id: mid, title, sender, body, ts: Date.now(), read: false, reward });
    if (acc.inbox.length > 50) acc.inbox.length = 50;
}
function pushMailAll(spec) {
    const mailObj = { id: 'm_' + Date.now() + '_' + Math.floor(Math.random() * 1e6), title: spec.title, sender: spec.sender || 'SYSTEM', body: spec.body, ts: Date.now(), read: false, reward: null };
    Object.values(accountsCache).forEach(acc => pushMail(acc, mailObj));
    saveAccountsCache(); return mailObj;
}
function syncSeasonLifecycle() {
    seasonStatusCache = computeSeasonStatus();
    const st = seasonStatusCache; let changed = false;
    const targetFinalized = (st.phase === 'GAP') ? st.seasonNum : (st.seasonNum - 1);
    while (seasonStateCache.lastFinalizedSeason < targetFinalized) { const ended = seasonStateCache.lastFinalizedSeason + 1; finalizeSeason(ended); seasonStateCache.lastFinalizedSeason = ended; changed = true; }
    if (st.phase === 'ACTIVE' && seasonStateCache.lastAnnouncedSeason < st.seasonNum) {
        const feat = getSeasonFeaturedSkin(st.seasonNum);
        pushMailAll({ title: `Season ${st.seasonNum} Started`, sender: 'SEASON ENGINE', body: `Season ${st.seasonNum} is live for 3 days (followed by a 1-day off-season gap).\n\nFinish Top 5 in Season ${st.seasonNum} to unlock "${feat.name}" (All-in-One Chroma) for Season ${st.seasonNum + 1}. Hold #1 All-Time to wield Void Prismatic FX!` });
        seasonStateCache.lastAnnouncedSeason = st.seasonNum; changed = true;
    }
    if (changed) { saveSeasonState(); refreshSeasonUI(); refreshInboxBadgeUI(); }
}
function finalizeSeason(endedSeason) {
    const sLb = getSeasonLbFor(endedSeason), rewardSkin = getSeasonFeaturedSkin(endedSeason), nextSeason = endedSeason + 1;
    const top5 = new Map(); sLb.slice(0, 5).forEach((e, i) => top5.set(e.uid, { rank: i + 1, score: e.score }));
    Object.values(accountsCache).forEach(acc => {
        if (!acc.isDev && Array.isArray(acc.seasonalSkins)) {
            const expNames = [];
            acc.seasonalSkins.forEach(sk => { if (!sk.expired && sk.validForSeason <= endedSeason) { sk.expired = true; const m = SEASON_FX_SKINS.find(x => x.id === sk.skinId); expNames.push(m ? m.name : sk.skinId); } });
            if (expNames.length) {
                if (acc.custom.nitroSkin !== 'standard' && !hasNitroSkinUnlocked(acc, acc.custom.nitroSkin)) acc.custom.nitroSkin = 'standard';
                pushMail(acc, { title: `Seasonal Skin Expired (S${endedSeason})`, sender: 'GARAGE', body: `Your seasonal reward (${expNames.join(', ')}) expired at the end of Season ${endedSeason}.` });
            }
        }
        const win = top5.get(acc.uid);
        if (win) {
            if (!Array.isArray(acc.seasonalSkins)) acc.seasonalSkins = [];
            acc.seasonalSkins.push({ skinId: rewardSkin.id, wonSeason: endedSeason, validForSeason: nextSeason, claimed: false, expired: false, rank: win.rank });
            pushMail(acc, {
                title: `🏆 Season ${endedSeason} Top 5 (#${win.rank})`, sender: 'REWARDS',
                body: `Finished #${win.rank} in Season ${endedSeason} (${win.score.toLocaleString()} pts).\nClaim "${rewardSkin.name}" (All-in-One Chroma) below — active for Season ${nextSeason}.`,
                reward: { skinId: rewardSkin.id, skinName: rewardSkin.name, wonSeason: endedSeason, validForSeason: nextSeason, rank: win.rank, claimed: false }
            });
        }
        const rankIdx = sLb.findIndex(e => e.uid === acc.uid), pts = (acc.stats.seasonScores && acc.stats.seasonScores[endedSeason]) || 0;
        pushMail(acc, { title: `Season ${endedSeason} Ended`, sender: 'SEASON ENGINE', body: `${rankIdx >= 0 ? `Final Rank: #${rankIdx + 1} (${pts.toLocaleString()} pts)` : 'No ranked runs recorded.'}\n\n24h Off-Season Gap is now active before Season ${nextSeason}.` });
    });
    saveAccountsCache();
}
function syncAccountMetaInLeaderboards(acc) {
    if (!acc) return;
    let modAll = false, modS = false;
    lbAllCache.forEach(e => { if (e.uid === acc.uid) { e.name = acc.name; e.tag = acc.tag; e.accent = acc.custom.bodySecondary; e.skinId = acc.custom.nitroSkin; e.isPrism = acc.custom.nitroSkin === 'void_chroma'; modAll = true; } });
    Object.values(lbSeasonCache).forEach(arr => { if (!Array.isArray(arr)) return; arr.forEach(e => { if (e.uid === acc.uid) { e.name = acc.name; e.tag = acc.tag; e.accent = acc.custom.bodySecondary; e.skinId = acc.custom.nitroSkin; e.isPrism = acc.custom.nitroSkin === 'void_chroma'; modS = true; } }); });
    if (modAll) saveLbAll(); if (modS) saveLbSeason();
}
function recordScoreToLeaderboards(acc, scoreVal, epochVal) {
    if (!acc || scoreVal <= 0) return;
    const st = seasonStatusCache, nowTs = Date.now();
    const entry = { uid: acc.uid, name: acc.name, tag: acc.tag, isDev: acc.isDev, score: scoreVal, epoch: epochVal, accent: acc.custom.bodySecondary, skinId: acc.custom.nitroSkin, isPrism: acc.custom.nitroSkin === 'void_chroma', ts: nowTs };
    const sNum = st.phase === 'ACTIVE' ? st.seasonNum : 0, sScore = sNum ? (acc.stats.seasonScores[sNum] || scoreVal) : 0;
    mergeScoreEntryLocally(entry, sNum, sScore);
    reconcileAllTimeChampion(); updateTopLeaderBanner();
    publishRealtimeEvent('score_record', { entry, sNum, sScore });
}
function removeUidFromLeaderboards(uid) {
    lbAllCache = lbAllCache.filter(e => e.uid !== uid); saveLbAll();
    Object.keys(lbSeasonCache).forEach(k => { if (Array.isArray(lbSeasonCache[k])) lbSeasonCache[k] = lbSeasonCache[k].filter(e => e.uid !== uid); });
    saveLbSeason(); reconcileAllTimeChampion(); updateTopLeaderBanner();
}

// =========================================================================
// 9. AUDIO ENGINE & INDEXEDDB ARRAYBUFFER SONG STORAGE
// =========================================================================
let audioCtx = null, compressorNode = null, masterGain = null, musicBus = null, sfxBus = null;
let engineOsc1 = null, engineOsc2 = null, engineSub = null, engineTurbo = null, engineFilter = null, engineGain = null, engineTurboGain = null, engineLfo = null, engineLfoGain = null;
let musicSchedId = null, synthStep = 0, menuStep = 0, nextGameNoteT = 0, nextMenuNoteT = 0;
const lastSfxTs = {};

const MENU_ARP  = [293.66, 349.23, 440.00, 587.33, 523.25, 440.00, 349.23, 293.66, 261.63, 349.23, 440.00, 523.25, 440.00, 349.23, 329.63, 293.66];
const MENU_BASS = [73.42, 73.42, 87.31, 87.31, 65.41, 65.41, 110.00, 98.00];
const GAME_BASS = [73.42, 73.42, 146.83, 73.42, 87.31, 87.31, 98.00, 110.00, 73.42, 73.42, 146.83, 73.42, 116.54, 116.54, 110.00, 98.00];
const GAME_ARP  = [293.66, 349.23, 440.00, 587.33, 523.25, 440.00, 349.23, 440.00, 293.66, 349.23, 466.16, 587.33, 659.25, 587.33, 440.00, 349.23];

const mitadruAudio = new Audio();
mitadruAudio.preload = 'none'; mitadruAudio.loop = true;
mitadruAudio.addEventListener('error', () => {
    if (globalSettings.audio.ostMode === 'mitadru') {
        globalSettings.audio.ostMode = 'synth'; syncOstButtonsUI(); saveGlobalSettings();
        showToast('Mitadru.m4a not found locally — using Cyber-Synth.');
    }
});

const customAudio = new Audio(); customAudio.loop = true;
let customSongObjUrl = null;

function isAppAudible() { return document.visibilityState !== 'hidden' && !document.hidden && !isPortalExiting; }
function safeGain(v) { return Number.isFinite(v) ? Math.max(0.0005, Math.min(1.5, v)) : 0.0005; }
function safeFreq(f) { return Number.isFinite(f) ? Math.max(20, Math.min(18000, f)) : 220; }

function ensureAudioEngine() {
    if (!hasTrustedGesture || isPortalExiting) return null;
    try {
        if (!audioCtx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return null;
            audioCtx = new AC();
            compressorNode = audioCtx.createDynamicsCompressor();
            compressorNode.threshold.setValueAtTime(-12, audioCtx.currentTime);
            compressorNode.knee.setValueAtTime(18, audioCtx.currentTime);
            compressorNode.ratio.setValueAtTime(6, audioCtx.currentTime);
            compressorNode.attack.setValueAtTime(0.003, audioCtx.currentTime);
            compressorNode.release.setValueAtTime(0.15, audioCtx.currentTime);

            masterGain = audioCtx.createGain();
            masterGain.gain.setValueAtTime(Math.max(0.0001, globalSettings.audio.master), audioCtx.currentTime);
            musicBus = audioCtx.createGain(); musicBus.gain.setValueAtTime(0.75, audioCtx.currentTime);
            sfxBus = audioCtx.createGain(); sfxBus.gain.setValueAtTime(0.80, audioCtx.currentTime);
            musicBus.connect(compressorNode); sfxBus.connect(compressorNode);
            compressorNode.connect(masterGain); masterGain.connect(audioCtx.destination);

            engineOsc1 = audioCtx.createOscillator(); engineOsc2 = audioCtx.createOscillator();
            engineSub = audioCtx.createOscillator(); engineTurbo = audioCtx.createOscillator();
            engineLfo = audioCtx.createOscillator(); engineFilter = audioCtx.createBiquadFilter();
            engineGain = audioCtx.createGain(); engineTurboGain = audioCtx.createGain(); engineLfoGain = audioCtx.createGain();

            engineOsc1.type = 'sawtooth'; engineOsc2.type = 'sawtooth'; engineSub.type = 'square';
            engineTurbo.type = 'triangle'; engineLfo.type = 'sine';
            const t0 = audioCtx.currentTime;
            engineOsc1.frequency.setValueAtTime(85, t0); engineOsc2.frequency.setValueAtTime(127.5, t0);
            engineSub.frequency.setValueAtTime(42.5, t0); engineTurbo.frequency.setValueAtTime(420, t0);
            engineLfo.frequency.setValueAtTime(28, t0); engineLfoGain.gain.setValueAtTime(14, t0);

            engineLfo.connect(engineLfoGain); engineLfoGain.connect(engineOsc1.frequency); engineLfoGain.connect(engineOsc2.frequency);
            engineFilter.type = 'lowpass'; engineFilter.frequency.setValueAtTime(720, t0); engineFilter.Q.setValueAtTime(2.8, t0);
            engineGain.gain.setValueAtTime(0.0001, t0); engineTurboGain.gain.setValueAtTime(0.0001, t0);

            engineOsc1.connect(engineFilter); engineOsc2.connect(engineFilter); engineSub.connect(engineFilter);
            engineFilter.connect(engineGain); engineGain.connect(sfxBus);
            engineTurbo.connect(engineTurboGain); engineTurboGain.connect(sfxBus);
            engineOsc1.start(t0); engineOsc2.start(t0); engineSub.start(t0); engineTurbo.start(t0); engineLfo.start(t0);
        }
        if (isAppAudible() && audioCtx.state !== 'running') {
            audioCtx.resume().then(() => {
                if (!audioCtx) return;
                nextGameNoteT = audioCtx.currentTime + 0.02; nextMenuNoteT = audioCtx.currentTime + 0.02;
                tickMusicScheduler();
            }).catch(() => {});
        }
        return audioCtx;
    } catch (e) { return null; }
}

function updateEnginePitch() {
    if (!audioCtx || audioCtx.state !== 'running' || !engineGain) return;
    try {
        const now = audioCtx.currentTime, vol = globalSettings.audio.engine;
        if (!gameState.running || gameState.paused || !isAppAudible() || globalSettings.audio.master <= 0.01 || vol <= 0.01) {
            engineGain.gain.setTargetAtTime(0.0001, now, 0.04); engineTurboGain.gain.setTargetAtTime(0.0001, now, 0.04); return;
        }
        const r = Math.max(0.75, Math.min(2.4, (Number(gameState.speedMps) || 24) / 24));
        const hz = safeFreq(78 * r + (gameState.boosting ? 46 : (gameState.braking ? -18 : 0)));
        engineOsc1.frequency.setTargetAtTime(hz, now, 0.04);
        engineOsc2.frequency.setTargetAtTime(safeFreq(hz * 1.498), now, 0.04);
        engineSub.frequency.setTargetAtTime(safeFreq(hz * 0.5), now, 0.04);
        engineLfo.frequency.setTargetAtTime(gameState.boosting ? 44 : 26 * r, now, 0.05);
        engineFilter.frequency.setTargetAtTime(gameState.boosting ? 2400 : (gameState.braking ? 480 : 780 * r), now, 0.05);
        engineFilter.Q.setTargetAtTime(gameState.boosting ? 4.2 : 2.6, now, 0.05);
        engineGain.gain.setTargetAtTime(safeGain(vol * (gameState.boosting ? 0.38 : (gameState.braking ? 0.18 : 0.25))), now, 0.05);
        engineTurbo.frequency.setTargetAtTime(safeFreq(gameState.boosting ? (560 + r * 220) : (280 + r * 90)), now, 0.06);
        engineTurboGain.gain.setTargetAtTime(safeGain(vol * (gameState.boosting ? 0.20 : 0.02)), now, 0.06);
    } catch (e) {}
}

function scheduleMenuNote(t) {
    const v = globalSettings.audio.menuMusic;
    if (!audioCtx || audioCtx.state !== 'running' || globalSettings.audio.master <= 0.01 || v <= 0.01) return;
    try {
        const i = menuStep % 16, n = MENU_ARP[i];
        const o1 = audioCtx.createOscillator(), o2 = audioCtx.createOscillator(), g = audioCtx.createGain();
        o1.type = 'triangle'; o2.type = 'sine'; o1.frequency.setValueAtTime(n, t); o2.frequency.setValueAtTime(n * 0.5, t);
        g.gain.setValueAtTime(0.0005, t); g.gain.linearRampToValueAtTime(safeGain(0.22 * v), t + 0.008); g.gain.exponentialRampToValueAtTime(0.0005, t + 0.195);
        o1.connect(g); o2.connect(g); g.connect(musicBus); o1.start(t); o2.start(t); o1.stop(t + 0.205); o2.stop(t + 0.205);
        if (i % 2 === 0) {
            const b = audioCtx.createOscillator(), f = audioCtx.createBiquadFilter(), bg = audioCtx.createGain();
            b.type = 'sawtooth'; b.frequency.setValueAtTime(MENU_BASS[(i >> 1) % MENU_BASS.length], t); f.type = 'lowpass'; f.frequency.setValueAtTime(380, t);
            bg.gain.setValueAtTime(0.0005, t); bg.gain.linearRampToValueAtTime(safeGain(0.18 * v), t + 0.008); bg.gain.exponentialRampToValueAtTime(0.0005, t + 0.205);
            b.connect(f); f.connect(bg); bg.connect(musicBus); b.start(t); b.stop(t + 0.215);
        }
        menuStep++;
    } catch (e) {}
}

function scheduleGameNote(t) {
    const v = globalSettings.audio.music;
    if (!audioCtx || audioCtx.state !== 'running' || globalSettings.audio.ostMode !== 'synth' || globalSettings.audio.master <= 0.01 || v <= 0.01) return;
    try {
        const i = synthStep % 16;
        if (i % 4 === 0) {
            const k = audioCtx.createOscillator(), kg = audioCtx.createGain();
            k.type = 'sine'; k.frequency.setValueAtTime(146.83, t); k.frequency.exponentialRampToValueAtTime(36.71, t + 0.13);
            kg.gain.setValueAtTime(0.0005, t); kg.gain.linearRampToValueAtTime(safeGain(0.42 * v), t + 0.005); kg.gain.exponentialRampToValueAtTime(0.0005, t + 0.14);
            k.connect(kg); kg.connect(musicBus); k.start(t); k.stop(t + 0.145);
        } else if (i % 4 === 2) {
            const s = audioCtx.createOscillator(), sg = audioCtx.createGain();
            s.type = 'triangle'; s.frequency.setValueAtTime(220, t); s.frequency.exponentialRampToValueAtTime(73.42, t + 0.085);
            sg.gain.setValueAtTime(0.0005, t); sg.gain.linearRampToValueAtTime(safeGain(0.20 * v), t + 0.005); sg.gain.exponentialRampToValueAtTime(0.0005, t + 0.09);
            s.connect(sg); sg.connect(musicBus); s.start(t); s.stop(t + 0.095);
        }
        const b = audioCtx.createOscillator(), bf = audioCtx.createBiquadFilter(), bg = audioCtx.createGain();
        b.type = 'sawtooth'; b.frequency.setValueAtTime(GAME_BASS[i], t); bf.type = 'lowpass'; bf.frequency.setValueAtTime(680, t);
        bg.gain.setValueAtTime(0.0005, t); bg.gain.linearRampToValueAtTime(safeGain(0.28 * v), t + 0.006); bg.gain.exponentialRampToValueAtTime(0.001, t + 0.11);
        b.connect(bf); bf.connect(bg); bg.connect(musicBus); b.start(t); b.stop(t + 0.115);

        const l1 = audioCtx.createOscillator(), l2 = audioCtx.createOscillator(), lg = audioCtx.createGain();
        l1.type = 'sawtooth'; l2.type = 'triangle'; l1.frequency.setValueAtTime(GAME_ARP[i], t); l2.frequency.setValueAtTime(GAME_ARP[i] * 1.004, t);
        lg.gain.setValueAtTime(0.0005, t); lg.gain.linearRampToValueAtTime(safeGain(0.20 * v), t + 0.006); lg.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
        l1.connect(lg); l2.connect(lg); lg.connect(musicBus); l1.start(t); l2.start(t); l1.stop(t + 0.135); l2.stop(t + 0.135);
        synthStep++;
    } catch (e) {}
}

function tickMusicScheduler() {
    if (!isAppAudible() || !hasTrustedGesture || !isBootSplashDismissed || globalSettings.audio.master <= 0.01) return;
    if (!audioCtx || audioCtx.state !== 'running') return;
    const now = audioCtx.currentTime;
    if (!gameState.running || gameState.paused) {
        if (nextMenuNoteT < now - 0.05 || nextMenuNoteT > now + 1.0) nextMenuNoteT = now + 0.02;
        let g = 0; while (nextMenuNoteT < now + 0.22 && g++ < 4) { scheduleMenuNote(nextMenuNoteT); nextMenuNoteT += 0.135; }
        nextGameNoteT = 0;
    } else if (globalSettings.audio.ostMode === 'synth') {
        if (nextGameNoteT < now - 0.05 || nextGameNoteT > now + 1.0) nextGameNoteT = now + 0.02;
        let g = 0; while (nextGameNoteT < now + 0.22 && g++ < 4) { scheduleGameNote(nextGameNoteT); nextGameNoteT += 0.1171875; }
        nextMenuNoteT = 0;
    }
}

function startMusicScheduler() {
    if (musicSchedId) clearInterval(musicSchedId);
    musicSchedId = setInterval(tickMusicScheduler, 32);
}

function syncExternalTracks() {
    const play = gameState.running && !gameState.paused && isAppAudible();
    const vol = Math.max(0, Math.min(1, globalSettings.audio.master * globalSettings.audio.music));
    mitadruAudio.volume = vol; customAudio.volume = vol;
    if (!play) { mitadruAudio.pause(); customAudio.pause(); return; }
    if (globalSettings.audio.ostMode === 'mitadru') {
        customAudio.pause();
        if (!mitadruAudio.src || mitadruAudio.src === window.location.href) mitadruAudio.src = 'Mitadru.m4a';
        mitadruAudio.play().catch(() => {});
    } else if (globalSettings.audio.ostMode === 'custom') {
        mitadruAudio.pause();
        if (customAudio.src) customAudio.play().catch(() => {});
    } else { mitadruAudio.pause(); customAudio.pause(); }
}

function playSfx(type) {
    if (globalSettings.audio.master <= 0.01 || !isAppAudible() || !hasTrustedGesture || !isBootSplashDismissed) return;
    const np = performance.now();
    if (lastSfxTs[type] && np - lastSfxTs[type] < 50) return;
    lastSfxTs[type] = np;
    const actx = ensureAudioEngine();
    if (!actx || actx.state !== 'running') return;
    try {
        const now = actx.currentTime, sv = globalSettings.audio.sfx, cv = globalSettings.audio.uiClick;
        if (type === 'uiClick') {
            if (cv <= 0.01) return;
            const o = actx.createOscillator(), g = actx.createGain();
            o.type = 'sine'; o.frequency.setValueAtTime(587.33, now); o.frequency.exponentialRampToValueAtTime(880, now + 0.045);
            g.gain.setValueAtTime(0.0005, now); g.gain.linearRampToValueAtTime(safeGain(0.11 * cv), now + 0.005); g.gain.exponentialRampToValueAtTime(0.0005, now + 0.05);
            o.connect(g); g.connect(sfxBus); o.start(now); o.stop(now + 0.055);
            return;
        }
        if (sv <= 0.01) return;
        if (type === 'steer') {
            const o = actx.createOscillator(), g = actx.createGain();
            o.type = 'sine'; o.frequency.setValueAtTime(349.23, now); o.frequency.exponentialRampToValueAtTime(587.33, now + 0.05);
            g.gain.setValueAtTime(0.0005, now); g.gain.linearRampToValueAtTime(safeGain(0.11 * sv), now + 0.005); g.gain.exponentialRampToValueAtTime(0.0005, now + 0.055);
            o.connect(g); g.connect(sfxBus); o.start(now); o.stop(now + 0.06);
        } else if (type === 'nitro') {
            const r1 = actx.createOscillator(), r2 = actx.createOscillator(), rf = actx.createBiquadFilter(), rg = actx.createGain();
            r1.type = 'sawtooth'; r2.type = 'square'; r1.frequency.setValueAtTime(95, now); r1.frequency.exponentialRampToValueAtTime(240, now + 0.34);
            r2.frequency.setValueAtTime(48, now); r2.frequency.exponentialRampToValueAtTime(120, now + 0.34);
            rf.type = 'lowpass'; rf.frequency.setValueAtTime(450, now); rf.frequency.exponentialRampToValueAtTime(2600, now + 0.28); rf.Q.setValueAtTime(3.5, now);
            rg.gain.setValueAtTime(0.0005, now); rg.gain.linearRampToValueAtTime(safeGain(0.28 * sv), now + 0.015); rg.gain.exponentialRampToValueAtTime(0.0005, now + 0.38);
            r1.connect(rf); r2.connect(rf); rf.connect(rg); rg.connect(sfxBus); r1.start(now); r2.start(now); r1.stop(now + 0.39); r2.stop(now + 0.39);
            const sp = actx.createOscillator(), sg = actx.createGain();
            sp.type = 'triangle'; sp.frequency.setValueAtTime(320, now); sp.frequency.exponentialRampToValueAtTime(980, now + 0.32);
            sg.gain.setValueAtTime(0.0005, now); sg.gain.linearRampToValueAtTime(safeGain(0.16 * sv), now + 0.02); sg.gain.exponentialRampToValueAtTime(0.0005, now + 0.35);
            sp.connect(sg); sg.connect(sfxBus); sp.start(now); sp.stop(now + 0.36);
        } else if (type === 'pickup') {
            [587.33, 880, 1174.66].forEach((f, idx) => { const o = actx.createOscillator(), g = actx.createGain(), st = now + idx * 0.035; o.type = 'sine'; o.frequency.setValueAtTime(f, st); g.gain.setValueAtTime(0.0005, st); g.gain.linearRampToValueAtTime(safeGain(0.15 * sv), st + 0.005); g.gain.exponentialRampToValueAtTime(0.0005, st + 0.14); o.connect(g); g.connect(sfxBus); o.start(st); o.stop(st + 0.145); });
        } else if (type === 'phantom') {
            [587.33, 698.46, 880, 1174.66].forEach((f, idx) => { const o = actx.createOscillator(), g = actx.createGain(), st = now + idx * 0.03; o.type = 'triangle'; o.frequency.setValueAtTime(f, st); g.gain.setValueAtTime(0.0005, st); g.gain.linearRampToValueAtTime(safeGain(0.15 * sv), st + 0.005); g.gain.exponentialRampToValueAtTime(0.0005, st + 0.22); o.connect(g); g.connect(sfxBus); o.start(st); o.stop(st + 0.225); });
        } else if (type === 'emp') {
            const o1 = actx.createOscillator(), o2 = actx.createOscillator(), g = actx.createGain();
            o1.type = 'sawtooth'; o2.type = 'triangle'; o1.frequency.setValueAtTime(880, now); o1.frequency.exponentialRampToValueAtTime(73.42, now + 0.52);
            o2.frequency.setValueAtTime(1174.66, now); o2.frequency.exponentialRampToValueAtTime(146.83, now + 0.52);
            g.gain.setValueAtTime(0.0005, now); g.gain.linearRampToValueAtTime(safeGain(0.20 * sv), now + 0.008); g.gain.exponentialRampToValueAtTime(0.0005, now + 0.55);
            o1.connect(g); o2.connect(g); g.connect(sfxBus); o1.start(now); o2.start(now); o1.stop(now + 0.56); o2.stop(now + 0.56);
        } else if (type === 'siren250') {
            for (let c = 0; c < 6; c++) { const st = now + c * 0.5, o = actx.createOscillator(), g = actx.createGain(); o.type = 'triangle'; o.frequency.setValueAtTime(440, st); o.frequency.linearRampToValueAtTime(880, st + 0.25); o.frequency.linearRampToValueAtTime(440, st + 0.48); g.gain.setValueAtTime(0.0005, st); g.gain.linearRampToValueAtTime(safeGain(0.20 * sv), st + 0.01); g.gain.exponentialRampToValueAtTime(0.0005, st + 0.49); o.connect(g); g.connect(sfxBus); o.start(st); o.stop(st + 0.495); }
        } else if (type === 'hit') {
            if (!actx._crashBuf) { const len = Math.floor(actx.sampleRate * 0.45), buf = actx.createBuffer(1, len, actx.sampleRate), d = buf.getChannelData(0); for (let i = 0; i < len; i++) d[i] = Math.tanh((Math.random() * 2 - 1) * 2.2) * Math.pow(1 - i / len, 0.55); actx._crashBuf = buf; }
            const n1 = actx.createBufferSource(); n1.buffer = actx._crashBuf;
            const f1 = actx.createBiquadFilter(); f1.type = 'bandpass'; f1.frequency.setValueAtTime(1850, now); f1.frequency.exponentialRampToValueAtTime(320, now + 0.32); f1.Q.setValueAtTime(1.4, now);
            const g1 = actx.createGain(); g1.gain.setValueAtTime(safeGain(0.46 * sv), now); g1.gain.exponentialRampToValueAtTime(0.0005, now + 0.34);
            n1.connect(f1); f1.connect(g1); g1.connect(sfxBus); n1.start(now); n1.stop(now + 0.35);

            const n2 = actx.createBufferSource(); n2.buffer = actx._crashBuf;
            const f2 = actx.createBiquadFilter(); f2.type = 'highpass'; f2.frequency.setValueAtTime(3200, now);
            const g2 = actx.createGain(); g2.gain.setValueAtTime(safeGain(0.26 * sv), now); g2.gain.exponentialRampToValueAtTime(0.0005, now + 0.11);
            n2.connect(f2); f2.connect(g2); g2.connect(sfxBus); n2.start(now); n2.stop(now + 0.12);

            const p = actx.createOscillator(), pg = actx.createGain();
            p.type = 'sine'; p.frequency.setValueAtTime(165, now); p.frequency.exponentialRampToValueAtTime(28, now + 0.26);
            pg.gain.setValueAtTime(safeGain(0.50 * sv), now); pg.gain.exponentialRampToValueAtTime(0.0005, now + 0.28);
            p.connect(pg); pg.connect(sfxBus); p.start(now); p.stop(now + 0.29);
        }
    } catch (e) {}
}

function silenceAllAudio() {
    mitadruAudio.pause(); customAudio.pause();
    if (audioCtx && audioCtx.state === 'running') audioCtx.suspend().catch(() => {});
    updateEqVisuals(false);
}
function resumeAudioForeground() {
    if (!isAppAudible() || !isBootSplashDismissed) return;
    if (hasTrustedGesture) ensureAudioEngine();
    syncExternalTracks(); updateEnginePitch(); updateEqVisuals(gameState.running && !gameState.paused);
}
function updateEqVisuals(playing) {
    const on = playing && globalSettings.audio.master > 0.01 && globalSettings.audio.music > 0.01;
    document.querySelectorAll('.eq-bar').forEach(b => b.classList.toggle('eq-paused', !on));
}

function unlockAudioFromUserGesture(e) {
    if (e && e.isTrusted) {
        hasTrustedGesture = true;
        if (isBootSplashDismissed) {
            const actx = ensureAudioEngine();
            if (actx && actx.state === 'running') tickMusicScheduler();
        }
    }
}
['click', 'touchend', 'keydown'].forEach(evt => window.addEventListener(evt, unlockAudioFromUserGesture, { capture: true, passive: true }));

// Stores ArrayBuffer + mimeType in IndexedDB so iOS Safari, Android, and PC all play uploaded songs reliably!
async function handleCustomSongUpload(files) {
    if (!activeAccount || !files || !files[0]) return;
    const f = files[0], inp = document.getElementById('customSongFileInput');
    if (inp) inp.value = '';
    if (f.size > 20 * 1024 * 1024) { setTextCached('customSongStatusText', '✕ Exceeds 20 MB'); showToast('Track exceeds 20 MB limit.', 'err'); playSfx('hit'); return; }
    try {
        const arrayBuf = await f.arrayBuffer();
        const mimeType = f.type || 'audio/mpeg';
        const db = await openLocalIDB();
        await new Promise((res, rej) => {
            const tx = db.transaction('songs', 'readwrite');
            tx.objectStore('songs').put({
                uid: activeAccount.uid,
                pilotName: `${activeAccount.name} #${activeAccount.tag}`,
                fileName: f.name,
                sizeBytes: f.size,
                mimeType,
                buffer: arrayBuf,
                ts: Date.now()
            });
            tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
        });
        await loadCustomSongForActiveAccount(); selectOstMode('custom');
        showToast(`Loaded track into IndexedDB: ${f.name}`, 'ok'); playSfx('pickup');
    } catch (e) { setTextCached('customSongStatusText', '✕ Upload failed'); showToast('Track upload failed.', 'err'); }
}
async function loadCustomSongForActiveAccount() {
    const stEl = document.getElementById('customSongStatusText'), subEl = document.getElementById('customOstBtnSub'), rmBtn = document.getElementById('removeMyCustomSongBtn');
    if (customSongObjUrl) { URL.revokeObjectURL(customSongObjUrl); customSongObjUrl = null; }
    if (!activeAccount) {
        customAudio.pause(); customAudio.removeAttribute('src');
        if (stEl) stEl.innerText = 'Custom Track (≤ 20 MB)'; if (subEl) subEl.innerText = 'None'; if (rmBtn) rmBtn.classList.add('hidden');
        return;
    }
    try {
        const db = await openLocalIDB();
        const rec = await new Promise(res => { const req = db.transaction('songs', 'readonly').objectStore('songs').get(activeAccount.uid); req.onsuccess = () => res(req.result || null); req.onerror = () => res(null); });
        if (rec && (rec.buffer || rec.blob)) {
            const blobObj = rec.buffer ? new Blob([rec.buffer], { type: rec.mimeType || 'audio/mpeg' }) : rec.blob;
            customSongObjUrl = URL.createObjectURL(blobObj);
            customAudio.src = customSongObjUrl; customAudio.loop = true;
            if (stEl) stEl.innerText = `✓ ${rec.fileName} (${(rec.sizeBytes / 1048576).toFixed(1)} MB)`;
            if (subEl) subEl.innerText = rec.fileName; if (rmBtn) rmBtn.classList.remove('hidden');
        } else {
            customAudio.pause(); customAudio.removeAttribute('src');
            if (stEl) stEl.innerText = 'Custom Track (≤ 20 MB)'; if (subEl) subEl.innerText = 'None'; if (rmBtn) rmBtn.classList.add('hidden');
            if (globalSettings.audio.ostMode === 'custom') selectOstMode('synth');
        }
        renderDevCustomSongsList();
    } catch (e) {}
}
async function removeCurrentPilotCustomSong() { if (activeAccount) { await deleteCustomSongByUid(activeAccount.uid); showToast('Custom track removed.'); playSfx('uiClick'); } }
async function deleteCustomSongByUid(uid) {
    try {
        const db = await openLocalIDB();
        await new Promise(res => { const tx = db.transaction('songs', 'readwrite'); tx.objectStore('songs').delete(uid); tx.oncomplete = () => res(); tx.onerror = () => res(); });
        if (activeAccount && activeAccount.uid === uid) await loadCustomSongForActiveAccount(); else renderDevCustomSongsList();
    } catch (e) {}
}
async function devRemoveAllCustomSongs() {
    if (!activeAccount || !activeAccount.isDev) return;
    const ok = await askConfirm({ title: 'Clear All Custom Songs?', body: 'Remove every uploaded custom audio track from IndexedDB?', okLabel: 'Clear All' });
    if (!ok) return;
    try {
        const db = await openLocalIDB();
        await new Promise(res => { const tx = db.transaction('songs', 'readwrite'); tx.objectStore('songs').clear(); tx.oncomplete = () => res(); });
        await loadCustomSongForActiveAccount();
        showDevFeedback('✓ All custom songs cleared.'); showToast('All custom songs cleared.', 'ok'); playSfx('pickup');
    } catch (e) {}
}
async function renderDevCustomSongsList() {
    const el = document.getElementById('devCustomSongsList');
    if (!el || !activeAccount || !activeAccount.isDev) return;
    try {
        const db = await openLocalIDB();
        const list = await new Promise(res => { const req = db.transaction('songs', 'readonly').objectStore('songs').getAll(); req.onsuccess = () => res(req.result || []); req.onerror = () => res([]); });
        if (!list.length) { el.innerHTML = '<div style="color:var(--text-dim);">None</div>'; return; }
        el.innerHTML = list.map(r => `<div class="row-between recessed-well" style="padding:4px 8px;"><span class="truncate mono">${escapeHtml(r.pilotName)}: <strong>${escapeHtml(r.fileName)}</strong></span><button type="button" class="btn btn-xs btn-danger" onclick="deleteCustomSongByUid('${escapeHtml(r.uid)}')">✕</button></div>`).join('');
    } catch (e) {}
}

// =========================================================================
// 10. GAME STATE, PHYSICS & FAIR SPAWNER
// =========================================================================
const gameState = {
    running: false, paused: false, score: 0, epoch: 1, combo: 1.0, nearMisses: 0,
    armor: 100, nitroFuel: 100, empCharge: 100, distanceM: 0, speedMps: 25,
    targetLane: 0, egoLaneX: 0, egoRoll: 0, boosting: false, braking: false,
    slowMoTimer: 0, invulnTimer: 0, hitFlashTimer: 0,
    empWaveRadius: 0, empFlashAlpha: 0, screenShake: 0,
    ep250WarnTriggered: false, ep250WarnTimer: 0,
    viewW: window.innerWidth, viewH: window.innerHeight,
    hazards: [], pickups: [], FloatingTexts: [], empFX: [], stars: []
};

const STAR_COLORS = ['#ffffff', '#7dd3fc', '#f472b6', '#c084fc', '#fde68a', '#00f5d4'];
for (let i = 0; i < 85; i++) gameState.stars.push({ x: Math.random(), y: Math.random() * 0.41, s: Math.random() * 1.8 + 0.6, sp: Math.random() * 0.25 + 0.06, col: STAR_COLORS[i % STAR_COLORS.length] });

const IDD_HAZARD_CLASSES = [
    { id: 0, name: 'auto_rickshaw', speedMul: 0.55, color: '#f59e0b', roof: '#1e293b', points: 120 },
    { id: 1, name: 'bus_truck',     speedMul: 0.45, color: '#ef4444', roof: '#450a0a', points: 180 },
    { id: 2, name: 'car',           speedMul: 0.65, color: '#38bdf8', roof: '#0c4a6e', points: 140 },
    { id: 3, name: 'two_wheeler',   speedMul: 0.75, color: '#a855f7', roof: '#3b0764', points: 160 },
    { id: 4, name: 'pedestrian',    speedMul: 0.12, color: '#fb7185', roof: '#881337', points: 200 },
    { id: 5, name: 'stray_animal',  speedMul: 0.08, color: '#fbbf24', roof: '#78350f', points: 190 },
    { id: 6, name: 'pothole',       speedMul: 0.00, color: '#64748b', roof: '#0f172a', points: 100, flat: true },
    { id: 7, name: 'speed_bump',    speedMul: 0.00, color: '#eab308', roof: '#422006', points: 90,  flat: true }
];

const REAL_LIFE_HAZARD_DIMS = { 0: { w: 20, h: 22 }, 1: { w: 28, h: 29 }, 2: { w: 24, h: 21 }, 3: { w: 13, h: 21 }, 4: { w: 13, h: 22 }, 5: { w: 18, h: 17 }, 6: { w: 22, h: 10 }, 7: { w: 26, h: 9 } };
const CLASS_SCALE_STOPPERS = {
    0: { laneFrac: 0.38, zStop: 2.25, unitW: 20 }, 1: { laneFrac: 0.48, zStop: 2.35, unitW: 28 },
    2: { laneFrac: 0.44, zStop: 2.20, unitW: 24 }, 3: { laneFrac: 0.26, zStop: 2.30, unitW: 13 },
    4: { laneFrac: 0.24, zStop: 2.35, unitW: 13 }, 5: { laneFrac: 0.27, zStop: 2.40, unitW: 18 },
    6: { laneFrac: 0.46, zStop: 2.20, unitW: 22 }, 7: { laneFrac: 0.56, zStop: 2.15, unitW: 26 },
    pickup: { laneFrac: 0.22, zStop: 2.30, unitW: 12 }
};

let spawnAccum = 0, pickupAccum = 0, radarAngle = Math.PI, lastHudTs = 0;
let fairBag = [], variantCounters = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
let cachedGradients = { key: '', sky: null, sun: null };

function getNextFairHazardClass() {
    if (!fairBag.length) {
        fairBag = [0, 1, 2, 3, 4, 5, 6, 7];
        for (let i = fairBag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = fairBag[i]; fairBag[i] = fairBag[j]; fairBag[j] = t; }
    }
    return IDD_HAZARD_CLASSES[fairBag.pop()];
}

function initHazardVariant(hz) {
    const cid = hz.cls.id, vCount = (variantCounters[cid] = (variantCounters[cid] || 0) + 1), rngBit = vCount + (Math.random() < 0.35 ? 1 : 0);
    if (cid === 0) {
        hz.variantIdx = rngBit % 2;
        hz.palette = hz.variantIdx === 0 ? { roof: '#fde047', bodyTop: '#facc15', bodyBot: '#111827', trim: '#f59e0b', glass: '#7dd3fc' } : { roof: '#fde047', bodyTop: '#0ea5e9', bodyBot: '#0c4a6e', trim: '#38bdf8', glass: '#e0f2fe' };
    } else if (cid === 1) {
        hz.subType = (rngBit % 2 === 0) ? 'bus' : 'truck';
        hz.palette = hz.subType === 'bus'
            ? ((vCount >> 1) % 2 === 0 ? { top: '#3b82f6', body: '#1d4ed8', bot: '#0f172a', stripe: '#38bdf8', trim: '#93c5fd' } : { top: '#f43f5e', body: '#dc2626', bot: '#1f080c', stripe: '#facc15', trim: '#fda4af' })
            : [{ cab: '#f97316', cargo: '#c2410c', trim: '#facc15' }, { cab: '#10b981', cargo: '#047857', trim: '#6ee7b7' }, { cab: '#38bdf8', cargo: '#1d4ed8', trim: '#bae6fd' }][(vCount >> 1) % 3];
    } else if (cid === 2) {
        hz.palette = [{ top: '#0ea5e9', bot: '#0c4a6e', trim: '#38bdf8', canopy: '#bae6fd' }, { top: '#ef4444', bot: '#7f1d1d', trim: '#fda4af', canopy: '#fecdd3' }, { top: '#f59e0b', bot: '#78350f', trim: '#fde047', canopy: '#fef08a' }, { top: '#10b981', bot: '#064e3b', trim: '#6ee7b7', canopy: '#a7f3d0' }, { top: '#a855f7', bot: '#4c1d95', trim: '#d8b4fe', canopy: '#f3e8ff' }][vCount % 5];
    } else if (cid === 3) {
        hz.palette = [{ main: '#22c55e', trim: '#86efac', visor: '#00f5d4' }, { main: '#ef4444', trim: '#fca5a5', visor: '#fde047' }, { main: '#3b82f6', trim: '#c084fc', visor: '#38bdf8' }][vCount % 3];
    } else if (cid === 4) {
        hz.subType = (rngBit % 2 === 0) ? 'boy' : 'girl';
        hz.palette = hz.subType === 'boy'
            ? ((vCount >> 1) % 2 === 0 ? { top: '#0ea5e9', trim: '#7dd3fc', hair: '#0f172a', skin: '#fed7aa' } : { top: '#ef4444', trim: '#fca5a5', hair: '#1c1917', skin: '#fdba74' })
            : ((vCount >> 1) % 2 === 0 ? { top: '#ec4899', trim: '#f9a8d4', hair: '#1c1917', skin: '#fed7aa' } : { top: '#a855f7', trim: '#d8b4fe', hair: '#27170e', skin: '#fdba74' });
    } else if (cid === 5) {
        hz.subType = (rngBit % 2 === 0) ? 'dog' : 'cat';
        hz.palette = hz.subType === 'dog'
            ? ((vCount >> 1) % 2 === 0 ? { coat: '#f59e0b', dark: '#b45309', belly: '#fef3c7', collar: '#ef4444', outline: '#fde68a' } : { coat: '#d97706', dark: '#78350f', belly: '#ffedd5', collar: '#00f5d4', outline: '#fed7aa' })
            : ((vCount >> 1) % 2 === 0 ? { coat: '#fb923c', dark: '#c2410c', belly: '#ffedd5', eye: '#4ade80', outline: '#fed7aa' } : { coat: '#cbd5e1', dark: '#475569', belly: '#ffffff', eye: '#facc15', outline: '#f8fafc' });
    } else if (cid === 7) hz.variantIdx = rngBit % 2;
}

function getDistanceForEpoch(ep) { const e = Math.max(1, Math.floor(ep)); return e <= 250 ? (e - 1) * 70 : 249 * 70 + EPOCH_250_LENGTH_M + (e - 251) * 70; }
function getEpochFromDistance(distM) { const s = 249 * 70, e = s + EPOCH_250_LENGTH_M; if (distM < s) return 1 + Math.floor(distM / 70); if (distM < e) return 250; return 251 + Math.floor((distM - e) / 70); }

function isBiomeUnlockedForAccount(idx) {
    if (activeAccount && activeAccount.isDev) return true;
    const b = BIOME_THEMES[idx]; if (!b) return false;
    const maxEp = Math.max((activeAccount && activeAccount.stats.bestEpoch) || 1, gameState.epoch || 1);
    if (b.isEpoch250Special) return Boolean((activeAccount && activeAccount.stats.completedEpoch250) || maxEp >= 251);
    return maxEp >= (b.unlockEpoch || 1);
}

function projectX(laneOffset, zSafe, W, H, roadCurve = 0) {
    const scale = (H * 0.85) / zSafe, zNorm = zSafe * 0.0181818;
    return W * 0.5 + ((laneOffset - gameState.egoLaneX * 0.82) * LANE_WIDTH_M) * scale * 0.24 + roadCurve * (zNorm * zNorm) * (W * 0.22);
}
function projectY(zSafe, yMeters, H) { return (H * 0.42) + (1.72 - yMeters) * ((H * 0.85) / zSafe) * 0.36; }
function getRigidPerspectiveScale(zSafe, W, H, key) {
    const st = CLASS_SCALE_STOPPERS[key] || CLASS_SCALE_STOPPERS.pickup;
    const zC = Math.max(1.25, Math.min(60.0, zSafe));
    const sAt = (LANE_WIDTH_M * ((H * 0.85) / st.zStop) * 0.24 * st.laneFrac) / st.unitW;
    return zC >= st.zStop ? sAt * Math.pow(st.zStop / zC, 0.85) : sAt * Math.pow(st.zStop / zC, 0.22);
}

function spawnFloat(text, color, oy = -42) {
    if (!globalSettings.graphics.transitions) return;
    if (gameState.FloatingTexts.length > 4) gameState.FloatingTexts.shift();
    gameState.FloatingTexts.push({ text, color, x: gameState.viewW * 0.5, y: gameState.viewH * 0.42 + oy, life: 1.0 });
}

function syncEpoch250Banners() {
    const alertEl = document.getElementById('epoch250Alert'), banEl = document.getElementById('singularityBanner');
    if (!gameState.running) { if (alertEl) alertEl.style.display = 'none'; if (banEl) banEl.style.display = 'none'; return; }
    if (gameState.ep250WarnTimer > 0) { if (alertEl) alertEl.style.display = 'flex'; if (banEl) banEl.style.display = 'none'; }
    else { if (alertEl) alertEl.style.display = 'none'; if (banEl) banEl.style.display = (gameState.epoch === 250) ? 'flex' : 'none'; }
}

function triggerEpoch250Warning() { gameState.ep250WarnTriggered = true; gameState.ep250WarnTimer = 2.8; syncEpoch250Banners(); playSfx('siren250'); }

function syncBiomeForEpoch(isInit = false) {
    if (gameState.epoch === 250) {
        biomeIdx = EPOCH_250_INDEX; cachedGradients.key = '';
        if (!gameState.ep250WarnTriggered) triggerEpoch250Warning(); else syncEpoch250Banners();
    } else {
        syncEpoch250Banners();
        if (gameState.epoch === 251 && !isInit) {
            if (activeAccount) { activeAccount.stats.completedEpoch250 = true; activeAccount.updatedAt = Date.now(); saveAccountsCache(); publishRealtimeEvent('acc_upsert', { acc: packAccountForSync(activeAccount) }); }
            spawnFloat('🏆 EPOCH 250 SURVIVED! COSMIC SINGULARITY UNLOCKED!', '#fbbf24', -58);
        }
        if (globalSettings.autoCycleBiomes) {
            const pool = isBiomeUnlockedForAccount(EPOCH_250_INDEX) ? 14 : 13, nextIdx = Math.floor((gameState.epoch - 1) / 10) % pool;
            if (nextIdx !== biomeIdx || isInit) { biomeIdx = nextIdx; cachedGradients.key = ''; if (!isInit) spawnFloat(`🌍 ${BIOME_THEMES[biomeIdx].label.toUpperCase()}`, '#38bdf8', -48); }
        } else { biomeIdx = isBiomeUnlockedForAccount(globalSettings.selectedBiomeIdx) ? globalSettings.selectedBiomeIdx : 0; cachedGradients.key = ''; }
    }
    setTextCached('hudBiomeName', BIOME_THEMES[biomeIdx].label);
}

function checkPhantomFlash(prevLane) {
    for (let i = 0; i < gameState.hazards.length; i++) {
        const h = gameState.hazards[i];
        if (!h.nearMissed && Math.abs(h.lane - prevLane) < 0.72 && h.z > EGO_Z_REAR && h.z < 10.5) {
            h.nearMissed = true; gameState.nearMisses++;
            gameState.combo = Math.min(8.0, +(gameState.combo + 0.5).toFixed(1));
            const bonus = Math.round(250 * gameState.combo);
            gameState.score += bonus; gameState.nitroFuel = Math.min(100, gameState.nitroFuel + 18); gameState.empCharge = Math.min(100, gameState.empCharge + 14);
            if (globalSettings.graphics.transitions) gameState.slowMoTimer = 0.42;
            playSfx('phantom'); spawnFloat(`⚡ PHANTOM FLASH +${bonus}`, '#00f5d4', -45); break;
        }
    }
}

function setDiscreteTargetLane(laneInt) {
    const c = Math.max(-2, Math.min(2, Math.round(laneInt))), prev = Math.round(gameState.targetLane);
    if (c !== prev) { gameState.targetLane = c; gameState.egoRoll = (c > prev ? 1 : -1) * 0.14; playSfx('steer'); checkPhantomFlash(prev); }
}
function steerLane(dir) { if (gameState.running && !gameState.paused) setDiscreteTargetLane(Math.round(gameState.targetLane) + dir); }
function setBoosting(active) { const next = Boolean(active && gameState.nitroFuel > 2); if (next && !gameState.boosting && gameState.running && !gameState.paused) playSfx('nitro'); gameState.boosting = next; }
function setBraking(active) { gameState.braking = Boolean(active); }

function triggerNeuralEmp() {
    if (!gameState.running || gameState.paused) return;
    const god = Boolean(devGodModeActive && activeAccount && activeAccount.isDev);
    if (!god && gameState.empCharge < 100) { spawnFloat('⚡ EMP CHARGING...', '#94a3b8', -20); return; }
    if (!god) gameState.empCharge = 0;
    gameState.empWaveRadius = 1; gameState.empFlashAlpha = 0.45;
    if (globalSettings.graphics.shake) gameState.screenShake = 10;
    playSfx('emp');

    const cust = activeAccount ? activeAccount.custom : DEFAULT_VEHICLE_CUST, chroma = getSkinChromaPalette(cust.nitroSkin, cust, performance.now());
    const empCol = chroma.empPrimary, empSec = chroma.empSecondary;

    for (let i = 0; i < gameState.hazards.length; i++) {
        const h = gameState.hazards[i], shards = [], cnt = isMobileHardware ? 10 : 16;
        const mainCol = (h.palette && (h.palette.top || h.palette.main || h.palette.coat || h.palette.bodyTop)) || h.cls.color || '#38bdf8';
        for (let s = 0; s < cnt; s++) {
            const ang = (s / cnt) * Math.PI * 2 + Math.random() * 0.35, spd = 24 + Math.random() * 50;
            shards.push({ vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd - 22, sz: 2 + Math.random() * 2.4, col: s % 3 === 0 ? '#ffffff' : (s % 2 === 0 ? empCol : (chroma.isAllInOne ? empSec : mainCol)) });
        }
        gameState.empFX.push({ lane: h.lane, z: Math.max(0.9, h.z), cls: h.cls, mainCol, empCol, empSec, life: 1.0, shards });
    }
    const cleared = gameState.hazards.length, bonus = cleared * Math.round(160 * gameState.combo);
    gameState.score += bonus; gameState.hazards = [];
    spawnFloat(`⚡ EMP VAPORIZED ${cleared} HAZARDS! +${bonus}`, empCol, -60);
    updateHudDOM(true);
}

function updateGamePhysics(dt, now) {
    if (!gameState.running) {
        menuCruiseDist += dt * 16;
        return;
    }
    if (gameState.paused) return;

    const god = Boolean(devGodModeActive && activeAccount && activeAccount.isDev);
    if (god) { gameState.armor = 100; gameState.nitroFuel = 100; gameState.empCharge = 100; }

    if (gameState.ep250WarnTimer > 0) { gameState.ep250WarnTimer = Math.max(0, gameState.ep250WarnTimer - dt); if (gameState.ep250WarnTimer <= 0) syncEpoch250Banners(); }
    if (gameState.invulnTimer > 0) gameState.invulnTimer = Math.max(0, gameState.invulnTimer - dt);
    if (gameState.hitFlashTimer > 0) { gameState.hitFlashTimer = Math.max(0, gameState.hitFlashTimer - dt); if (gameState.hitFlashTimer <= 0) document.getElementById('atmosphereOverlay').classList.remove('hit-flash'); }

    const activeDiffKey = (gameState.epoch === 250) ? 'void' : globalSettings.difficulty;
    const diff = DIFFICULTY_PRESETS[activeDiffKey] || DIFFICULTY_PRESETS.easy;
    let timeScale = 1.0;
    if (gameState.slowMoTimer > 0) { gameState.slowMoTimer = Math.max(0, gameState.slowMoTimer - dt); timeScale = 0.50; }
    const effDt = dt * timeScale;

    const distTo250 = (249 * 70) - gameState.distanceM;
    if (!gameState.ep250WarnTriggered && distTo250 > 0 && distTo250 <= gameState.speedMps * 3.1) triggerEpoch250Warning();

    const prevEp = gameState.epoch;
    gameState.epoch = getEpochFromDistance(gameState.distanceM);
    if (gameState.epoch !== prevEp) syncBiomeForEpoch(false);

    const lvlScale = Math.max(0.55, 1.0 - Math.min(0.45, (gameState.epoch - 1) * 0.0025));
    if (!god) {
        if (gameState.boosting) { gameState.nitroFuel = Math.max(0, gameState.nitroFuel - dt * 24); if (gameState.nitroFuel <= 0) gameState.boosting = false; }
        else gameState.nitroFuel = Math.min(100, gameState.nitroFuel + dt * diff.nitroRegen * lvlScale);
        gameState.empCharge = Math.min(100, gameState.empCharge + dt * diff.empRegen * lvlScale);
    }

    const endlessBonus = Math.min(15, Math.log2(1 + gameState.epoch) * 2.1), baseCruise = (24 + endlessBonus) * diff.speedMul;
    const targetSpd = gameState.boosting ? baseCruise * 1.44 : (gameState.braking ? baseCruise * 0.52 : baseCruise);
    gameState.speedMps += (targetSpd - gameState.speedMps) * (1 - Math.exp(-8 * dt));
    gameState.distanceM += gameState.speedMps * effDt;
    gameState.score += Math.round(gameState.speedMps * effDt * gameState.combo * diff.scoreMul * 1.35);
    updateEnginePitch();

    const laneDiff = gameState.targetLane - gameState.egoLaneX;
    if (Math.abs(laneDiff) < 0.003) { gameState.egoLaneX = gameState.targetLane; gameState.egoRoll *= Math.exp(-16 * dt); }
    else { gameState.egoLaneX += laneDiff * (1 - Math.exp(-18 * dt)); gameState.egoRoll += (Math.max(-0.16, Math.min(0.16, laneDiff * 0.14)) - gameState.egoRoll) * (1 - Math.exp(-16 * dt)); }

    if (gameState.screenShake > 0) gameState.screenShake = Math.max(0, gameState.screenShake - dt * 28);
    if (gameState.empWaveRadius > 0) { gameState.empWaveRadius += dt * 1400; if (gameState.empWaveRadius > 1500) gameState.empWaveRadius = 0; }
    if (gameState.empFlashAlpha > 0) gameState.empFlashAlpha = Math.max(0, gameState.empFlashAlpha - dt * 1.35);

    spawnAccum += gameState.speedMps * effDt;
    const spawnInt = Math.max(17.0, diff.spawnMeters - Math.min(8.5, Math.log2(1 + gameState.epoch) * 1.25));
    if (spawnAccum >= spawnInt) {
        spawnAccum = 0;
        const occ = new Set();
        for (let i = 0; i < gameState.hazards.length; i++) if (gameState.hazards[i].z > 46) occ.add(Math.round(gameState.hazards[i].lane));
        const free = LANES.filter(l => !occ.has(l));
        if (free.length >= 2) {
            const cls = getNextFairHazardClass(), lane = free[Math.floor(Math.random() * free.length)];
            const hz = { cls, lane, z: 60.0, speedMps: cls.speedMul * baseCruise * 0.52, dgi: +(Math.random() * 0.18 + 0.02).toFixed(2), phase: Math.random() * Math.PI * 2, nearMissed: false };
            initHazardVariant(hz); gameState.hazards.push(hz);
        }
    }

    pickupAccum += gameState.speedMps * effDt;
    if (pickupAccum >= (diff.pickupSpacing / lvlScale) && gameState.pickups.length < 2) {
        pickupAccum = 0; const r = Math.random();
        gameState.pickups.push({ lane: LANES[Math.floor(Math.random() * LANES.length)], z: 58.0, type: r < 0.3333 ? 'nitro' : (r < 0.6667 ? 'emp' : 'hull'), spin: 0 });
    }

    const hitThresh = 0.56 + (diff.hitboxScale - 0.75) * 0.50;
    for (let i = gameState.hazards.length - 1; i >= 0; i--) {
        const h = gameState.hazards[i];
        h.z -= Math.max(4, gameState.speedMps - h.speedMps) * effDt;
        if (h.z <= EGO_Z_FRONT + 0.35 && h.z >= EGO_Z_REAR - 0.22) {
            const lat = Math.min(Math.abs(h.lane - gameState.egoLaneX), Math.abs(h.lane - gameState.targetLane));
            if (lat < hitThresh) {
                gameState.hazards.splice(i, 1);
                if (gameState.invulnTimer <= 0) {
                    playSfx('hit');
                    if (globalSettings.graphics.shake) gameState.screenShake = 9;
                    if (!god) {
                        gameState.combo = 1.0;
                        const dmg = Math.round((h.cls.flat ? 12 : 19) * diff.hitboxScale);
                        gameState.armor = Math.max(0, gameState.armor - dmg);
                        gameState.invulnTimer = 0.36; gameState.hitFlashTimer = 0.22;
                        document.getElementById('atmosphereOverlay').classList.add('hit-flash');
                        spawnFloat(`💥 IMPACT: ${h.cls.name.toUpperCase()} (-${dmg}% HULL)`, '#ef4444', -26);
                    }
                    updateHudDOM(true);
                    if (gameState.armor <= 0 && !god) { triggerGameOver(); return; }
                }
                continue;
            }
        }
        if (h.z < 0.70) { gameState.score += Math.round(h.cls.points * gameState.combo * diff.scoreMul); gameState.hazards.splice(i, 1); }
    }

    const fillMul = diff.pickupScale * lvlScale;
    for (let i = gameState.pickups.length - 1; i >= 0; i--) {
        const p = gameState.pickups[i]; p.z -= gameState.speedMps * effDt; p.spin += dt * 4.5;
        if (p.z <= EGO_Z_FRONT + 0.8 && p.z >= EGO_Z_REAR - 0.35 && Math.abs(p.lane - gameState.egoLaneX) < 0.68) {
            playSfx('pickup');
            if (p.type === 'nitro') { const g = Math.max(15, Math.round(42 * fillMul)); gameState.nitroFuel = Math.min(100, gameState.nitroFuel + g); gameState.score += Math.round(280 * gameState.combo); spawnFloat(`🟨 NITRO +${g}%`, '#fbbf24', -34); }
            else if (p.type === 'emp') { const g = Math.max(14, Math.round(38 * fillMul)); gameState.empCharge = Math.min(100, gameState.empCharge + g); gameState.score += Math.round(280 * gameState.combo); spawnFloat(`🟦 EMP +${g}%`, '#38bdf8', -34); }
            else { const g = Math.max(10, Math.round(26 * fillMul)); gameState.armor = Math.min(100, gameState.armor + g); gameState.score += Math.round(280 * gameState.combo); spawnFloat(`🟩 HULL +${g}%`, '#10b981', -34); }
            gameState.pickups.splice(i, 1); updateHudDOM(true); continue;
        }
        if (p.z < 0.70) gameState.pickups.splice(i, 1);
    }

    for (let i = gameState.FloatingTexts.length - 1; i >= 0; i--) {
        const ft = gameState.FloatingTexts[i]; ft.y -= dt * 42; ft.life -= dt * 1.15;
        if (ft.life <= 0) gameState.FloatingTexts.splice(i, 1);
    }

    if (now - lastHudTs >= 100) { lastHudTs = now; updateHudDOM(false); if (!isHudHidden) renderMiniRadar(now); }
}

function triggerGameOver() {
    gameState.running = false; gameState.ep250WarnTimer = 0; gameState.hitFlashTimer = 0; gameState.boosting = false; gameState.braking = false;
    nextGameNoteT = 0; nextMenuNoteT = 0;
    document.getElementById('atmosphereOverlay').classList.remove('hit-flash');
    syncEpoch250Banners(); syncExternalTracks(); updateEnginePitch(); updateEqVisuals(false);

    const score = Math.max(0, Math.round(gameState.score)), ep = Math.max(1, Math.round(gameState.epoch)), st = seasonStatusCache;
    if (activeAccount) {
        activeAccount.stats.allTimeBest = Math.max(activeAccount.stats.allTimeBest || 0, score);
        activeAccount.stats.bestEpoch = Math.max(activeAccount.stats.bestEpoch || 1, ep);
        activeAccount.stats.totalFlashes = (activeAccount.stats.totalFlashes || 0) + gameState.nearMisses;
        activeAccount.stats.totalRuns = (activeAccount.stats.totalRuns || 0) + 1;
        if (ep > 250) activeAccount.stats.completedEpoch250 = true;
        if (!activeAccount.stats.seasonScores) activeAccount.stats.seasonScores = {};
        if (st.phase === 'ACTIVE') activeAccount.stats.seasonScores[st.seasonNum] = Math.max(activeAccount.stats.seasonScores[st.seasonNum] || 0, score);
        activeAccount.updatedAt = Date.now();
        saveAccountsCache(); recordScoreToLeaderboards(activeAccount, score, ep);
    }

    const sBest = (activeAccount && activeAccount.stats.seasonScores[st.seasonNum]) || 0;
    const aBest = (activeAccount && activeAccount.stats.allTimeBest) || score;
    document.getElementById('finalScoreVal').innerText = score.toLocaleString();
    document.getElementById('finalBestVal').innerText = st.phase === 'ACTIVE' ? `S${st.seasonNum}: ${sBest.toLocaleString()} / All: ${aBest.toLocaleString()}` : aBest.toLocaleString();
    document.getElementById('finalEpochVal').innerText = `Ep ${ep} • ${BIOME_THEMES[biomeIdx].label}`;
    document.getElementById('finalNearMissVal').innerText = String(gameState.nearMisses);
    document.getElementById('gameOverSeasonNote').innerText = st.phase === 'ACTIVE' ? `Season ${st.seasonNum} Ranked` : 'Off-Season Gap (All-Time Recorded)';

    refreshMenuAccountUI(); refreshInboxBadgeUI();
    document.getElementById('gameOverModal').style.display = 'flex';
    syncCursorVisibility();
}

// =========================================================================
// 11. RENDERER
// =========================================================================
function ensureCachedBiomeGradients(W, H, horizonY, theme) {
    const key = `${W}_${H}_${biomeIdx}`;
    if (cachedGradients.key === key) return;
    cachedGradients.key = key;
    const skyGrad = ctx.createLinearGradient(0, 0, 0, H);
    skyGrad.addColorStop(0, theme.skyTop); skyGrad.addColorStop(0.42, theme.skyBot);
    skyGrad.addColorStop(0.43, theme.roadDark); skyGrad.addColorStop(1, theme.roadDark);
    cachedGradients.sky = skyGrad;

    const sunGrad = ctx.createRadialGradient(W * 0.5, horizonY - 16, 6, W * 0.5, horizonY - 16, H * 0.34);
    sunGrad.addColorStop(0, '#ffffff'); sunGrad.addColorStop(0.26, theme.sun); sunGrad.addColorStop(1, 'transparent');
    cachedGradients.sun = sunGrad;
}

function renderUniqueDimensionHorizon(W, H, horizonY, theme, now, dynamicWorldColor, cosmicHue) {
    const cx = W * 0.5, hType = theme.horizonType || 'cyber', u = Math.min(W, H), showP = globalSettings.graphics.pillars;

    if (hType === 'cosmic250' || gameState.epoch === 250) {
        const cy = horizonY - 22, bhR = u * 0.115;
        if (showP) {
            const jetW = bhR * 0.44; ctx.fillStyle = `hsla(${cosmicHue},95%,65%,0.22)`;
            ctx.beginPath(); ctx.moveTo(cx - jetW * 0.2, cy); ctx.lineTo(cx - jetW * 1.45, 0); ctx.lineTo(cx + jetW * 1.45, 0); ctx.lineTo(cx + jetW * 0.2, cy); ctx.fill();
            for (let p = -2; p <= 2; p++) { if (p === 0) continue; const px = cx + p * (W * 0.185); ctx.fillStyle = `hsla(${(cosmicHue + p * 55 + 360) % 360},95%,62%,0.15)`; ctx.fillRect(px - 8, 0, 16, horizonY); }
        }
        ctx.fillStyle = cachedGradients.sun; ctx.beginPath(); ctx.arc(cx, cy, bhR * 2.75, 0, Math.PI * 2); ctx.fill();
        if (showP) {
            ctx.save(); ctx.translate(cx, cy); ctx.rotate(-0.14 + Math.sin(now * 0.0008) * 0.04);
            for (let r = 0; r < 3; r++) { ctx.strokeStyle = `hsla(${(cosmicHue + r * 65) % 360},95%,65%,${0.78 - r * 0.18})`; ctx.lineWidth = 3 - r * 0.65; ctx.beginPath(); ctx.ellipse(0, 0, bhR * (1.55 + r * 0.38), bhR * (0.32 + r * 0.08), 0, 0, Math.PI * 2); ctx.stroke(); }
            ctx.restore();
        }
        ctx.fillStyle = '#010006'; ctx.beginPath(); ctx.arc(cx, cy, bhR * 0.88, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = dynamicWorldColor; ctx.lineWidth = 2.8; ctx.beginPath(); ctx.arc(cx, cy, bhR * 0.90, 0, Math.PI * 2); ctx.stroke();
        return;
    }

    ctx.fillStyle = cachedGradients.sun; ctx.beginPath(); ctx.arc(cx, horizonY - 10, H * 0.28, Math.PI, 0, false); ctx.fill();

    if (hType === 'cyber') {
        const sunR = u * 0.135;
        if (showP) { [-1, 1].forEach((s, i) => { const ang = Math.sin(now * 0.0012 + i) * 0.28; ctx.fillStyle = 'rgba(56,189,248,0.10)'; ctx.beginPath(); ctx.moveTo(cx + s * W * 0.22, horizonY); ctx.lineTo(cx + s * W * 0.22 + Math.sin(ang) * 140 - 28, 0); ctx.lineTo(cx + s * W * 0.22 + Math.sin(ang) * 140 + 28, 0); ctx.closePath(); ctx.fill(); }); }
        ctx.save(); ctx.beginPath(); ctx.arc(cx, horizonY - 2, sunR, Math.PI, 0, false); ctx.clip();
        const sg = ctx.createLinearGradient(cx, horizonY - sunR, cx, horizonY);
        sg.addColorStop(0, '#00f5d4'); sg.addColorStop(0.55, '#38bdf8'); sg.addColorStop(1, '#ec4899');
        ctx.fillStyle = sg; ctx.fillRect(cx - sunR, horizonY - sunR - 2, sunR * 2, sunR + 2);
        ctx.fillStyle = theme.skyBot; for (let s = 0; s < 7; s++) ctx.fillRect(cx - sunR, horizonY - s * (sunR * 0.13) - 3, sunR * 2, 1.8 + s * 0.65);
        ctx.restore();
        const bCount = 24, bw = W / bCount;
        for (let b = 0; b < bCount; b++) {
            const bx = b * bw, distC = Math.abs((bx + bw * 0.5) - cx) / (W * 0.5), bh = (18 + ((b * 41) % 46)) * (0.45 + distC * 0.75);
            ctx.fillStyle = '#040710'; ctx.fillRect(bx, horizonY - bh, bw + 1, bh);
            ctx.strokeStyle = 'rgba(56,189,248,0.45)'; ctx.lineWidth = 1; ctx.strokeRect(bx, horizonY - bh, bw, bh);
            ctx.fillStyle = (b & 1) ? '#38bdf888' : '#f472b688'; ctx.fillRect(bx + 3, horizonY - bh + 4, Math.max(2, bw - 6), 2);
            if (bh > 34) { ctx.beginPath(); ctx.moveTo(bx + bw * 0.5, horizonY - bh); ctx.lineTo(bx + bw * 0.5, horizonY - bh - 12); ctx.stroke(); }
        }
    } else if (hType === 'monsoon') {
        if ((Math.floor(now * 0.009) % 11) === 0) { ctx.strokeStyle = '#a7f3d0'; ctx.lineWidth = 2.2; ctx.beginPath(); ctx.moveTo(cx + W * 0.12, 0); ctx.lineTo(cx + W * 0.09, horizonY * 0.38); ctx.lineTo(cx + W * 0.13, horizonY * 0.52); ctx.lineTo(cx + W * 0.07, horizonY); ctx.stroke(); }
        const spanW = W * 0.26, towerH = H * 0.19, deckY = horizonY - H * 0.045;
        ctx.strokeStyle = 'rgba(16,185,129,0.42)'; ctx.lineWidth = 1.2;
        for (let x = cx - spanW; x <= cx + spanW; x += 18) { const norm = (x - cx) / spanW, cableY = (horizonY - towerH) + (1 - norm * norm) * (deckY - (horizonY - towerH) - 6); ctx.beginPath(); ctx.moveTo(x, cableY); ctx.lineTo(x, deckY); ctx.stroke(); }
        ctx.strokeStyle = '#10b981'; ctx.lineWidth = 2.4; ctx.beginPath(); ctx.moveTo(cx - spanW, horizonY - towerH); ctx.quadraticCurveTo(cx, deckY - 6, cx + spanW, horizonY - towerH); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, deckY); ctx.lineTo(cx - spanW, horizonY - towerH); ctx.moveTo(cx + spanW, horizonY - towerH); ctx.lineTo(W, deckY); ctx.stroke();
        ctx.fillStyle = '#041214'; ctx.fillRect(0, deckY, W, 4);
        [-1, 1].forEach(s => { const tx = cx + s * spanW; ctx.fillStyle = '#061a1e'; ctx.strokeStyle = '#10b981'; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.moveTo(tx - 12, horizonY); ctx.lineTo(tx - 6, horizonY - towerH); ctx.lineTo(tx + 6, horizonY - towerH); ctx.lineTo(tx + 12, horizonY); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.fillStyle = '#34d399'; ctx.beginPath(); ctx.arc(tx, horizonY - towerH - 3, 3, 0, Math.PI * 2); ctx.fill(); });
    } else if (hType === 'solar') {
        const r = u * 0.125, cy = horizonY - r * 0.55;
        ctx.fillStyle = '#fff7ed'; ctx.strokeStyle = '#f97316'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI * 0.92, Math.PI * 0.08, false); ctx.fill(); ctx.stroke();
        ctx.strokeStyle = 'rgba(251,146,60,0.65)'; ctx.lineWidth = 2;
        for (let i = 0; i < 6; i++) { const a = Math.PI + (i / 5) * Math.PI + Math.sin(now * 0.002 + i) * 0.08; ctx.beginPath(); ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, r * 0.24, 0, Math.PI * 2); ctx.stroke(); }
        [-1, 1].forEach(s => { const px = cx + s * (W * 0.27), py = horizonY - H * 0.11; if (showP) { ctx.fillStyle = 'rgba(245,158,11,0.16)'; ctx.fillRect(px - 5, 0, 10, horizonY); } ctx.fillStyle = '#1c080d'; ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.moveTo(px, py - 26); ctx.lineTo(px + 22, py); ctx.lineTo(px, py + 26); ctx.lineTo(px - 22, py); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.beginPath(); ctx.moveTo(px - 18, horizonY); ctx.lineTo(px, py + 26); ctx.lineTo(px + 18, horizonY); ctx.stroke(); });
    } else if (hType === 'cryo') {
        if (showP) { for (let band = 0; band < 3; band++) { ctx.strokeStyle = band === 0 ? 'rgba(56,189,248,0.34)' : (band === 1 ? 'rgba(52,211,153,0.28)' : 'rgba(192,132,252,0.22)'); ctx.lineWidth = 12 - band * 3; ctx.beginPath(); for (let x = 0; x <= W; x += 32) { const y = horizonY * (0.22 + band * 0.12) + Math.sin(x * 0.011 + now * 0.0016 + band) * 14; if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); } ctx.stroke(); } }
        [[-0.38, 0.11], [-0.22, 0.18], [-0.08, 0.13], [0, 0.22], [0.11, 0.14], [0.25, 0.19], [0.39, 0.12]].forEach(([ox, oh]) => { const px = cx + ox * W, pw = W * 0.13, ph = H * oh; ctx.fillStyle = '#041529'; ctx.strokeStyle = '#7dd3fc'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(px - pw, horizonY); ctx.lineTo(px, horizonY - ph); ctx.lineTo(px + pw, horizonY); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.fillStyle = 'rgba(224,242,254,0.25)'; ctx.beginPath(); ctx.moveTo(px, horizonY - ph); ctx.lineTo(px + pw, horizonY); ctx.lineTo(px + pw * 0.15, horizonY); ctx.closePath(); ctx.fill(); });
    } else if (hType === 'bio') {
        const mr = u * 0.095, mcy = horizonY - mr * 1.25, pulse = 1 + Math.sin(now * 0.0035) * 0.08;
        if (showP) { for (let b = -2; b <= 2; b++) { if (b === 0) continue; const bx = cx + b * (W * 0.18) + Math.sin(now * 0.0015 + b) * 10; ctx.fillStyle = 'rgba(74,222,128,0.11)'; ctx.fillRect(bx - 5, 0, 10, horizonY); } }
        ctx.save(); ctx.translate(cx, mcy); ctx.fillStyle = '#032211'; ctx.strokeStyle = '#4ade80'; ctx.lineWidth = 2.2; ctx.beginPath(); ctx.arc(0, 0, mr * pulse, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.fillStyle = 'rgba(34,197,94,0.38)'; ctx.beginPath(); ctx.arc(0, 0, mr * 0.58 * pulse, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#bbf7d0'; ctx.beginPath(); ctx.arc(0, 0, mr * 0.24 * pulse, 0, Math.PI * 2); ctx.fill();
        for (let r = 0; r < 2; r++) { ctx.save(); ctx.rotate(now * (r === 0 ? 0.0012 : -0.0015) + r * 1.1); ctx.strokeStyle = r === 0 ? '#4ade80' : '#00f5d4'; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.ellipse(0, 0, mr * 1.48, mr * 0.38, 0, 0, Math.PI * 2); ctx.stroke(); for (let n = 0; n < 6; n++) { const a = (n / 6) * Math.PI * 2; ctx.fillStyle = '#fef08a'; ctx.beginPath(); ctx.arc(Math.cos(a) * mr * 1.48, Math.sin(a) * mr * 0.38, 2.5, 0, Math.PI * 2); ctx.fill(); } ctx.restore(); }
        ctx.restore();
        [-0.35, -0.20, 0.20, 0.35].forEach((ox, i) => { const sway = Math.sin(now * 0.0022 + i) * 6, mx = cx + ox * W + sway, stemH = H * (i % 2 === 0 ? 0.10 : 0.145), capR = u * (i % 2 === 0 ? 0.052 : 0.072), topY = horizonY - stemH; ctx.fillStyle = '#041f11'; ctx.strokeStyle = '#22c55e'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(cx + ox * W - 6, horizonY); ctx.quadraticCurveTo(mx - 2, horizonY - stemH * 0.5, mx - 4, topY); ctx.lineTo(mx + 4, topY); ctx.quadraticCurveTo(mx + 2, horizonY - stemH * 0.5, cx + ox * W + 6, horizonY); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.fillStyle = '#06371c'; ctx.strokeStyle = '#4ade80'; ctx.lineWidth = 2; ctx.beginPath(); ctx.ellipse(mx, topY, capR, capR * 0.44, 0, Math.PI, 0, false); ctx.closePath(); ctx.fill(); ctx.stroke(); for (let g = -2; g <= 2; g++) { const tendrilH = 10 + Math.sin(now * 0.004 + i + g) * 5; ctx.strokeStyle = 'rgba(0,245,212,0.55)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(mx + g * (capR * 0.32), topY); ctx.lineTo(mx + g * (capR * 0.32) + sway * 0.4, topY + tendrilH); ctx.stroke(); } });
    } else if (hType === 'eclipse') {
        const r = u * 0.105, ecy = horizonY - r * 1.12; ctx.strokeStyle = 'rgba(244,63,94,0.35)'; ctx.lineWidth = 8; ctx.beginPath(); ctx.arc(cx, ecy, r * 1.14, 0, Math.PI * 2); ctx.stroke(); ctx.fillStyle = '#040002'; ctx.strokeStyle = '#fb7185'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(cx, ecy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(cx + r * 0.72, ecy - r * 0.68, 5 + Math.sin(now * 0.005) * 1.5, 0, Math.PI * 2); ctx.fill();
        for (let s = -5; s <= 5; s++) { if (s === 0) continue; const sx = cx + s * (W * 0.075), sh = H * (Math.abs(s) % 2 === 1 ? 0.15 : 0.10); ctx.fillStyle = '#120307'; ctx.strokeStyle = '#f43f5e88'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(sx - 10, horizonY); ctx.lineTo(sx - 6, horizonY - sh * 0.55); ctx.lineTo(sx, horizonY - sh); ctx.lineTo(sx + 6, horizonY - sh * 0.55); ctx.lineTo(sx + 10, horizonY); ctx.closePath(); ctx.fill(); ctx.stroke(); }
    } else if (hType === 'tachyon') {
        const coreY = horizonY - H * 0.13, coreR = u * 0.055; ctx.fillStyle = '#1e0b3b'; ctx.strokeStyle = '#eab308'; ctx.lineWidth = 2.2; ctx.beginPath(); ctx.arc(cx, coreY, coreR, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.strokeStyle = '#c084fc'; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.ellipse(cx, coreY, coreR * 1.65, coreR * 0.45, now * 0.002, 0, Math.PI * 2); ctx.stroke();
        [-1, 1].forEach(s => { const tx = cx + s * (W * 0.24), th = H * 0.17; ctx.fillStyle = '#120726'; ctx.strokeStyle = '#c084fc'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(tx - 14, horizonY); ctx.lineTo(tx - 6, horizonY - th); ctx.lineTo(tx + 6, horizonY - th); ctx.lineTo(tx + 14, horizonY); ctx.closePath(); ctx.fill(); ctx.stroke(); for (let r = 1; r <= 3; r++) ctx.strokeRect(tx - 11, horizonY - th * (0.28 * r), 22, 4); ctx.strokeStyle = '#fde047'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(tx, horizonY - th); ctx.quadraticCurveTo((tx + cx) * 0.5, coreY - 18 + Math.sin(now * 0.018 + s) * 12, cx + s * coreR, coreY); ctx.stroke(); });
    } else if (hType === 'dune') {
        ctx.fillStyle = '#fef08a'; ctx.beginPath(); ctx.arc(cx - W * 0.09, horizonY - H * 0.15, u * 0.038, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#f97316'; ctx.beginPath(); ctx.arc(cx + W * 0.10, horizonY - H * 0.10, u * 0.068, 0, Math.PI * 2); ctx.fill();
        [[-0.23, 0.11, 0.10], [0, 0.16, 0.15], [0.23, 0.11, 0.10]].forEach(([ox, pwR, phR]) => { const px = cx + ox * W, pw = W * pwR, ph = H * phR; ctx.fillStyle = '#120902'; ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(px - pw, horizonY); ctx.lineTo(px, horizonY - ph); ctx.lineTo(px + pw * 0.85, horizonY); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.fillStyle = '#291505'; ctx.beginPath(); ctx.moveTo(px, horizonY - ph); ctx.lineTo(px + pw * 0.85, horizonY); ctx.lineTo(px + pw * 0.1, horizonY); ctx.closePath(); ctx.fill(); ctx.fillStyle = '#fde68a'; ctx.beginPath(); ctx.moveTo(px - pw * 0.18, horizonY - ph * 0.82); ctx.lineTo(px, horizonY - ph); ctx.lineTo(px + pw * 0.15, horizonY - ph * 0.82); ctx.closePath(); ctx.fill(); });
    } else if (hType === 'sakura') {
        const mr = u * 0.125; ctx.fillStyle = 'rgba(251,207,232,0.88)'; ctx.beginPath(); ctx.arc(cx, horizonY - mr * 0.55, mr, Math.PI, 0, false); ctx.fill();
        const fw = W * 0.26, fh = H * 0.16; ctx.fillStyle = '#12061c'; ctx.strokeStyle = '#f472b6'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(cx - fw, horizonY); ctx.quadraticCurveTo(cx - fw * 0.35, horizonY - fh * 0.35, cx - fw * 0.14, horizonY - fh); ctx.lineTo(cx + fw * 0.14, horizonY - fh); ctx.quadraticCurveTo(cx + fw * 0.35, horizonY - fh * 0.35, cx + fw, horizonY); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#fdf2f8'; ctx.beginPath(); ctx.moveTo(cx - fw * 0.14, horizonY - fh); ctx.lineTo(cx + fw * 0.14, horizonY - fh); ctx.lineTo(cx + fw * 0.22, horizonY - fh * 0.68); ctx.lineTo(cx, horizonY - fh * 0.76); ctx.lineTo(cx - fw * 0.22, horizonY - fh * 0.68); ctx.closePath(); ctx.fill();
        const px = cx - W * 0.29; for (let t = 0; t < 4; t++) { const tw = 26 - t * 4, ty = horizonY - 10 - t * 11; ctx.fillStyle = '#1a0826'; ctx.strokeStyle = '#ec4899'; ctx.lineWidth = 1.2; ctx.fillRect(px - tw * 0.5, ty, tw, 8); ctx.beginPath(); ctx.moveTo(px - tw * 0.75, ty); ctx.lineTo(px + tw * 0.75, ty); ctx.stroke(); }
        const tx = cx + W * 0.29; ctx.fillStyle = '#ec4899'; ctx.fillRect(tx - 14, horizonY - 32, 4, 32); ctx.fillRect(tx + 10, horizonY - 32, 4, 32); ctx.fillRect(tx - 22, horizonY - 34, 44, 4); ctx.fillRect(tx - 17, horizonY - 23, 34, 3);
    } else if (hType === 'matrix') {
        if (showP) { ctx.fillStyle = 'rgba(34,197,94,0.28)'; for (let c = 0; c < 22; c++) { const mx = (c / 22) * W, my = (now * 0.09 + c * 53) % (horizonY - 14); ctx.fillRect(mx, my, 2.5, 14); ctx.fillStyle = '#bbf7d0'; ctx.fillRect(mx, my + 12, 2.5, 3); ctx.fillStyle = 'rgba(34,197,94,0.28)'; } }
        const mr = u * 0.105, cy = horizonY - mr * 1.08; ctx.save(); ctx.translate(cx, cy); ctx.strokeStyle = '#22c55e'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, mr * 1.18, 0, Math.PI * 2); ctx.stroke(); ctx.rotate(now * 0.0008); ctx.fillStyle = '#021407'; ctx.beginPath(); ctx.moveTo(0, -mr); ctx.lineTo(mr, 0); ctx.lineTo(0, mr); ctx.lineTo(-mr, 0); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.strokeRect(-mr * 0.55, -mr * 0.55, mr * 1.1, mr * 1.1); ctx.restore();
    } else if (hType === 'saturn') {
        const r = u * 0.105, cy = horizonY - r * 1.02; ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip(); ctx.fillStyle = '#1e1b4b'; ctx.fillRect(cx - r, cy - r, r * 2, r * 2); ctx.fillStyle = 'rgba(129,140,248,0.28)'; for (let b = -3; b <= 3; b++) ctx.fillRect(cx - r, cy + b * (r * 0.24), r * 2, r * 0.11); ctx.restore();
        ctx.strokeStyle = '#818cf8'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(-0.18 + Math.sin(now * 0.0005) * 0.03); for (let ring = 0; ring < 3; ring++) { ctx.strokeStyle = ring === 1 ? 'rgba(199,210,254,0.85)' : 'rgba(129,140,248,0.55)'; ctx.lineWidth = ring === 1 ? 3.5 : 1.8; ctx.beginPath(); ctx.ellipse(0, 0, r * (1.65 + ring * 0.35), r * (0.28 + ring * 0.07), 0, 0, Math.PI * 2); ctx.stroke(); } ctx.restore();
        ctx.fillStyle = '#c7d2fe'; ctx.beginPath(); ctx.arc(cx - r * 2.4, cy - r * 0.5, 5, 0, Math.PI * 2); ctx.arc(cx + r * 2.3, cy + r * 0.3, 7, 0, Math.PI * 2); ctx.fill();
    } else if (hType === 'magma') {
        const vh = H * 0.17, vw = W * 0.24; ctx.fillStyle = '#170401'; ctx.strokeStyle = '#fb923c'; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.moveTo(0, horizonY); ctx.lineTo(cx - vw, horizonY - vh * 0.42); ctx.lineTo(cx - vw * 0.22, horizonY - vh); ctx.lineTo(cx, horizonY - vh * 0.86); ctx.lineTo(cx + vw * 0.22, horizonY - vh); ctx.lineTo(cx + vw, horizonY - vh * 0.42); ctx.lineTo(W, horizonY); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#ef4444'; ctx.beginPath(); ctx.arc(cx, horizonY - vh, 14 + Math.sin(now * 0.012) * 4, Math.PI, 0, false); ctx.fill();
        ctx.strokeStyle = '#facc15'; ctx.lineWidth = 2.4; ctx.beginPath(); ctx.moveTo(cx - 6, horizonY - vh * 0.9); ctx.quadraticCurveTo(cx - 24, horizonY - vh * 0.4, cx - 38, horizonY); ctx.moveTo(cx + 6, horizonY - vh * 0.9); ctx.quadraticCurveTo(cx + 20, horizonY - vh * 0.45, cx + 32, horizonY); ctx.stroke();
    } else if (hType === 'astral') {
        const cy = horizonY - H * 0.12, r = u * 0.075; ctx.save(); ctx.translate(cx, cy); ctx.rotate(now * 0.0008); ctx.strokeStyle = '#f8fafc'; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke(); ctx.strokeRect(-r * 0.7, -r * 0.7, r * 1.4, r * 1.4); ctx.restore();
        for (let m = -3; m <= 3; m++) { if (m === 0) continue; const mx = cx + m * (W * 0.105), mh = 34 - Math.abs(m) * 4, fy = horizonY - 18 - Math.sin(now * 0.0022 + m) * 6; ctx.fillStyle = '#0b0f19'; ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(mx - 8, fy); ctx.lineTo(mx - 8, fy - mh); ctx.lineTo(mx, fy - mh - 8); ctx.lineTo(mx + 8, fy - mh); ctx.lineTo(mx + 8, fy); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.fillStyle = '#38bdf8'; ctx.fillRect(mx - 1.5, fy - mh + 4, 3, mh - 10); }
    }
}

function renderHighTexturePickup(pk, W, H, roadCurve, now) {
    const zSafe = Math.max(0.55, pk.z), px = projectX(pk.lane, zSafe, W, H, roadCurve), roadY = projectY(zSafe, 0, H);
    const s = getRigidPerspectiveScale(zSafe, W, H, 'pickup'), r = 6.0 * s;
    const mainCol = pk.type === 'nitro' ? '#fbbf24' : (pk.type === 'emp' ? '#38bdf8' : '#10b981');
    if (globalSettings.graphics.legacyModels) {
        ctx.save(); ctx.translate(px, roadY - r * 1.4); ctx.rotate(pk.spin);
        ctx.fillStyle = mainCol; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(1.1, 1.4 * s);
        ctx.fillRect(-r, -r, r * 2, r * 2); ctx.strokeRect(-r, -r, r * 2, r * 2); ctx.fillStyle = '#ffffff'; ctx.fillRect(-r * 0.35, -r * 0.35, r * 0.7, r * 0.7);
        ctx.restore(); return;
    }
    const py = roadY - r * 1.45 + (globalSettings.graphics.transitions ? Math.sin(now * 0.0065 + pk.spin) * 1.6 * s : 0);
    const coreCol = pk.type === 'nitro' ? '#fef08a' : (pk.type === 'emp' ? '#e0f2fe' : '#a7f3d0'), darkCol = pk.type === 'nitro' ? '#78350f' : (pk.type === 'emp' ? '#0c4a6e' : '#064e3b');
    const hiDet = globalSettings.graphics.preset === 'high' || globalSettings.graphics.preset === 'ultra';
    ctx.fillStyle = 'rgba(0,0,0,0.52)'; ctx.beginPath(); ctx.ellipse(px, roadY + 1.2 * s, r * 0.92, r * 0.26, 0, 0, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.translate(px, py);
    if (hiDet) { ctx.save(); ctx.rotate(-pk.spin * 0.65); ctx.strokeStyle = colorWithAlpha(mainCol, 0.53); ctx.lineWidth = Math.max(0.9, 1.05 * s); const ro = r * 1.14; ctx.strokeRect(-ro, -ro, ro * 2, ro * 2); ctx.restore(); }
    ctx.rotate(pk.spin);
    if (globalSettings.graphics.bloom && !isMobileHardware) { ctx.shadowBlur = 10; ctx.shadowColor = mainCol; }
    ctx.fillStyle = mainCol; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(1.1, 1.4 * s);
    ctx.fillRect(-r, -r, r * 2, r * 2); ctx.strokeRect(-r, -r, r * 2, r * 2); ctx.shadowBlur = 0;
    ctx.fillStyle = darkCol; ctx.fillRect(-r * 0.66, -r * 0.66, r * 1.32, r * 1.32);
    ctx.strokeStyle = coreCol; ctx.lineWidth = Math.max(0.8, 0.95 * s); ctx.strokeRect(-r * 0.66, -r * 0.66, r * 1.32, r * 1.32);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(-r * 0.35, -r * 0.35, r * 0.70, r * 0.70);
    ctx.restore();
}

function renderLegacyHazardModel(hz, bx, by, s, boxW, boxH, primaryCol) {
    const x1 = bx - boxW * 0.5, y2 = by, y1 = y2 - boxH, cid = hz.cls.id;
    if (cid === 0) {
        ctx.fillStyle = '#05070b'; ctx.fillRect(x1 + 1 * s, y2 - 6 * s, 4 * s, 6 * s); ctx.fillRect(x1 + boxW - 5 * s, y2 - 6 * s, 4 * s, 6 * s);
        ctx.fillStyle = '#111827'; ctx.strokeStyle = primaryCol; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x1 + 2 * s, y2 - 3 * s); ctx.lineTo(x1 + 3 * s, y1 + boxH * 0.36); ctx.quadraticCurveTo(bx, y1 - 3 * s, x1 + boxW - 3 * s, y1 + boxH * 0.36); ctx.lineTo(x1 + boxW - 2 * s, y2 - 3 * s); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = primaryCol; ctx.fillRect(x1 + 3 * s, y1 + boxH * 0.48, boxW - 6 * s, boxH * 0.40); ctx.fillStyle = '#ff1e42'; ctx.fillRect(x1 + 4 * s, y2 - 7 * s, 5 * s, 3 * s); ctx.fillRect(x1 + boxW - 9 * s, y2 - 7 * s, 5 * s, 3 * s);
    } else if (cid === 1) {
        ctx.fillStyle = '#05070b'; ctx.fillRect(x1, y2 - 7 * s, 5 * s, 7 * s); ctx.fillRect(x1 + boxW - 5 * s, y2 - 7 * s, 5 * s, 7 * s);
        ctx.fillStyle = hz.cls.roof; ctx.strokeStyle = primaryCol; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(x1 + 1 * s, y2 - 2 * s); ctx.lineTo(x1 + 1 * s, y1 + 3 * s); ctx.lineTo(x1 + 4 * s, y1); ctx.lineTo(x1 + boxW - 4 * s, y1); ctx.lineTo(x1 + boxW - 1 * s, y1 + 3 * s); ctx.lineTo(x1 + boxW - 1 * s, y2 - 2 * s); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = primaryCol; ctx.fillRect(x1 + 3 * s, y1 + boxH * 0.22, boxW - 6 * s, boxH * 0.62); ctx.fillStyle = '#09101d'; ctx.fillRect(x1 + 4 * s, y1 + boxH * 0.26, boxW - 8 * s, boxH * 0.22); ctx.fillStyle = '#ff1e42'; ctx.fillRect(x1 + 3 * s, y2 - 6 * s, 6 * s, 3 * s); ctx.fillRect(x1 + boxW - 9 * s, y2 - 6 * s, 6 * s, 3 * s);
    } else if (cid === 2) {
        ctx.fillStyle = '#05070b'; ctx.fillRect(x1, y2 - 6 * s, 4.5 * s, 6 * s); ctx.fillRect(x1 + boxW - 4.5 * s, y2 - 6 * s, 4.5 * s, 6 * s);
        ctx.fillStyle = hz.cls.roof; ctx.strokeStyle = primaryCol; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(bx, y1); ctx.quadraticCurveTo(x1 + 4 * s, y1 + 2 * s, x1 + 2 * s, y1 + boxH * 0.36); ctx.lineTo(x1, y2 - 2 * s); ctx.lineTo(x1 + boxW, y2 - 2 * s); ctx.lineTo(x1 + boxW - 2 * s, y1 + boxH * 0.36); ctx.quadraticCurveTo(x1 + boxW - 4 * s, y1 + 2 * s, bx, y1); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#7dd3fc'; ctx.beginPath(); ctx.moveTo(bx, y1 + 5 * s); ctx.lineTo(x1 + 5 * s, y1 + boxH * 0.44); ctx.lineTo(x1 + boxW - 5 * s, y1 + boxH * 0.44); ctx.closePath(); ctx.fill(); ctx.fillStyle = '#ff1e42'; ctx.fillRect(x1 + 3.5 * s, y2 - 7.5 * s, 7 * s, 3 * s); ctx.fillRect(x1 + boxW - 10.5 * s, y2 - 7.5 * s, 7 * s, 3 * s);
    } else if (cid === 3) {
        ctx.fillStyle = '#05070b'; ctx.fillRect(bx - 3 * s, y2 - 9 * s, 6 * s, 9 * s); ctx.fillStyle = hz.cls.roof; ctx.strokeStyle = primaryCol; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(bx - 6 * s, y2 - 3 * s); ctx.lineTo(bx - 7 * s, y1 + boxH * 0.44); ctx.lineTo(bx, y1 + 2 * s); ctx.lineTo(bx + 7 * s, y1 + boxH * 0.44); ctx.lineTo(bx + 6 * s, y2 - 3 * s); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.fillStyle = '#f8fafc'; ctx.beginPath(); ctx.arc(bx, y1 + 6 * s, 4.2 * s, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#ff1e42'; ctx.fillRect(bx - 3 * s, y2 - 8 * s, 6 * s, 3 * s);
    } else if (cid === 4) {
        ctx.fillStyle = '#0f172a'; ctx.strokeStyle = primaryCol; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(bx, y1 + 4.5 * s, 4.2 * s, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.fillStyle = primaryCol; ctx.fillRect(bx - 5 * s, y1 + 9.5 * s, 10 * s, 9.5 * s); ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.moveTo(bx - 2.5 * s, y1 + 19 * s); ctx.lineTo(bx - 3.5 * s, y2); ctx.moveTo(bx + 2.5 * s, y1 + 19 * s); ctx.lineTo(bx + 3.5 * s, y2); ctx.stroke();
    } else if (cid === 5) {
        ctx.fillStyle = hz.cls.roof; ctx.strokeStyle = primaryCol; ctx.lineWidth = 1.5; ctx.fillRect(x1 + 4 * s, y1 + 9 * s, boxW - 8 * s, 9 * s); ctx.strokeRect(x1 + 4 * s, y1 + 9 * s, boxW - 8 * s, 9 * s); ctx.fillStyle = primaryCol; ctx.fillRect(x1 + 4 * s, y1 + 18 * s, 3 * s, 7 * s); ctx.fillRect(x1 + boxW - 7 * s, y1 + 18 * s, 3 * s, 7 * s);
    } else if (cid === 6) {
        ctx.fillStyle = '#05070c'; ctx.strokeStyle = primaryCol; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.ellipse(bx, y2 - 6 * s, boxW * 0.45, 5 * s, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    } else {
        ctx.fillStyle = hz.cls.roof; ctx.strokeStyle = primaryCol; ctx.lineWidth = 1.5; ctx.fillRect(x1, y2 - 11 * s, boxW, 9 * s); ctx.strokeRect(x1, y2 - 11 * s, boxW, 9 * s);
    }
}

function renderHighTextureDistinctHazard(hz, zSafe, W, H, roadCurve, dynamicWorldColor, isCosmic250, cosmicHue, now) {
    const bx = projectX(hz.lane, zSafe, W, H, roadCurve), by = projectY(zSafe, 0, H);
    const cid = hz.cls.id, s = getRigidPerspectiveScale(zSafe, W, H, cid);
    const dims = globalSettings.graphics.legacyModels ? { w: 25, h: 23 } : (REAL_LIFE_HAZARD_DIMS[cid] || { w: 24, h: 21 });
    const boxW = dims.w * s, boxH = dims.h * s, x1 = bx - boxW * 0.5, y2 = by, y1 = y2 - boxH;
    const tierCol = hz.rFinal >= 0.85 ? '#ef4444' : (hz.rFinal >= 0.65 ? '#f97316' : (hz.rFinal >= 0.35 ? '#f59e0b' : dynamicWorldColor));
    ctx.fillStyle = 'rgba(0,0,0,0.62)'; ctx.beginPath(); ctx.ellipse(bx, y2 + 1.8 * s, boxW * 0.50, 3.0 * s, 0, 0, Math.PI * 2); ctx.fill();

    if (globalSettings.graphics.legacyModels) {
        renderLegacyHazardModel(hz, bx, by, s * 0.84, boxW, boxH, isCosmic250 ? `hsl(${(cosmicHue + cid * 45) % 360},90%,58%)` : hz.cls.color);
    } else {
        const highDetail = globalSettings.graphics.preset === 'high' || globalSettings.graphics.preset === 'ultra', ms = s * 0.84, pal = hz.palette || {};
        ctx.save(); ctx.translate(bx, y2); ctx.scale(ms, ms);
        if (cid === 0) {
            ctx.fillStyle = '#05070b'; ctx.fillRect(-10.5, -6, 3.2, 6); ctx.fillRect(7.3, -6, 3.2, 6); ctx.fillRect(-1.8, -5, 3.6, 5.5);
            ctx.fillStyle = pal.bodyBot; ctx.strokeStyle = pal.trim; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.roundRect(-10, -14.5, 20, 12.5, 2); ctx.fill(); ctx.stroke();
            ctx.fillStyle = pal.bodyTop; ctx.fillRect(-9.2, -14, 18.4, 5.5);
            ctx.fillStyle = pal.roof; ctx.strokeStyle = '#fde047'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(-10, -14); ctx.lineTo(-8.8, -21.5); ctx.quadraticCurveTo(0, -26, 8.8, -21.5); ctx.lineTo(10, -14); ctx.closePath(); ctx.fill(); ctx.stroke();
            ctx.fillStyle = pal.glass; ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(-7.6, -20.8, 15.2, 6.2, 1.5); ctx.fill(); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0, -20.8); ctx.lineTo(0, -14.6); ctx.stroke(); ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(0, -8.5, 2.2, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#ff1e42'; ctx.fillRect(-8.5, -9, 3, 2.2); ctx.fillRect(5.5, -9, 3, 2.2);
        } else if (cid === 1) {
            if (hz.subType === 'bus') {
                ctx.fillStyle = '#05070b'; ctx.fillRect(-15.5, -7, 4.2, 7); ctx.fillRect(11.3, -7, 4.2, 7);
                ctx.fillStyle = pal.body; ctx.strokeStyle = pal.trim; ctx.lineWidth = 1.7; ctx.beginPath(); ctx.roundRect(-15.5, -32.5, 31, 30.5, 3.5); ctx.fill(); ctx.stroke();
                if (highDetail) { ctx.fillStyle = pal.top; ctx.fillRect(-14.5, -31.5, 29, 6); }
                ctx.fillStyle = '#050811'; ctx.fillRect(-11.5, -30.5, 23, 3.5); ctx.fillStyle = '#fde047'; ctx.fillRect(-8.5, -29.4, 17, 1.4);
                ctx.fillStyle = '#38bdf8'; ctx.beginPath(); ctx.roundRect(-13.5, -26, 27, 10.5, 2); ctx.fill();
                if (highDetail) { ctx.fillStyle = '#e0f2fe'; ctx.fillRect(-12.5, -25.2, 25, 2.2); }
                ctx.fillStyle = pal.stripe; ctx.fillRect(-14.8, -14, 29.6, 2.5); ctx.fillStyle = '#090d16'; ctx.fillRect(-8.5, -10, 17, 5);
                ctx.fillStyle = '#ffffff'; ctx.fillRect(-13.8, -9, 4, 2.8); ctx.fillRect(9.8, -9, 4, 2.8); ctx.fillStyle = '#fbbf24'; ctx.fillRect(-13.8, -5.5, 3, 2); ctx.fillRect(10.8, -5.5, 3, 2);
            } else {
                ctx.fillStyle = '#05070b'; ctx.fillRect(-16, -7.5, 4.5, 7.5); ctx.fillRect(11.5, -7.5, 4.5, 7.5);
                ctx.fillStyle = pal.cargo; ctx.strokeStyle = pal.trim; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.roundRect(-16.5, -34, 33, 19, 2); ctx.fill(); ctx.stroke();
                ctx.fillStyle = '#fde047'; [-10, -5, 0, 5, 10].forEach(lx => ctx.fillRect(lx - 1.1, -33, 2.2, 1.8));
                ctx.fillStyle = pal.cab; ctx.strokeStyle = pal.trim; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.roundRect(-14, -26, 28, 24, 3); ctx.fill(); ctx.stroke();
                ctx.fillStyle = '#7dd3fc'; ctx.fillRect(-12, -23.5, 11, 7); ctx.fillRect(1, -23.5, 11, 7);
                ctx.fillStyle = '#0f172a'; ctx.strokeStyle = '#f8fafc'; ctx.lineWidth = 1.3; ctx.beginPath(); ctx.roundRect(-8, -14.5, 16, 9.5, 1.5); ctx.fill(); ctx.stroke();
                for (let g = -5; g <= 5; g += 2.5) { ctx.beginPath(); ctx.moveTo(g, -14); ctx.lineTo(g, -5.5); ctx.stroke(); }
                ctx.fillStyle = '#fef08a'; ctx.fillRect(-13, -11.5, 3.8, 3.2); ctx.fillRect(9.2, -11.5, 3.8, 3.2);
            }
        } else if (cid === 2) {
            ctx.fillStyle = '#05070b'; ctx.beginPath(); ctx.roundRect(-14, -6.5, 4, 6.5, 1.5); ctx.roundRect(10, -6.5, 4, 6.5, 1.5); ctx.fill();
            ctx.fillStyle = pal.top; ctx.strokeStyle = pal.trim; ctx.lineWidth = 1.7; ctx.beginPath(); ctx.moveTo(-13, -2); ctx.quadraticCurveTo(-14.5, -8.5, -12, -13.5); ctx.lineTo(-8, -21.5); ctx.quadraticCurveTo(0, -23.5, 8, -21.5); ctx.lineTo(12, -13.5); ctx.quadraticCurveTo(14.5, -8.5, 13, -2); ctx.closePath(); ctx.fill(); ctx.stroke();
            ctx.fillStyle = pal.bot; ctx.fillRect(-12.2, -11, 24.4, 8); ctx.fillStyle = pal.canopy; ctx.beginPath(); ctx.moveTo(-6.8, -20); ctx.quadraticCurveTo(0, -21.4, 6.8, -20); ctx.lineTo(9.4, -13.2); ctx.quadraticCurveTo(0, -12, -9.4, -13.2); ctx.closePath(); ctx.fill();
            ctx.fillStyle = '#05070c'; ctx.beginPath(); ctx.roundRect(-11, -7.2, 22, 4.8, 2); ctx.fill(); ctx.fillStyle = '#ff1e42'; ctx.fillRect(-10.2, -6.5, 6.2, 2.5); ctx.fillRect(4, -6.5, 6.2, 2.5); ctx.fillStyle = pal.trim; ctx.fillRect(-2.4, -6, 4.8, 1.6);
        } else if (cid === 3) {
            ctx.fillStyle = '#05070b'; ctx.strokeStyle = '#475569'; ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(-2.8, -10, 5.6, 10, 2); ctx.fill(); ctx.stroke();
            ctx.fillStyle = '#0f172a'; ctx.fillRect(-6.8, -15, 3, 7); ctx.fillRect(3.8, -15, 3, 7); ctx.fillStyle = pal.main; ctx.strokeStyle = pal.trim; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(0, -4.5); ctx.lineTo(-6.2, -13.5); ctx.lineTo(-4.4, -20.5); ctx.lineTo(4.4, -20.5); ctx.lineTo(6.2, -13.5); ctx.closePath(); ctx.fill(); ctx.stroke();
            ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(-8.5, -18.5); ctx.lineTo(8.5, -18.5); ctx.stroke(); ctx.fillStyle = '#0f172a'; ctx.strokeStyle = pal.trim; ctx.lineWidth = 1.3; ctx.beginPath(); ctx.arc(0, -22.5, 4.2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
            ctx.fillStyle = pal.visor; ctx.fillRect(-2.8, -23.4, 5.6, 2.2); ctx.fillStyle = '#fef08a'; ctx.fillRect(-4.2, -13.5, 2.6, 2.2); ctx.fillRect(1.6, -13.5, 2.6, 2.2);
        } else if (cid === 4) {
            const runCycle = now * 0.015 + (hz.phase || 0), swing = Math.sin(runCycle), bob = Math.abs(Math.cos(runCycle)) * 1.6; ctx.translate(0, -bob);
            const ll = swing > 0 ? swing * 4.0 : swing * 1.2, rl = swing < 0 ? -swing * 4.0 : -swing * 1.2;
            ctx.lineCap = 'round'; ctx.lineWidth = 2.8; ctx.strokeStyle = '#e2e8f0'; ctx.beginPath(); ctx.moveTo(-2.5, -10); ctx.lineTo(-3.0, -2.2 - ll); ctx.moveTo(2.5, -10); ctx.lineTo(3.0, -2.2 - rl); ctx.stroke();
            ctx.fillStyle = pal.trim; ctx.beginPath(); ctx.arc(-3.0, -1.6 - ll, 1.7, 0, Math.PI * 2); ctx.arc(3.0, -1.6 - rl, 1.7, 0, Math.PI * 2); ctx.fill();
            const laY = -13 + swing * 3.0, raY = -13 - swing * 3.0; ctx.strokeStyle = pal.top; ctx.lineWidth = 2.4; ctx.beginPath(); ctx.moveTo(-4.4, -18.5); ctx.lineTo(-7.0, laY); ctx.moveTo(4.4, -18.5); ctx.lineTo(7.0, raY); ctx.stroke();
            ctx.fillStyle = pal.skin; ctx.beginPath(); ctx.arc(-7.0, laY, 1.3, 0, Math.PI * 2); ctx.arc(7.0, raY, 1.3, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = pal.top; ctx.strokeStyle = pal.trim; ctx.lineWidth = 1.3;
            if (hz.subType === 'girl') { ctx.beginPath(); ctx.moveTo(-4.2, -19.5); ctx.lineTo(4.2, -19.5); ctx.lineTo(3.5, -13); ctx.lineTo(-3.5, -13); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.fillStyle = pal.trim; ctx.beginPath(); ctx.moveTo(-3.8, -13.2); ctx.lineTo(3.8, -13.2); ctx.lineTo(5.8, -8.8); ctx.lineTo(-5.8, -8.8); ctx.closePath(); ctx.fill(); }
            else { ctx.beginPath(); ctx.roundRect(-4.8, -19.5, 9.6, 9.8, 2); ctx.fill(); ctx.stroke(); ctx.fillStyle = pal.trim; ctx.fillRect(-4.2, -16.2, 8.4, 1.8); }
            ctx.fillStyle = pal.skin; ctx.beginPath(); ctx.arc(0, -23.5, 3.8, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = pal.hair;
            if (hz.subType === 'girl') { ctx.beginPath(); ctx.ellipse(3.5 + swing * 0.9, -23.8, 3.0, 1.6, 0.35, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.arc(0, -24.6, 3.9, Math.PI * 0.95, Math.PI * 0.05, false); ctx.fill(); }
            else { ctx.beginPath(); ctx.arc(0, -24.8, 4.0, Math.PI, 0, false); ctx.lineTo(3.2, -27.6); ctx.lineTo(0, -26.5); ctx.lineTo(-3.2, -27.6); ctx.closePath(); ctx.fill(); }
            ctx.fillStyle = '#0f172a'; ctx.fillRect(-1.8, -23.8, 1.1, 1.3); ctx.fillRect(0.7, -23.8, 1.1, 1.3);
        } else if (cid === 5) {
            const runCycle = now * 0.020 + (hz.phase || 0), stride = Math.sin(runCycle), bounce = Math.abs(Math.cos(runCycle)) * 1.4; ctx.translate(0, -bounce);
            const tailSway = Math.sin(runCycle * 1.6) * 4.2; ctx.strokeStyle = pal.coat; ctx.lineCap = 'round'; ctx.lineWidth = hz.subType === 'cat' ? 2.2 : 2.8; ctx.beginPath(); ctx.moveTo(0, -15.5); ctx.quadraticCurveTo(tailSway * 0.6, -20, tailSway, -23.2); ctx.stroke();
            ctx.fillStyle = pal.dark; ctx.strokeStyle = pal.outline; ctx.lineWidth = 1.0; ctx.beginPath(); ctx.ellipse(0, -13.2, 6.8, 4.2, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
            const hl = stride < 0 ? -stride * 3.6 : 0, hr = stride > 0 ? stride * 3.6 : 0; ctx.strokeStyle = pal.dark; ctx.lineWidth = 2.6; ctx.beginPath(); ctx.moveTo(-6.2, -11.5); ctx.lineTo(-6.6, -3.2 - hl); ctx.moveTo(6.2, -11.5); ctx.lineTo(6.6, -3.2 - hr); ctx.stroke();
            ctx.fillStyle = pal.coat; ctx.strokeStyle = pal.outline; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.ellipse(0, -9.8, 5.8, 4.6, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
            ctx.fillStyle = pal.belly; ctx.beginPath(); ctx.ellipse(0, -9.2, 3.4, 3.0, 0, 0, Math.PI * 2); ctx.fill();
            const fl = stride > 0 ? stride * 3.8 : 0, fr = stride < 0 ? -stride * 3.8 : 0; ctx.strokeStyle = pal.coat; ctx.lineWidth = 2.7; ctx.beginPath(); ctx.moveTo(-3.1, -8.0); ctx.lineTo(-3.2, -1.0 - fl); ctx.moveTo(3.1, -8.0); ctx.lineTo(3.2, -1.0 - fr); ctx.stroke();
            if (hz.subType === 'dog') {
                ctx.strokeStyle = pal.collar; ctx.lineWidth = 2.1; ctx.beginPath(); ctx.moveTo(-4.4, -12.6); ctx.quadraticCurveTo(0, -11.0, 4.4, -12.6); ctx.stroke();
                ctx.fillStyle = pal.dark; ctx.beginPath(); ctx.ellipse(-4.8, -16.8 + stride * 0.6, 2.0, 3.6, 0.32, 0, Math.PI * 2); ctx.ellipse(4.8, -16.8 - stride * 0.6, 2.0, 3.6, -0.32, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = pal.coat; ctx.strokeStyle = pal.outline; ctx.lineWidth = 1.1; ctx.beginPath(); ctx.arc(0, -16.5, 4.6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
                ctx.fillStyle = pal.belly; ctx.beginPath(); ctx.ellipse(0, -14.8, 2.6, 2.0, 0, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#090d16'; ctx.beginPath(); ctx.arc(0, -15.4, 1.2, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(-1.8, -17.5, 1.05, 0, Math.PI * 2); ctx.arc(1.8, -17.5, 1.05, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#090d16'; ctx.beginPath(); ctx.arc(-1.8, -17.5, 0.5, 0, Math.PI * 2); ctx.arc(1.8, -17.5, 0.5, 0, Math.PI * 2); ctx.fill();
            } else {
                ctx.fillStyle = pal.coat; ctx.strokeStyle = pal.outline; ctx.lineWidth = 1.1; ctx.beginPath(); ctx.moveTo(-4.4, -17.8); ctx.lineTo(-5.4, -22.6); ctx.lineTo(-1.4, -19.8); ctx.moveTo(4.4, -17.8); ctx.lineTo(5.4, -22.6); ctx.lineTo(1.4, -19.8); ctx.closePath(); ctx.fill(); ctx.stroke();
                ctx.fillStyle = '#f472b6'; ctx.beginPath(); ctx.moveTo(-3.9, -18.2); ctx.lineTo(-4.6, -21.4); ctx.lineTo(-2.0, -19.5); ctx.moveTo(3.9, -18.2); ctx.lineTo(4.6, -21.4); ctx.lineTo(2.0, -19.5); ctx.closePath(); ctx.fill();
                ctx.fillStyle = pal.coat; ctx.beginPath(); ctx.arc(0, -16.4, 4.3, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.fillStyle = pal.eye; ctx.beginPath(); ctx.ellipse(-1.8, -17.0, 1.15, 0.85, -0.18, 0, Math.PI * 2); ctx.ellipse(1.8, -17.0, 1.15, 0.85, 0.18, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#fb7185'; ctx.beginPath(); ctx.arc(0, -15.2, 0.85, 0, Math.PI * 2); ctx.fill();
            }
        } else if (cid === 6) {
            ctx.fillStyle = '#334155'; ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(-12.5, -5); ctx.lineTo(-9, -9.8); ctx.lineTo(-2, -11); ctx.lineTo(6.5, -10.2); ctx.lineTo(12.5, -6); ctx.lineTo(10, -1.2); ctx.lineTo(1.5, -0.4); ctx.lineTo(-8.5, -1); ctx.closePath(); ctx.fill(); ctx.stroke();
            ctx.fillStyle = '#020617'; ctx.beginPath(); ctx.ellipse(0, -5.2, 9.2, 3.4, 0, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#38bdf8'; ctx.beginPath(); ctx.ellipse(-1, -4.8, 5.5, 1.5, 0, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#f97316'; ctx.fillRect(-11.5, -11.5, 3.2, 2.2); ctx.fillRect(8.3, -11.5, 3.2, 2.2);
        } else {
            const isY = hz.variantIdx === 0; ctx.fillStyle = isY ? '#090d16' : '#334155'; ctx.strokeStyle = isY ? '#fde047' : '#cbd5e1'; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.moveTo(-15.5, -1.2); ctx.quadraticCurveTo(-14, -9.8, -11, -9.8); ctx.lineTo(11, -9.8); ctx.quadraticCurveTo(14, -9.8, 15.5, -1.2); ctx.closePath(); ctx.fill(); ctx.stroke();
            ctx.fillStyle = isY ? '#facc15' : '#ffffff'; for (let c = -2; c <= 2; c++) { const sx = c * 5.2; ctx.beginPath(); ctx.moveTo(sx - 1.8, -1.8); ctx.lineTo(sx - 0.2, -9.0); ctx.lineTo(sx + 2.2, -9.0); ctx.lineTo(sx + 0.6, -1.8); ctx.closePath(); ctx.fill(); }
            ctx.fillStyle = '#ef4444'; ctx.fillRect(-13.5, -4.5, 2.5, 1.8); ctx.fillRect(11, -4.5, 2.5, 1.8);
        }
        ctx.restore();
    }

    if (globalSettings.graphics.hudBoxes) {
        ctx.strokeStyle = tierCol; ctx.lineWidth = hz.rFinal >= 0.65 ? 1.8 : 1.2; ctx.strokeRect(x1 - 2, y1 - 2, boxW + 4, boxH + 4);
        if (hz.z < 34) { const label = `${hz.cls.name} ${hz.z.toFixed(1)}m | DGI ${hz.dgi}`, ew = label.length * 6.0 + 8; ctx.fillStyle = 'rgba(9,11,16,0.88)'; ctx.fillRect(bx - ew * 0.5, y1 - 17, ew, 13); ctx.fillStyle = tierCol; ctx.fillText(label, bx - ew * 0.5 + 4, y1 - 7); }
    }
}

function drawRoadsterVehicle(tCtx, carCenterX, rearY, halfW, carH, hoodLeadX, cust, isBoosting, isBraking, now, allowBloom, rollRad = 0) {
    const skin = cust.nitroSkin || 'standard';
    const chroma = getSkinChromaPalette(skin, cust, now);
    const borderGlowCol = chroma.primaryGlow, secGlowCol = chroma.secondaryGlow, primary = cust.bodyPrimary || '#1e293b';
    const boostCol = cust.boostColor || '#fbbf24';
    const voidHue = (now * 0.16) % 360;

    const ringPulse = 1.0 + Math.sin(now * (isBoosting ? 0.018 : 0.007)) * (isBoosting ? 0.15 : 0.075);
    const ringR = halfW * (isBoosting ? 1.64 : 1.38) * ringPulse;
    const ringRY = Math.max(7.5, halfW * (isBoosting ? 0.28 : 0.235)) * ringPulse;
    const ringPrimaryCol = chroma.isAllInOne ? chroma.empPrimary : boostCol;
    const ringSecCol = chroma.isAllInOne ? secGlowCol : borderGlowCol;

    const ugR = Math.max(10, halfW * (isBoosting ? 1.68 : 1.40));
    const ug = tCtx.createRadialGradient(carCenterX, rearY + 3, 3, carCenterX, rearY + 3, ugR);
    ug.addColorStop(0, chroma.underglow);
    ug.addColorStop(0.65, colorWithAlpha(isBoosting ? ringPrimaryCol : ringSecCol, isBoosting ? 0.28 : 0.15));
    ug.addColorStop(1, 'transparent');
    tCtx.fillStyle = ug;
    tCtx.beginPath();
    tCtx.ellipse(carCenterX, rearY + 3, ugR, Math.max(9, halfW * (isBoosting ? 0.29 : 0.24)), 0, 0, Math.PI * 2);
    tCtx.fill();

    tCtx.save();
    if (allowBloom) {
        tCtx.shadowBlur = isBoosting ? (isMobileHardware ? 14 : 22) : (isMobileHardware ? 8 : 13);
        tCtx.shadowColor = ringPrimaryCol;
    }

    tCtx.strokeStyle = ringPrimaryCol;
    tCtx.globalAlpha = isBoosting ? 0.94 : 0.72;
    tCtx.lineWidth = isBoosting ? 2.8 : 2.0;
    tCtx.beginPath();
    tCtx.ellipse(carCenterX, rearY + 3, ringR, ringRY, 0, 0, Math.PI * 2);
    tCtx.stroke();

    if (isBoosting) {
        tCtx.strokeStyle = chroma.isAllInOne ? secGlowCol : '#ffffff';
        tCtx.globalAlpha = 0.58;
        tCtx.lineWidth = 1.6;
        tCtx.beginPath();
        tCtx.ellipse(carCenterX, rearY + 3, ringR * 1.15, ringRY * 1.15, 0, 0, Math.PI * 2);
        tCtx.stroke();
    }

    const arcSpeed = isBoosting ? 0.015 : 0.0065;
    const arcStart1 = now * arcSpeed;
    const arcStart2 = -now * (arcSpeed * 0.85) + Math.PI;
    tCtx.shadowBlur = 0;

    tCtx.strokeStyle = chroma.isAllInOne ? secGlowCol : '#ffffff';
    tCtx.globalAlpha = isBoosting ? 0.88 : 0.64;
    tCtx.lineWidth = isBoosting ? 2.1 : 1.5;
    tCtx.beginPath();
    tCtx.ellipse(carCenterX, rearY + 3, ringR * 0.85, ringRY * 0.85, 0, arcStart1, arcStart1 + 2.05);
    tCtx.stroke();

    tCtx.strokeStyle = ringSecCol;
    tCtx.globalAlpha = isBoosting ? 0.82 : 0.55;
    tCtx.lineWidth = isBoosting ? 1.8 : 1.3;
    tCtx.beginPath();
    tCtx.ellipse(carCenterX, rearY + 3, ringR * 0.68, ringRY * 0.68, 0, arcStart2, arcStart2 + 2.25);
    tCtx.stroke();

    const nodeCount = isBoosting ? 4 : 2;
    for (let n = 0; n < nodeCount; n++) {
        const na = arcStart1 * 1.15 + (n / nodeCount) * Math.PI * 2;
        const nx = carCenterX + Math.cos(na) * ringR;
        const ny = (rearY + 3) + Math.sin(na) * ringRY;
        tCtx.fillStyle = n % 2 === 0 ? '#ffffff' : ringPrimaryCol;
        tCtx.globalAlpha = isBoosting ? 0.95 : 0.78;
        tCtx.beginPath();
        tCtx.arc(nx, ny, isBoosting ? 2.6 : 1.9, 0, Math.PI * 2);
        tCtx.fill();
    }
    tCtx.restore();

    tCtx.fillStyle = 'rgba(0,0,0,0.80)';
    tCtx.beginPath();
    tCtx.ellipse(carCenterX, rearY + 3, halfW * 0.98, 6, 0, 0, Math.PI * 2);
    tCtx.fill();

    const vibX = isBoosting ? (Math.sin(now * 0.135) * 2.45 + Math.cos(now * 0.188) * 1.55) : 0;
    const vibY = isBoosting ? (Math.sin(now * 0.028) * 2.35 + Math.cos(now * 0.148) * 1.75) : 0;
    const vibRoll = isBoosting ? (Math.sin(now * 0.095) * 0.022) : 0;

    tCtx.save();
    tCtx.translate(carCenterX + vibX, rearY + vibY);
    tCtx.rotate((rollRad * 0.45) + vibRoll);
    tCtx.translate(-carCenterX, -rearY);

    const diffuserBotY = rearY, fasciaTopY = rearY - Math.round(carH * 0.34), shoulderY = rearY - Math.round(carH * 0.56), roofTopY = rearY - carH;
    const shoulderHalfW = Math.round(halfW * 0.96), roofHalfW = Math.round(halfW * 0.56), hoodHalfW = Math.round(halfW * 0.44);

    const tireW = Math.max(9, Math.round(halfW * 0.26)), tireH = Math.max(13, Math.round(carH * 0.36));
    tCtx.fillStyle = '#04060a'; tCtx.strokeStyle = chroma.isAllInOne ? borderGlowCol : colorWithAlpha(borderGlowCol, 0.53); tCtx.lineWidth = 1.3;
    tCtx.beginPath(); tCtx.roundRect(carCenterX - halfW - 2, diffuserBotY - tireH + 3, tireW, tireH, 3); tCtx.roundRect(carCenterX + halfW - tireW + 2, diffuserBotY - tireH + 3, tireW, tireH, 3); tCtx.fill(); tCtx.stroke();

    if (allowBloom) { tCtx.shadowBlur = isMobileHardware ? 13 : (skin === 'void_chroma' ? 22 : 18); tCtx.shadowColor = borderGlowCol; }

    const bodyGrad = tCtx.createLinearGradient(carCenterX - halfW * 0.5, roofTopY, carCenterX + halfW * 0.5, diffuserBotY);
    if (chroma.isAllInOne) { bodyGrad.addColorStop(0, '#0a0f1c'); bodyGrad.addColorStop(0.32, chroma.bodyTint); bodyGrad.addColorStop(0.66, chroma.bodyMidTint); bodyGrad.addColorStop(1, '#070a12'); }
    else { bodyGrad.addColorStop(0, primary); bodyGrad.addColorStop(0.45, chroma.bodyTint); bodyGrad.addColorStop(1, '#080c15'); }
    tCtx.fillStyle = bodyGrad; tCtx.strokeStyle = borderGlowCol; tCtx.lineWidth = chroma.isAllInOne ? 2.4 : 2.25;
    tCtx.beginPath();
    tCtx.moveTo(carCenterX - halfW + 2, diffuserBotY - 3);
    tCtx.quadraticCurveTo(carCenterX - halfW - 4, fasciaTopY + 4, carCenterX - shoulderHalfW, shoulderY);
    tCtx.quadraticCurveTo(carCenterX + hoodLeadX * 0.5 - roofHalfW * 1.12, roofTopY + Math.round(carH * 0.18), carCenterX + hoodLeadX - hoodHalfW, roofTopY + 3);
    tCtx.quadraticCurveTo(carCenterX + hoodLeadX, roofTopY - 3, carCenterX + hoodLeadX + hoodHalfW, roofTopY + 3);
    tCtx.quadraticCurveTo(carCenterX + hoodLeadX * 0.5 + roofHalfW * 1.12, roofTopY + Math.round(carH * 0.18), carCenterX + shoulderHalfW, shoulderY);
    tCtx.quadraticCurveTo(carCenterX + halfW + 4, fasciaTopY + 4, carCenterX + halfW - 2, diffuserBotY - 3);
    tCtx.closePath(); tCtx.fill(); tCtx.stroke(); tCtx.shadowBlur = 0;

    if (skin === 'void_chroma') {
        tCtx.save(); tCtx.strokeStyle = `hsla(${(voidHue + 180) % 360},100%,70%,0.55)`; tCtx.lineWidth = 1.4;
        tCtx.beginPath(); tCtx.ellipse(carCenterX, shoulderY + 4, halfW * 1.06, carH * 0.40, Math.sin(now * 0.0025) * 0.08, 0, Math.PI * 2); tCtx.stroke(); tCtx.restore();
    } else if (skin === 'aether_helix') {
        tCtx.strokeStyle = secGlowCol; tCtx.lineWidth = 1.35;
        tCtx.beginPath(); tCtx.moveTo(carCenterX - shoulderHalfW * 0.88, shoulderY + 1); tCtx.lineTo(carCenterX + hoodLeadX * 0.5 - roofHalfW * 0.72, roofTopY + 10); tCtx.moveTo(carCenterX + shoulderHalfW * 0.88, shoulderY + 1); tCtx.lineTo(carCenterX + hoodLeadX * 0.5 + roofHalfW * 0.72, roofTopY + 10); tCtx.stroke();
    } else if (skin === 'solar_crown') {
        tCtx.strokeStyle = '#fef08a'; tCtx.lineWidth = 1.35;
        tCtx.beginPath(); tCtx.moveTo(carCenterX - halfW * 0.74, fasciaTopY - 2); tCtx.lineTo(carCenterX, shoulderY - 3); tCtx.lineTo(carCenterX + halfW * 0.74, fasciaTopY - 2); tCtx.stroke();
    } else if (skin === 'chrono_arc') {
        tCtx.strokeStyle = secGlowCol; tCtx.lineWidth = 1.3; const px = Math.sin(now * 0.007) * 3;
        tCtx.beginPath(); tCtx.moveTo(carCenterX - shoulderHalfW * 0.72, shoulderY + 2); tCtx.lineTo(carCenterX - halfW * 0.35 + px, fasciaTopY - 1); tCtx.moveTo(carCenterX + shoulderHalfW * 0.72, shoulderY + 2); tCtx.lineTo(carCenterX + halfW * 0.35 - px, fasciaTopY - 1); tCtx.stroke();
    } else {
        const sheenA = 0.24 + Math.abs(Math.sin(now * 0.003)) * 0.32;
        tCtx.save(); tCtx.globalAlpha = sheenA; tCtx.strokeStyle = secGlowCol; tCtx.lineWidth = 1.2;
        tCtx.beginPath(); tCtx.moveTo(carCenterX - shoulderHalfW * 0.78, shoulderY + 2); tCtx.lineTo(carCenterX + hoodLeadX * 0.35, roofTopY + carH * 0.26); tCtx.lineTo(carCenterX + shoulderHalfW * 0.78, shoulderY + 2); tCtx.stroke(); tCtx.restore();
    }

    tCtx.fillStyle = primary; tCtx.strokeStyle = borderGlowCol; tCtx.lineWidth = 1.25;
    const mirrorY = shoulderY - Math.round(carH * 0.16), mCX = carCenterX + Math.round(hoodLeadX * 0.45);
    tCtx.beginPath();
    tCtx.moveTo(mCX - roofHalfW * 1.10, mirrorY); tCtx.lineTo(mCX - roofHalfW * 1.28, mirrorY - 2); tCtx.lineTo(mCX - roofHalfW * 1.18, mirrorY + 3); tCtx.closePath();
    tCtx.moveTo(mCX + roofHalfW * 1.10, mirrorY); tCtx.lineTo(mCX + roofHalfW * 1.28, mirrorY - 2); tCtx.lineTo(mCX + roofHalfW * 1.18, mirrorY + 3); tCtx.closePath();
    tCtx.fill(); tCtx.stroke();

    const glassGrad = tCtx.createLinearGradient(carCenterX, roofTopY + 2, carCenterX, shoulderY + 4);
    glassGrad.addColorStop(0, chroma.canopyTop); glassGrad.addColorStop(0.55, chroma.canopyMid); glassGrad.addColorStop(1, '#060911');
    tCtx.fillStyle = glassGrad; tCtx.strokeStyle = chroma.isAllInOne ? secGlowCol : colorWithAlpha(borderGlowCol, 0.67); tCtx.lineWidth = 1.35;
    tCtx.beginPath();
    tCtx.moveTo(carCenterX + hoodLeadX - hoodHalfW * 0.82, roofTopY + 4); tCtx.quadraticCurveTo(carCenterX + hoodLeadX, roofTopY + 1, carCenterX + hoodLeadX + hoodHalfW * 0.82, roofTopY + 4);
    tCtx.lineTo(carCenterX + roofHalfW * 0.76, shoulderY + 2); tCtx.quadraticCurveTo(carCenterX, shoulderY + 5, carCenterX - roofHalfW * 0.76, shoulderY + 2); tCtx.closePath(); tCtx.fill(); tCtx.stroke();

    tCtx.strokeStyle = 'rgba(255,255,255,0.36)'; tCtx.lineWidth = 1.1;
    tCtx.beginPath(); tCtx.moveTo(carCenterX + hoodLeadX * 0.55 - roofHalfW * 0.68, roofTopY + Math.round(carH * 0.18)); tCtx.quadraticCurveTo(carCenterX + hoodLeadX * 0.55, roofTopY + Math.round(carH * 0.15), carCenterX + hoodLeadX * 0.55 + roofHalfW * 0.68, roofTopY + Math.round(carH * 0.18)); tCtx.stroke();

    tCtx.strokeStyle = chroma.isAllInOne ? borderGlowCol : colorWithAlpha(borderGlowCol, 0.73); tCtx.lineWidth = 1.3;
    tCtx.beginPath(); tCtx.moveTo(carCenterX - shoulderHalfW + 2, shoulderY); tCtx.quadraticCurveTo(carCenterX - halfW * 0.68, fasciaTopY - 4, carCenterX - halfW * 0.42, fasciaTopY); tCtx.moveTo(carCenterX + shoulderHalfW - 2, shoulderY); tCtx.quadraticCurveTo(carCenterX + halfW * 0.68, fasciaTopY - 4, carCenterX + halfW * 0.42, fasciaTopY); tCtx.stroke();

    const wingLift = isBraking ? 6 : (isBoosting ? 4.5 : 0.8), wingY = fasciaTopY - 2 - wingLift, wingW = Math.round(shoulderHalfW * 0.94);
    tCtx.fillStyle = '#070b14'; tCtx.strokeStyle = borderGlowCol; tCtx.lineWidth = 1.6;
    tCtx.beginPath(); tCtx.moveTo(carCenterX - wingW, wingY + 2); tCtx.quadraticCurveTo(carCenterX, wingY - 2, carCenterX + wingW, wingY + 2); tCtx.lineTo(carCenterX + wingW - 3, wingY + 5); tCtx.quadraticCurveTo(carCenterX, wingY + 2, carCenterX - wingW + 3, wingY + 5); tCtx.closePath(); tCtx.fill(); tCtx.stroke();

    const fasciaW = Math.round(halfW * 0.90), fasciaH = Math.max(10, diffuserBotY - fasciaTopY - 3);
    tCtx.fillStyle = '#05070e'; tCtx.strokeStyle = chroma.isAllInOne ? secGlowCol : '#1e293b'; tCtx.lineWidth = 1.25;
    tCtx.beginPath(); tCtx.roundRect(carCenterX - fasciaW, fasciaTopY, fasciaW * 2, fasciaH, 4); tCtx.fill(); tCtx.stroke();

    const tailCol = isBraking ? '#ff1e42' : chroma.tailColor;
    if (allowBloom) { tCtx.shadowBlur = isBraking ? 20 : 12; tCtx.shadowColor = tailCol; }
    tCtx.fillStyle = tailCol;
    const bladeW = Math.round(fasciaW * 0.42), bladeY = fasciaTopY + 2;
    tCtx.beginPath(); tCtx.roundRect(carCenterX - fasciaW + 3, bladeY, bladeW, 3.5, 2); tCtx.roundRect(carCenterX + fasciaW - bladeW - 3, bladeY, bladeW, 3.5, 2); tCtx.roundRect(carCenterX - 4, bladeY + 0.5, 8, 2.5, 1); tCtx.fill(); tCtx.shadowBlur = 0;

    const diffY = diffuserBotY - 8;
    tCtx.strokeStyle = chroma.isAllInOne ? borderGlowCol : colorWithAlpha(borderGlowCol, 0.53); tCtx.lineWidth = 1.25;
    tCtx.beginPath(); [-0.55, -0.25, 0.25, 0.55].forEach(r => { const sx = carCenterX + Math.round(fasciaW * r); tCtx.moveTo(sx, diffY); tCtx.lineTo(sx, diffuserBotY - 2); }); tCtx.stroke();

    const leftNozX = Math.round(carCenterX - fasciaW * 0.36), rightNozX = Math.round(carCenterX + fasciaW * 0.36);
    tCtx.fillStyle = '#090d16'; tCtx.strokeStyle = isBoosting ? (chroma.isAllInOne ? borderGlowCol : boostCol) : borderGlowCol; tCtx.lineWidth = 1.45;
    tCtx.beginPath(); tCtx.roundRect(leftNozX - 6, diffY + 1, 12, 4.5, 2); tCtx.roundRect(rightNozX - 6, diffY + 1, 12, 4.5, 2); tCtx.roundRect(carCenterX - 8, diffY + 1, 16, 5, 2); tCtx.fill(); tCtx.stroke();

    if (!isBoosting) {
        const idlePulse = 0.65 + Math.sin(now * 0.03) * 0.25;
        tCtx.save();
        tCtx.globalAlpha = idlePulse;
        tCtx.fillStyle = ringPrimaryCol;
        tCtx.beginPath();
        tCtx.ellipse(leftNozX, diffY + 3.5, 3.5, 1.4, 0, 0, Math.PI * 2);
        tCtx.ellipse(rightNozX, diffY + 3.5, 3.5, 1.4, 0, 0, Math.PI * 2);
        tCtx.ellipse(carCenterX, diffY + 3.6, 5.0, 1.6, 0, 0, Math.PI * 2);
        tCtx.fill();
        tCtx.restore();
    } else {
        const pulse = Math.sin(now * 0.042);
        const flameLen = 19 + pulse * 4.2 + Math.random() * 6.5;

        if (skin === 'void_chroma') {
            const c1 = `hsl(${voidHue},100%,60%)`, c2 = `hsl(${(voidHue + 95) % 360},100%,64%)`, c3 = `hsl(${(voidHue + 205) % 360},100%,66%)`, c4 = `hsl(${(voidHue + 300) % 360},100%,72%)`;
            for (let r = 0; r < 3; r++) {
                const prog = (now * 0.0048 + r * 0.333) % 1;
                const ry = diffuserBotY + 3 + prog * flameLen * 1.65, rx = (9 + prog * 16) * (1 - prog * 0.25);
                tCtx.save(); tCtx.globalAlpha = (1 - prog) * 0.85; tCtx.strokeStyle = `hsl(${(voidHue + r * 110) % 360},100%,66%)`; tCtx.lineWidth = 2.2 - prog * 1.1;
                tCtx.beginPath(); tCtx.ellipse(carCenterX, ry, rx, rx * 0.26, 0, 0, Math.PI * 2); tCtx.stroke(); tCtx.restore();
            }
            if (allowBloom) { tCtx.shadowBlur = 24; tCtx.shadowColor = c1; }
            for (let side = -1; side <= 1; side += 2) {
                const nx = side < 0 ? leftNozX : rightNozX, gOut = tCtx.createLinearGradient(nx, diffuserBotY - 2, nx, diffuserBotY + flameLen * 1.38);
                gOut.addColorStop(0, '#ffffff'); gOut.addColorStop(0.28, side < 0 ? c1 : c3); gOut.addColorStop(0.70, c2); gOut.addColorStop(1, 'transparent');
                tCtx.fillStyle = gOut; const sway = Math.sin(now * 0.032 + side) * 3.0;
                tCtx.beginPath(); tCtx.moveTo(nx - 6, diffuserBotY - 2); tCtx.quadraticCurveTo(nx - 2 + sway, diffuserBotY + flameLen * 0.65, nx + sway * 1.4, diffuserBotY + flameLen * 1.35); tCtx.quadraticCurveTo(nx + 4 + sway, diffuserBotY + flameLen * 0.65, nx + 6, diffuserBotY - 2); tCtx.closePath(); tCtx.fill();
            }
            const gMid = tCtx.createLinearGradient(carCenterX, diffuserBotY - 2, carCenterX, diffuserBotY + flameLen * 1.85);
            gMid.addColorStop(0, '#ffffff'); gMid.addColorStop(0.20, c4); gMid.addColorStop(0.55, c1); gMid.addColorStop(0.85, c3); gMid.addColorStop(1, 'transparent');
            tCtx.fillStyle = gMid;
            tCtx.beginPath(); tCtx.moveTo(carCenterX - 11, diffuserBotY - 2); tCtx.quadraticCurveTo(carCenterX - 12.5, diffuserBotY + flameLen * 0.55, carCenterX, diffuserBotY + flameLen * 1.85); tCtx.quadraticCurveTo(carCenterX + 12.5, diffuserBotY + flameLen * 0.55, carCenterX + 11, diffuserBotY - 2); tCtx.closePath(); tCtx.fill();
            tCtx.fillStyle = '#ffffff'; tCtx.beginPath(); tCtx.moveTo(carCenterX - 5, diffuserBotY - 2); tCtx.lineTo(carCenterX, diffuserBotY + flameLen * 1.22); tCtx.lineTo(carCenterX + 5, diffuserBotY - 2); tCtx.closePath(); tCtx.fill();
            for (let d = 0; d < 4; d++) {
                const dy = diffuserBotY + 4 + d * (flameLen * 0.34), dw = 7.2 - d * 1.35;
                tCtx.fillStyle = d === 0 ? '#ffffff' : `hsl(${(voidHue + d * 80) % 360},100%,74%)`;
                tCtx.beginPath(); tCtx.moveTo(carCenterX, dy - 3.2); tCtx.lineTo(carCenterX + dw, dy); tCtx.lineTo(carCenterX, dy + 4.5); tCtx.lineTo(carCenterX - dw, dy); tCtx.closePath(); tCtx.fill();
            }
            tCtx.save(); tCtx.translate(carCenterX, diffuserBotY + 3);
            tCtx.fillStyle = '#03000a'; tCtx.beginPath(); tCtx.ellipse(0, 0, 6.8, 3.0, 0, 0, Math.PI * 2); tCtx.fill();
            for (let arc = 0; arc < 2; arc++) { const a0 = now * 0.014 + arc * Math.PI; tCtx.strokeStyle = arc === 0 ? c1 : c2; tCtx.lineWidth = 2.0; tCtx.beginPath(); tCtx.ellipse(0, 0, 10, 4.1, 0, a0, a0 + 2.1); tCtx.stroke(); }
            tCtx.restore();
            tCtx.strokeStyle = '#ffffff'; tCtx.lineWidth = 1.35;
            for (let w = -1; w <= 1; w += 2) {
                tCtx.beginPath(); tCtx.moveTo(carCenterX + w * 9, diffuserBotY);
                tCtx.lineTo(carCenterX + w * 13 + Math.sin(now * 0.055 + w * 3) * 6, diffuserBotY + flameLen * 0.48);
                tCtx.lineTo(carCenterX + w * 5 + Math.cos(now * 0.048 + w * 5) * 7, diffuserBotY + flameLen * 1.08); tCtx.stroke();
            }
            for (let sp = 0; sp < 6; sp++) {
                const p = (now * 0.0052 + sp * 0.166) % 1, sx = carCenterX + Math.sin(sp * 2.4 + now * 0.01) * (5 + p * 15), sy = diffuserBotY + 3 + p * flameLen * 1.7;
                tCtx.fillStyle = `hsl(${(voidHue + sp * 60) % 360},100%,76%)`; tCtx.fillRect(sx - 1.5, sy - 1.5, 3 * (1 - p * 0.5), 5 * (1 - p * 0.4));
            }
            tCtx.shadowBlur = 0;
        } else if (skin === 'aether_helix') {
            if (allowBloom) { tCtx.shadowBlur = 20; tCtx.shadowColor = borderGlowCol; }
            for (const nx of [leftNozX, rightNozX]) {
                for (let strand = 0; strand < 2; strand++) {
                    tCtx.strokeStyle = strand === 0 ? borderGlowCol : secGlowCol; tCtx.lineWidth = 2.3; tCtx.beginPath();
                    for (let t = 0; t <= 1; t += 0.14) { const y = diffuserBotY - 1 + t * flameLen * 1.42, x = nx + Math.sin(now * 0.030 + t * 9.5 + strand * Math.PI) * (5.0 * (1 - t * 0.42)); if (t === 0) tCtx.moveTo(x, y); else tCtx.lineTo(x, y); }
                    tCtx.stroke();
                }
            }
            const gA = tCtx.createLinearGradient(carCenterX, diffuserBotY - 2, carCenterX, diffuserBotY + flameLen * 1.55);
            gA.addColorStop(0, '#ffffff'); gA.addColorStop(0.35, borderGlowCol); gA.addColorStop(0.75, secGlowCol); gA.addColorStop(1, 'transparent');
            tCtx.fillStyle = gA; tCtx.beginPath(); tCtx.moveTo(carCenterX - 7.5, diffuserBotY - 2); tCtx.lineTo(carCenterX, diffuserBotY + flameLen * 1.58); tCtx.lineTo(carCenterX + 7.5, diffuserBotY - 2); tCtx.closePath(); tCtx.fill();
            tCtx.fillStyle = '#ffffff'; tCtx.beginPath(); tCtx.moveTo(carCenterX - 3.4, diffuserBotY - 2); tCtx.lineTo(carCenterX, diffuserBotY + flameLen * 1.05); tCtx.lineTo(carCenterX + 3.4, diffuserBotY - 2); tCtx.closePath(); tCtx.fill();
            for (let c = 0; c < 5; c++) { const p = (now * 0.0046 + c * 0.2) % 1, cxp = carCenterX + Math.cos(c * 2.1 + now * 0.012) * (9 + p * 8), cyp = diffuserBotY + 3 + p * flameLen * 1.45, sz = 3.0 * (1 - p * 0.5); tCtx.fillStyle = c % 2 === 0 ? '#e0f2fe' : secGlowCol; tCtx.beginPath(); tCtx.moveTo(cxp, cyp - sz); tCtx.lineTo(cxp + sz, cyp); tCtx.lineTo(cxp, cyp + sz); tCtx.lineTo(cxp - sz, cyp); tCtx.closePath(); tCtx.fill(); }
            tCtx.shadowBlur = 0;
        } else if (skin === 'solar_crown') {
            if (allowBloom) { tCtx.shadowBlur = 20; tCtx.shadowColor = borderGlowCol; }
            for (let side = -1; side <= 1; side += 2) {
                tCtx.strokeStyle = borderGlowCol; tCtx.lineWidth = 2.3; tCtx.beginPath(); tCtx.moveTo(carCenterX + side * 6, diffuserBotY); tCtx.quadraticCurveTo(carCenterX + side * (fasciaW * 0.72), diffuserBotY + flameLen * 0.45, carCenterX + side * (fasciaW * 0.46), diffuserBotY + flameLen * 1.18); tCtx.stroke();
                const nx = side < 0 ? leftNozX : rightNozX, gS = tCtx.createLinearGradient(nx, diffuserBotY - 2, nx, diffuserBotY + flameLen * 1.25);
                gS.addColorStop(0, '#fef9c3'); gS.addColorStop(0.4, borderGlowCol); gS.addColorStop(1, 'transparent');
                tCtx.fillStyle = gS; tCtx.beginPath(); tCtx.moveTo(nx - 5.5, diffuserBotY - 2); tCtx.lineTo(nx, diffuserBotY + flameLen * 1.25); tCtx.lineTo(nx + 5.5, diffuserBotY - 2); tCtx.closePath(); tCtx.fill();
            }
            const gC = tCtx.createLinearGradient(carCenterX, diffuserBotY - 2, carCenterX, diffuserBotY + flameLen * 1.62);
            gC.addColorStop(0, '#ffffff'); gC.addColorStop(0.35, borderGlowCol); gC.addColorStop(0.75, secGlowCol); gC.addColorStop(1, 'transparent');
            tCtx.fillStyle = gC; tCtx.beginPath(); tCtx.moveTo(carCenterX - 8.5, diffuserBotY - 2); tCtx.lineTo(carCenterX, diffuserBotY + flameLen * 1.62); tCtx.lineTo(carCenterX + 8.5, diffuserBotY - 2); tCtx.closePath(); tCtx.fill();
            for (let d = 0; d < 4; d++) { const dy = diffuserBotY + 3 + d * (flameLen * 0.34), dw = 7.2 - d * 1.45; tCtx.fillStyle = d === 0 ? '#ffffff' : (d === 1 ? '#fef08a' : (d === 2 ? borderGlowCol : secGlowCol)); tCtx.beginPath(); tCtx.moveTo(carCenterX, dy - 3.3); tCtx.lineTo(carCenterX + dw, dy); tCtx.lineTo(carCenterX, dy + 4.3); tCtx.lineTo(carCenterX - dw, dy); tCtx.closePath(); tCtx.fill(); }
            for (let e = 0; e < 5; e++) { const p = (now * 0.005 + e * 0.2) % 1; tCtx.fillStyle = e % 2 === 0 ? '#fef08a' : '#f97316'; tCtx.beginPath(); tCtx.arc(carCenterX + Math.sin(e * 3.1 + now * 0.015) * (13 * p + 4), diffuserBotY + 3 + p * flameLen * 1.5, 2.0 * (1 - p * 0.5), 0, Math.PI * 2); tCtx.fill(); }
            tCtx.shadowBlur = 0;
        } else if (skin === 'chrono_arc') {
            if (allowBloom) { tCtx.shadowBlur = 20; tCtx.shadowColor = borderGlowCol; }
            const gCh = tCtx.createLinearGradient(carCenterX, diffuserBotY - 2, carCenterX, diffuserBotY + flameLen * 1.55);
            gCh.addColorStop(0, '#ecfdf5'); gCh.addColorStop(0.32, borderGlowCol); gCh.addColorStop(0.72, secGlowCol); gCh.addColorStop(1, 'transparent');
            tCtx.fillStyle = gCh; tCtx.beginPath(); tCtx.moveTo(carCenterX - 7.5, diffuserBotY - 2); tCtx.lineTo(carCenterX, diffuserBotY + flameLen * 1.55); tCtx.lineTo(carCenterX + 7.5, diffuserBotY - 2); tCtx.closePath(); tCtx.fill();
            for (const nx of [leftNozX, rightNozX]) { tCtx.fillStyle = secGlowCol; tCtx.beginPath(); tCtx.moveTo(nx - 4.2, diffuserBotY - 2); tCtx.lineTo(nx, diffuserBotY + flameLen * 1.05); tCtx.lineTo(nx + 4.2, diffuserBotY - 2); tCtx.closePath(); tCtx.fill(); }
            for (let r = 0; r < 4; r++) {
                const prog = (now * 0.0052 + r * 0.25) % 1, ry = diffuserBotY + 3 + prog * flameLen * 1.48, rx = 11 * (1 - prog * 0.38);
                tCtx.save(); tCtx.globalAlpha = 1 - prog * 0.78; tCtx.strokeStyle = r % 2 === 0 ? '#a7f3d0' : borderGlowCol; tCtx.lineWidth = 1.8;
                tCtx.beginPath(); tCtx.ellipse(carCenterX, ry, rx, 2.7, 0, 0, Math.PI * 2); tCtx.stroke();
                const tickA = now * 0.012 + r * 1.4; tCtx.fillStyle = '#ffffff'; tCtx.beginPath(); tCtx.arc(carCenterX + Math.cos(tickA) * rx, ry + Math.sin(tickA) * 2.7, 1.7, 0, Math.PI * 2); tCtx.fill(); tCtx.restore();
            }
            tCtx.strokeStyle = '#d1fae5'; tCtx.lineWidth = 1.4;
            tCtx.beginPath(); tCtx.moveTo(leftNozX, diffuserBotY + 4); tCtx.lineTo((leftNozX + carCenterX) * 0.5, diffuserBotY + 8 + Math.sin(now * 0.06) * 4); tCtx.lineTo(carCenterX, diffuserBotY + 6); tCtx.lineTo((rightNozX + carCenterX) * 0.5, diffuserBotY + 8 + Math.cos(now * 0.06) * 4); tCtx.lineTo(rightNozX, diffuserBotY + 4); tCtx.stroke();
            tCtx.shadowBlur = 0;
        } else {
            if (allowBloom) { tCtx.shadowBlur = 20; tCtx.shadowColor = boostCol; }
            for (const nx of [leftNozX, rightNozX]) {
                const gSide = tCtx.createLinearGradient(nx, diffuserBotY - 2, nx, diffuserBotY + flameLen * 1.18);
                gSide.addColorStop(0, '#ffffff'); gSide.addColorStop(0.30, boostCol); gSide.addColorStop(0.78, borderGlowCol); gSide.addColorStop(1, 'transparent');
                tCtx.fillStyle = gSide;
                tCtx.beginPath(); tCtx.moveTo(nx - 5.5, diffuserBotY - 2); tCtx.quadraticCurveTo(nx - 4, diffuserBotY + flameLen * 0.5, nx, diffuserBotY + flameLen * 1.18); tCtx.quadraticCurveTo(nx + 4, diffuserBotY + flameLen * 0.5, nx + 5.5, diffuserBotY - 2); tCtx.closePath(); tCtx.fill();
            }
            const gBase = tCtx.createLinearGradient(carCenterX, diffuserBotY - 2, carCenterX, diffuserBotY + flameLen * 1.52);
            gBase.addColorStop(0, '#ffffff'); gBase.addColorStop(0.28, boostCol); gBase.addColorStop(0.72, borderGlowCol); gBase.addColorStop(1, 'transparent');
            tCtx.fillStyle = gBase;
            tCtx.beginPath(); tCtx.moveTo(carCenterX - 8.5, diffuserBotY - 2); tCtx.quadraticCurveTo(carCenterX - 9, diffuserBotY + flameLen * 0.5, carCenterX, diffuserBotY + flameLen * 1.52); tCtx.quadraticCurveTo(carCenterX + 9, diffuserBotY + flameLen * 0.5, carCenterX + 8.5, diffuserBotY - 2); tCtx.closePath(); tCtx.fill();
            tCtx.fillStyle = '#f0f9ff';
            tCtx.beginPath(); tCtx.moveTo(carCenterX - 4.2, diffuserBotY - 2); tCtx.lineTo(carCenterX, diffuserBotY + flameLen * 1.02); tCtx.lineTo(carCenterX + 4.2, diffuserBotY - 2); tCtx.closePath(); tCtx.fill();
            for (let r = 0; r < 3; r++) {
                const prog = (now * 0.005 + r * 0.333) % 1, ry = diffuserBotY + 3 + prog * flameLen * 1.38, rx = 9.5 * (1 - prog * 0.38);
                tCtx.save(); tCtx.globalAlpha = (1 - prog) * 0.78; tCtx.strokeStyle = r === 0 ? '#ffffff' : boostCol; tCtx.lineWidth = 1.6;
                tCtx.beginPath(); tCtx.ellipse(carCenterX, ry, rx, 2.3, 0, 0, Math.PI * 2); tCtx.stroke(); tCtx.restore();
            }
            for (let sp = 0; sp < 5; sp++) {
                const p = (now * 0.0052 + sp * 0.2) % 1, sx = carCenterX + Math.sin(sp * 2.9 + now * 0.012) * (6 + p * 12), sy = diffuserBotY + 3 + p * flameLen * 1.48;
                tCtx.fillStyle = sp % 2 === 0 ? '#ffffff' : boostCol; tCtx.fillRect(sx - 1.2, sy - 1.2, 2.4 * (1 - p * 0.4), 4.2 * (1 - p * 0.4));
            }
            tCtx.shadowBlur = 0;
        }
    }

    tCtx.restore();
}

let lastRenderNow = performance.now();
function renderSceneFrame(now) {
    const dtRender = Math.min(0.05, Math.max(0.001, (now - lastRenderNow) / 1000));
    lastRenderNow = now;

    const W = gameState.viewW, H = gameState.viewH, theme = BIOME_THEMES[biomeIdx] || BIOME_THEMES[0];
    const isCosmic250 = Boolean(theme.isEpoch250Special || gameState.epoch === 250), horizonY = H * 0.42;
    const cust = activeAccount ? activeAccount.custom : DEFAULT_VEHICLE_CUST;
    const chroma = getSkinChromaPalette(cust.nitroSkin, cust, now);
    const activeDist = gameState.running ? gameState.distanceM : menuCruiseDist;

    ensureCachedBiomeGradients(W, H, horizonY, theme);
    ctx.save();
    if (gameState.screenShake > 0 && globalSettings.graphics.shake) ctx.translate((Math.random() - 0.5) * gameState.screenShake, (Math.random() - 0.5) * gameState.screenShake);

    ctx.fillStyle = cachedGradients.sky; ctx.fillRect(0, 0, W, H);
    const cosmicHue = (now * 0.08) % 360, dynamicWorldColor = isCosmic250 ? `hsl(${cosmicHue},95%,62%)` : theme.curb;

    const starCount = Math.min(gameState.stars.length, Math.floor((isMobileHardware ? 42 : 65) * globalSettings.graphics.particles));
    const streakLen = (globalSettings.graphics.speedLines || isCosmic250 || gameState.boosting) ? 5.8 : 1.5;
    for (let i = 0; i < starCount; i++) {
        const st = gameState.stars[i], sx = ((st.x * W - activeDist * st.sp) % W + W) % W;
        ctx.fillStyle = isCosmic250 ? st.col : (i % 3 === 0 ? theme.curb : '#e2e8f0');
        ctx.fillRect(sx, st.y * H, st.s * streakLen, st.s * 0.95);
    }

    renderUniqueDimensionHorizon(W, H, horizonY, theme, now, dynamicWorldColor, cosmicHue);
    ctx.fillStyle = theme.roadDark; ctx.fillRect(0, horizonY, W, H - horizonY);

    const roadCurve = Math.sin(activeDist * 0.012) * 0.65;
    const totalSlices = globalSettings.graphics.roadSlices || (isMobileHardware ? 26 : 36), sliceStep = 55.0 / totalSlices;

    for (let i = totalSlices; i >= 1; i--) {
        const zN = 0.55 + (i - 1) * sliceStep, zF = 0.55 + i * sliceStep;
        const yN = projectY(zN, 0, H), yF = i === totalSlices ? horizonY : projectY(zF, 0, H);
        const xNL = projectX(-2.6, zN, W, H, roadCurve), xNR = projectX(2.6, zN, W, H, roadCurve);
        const xFL = projectX(-2.6, zF, W, H, roadCurve), xFR = projectX(2.6, zF, W, H, roadCurve);
        const isAlt = (Math.floor((activeDist + zN) / 3.2) & 1) === 0;
        ctx.fillStyle = isAlt ? theme.roadLight : theme.roadDark;
        ctx.beginPath(); ctx.moveTo(xFL, yF); ctx.lineTo(xFR, yF); ctx.lineTo(xNR, yN); ctx.lineTo(xNL, yN); ctx.closePath(); ctx.fill();
        if (isAlt) { ctx.strokeStyle = dynamicWorldColor; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(xFL, yF); ctx.lineTo(xNL, yN); ctx.moveTo(xFR, yF); ctx.lineTo(xNR, yN); ctx.stroke(); }
    }

    ctx.strokeStyle = colorWithAlpha(dynamicWorldColor, 0.53); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(0, horizonY); ctx.lineTo(W, horizonY); ctx.stroke();
    if (globalSettings.graphics.reflections) { ctx.fillStyle = colorWithAlpha(dynamicWorldColor, 0.07); ctx.beginPath(); ctx.moveTo(W * 0.46, horizonY); ctx.lineTo(W * 0.54, horizonY); ctx.lineTo(W * 0.64, H); ctx.lineTo(W * 0.36, H); ctx.closePath(); ctx.fill(); }

    ctx.strokeStyle = colorWithAlpha(dynamicWorldColor, 0.34); ctx.lineWidth = 1.2; ctx.beginPath();
    const divSteps = isMobileHardware ? 14 : 18, divStepM = 48.0 / divSteps;
    for (let l = 0; l < 4; l++) {
        const dl = -1.5 + l;
        for (let s = 0; s < divSteps; s += 2) { const z1 = 0.65 + s * divStepM, z2 = z1 + divStepM * 0.75; ctx.moveTo(projectX(dl, z1, W, H, roadCurve), projectY(z1, 0, H)); ctx.lineTo(projectX(dl, z2, W, H, roadCurve), projectY(z2, 0, H)); }
    }
    ctx.stroke();

    const cSteps = isMobileHardware ? 14 : 20, cStepM = 42.0 / cSteps;
    ctx.fillStyle = chroma.railFill; ctx.beginPath();
    for (let s = 0; s <= cSteps; s++) { const z = 0.58 + s * cStepM, xL = projectX(gameState.egoLaneX - 0.46, z, W, H, roadCurve), y = projectY(z, 0, H); if (s === 0) ctx.moveTo(xL, y); else ctx.lineTo(xL, y); }
    for (let s = cSteps; s >= 0; s--) { const z = 0.58 + s * cStepM; ctx.lineTo(projectX(gameState.egoLaneX + 0.46, z, W, H, roadCurve), projectY(z, 0, H)); }
    ctx.closePath(); ctx.fill();

    ctx.strokeStyle = chroma.railColor; ctx.lineWidth = chroma.isAllInOne ? 2.4 : 2.1; ctx.beginPath();
    for (let s = 0; s <= cSteps; s++) { const z = 0.58 + s * cStepM, xL = projectX(gameState.egoLaneX - 0.46, z, W, H, roadCurve), y = projectY(z, 0, H); if (s === 0) ctx.moveTo(xL, y); else ctx.lineTo(xL, y); }
    for (let s = 0; s <= cSteps; s++) { const z = 0.58 + s * cStepM, xR = projectX(gameState.egoLaneX + 0.46, z, W, H, roadCurve), y = projectY(z, 0, H); if (s === 0) ctx.moveTo(xR, y); else ctx.lineTo(xR, y); }
    ctx.stroke();

    if (gameState.running) {
        for (let i = gameState.pickups.length - 1; i >= 0; i--) renderHighTexturePickup(gameState.pickups[i], W, H, roadCurve, now);
        gameState.hazards.sort((a, b) => b.z - a.z);
        ctx.font = "bold 10px 'JetBrains Mono',monospace";
        for (let i = 0; i < gameState.hazards.length; i++) renderHighTextureDistinctHazard(gameState.hazards[i], Math.max(0.55, gameState.hazards[i].z), W, H, roadCurve, dynamicWorldColor, isCosmic250, cosmicHue, now);
    }

    for (let i = gameState.empFX.length - 1; i >= 0; i--) {
        const fx = gameState.empFX[i]; fx.life -= dtRender * 1.65;
        if (fx.life <= 0) { gameState.empFX.splice(i, 1); continue; }
        const prog = 1 - fx.life, bx = projectX(fx.lane, fx.z, W, H, roadCurve), by = projectY(fx.z, 0, H) - prog * 18;
        const s = getRigidPerspectiveScale(fx.z, W, H, fx.cls.id), dims = globalSettings.graphics.legacyModels ? { w: 25, h: 23 } : (REAL_LIFE_HAZARD_DIMS[fx.cls.id] || { w: 24, h: 21 });
        const boxW = dims.w * s * (1 + prog * 0.35), boxH = dims.h * s * (1 - prog * 0.25);

        ctx.save(); ctx.globalAlpha = Math.max(0, fx.life * 0.32); ctx.fillStyle = fx.empCol;
        const beamW = Math.max(2.5, boxW * 0.32 * fx.life); ctx.fillRect(bx - beamW * 0.5, by - boxH * 2.2, beamW, boxH * 2.2);
        ctx.globalAlpha = Math.max(0, fx.life); ctx.strokeStyle = prog < 0.35 ? '#ffffff' : fx.empCol; ctx.lineWidth = 1.8;
        ctx.beginPath(); ctx.ellipse(bx, by - boxH * 0.35, boxW * (0.55 + prog * 0.95), boxH * (0.32 + prog * 0.55), 0, 0, Math.PI * 2); ctx.stroke();
        const slCnt = isMobileHardware ? 4 : 6, slH = boxH / slCnt;
        for (let sl = 0; sl < slCnt; sl++) { const jit = (sl % 2 === 0 ? 1 : -1) * prog * 13 * s; ctx.fillStyle = sl % 2 === 0 ? fx.empCol : (fx.empSec || fx.mainCol || chroma.railColor); ctx.fillRect(bx - boxW * 0.46 + jit, by - boxH + sl * slH, boxW * 0.92, slH * 0.58); }
        for (let k = 0; k < fx.shards.length; k++) { const sh = fx.shards[k], sz = sh.sz * s * fx.life; ctx.fillStyle = sh.col; ctx.fillRect(bx + sh.vx * prog * s - sz * 0.5, (by - boxH * 0.5) + sh.vy * prog * s - sz * 0.5, sz, sz); }
        ctx.restore();
    }

    const zR = 1.34, zF = 1.54, rx = projectX(gameState.egoLaneX, zR, W, H, roadCurve), fx = projectX(gameState.egoLaneX, zF, W, H, roadCurve);
    const carCenterX = Math.round(rx), rearY = Math.round(projectY(zR, 0, H));
    const halfW = Math.round(((H * 0.85) / zR) * EGO_HALF_LANE_W * LANE_WIDTH_M * 0.24 * 0.86), carH = Math.round(halfW * 0.92 * 1.05);
    const invulnFlicker = gameState.invulnTimer > 0 && Math.floor(now / 60) % 2 === 0;
    const isCarBoosting = gameState.running && gameState.boosting;
    ctx.save(); if (invulnFlicker) ctx.globalAlpha = 0.55;
    drawRoadsterVehicle(ctx, carCenterX, rearY, halfW, carH, Math.round((fx - rx) * 0.65), cust, isCarBoosting, gameState.running && gameState.braking, now, globalSettings.graphics.bloom, gameState.egoRoll);
    ctx.restore();

    if (isCarBoosting && globalSettings.graphics.speedLines) {
        ctx.save(); ctx.strokeStyle = chroma.primaryGlow; ctx.globalAlpha = 0.28; ctx.lineWidth = 1.6;
        const lineCnt = isMobileHardware ? 8 : 14;
        for (let i = 0; i < lineCnt; i++) { const ang = (i / lineCnt) * Math.PI * 2 + (now * 0.0015), rIn = Math.min(W, H) * (0.34 + ((now * 0.003 + i * 0.17) % 0.14)), rOut = Math.max(W, H) * 0.72; ctx.beginPath(); ctx.moveTo(W * 0.5 + Math.cos(ang) * rIn, H * 0.45 + Math.sin(ang) * rIn); ctx.lineTo(W * 0.5 + Math.cos(ang) * rOut, H * 0.45 + Math.sin(ang) * rOut); ctx.stroke(); }
        ctx.restore();
    }

    if (gameState.empWaveRadius > 0) {
        const ox = carCenterX, oy = rearY - carH * 0.45, r1 = gameState.empWaveRadius, fade = Math.max(0.12, 1 - (r1 / 1500));
        ctx.save(); ctx.globalAlpha = fade;
        if (gameState.empFlashAlpha > 0) { ctx.fillStyle = chroma.empFlash; if (!chroma.isAllInOne) ctx.globalAlpha = gameState.empFlashAlpha * 0.22; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = fade; }
        ctx.strokeStyle = chroma.empPrimary; ctx.lineWidth = 6; ctx.beginPath(); ctx.ellipse(ox, oy, r1, r1 * 0.52, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.8; ctx.beginPath(); ctx.ellipse(ox, oy, r1 * 0.76, r1 * 0.40, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = chroma.empSecondary; ctx.lineWidth = 3.2; ctx.beginPath(); ctx.arc(ox, oy, r1 * 0.88, 0, Math.PI * 2); ctx.stroke();
        const arcCount = isMobileHardware ? 6 : 10; ctx.strokeStyle = '#e0f2fe'; ctx.lineWidth = 1.8; ctx.beginPath();
        for (let a = 0; a < arcCount; a++) { const ba = (a / arcCount) * Math.PI * 2 + now * 0.008, j1 = Math.sin(now * 0.03 + a * 4.1) * 0.14, j2 = Math.cos(now * 0.04 + a * 2.7) * 0.14; ctx.moveTo(ox + Math.cos(ba) * r1 * 0.25, oy + Math.sin(ba) * r1 * 0.25 * 0.55); ctx.lineTo(ox + Math.cos(ba + j1) * r1 * 0.62, oy + Math.sin(ba + j1) * r1 * 0.62 * 0.55); ctx.lineTo(ox + Math.cos(ba + j2) * r1 * 0.96, oy + Math.sin(ba + j2) * r1 * 0.96 * 0.55); }
        ctx.stroke(); ctx.restore();
    }

    if (theme.weather !== 'none' && globalSettings.graphics.particles > 0.05) {
        const pCnt = Math.floor((isMobileHardware ? 18 : 30) * globalSettings.graphics.particles);
        for (let r = 0; r < pCnt; r++) {
            const rxp = (r * 97 + now * 0.42) % W, ryp = (r * 61 + now * 1.05) % H;
            if (theme.weather === 'rain') { ctx.strokeStyle = 'rgba(125,211,252,0.34)'; ctx.lineWidth = 1.3; ctx.beginPath(); ctx.moveTo(rxp, ryp); ctx.lineTo(rxp - 6, ryp + 15); ctx.stroke(); }
            else { ctx.fillStyle = theme.weather === 'snow' ? 'rgba(241,245,249,0.75)' : (theme.weather === 'embers' ? 'rgba(251,146,60,0.75)' : (theme.weather === 'petals' ? 'rgba(244,114,182,0.75)' : dynamicWorldColor)); ctx.fillRect(rxp, theme.weather === 'embers' ? H - ryp : ryp, 2.8, 2.8); }
        }
    }

    for (let i = 0; i < gameState.FloatingTexts.length; i++) {
        const ft = gameState.FloatingTexts[i]; ctx.save(); ctx.globalAlpha = Math.max(0, ft.life);
        ctx.font = "800 13px 'JetBrains Mono',monospace"; ctx.textAlign = 'center'; ctx.fillStyle = ft.color; ctx.fillText(ft.text, ft.x, ft.y); ctx.restore();
    }
    ctx.restore();

    if (gCtx && document.getElementById('pauseSettingsModal').style.display === 'flex' && currentSettingsTab === 'garage') renderGaragePreview(now, dtRender, cust);
}

function syncGarageCanvasResolution() {
    if (!garageCanvas || !gCtx) return;
    const rect = garageCanvas.getBoundingClientRect();
    const cssW = Math.max(240, Math.round(rect.width || 560)), cssH = Math.max(104, Math.round(rect.height || 172));
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const targetW = Math.round(cssW * dpr), targetH = Math.round(cssH * dpr);
    if (garageCanvas.width !== targetW || garageCanvas.height !== targetH) {
        garageCanvas.width = targetW; garageCanvas.height = targetH;
    }
    gCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    garageCanvas._cssW = cssW; garageCanvas._cssH = cssH;
}

function renderGaragePreview(now, dtRender, cust) {
    syncGarageCanvasResolution();
    const W = garageCanvas._cssW || 560, H = garageCanvas._cssH || 172;
    gCtx.fillStyle = '#050810'; gCtx.fillRect(0, 0, W, H);
    const chroma = getSkinChromaPalette(cust.nitroSkin, cust, now), scrollOff = (now * 0.08) % 20;
    gCtx.strokeStyle = chroma.isAllInOne ? chroma.railFill : colorWithAlpha(chroma.railColor, 0.20); gCtx.lineWidth = 1;
    for (let x = 20; x < W; x += 28) { gCtx.beginPath(); gCtx.moveTo(W * 0.5 + (x - W * 0.5) * 0.30, 22); gCtx.lineTo(x, H); gCtx.stroke(); }
    for (let y = 28 + scrollOff; y < H; y += 20) { gCtx.beginPath(); gCtx.moveTo(0, y); gCtx.lineTo(W, y); gCtx.stroke(); }

    gCtx.fillStyle = chroma.railFill; gCtx.beginPath(); gCtx.moveTo(W * 0.5 - 38, 22); gCtx.lineTo(W * 0.5 + 38, 22); gCtx.lineTo(W * 0.5 + 112, H); gCtx.lineTo(W * 0.5 - 112, H); gCtx.closePath(); gCtx.fill();
    gCtx.strokeStyle = chroma.railColor; gCtx.lineWidth = 2; gCtx.beginPath(); gCtx.moveTo(W * 0.5 - 38, 22); gCtx.lineTo(W * 0.5 - 112, H); gCtx.moveTo(W * 0.5 + 38, 22); gCtx.lineTo(W * 0.5 + 112, H); gCtx.stroke();

    const sway = Math.sin(now * 0.0024) * 7, carScale = Math.min(1, H / 160);
    drawRoadsterVehicle(gCtx, W * 0.5 + sway, H * 0.68, Math.round(54 * carScale), Math.round(52 * carScale), -sway * 0.4, cust, garageNitroPreviewOn, false, now, true, -sway * 0.012);

    if (garageEmpPreviewRadius > 0) {
        garageEmpPreviewRadius += dtRender * 420; const fade = Math.max(0, 1 - garageEmpPreviewRadius / 280);
        if (fade <= 0) garageEmpPreviewRadius = 0;
        else {
            gCtx.save(); gCtx.globalAlpha = fade;
            gCtx.strokeStyle = chroma.empPrimary; gCtx.lineWidth = 4; gCtx.beginPath(); gCtx.ellipse(W * 0.5, H * 0.58, garageEmpPreviewRadius, garageEmpPreviewRadius * 0.44, 0, 0, Math.PI * 2); gCtx.stroke();
            gCtx.strokeStyle = '#ffffff'; gCtx.lineWidth = 2; gCtx.beginPath(); gCtx.ellipse(W * 0.5, H * 0.58, garageEmpPreviewRadius * 0.72, garageEmpPreviewRadius * 0.32, 0, 0, Math.PI * 2); gCtx.stroke();
            gCtx.strokeStyle = chroma.empSecondary; gCtx.lineWidth = 2.2; gCtx.beginPath(); gCtx.arc(W * 0.5, H * 0.58, garageEmpPreviewRadius * 0.85, 0, Math.PI * 2); gCtx.stroke();
            gCtx.restore();
        }
    }
}

function updateHudDOM(force = false) {
    if (isHudHidden && !force) return;
    setTextCached('hudScore', String(gameState.score).padStart(6, '0'));
    setTextCached('hudEpoch', `EP ${gameState.epoch}`);
    setTextCached('hudCombo', `${gameState.combo.toFixed(1)}x`);
    setTextCached('hudSpeedKmh', `${Math.round(gameState.speedMps * 3.6)} km/h`);
    setWidthCached('hudArmorBar', `${gameState.armor}%`);
    setTextCached('hudArmorPct', `${gameState.armor}%`);
    const armBar = document.getElementById('hudArmorBar');
    if (armBar) armBar.style.background = gameState.armor <= 25 ? '#ef4444' : (gameState.armor <= 55 ? '#f59e0b' : '#34d399');

    const nP = Math.max(0, Math.min(100, Math.floor(gameState.nitroFuel))), eP = Math.max(0, Math.min(100, Math.floor(gameState.empCharge)));
    setTextCached('hudNitroPct', `${nP}%`); setWidthCached('hudNitroBar', `${nP}%`);
    setTextCached('hudEmpPct', eP >= 100 ? 'READY!' : `${eP}%`); setWidthCached('hudEmpBar', `${eP}%`);

    let lead = null, maxRisk = 0;
    for (let i = 0; i < gameState.hazards.length; i++) {
        const h = gameState.hazards[i];
        const dR = Math.max(0, Math.min(1, 1 - (h.z - 2) / 50)), ov = Math.max(0, 1 - Math.abs(h.lane - gameState.egoLaneX) / 1.2);
        const ttc = h.z / Math.max(1, gameState.speedMps - h.speedMps), tR = ttc <= 1.8 ? 1.0 : Math.max(0, (6.0 - ttc) / 4.2);
        h.rFinal = Math.min(1, 0.35 * dR + 0.35 * tR + 0.30 * ov); h.ttc = ttc;
        if (h.rFinal > maxRisk) { maxRisk = h.rFinal; lead = h; }
    }
    const rP = Math.round(maxRisk * 100), tier = rP >= 85 ? 'CRITICAL' : (rP >= 65 ? 'WARNING' : (rP >= 35 ? 'CAUTION' : 'CLEAR'));
    if (domCache.warnTier !== tier) {
        domCache.warnTier = tier;
        const wb = document.getElementById('hudWarningBadge');
        if (wb) { wb.innerText = tier; wb.className = tier === 'CRITICAL' ? 'badge badge-red' : (tier === 'WARNING' || tier === 'CAUTION' ? 'badge badge-amber' : 'badge badge-emerald'); }
    }
    if (lead) { setTextCached('hudLeadName', `${lead.cls.name.toUpperCase()} (${lead.z.toFixed(1)}m)`); setTextCached('hudLeadTtc', `${lead.ttc.toFixed(1)}s`); setTextCached('hudLeadDgi', String(lead.dgi)); }
    else { setTextCached('hudLeadName', 'CLEAR'); setTextCached('hudLeadTtc', 'STABLE'); setTextCached('hudLeadDgi', '0.00'); }
}

function renderMiniRadar(now = performance.now()) {
    const w = radarCanvas.width, h = radarCanvas.height, cx = w * 0.5, cy = h - 7;
    rCtx.clearRect(0, 0, w, h); rCtx.strokeStyle = '#1e2638'; rCtx.lineWidth = 1;
    rCtx.beginPath(); rCtx.arc(cx, cy, 20, Math.PI, 0, false); rCtx.arc(cx, cy, 40, Math.PI, 0, false); rCtx.arc(cx, cy, 60, Math.PI, 0, false); rCtx.stroke();
    const cust = activeAccount ? activeAccount.custom : DEFAULT_VEHICLE_CUST, chroma = getSkinChromaPalette(cust.nitroSkin, cust, now);
    rCtx.fillStyle = chroma.radarDot; rCtx.fillRect(cx - 3, cy - 5, 6, 5);
    radarAngle += 0.25; if (radarAngle > Math.PI * 2) radarAngle = Math.PI;
    rCtx.beginPath(); rCtx.moveTo(cx, cy); rCtx.lineTo(cx + Math.cos(radarAngle) * 65, cy + Math.sin(radarAngle) * 65); rCtx.strokeStyle = 'rgba(56,189,248,0.35)'; rCtx.stroke();
    for (let i = 0; i < gameState.hazards.length; i++) {
        const hz = gameState.hazards[i]; if (hz.z > 55) continue;
        const bx = cx + (hz.lane - gameState.egoLaneX) * 9, by = cy - hz.z * 1.18;
        if (by > 2 && by < h) { rCtx.fillStyle = hz.rFinal >= 0.85 ? '#ef4444' : (hz.rFinal >= 0.65 ? '#f97316' : (hz.rFinal >= 0.35 ? '#f59e0b' : '#38bdf8')); rCtx.fillRect(bx - 2, by - 2, 4, 4); }
    }
}

// =========================================================================
// 12. PRIVACY CLICK-TO-REVEAL, AUTH & ON-DEMAND FIREBASE UID SIGN-IN
// =========================================================================
function resetAllRevealStates() { Object.keys(revealState).forEach(k => { revealState[k] = false; }); }
function toggleRevealField(key) { if (!(key in revealState)) return; revealState[key] = !revealState[key]; refreshMenuAccountUI(); playSfx('uiClick'); }
function renderRevealButton(btnId, isRevealed, maskedText, plainText) {
    const el = document.getElementById(btnId); if (!el) return;
    el.classList.toggle('revealed', isRevealed);
    el.innerText = isRevealed ? `${plainText} 🙈` : `${maskedText} 👁`;
}
function showAuthFeedback(msg, ok = true) { const el = document.getElementById('authFeedback'); if (!el) return; el.className = ok ? 'mono badge-emerald auth-feedback' : 'mono badge-red auth-feedback'; el.style.display = 'block'; el.innerText = msg; }
function switchAuthSubTab(mode) {
    document.getElementById('authCreatePane').classList.toggle('hidden', mode !== 'create');
    document.getElementById('authLoginPane').classList.toggle('hidden', mode !== 'login');
    document.getElementById('authTabCreate').className = mode === 'create' ? 'btn btn-xs btn-sky active' : 'btn btn-xs';
    document.getElementById('authTabLogin').className = mode === 'login' ? 'btn btn-xs btn-sky active' : 'btn btn-xs';
}

function createNewPilotAccount() {
    const nameEl = document.getElementById('regNameInput'), tagEl = document.getElementById('regTagInput');
    const name = (nameEl.value || '').trim(), tag = (tagEl.value || '').trim();
    if (!name || name.length < 2) { showAuthFeedback('Enter a name (min 2 chars).', false); playSfx('hit'); return; }
    if (!tag) { showAuthFeedback('Enter an ID / Tag.', false); playSfx('hit'); return; }

    const uid = generateUnique17DigitUid();
    const acc = makeAccountObj({ uid, name, tag, isDev: false });
    const st = seasonStatusCache;
    pushMail(acc, {
        title: `Welcome, ${acc.name}`, sender: 'SYSTEM',
        body: `Account created: ${acc.name} #${acc.tag}\nYour unique 17-digit UID can be revealed & copied anytime in Profile.\n\nSeason ${st.seasonNum} is ${st.phase === 'ACTIVE' ? `LIVE — Top 5 earn "${st.featuredSkin.name}" for Season ${st.nextSeasonNum}.` : `in 24h Off-Season Gap before Season ${st.nextSeasonNum}.`}\nReach #1 All-Time to wield Void Prismatic FX!`
    });
    accountsCache[uid] = acc; saveAccountsCache();
    publishRealtimeEvent('acc_upsert', { acc: packAccountForSync(acc) });
    nameEl.value = ''; tagEl.value = '';
    activateAccountSession(uid);
    showToast(`Pilot created & synced live: ${acc.name}`, 'ok'); playSfx('pickup');
}

// Direct On-Demand UID Lookup from Firebase if UID isn't cached locally yet!
async function signInWithUid() {
    const inp = document.getElementById('loginUidInput'), uid = (inp.value || '').replace(/\D+/g, '');
    if (!/^\d{17}$/.test(uid)) { showAuthFeedback('Enter a valid 17-digit UID.', false); playSfx('hit'); return; }
    if (!accountsCache[uid] && FB_BASE_URL) {
        showAuthFeedback('Looking up 17-digit UID in Firebase Cloud DB...', true);
        const remAcc = await fbRequest(`/accounts/${uid}`, 'GET', null, 4500);
        if (remAcc && remAcc.uid === uid) {
            mergeSingleAccountRecord(remAcc, true);
        }
    }
    if (!accountsCache[uid]) { showAuthFeedback('UID not found. Check your 17-digit UID or create a new pilot.', false); playSfx('hit'); return; }
    inp.value = '';
    activateAccountSession(uid);
    showToast(`Signed in as ${activeAccount.name}`, 'ok'); playSfx('pickup');
}

function activateAccountSession(uid) {
    const acc = accountsCache[uid]; if (!acc) return;
    activeAccount = acc; lsSet(STORAGE_ACTIVE_UID_KEY, uid); resetAllRevealStates();
    if (!acc.isDev) { devGodModeActive = false; lbDevManageMode = false; }
    reconcileAllTimeChampion();
    if (acc.custom.nitroSkin !== 'standard' && !hasNitroSkinUnlocked(acc, acc.custom.nitroSkin)) { acc.custom.nitroSkin = 'standard'; saveAccountsCache(); }
    if (!isBiomeUnlockedForAccount(biomeIdx)) { biomeIdx = 0; cachedGradients.key = ''; }
    if (globalSettings.audio.ostMode === 'mitadru' && !acc.isDev) selectOstMode('synth');
    document.getElementById('authFeedback').style.display = 'none';
    refreshMenuAccountUI(); refreshSeasonUI(); refreshInboxBadgeUI();
    loadCustomSongForActiveAccount(); buildBiomeSelectorGrid(); syncOstButtonsUI(); syncDevUiVisibility();
}

function logoutActiveAccount() {
    if (!activeAccount) return;
    lastLoggedOutUid = activeAccount.uid; lsSet(STORAGE_LAST_OUT_KEY, lastLoggedOutUid);
    activeAccount = null; devGodModeActive = false; lbDevManageMode = false;
    lsRemove(STORAGE_ACTIVE_UID_KEY); resetAllRevealStates();
    if (globalSettings.audio.ostMode === 'mitadru') selectOstMode('synth');
    loadCustomSongForActiveAccount(); syncDevUiVisibility(); switchAuthSubTab('login');
    refreshMenuAccountUI(); refreshInboxBadgeUI();
    showToast('Logged out.'); playSfx('uiClick');
}
function logoutFromProfile() { document.getElementById('pauseSettingsModal').style.display = 'none'; returnToMainMenu(); logoutActiveAccount(); }

function saveProfileIdentity() {
    if (!activeAccount) return;
    const newName = (document.getElementById('profEditNameInput').value || '').trim(), newTag = (document.getElementById('profEditTagInput').value || '').trim();
    if (!newName || newName.length < 2) { showToast('Name must be at least 2 characters.', 'err'); playSfx('hit'); return; }
    if (!newTag) { showToast('ID / Tag cannot be empty.', 'err'); playSfx('hit'); return; }
    activeAccount.name = newName; activeAccount.tag = newTag; activeAccount.updatedAt = Date.now();
    saveAccountsCache(); syncAccountMetaInLeaderboards(activeAccount);
    publishRealtimeEvent('acc_upsert', { acc: packAccountForSync(activeAccount) });
    refreshMenuAccountUI(); updateTopLeaderBanner(); renderDevAccountsList();
    showToast('Name & ID updated live.', 'ok'); playSfx('pickup');
}

function syncMenuButtonsLockState(isLoggedIn) {
    ['engageLaunchBtn', 'menuMailBtn', 'menuRanksBtn', 'menuGarageBtn', 'menuSettingsBtn', 'menuExitBtn'].forEach(id => {
        const b = document.getElementById(id);
        if (!b) return;
        b.disabled = !isLoggedIn;
        b.title = isLoggedIn ? '' : 'Create a pilot or sign in with a UID first';
    });
    const hint = document.getElementById('menuLockedHint');
    if (hint) hint.classList.toggle('hidden', isLoggedIn);
}

function refreshQuickLoadoutStrip() {
    const diffObj = DIFFICULTY_PRESETS[globalSettings.difficulty] || DIFFICULTY_PRESETS.easy;
    setTextCached('menuQuickDiff', diffObj.label);
    const bObj = BIOME_THEMES[biomeIdx] || BIOME_THEMES[0];
    setTextCached('menuQuickBiome', bObj.label.replace(/^[^\w]+/, '').trim());
    const skinId = (activeAccount && activeAccount.custom && activeAccount.custom.nitroSkin) || 'standard';
    const skObj = SEASON_FX_SKINS.find(s => s.id === skinId) || SEASON_FX_SKINS[0];
    setTextCached('menuQuickSkin', skObj.name);
}

function refreshMenuAccountUI() {
    const acc = activeAccount, launchBtn = document.getElementById('engageLaunchBtn'), st = seasonStatusCache;
    const activeCard = document.getElementById('menuAccountActiveCard'), prevCard = document.getElementById('menuPrevAccountCard'), authCard = document.getElementById('menuAuthCard');

    syncMenuButtonsLockState(Boolean(acc));
    refreshQuickLoadoutStrip();

    if (!acc) {
        activeCard.classList.add('hidden'); authCard.classList.remove('hidden');
        const prevAcc = lastLoggedOutUid ? accountsCache[lastLoggedOutUid] : null;
        if (prevAcc) {
            prevCard.classList.remove('hidden');
            document.getElementById('prevPilotColorDot').style.background = prevAcc.custom.bodySecondary;
            document.getElementById('prevPilotName').innerText = prevAcc.name;
            renderRevealButton('prevPilotTagRevealBtn', revealState.prevTag, '#••••', `#${prevAcc.tag}`);
            renderRevealButton('prevPilotUidRevealBtn', revealState.prevUid, 'UID: •••• •••• •••• •••••', `UID: ${formatUidSpaced(prevAcc.uid)}`);
            document.getElementById('prevCopyUidBtn').classList.toggle('hidden', !revealState.prevUid);
        } else prevCard.classList.add('hidden');

        if (launchBtn) launchBtn.innerText = '🔒 SIGN IN TO PLAY';
        setTextCached('menuStatSeasonBest', '0'); setTextCached('menuStatAllBest', '0'); setTextCached('menuStatBestEpoch', 'Ep 1'); setTextCached('menuStatFlashes', '0');
        return;
    }

    activeCard.classList.remove('hidden'); prevCard.classList.add('hidden'); authCard.classList.add('hidden');
    if (launchBtn) launchBtn.innerText = '▶ PLAY';
    document.getElementById('menuPilotName').innerText = acc.name;
    document.getElementById('menuPilotColorDot').style.background = acc.custom.bodySecondary;
    renderRevealButton('menuPilotTagRevealBtn', revealState.menuTag, '#••••', `#${acc.tag}`);
    renderRevealButton('menuPilotUidRevealBtn', revealState.menuUid, 'UID: •••• •••• •••• •••••', `UID: ${formatUidSpaced(acc.uid)}`);
    document.getElementById('menuCopyUidBtn').classList.toggle('hidden', !revealState.menuUid);

    const rBadge = document.getElementById('menuPilotRoleBadge');
    rBadge.className = acc.isDev ? 'badge badge-cyan mono' : 'badge hidden';
    rBadge.innerText = acc.isDev ? 'DEV' : '';

    const sBest = (acc.stats.seasonScores && acc.stats.seasonScores[st.seasonNum]) || 0;
    setTextCached('menuStatSeasonBest', sBest.toLocaleString());
    setTextCached('menuStatAllBest', (acc.stats.allTimeBest || 0).toLocaleString());
    setTextCached('menuStatBestEpoch', `Ep ${acc.stats.bestEpoch || 1}`);
    setTextCached('menuStatFlashes', (acc.stats.totalFlashes || 0).toLocaleString());

    setTextCached('hudPilotCallsign', acc.name.toUpperCase());
    document.getElementById('hudPilotDot').style.background = acc.custom.bodySecondary;

    setTextCached('profNameDisplay', acc.name);
    renderRevealButton('profTagRevealBtn', revealState.profTag, 'ID: #••••', `ID: #${acc.tag}`);
    renderRevealButton('profUidRevealBtn', revealState.profUid, '•••• •••• •••• •••••', formatUidSpaced(acc.uid));
    document.getElementById('copyUidBtn').classList.toggle('hidden', !revealState.profUid);

    const nInp = document.getElementById('profEditNameInput'), tInp = document.getElementById('profEditTagInput');
    if (nInp && document.activeElement !== nInp) nInp.value = acc.name;
    if (tInp && document.activeElement !== tInp) tInp.value = acc.tag;

    const pr = document.getElementById('profRoleDisplay');
    pr.innerText = acc.isDev ? 'DEV' : 'PILOT'; pr.className = acc.isDev ? 'badge badge-cyan mono' : 'badge mono';
    setTextCached('profCreatedDisplay', new Date(acc.createdAt || Date.now()).toLocaleDateString());
    setTextCached('profRunsDisplay', String(acc.stats.totalRuns || 0));
    const owned = SEASON_FX_SKINS.filter(sk => sk.id !== 'standard' && hasNitroSkinUnlocked(acc, sk.id));
    setTextCached('profRewardsDisplay', acc.isDev ? 'All Unlocked' : (owned.length ? owned.map(s => s.name).join(', ') : 'None'));
    document.getElementById('profDeleteSection').classList.toggle('hidden', Boolean(acc.isDev));
}

async function deleteActiveAccountSelf() {
    if (!activeAccount || activeAccount.isDev) return;
    const ok = await askConfirm({ title: 'Delete Your Account?', body: `Permanently delete "${activeAccount.name}" and all scores across all browsers?\nYour 17-digit UID will be released immediately.`, okLabel: 'Delete Account' });
    if (!ok) return;
    await deleteAccountByUid(activeAccount.uid, false);
}

async function deleteAccountByUid(uid, askDevConfirm = true) {
    if (!uid || uid === CANONICAL_DEV_UID) return;
    const target = accountsCache[uid]; if (!target) return;
    if (askDevConfirm) {
        const ok = await askConfirm({ title: 'Delete Account?', body: `Delete pilot "${target.name}" (#${target.tag})\nUID: ${formatUidSpaced(target.uid)}\n\nWipes account & scores live across all connected browsers.`, okLabel: 'Delete' });
        if (!ok) return;
    }
    const now = Date.now();
    syncMeta.deletedUids[uid] = true; saveSyncMeta();
    applyAccountDeleteLocally(uid, false);
    publishRealtimeEvent('acc_delete', { uid, ts: now });
    renderDevAccountsList();
    if (document.getElementById('leaderboardModal').style.display === 'flex') renderLeaderboardList();
    showToast(`Deleted "${target.name}" live.`, 'ok'); playSfx('pickup');
}

function refreshSeasonUI() {
    const st = seasonStatusCache, cd = formatCountdown(st.remainingMs);
    const pill = document.getElementById('menuSeasonPill'), stTxt = document.getElementById('menuSeasonStatusText'), lbSub = document.getElementById('lbSeasonHeaderSub');
    if (st.phase === 'ACTIVE') {
        if (pill) { pill.className = 'badge badge-amber mono'; pill.innerText = `S${st.seasonNum} • ${cd}`; }
        if (stTxt) stTxt.innerText = `SEASON ${st.seasonNum} • ${cd} LEFT`;
        if (lbSub) lbSub.innerText = currentLbTab === 'season' ? `Season ${st.seasonNum} • ${cd} remaining` : 'All-Time Hall of Fame';
    } else {
        if (pill) { pill.className = 'badge badge-sky mono'; pill.innerText = `GAP • S${st.nextSeasonNum} in ${cd}`; }
        if (stTxt) stTxt.innerText = `OFF-SEASON GAP (S${st.nextSeasonNum} in ${cd})`;
        if (lbSub) lbSub.innerText = currentLbTab === 'season' ? `Off-Season Gap • Season ${st.nextSeasonNum} in ${cd}` : 'All-Time Hall of Fame';
    }
    updateTopLeaderBanner();
}

function updateTopLeaderBanner() {
    const top = lbAllCache[0] || getSeasonLbFor(seasonStatusCache.seasonNum)[0] || null;
    if (top && top.score > 0) {
        setTextCached('menuTopLeaderName', top.name); setTextCached('menuTopLeaderScore', `(${Number(top.score).toLocaleString()})`);
        setTextCached('hudLeaderMini', `${top.name.split(' ')[0]} (${Number(top.score).toLocaleString()})`);
    } else { setTextCached('menuTopLeaderName', 'Unclaimed'); setTextCached('menuTopLeaderScore', ''); setTextCached('hudLeaderMini', 'Unclaimed'); }
}

// INBOX
function refreshInboxBadgeUI() {
    const unread = activeAccount ? (activeAccount.inbox || []).filter(m => !m.read).length : 0;
    const b = document.getElementById('menuInboxBadge');
    if (b) { b.innerText = String(unread); b.classList.toggle('hidden', unread === 0); }
    setTextCached('inboxUnreadCountBadge', `${unread} Unread`);
}
function openInboxModal() {
    if (!activeAccount) { showToast('Sign in or create an account first.', 'err'); return; }
    syncSeasonLifecycle(); renderInboxList();
    document.getElementById('inboxModal').style.display = 'flex'; syncCursorVisibility();
}
function closeInboxModal() { document.getElementById('inboxModal').style.display = 'none'; refreshInboxBadgeUI(); syncCursorVisibility(); }
function renderInboxList() {
    const el = document.getElementById('inboxListContainer'); if (!el || !activeAccount) return;
    refreshInboxBadgeUI();
    const mails = activeAccount.inbox || [];
    if (!mails.length) { el.innerHTML = '<div class="recessed-well" style="padding:24px;text-align:center;color:var(--text-muted);">Inbox is empty.</div>'; return; }
    const st = seasonStatusCache;
    el.innerHTML = mails.map(m => {
        let rw = '';
        if (m.reward) {
            const exp = (st.phase === 'ACTIVE' && m.reward.validForSeason < st.seasonNum) || (st.phase === 'GAP' && m.reward.validForSeason <= st.seasonNum);
            rw = exp
                ? `<div class="recessed-well row-between" style="padding:7px 9px;margin-top:7px;"><span class="mono" style="font-size:10px;color:var(--text-dim);">🎁 ${escapeHtml(m.reward.skinName)} (S${m.reward.validForSeason})</span><span class="badge mono">EXPIRED</span></div>`
                : (m.reward.claimed
                    ? `<div class="recessed-well row-between" style="padding:7px 9px;margin-top:7px;border-color:rgba(16,185,129,0.35);"><span class="mono" style="font-size:10px;color:#34d399;">🎁 ${escapeHtml(m.reward.skinName)} (S${m.reward.validForSeason})</span><span class="badge badge-emerald mono">CLAIMED</span></div>`
                    : `<div class="recessed-well row-between" style="padding:7px 9px;margin-top:7px;border-color:rgba(245,158,11,0.45);"><span class="mono" style="font-size:10px;color:#fcd34d;">🎁 ${escapeHtml(m.reward.skinName)} (S${m.reward.validForSeason})</span><button type="button" class="btn btn-xs btn-amber" onclick="event.stopPropagation();claimInboxReward('${escapeHtml(m.id)}')">Claim</button></div>`);
        }
        return `<div class="mail-item ${m.read ? '' : 'unread'}" onclick="markMailRead('${escapeHtml(m.id)}')"><div class="row-between"><strong style="font-size:12px;color:#fff;">${escapeHtml(m.title)}</strong><span class="mono" style="font-size:9px;color:var(--text-dim);">${new Date(m.ts).toLocaleString()}</span></div><div class="mono" style="font-size:9px;color:#7dd3fc;margin-top:1px;">${escapeHtml(m.sender)}</div><div style="font-size:11.5px;color:#cbd5e1;margin-top:5px;white-space:pre-line;line-height:1.45;">${escapeHtml(m.body)}</div>${rw}</div>`;
    }).join('');
}
function markMailRead(id) { if (!activeAccount) return; const m = activeAccount.inbox.find(x => x.id === id); if (m && !m.read) { m.read = true; saveAccountsCache(); renderInboxList(); } }
function markAllInboxRead() { if (!activeAccount) return; activeAccount.inbox.forEach(m => { m.read = true; }); saveAccountsCache(); renderInboxList(); }
function clearReadInboxMail() { if (!activeAccount) return; activeAccount.inbox = activeAccount.inbox.filter(m => !m.read || (m.reward && !m.reward.claimed)); saveAccountsCache(); renderInboxList(); }
function claimInboxReward(id) {
    if (!activeAccount) return;
    const m = activeAccount.inbox.find(x => x.id === id);
    if (!m || !m.reward || m.reward.claimed) return;
    m.reward.claimed = true; m.read = true;
    const sk = (activeAccount.seasonalSkins || []).find(s => s.skinId === m.reward.skinId && s.validForSeason === m.reward.validForSeason);
    if (sk) sk.claimed = true; else activeAccount.seasonalSkins.push({ skinId: m.reward.skinId, wonSeason: m.reward.wonSeason, validForSeason: m.reward.validForSeason, claimed: true, expired: false, rank: m.reward.rank });
    activeAccount.custom.nitroSkin = m.reward.skinId; activeAccount.updatedAt = Date.now();
    saveAccountsCache(); syncAccountMetaInLeaderboards(activeAccount);
    publishRealtimeEvent('acc_upsert', { acc: packAccountForSync(activeAccount) });
    playSfx('pickup'); renderInboxList(); buildGarageUI(); refreshMenuAccountUI();
    showToast(`Claimed & equipped ${m.reward.skinName}!`, 'ok');
}

// LEADERBOARD
function openLeaderboardModal() {
    if (!activeAccount) { showToast('Sign in or create an account first.', 'err'); return; }
    syncSeasonLifecycle(); refreshSeasonUI();
    document.getElementById('lbDevManageBtn').classList.toggle('hidden', !(activeAccount && activeAccount.isDev));
    renderLeaderboardList();
    document.getElementById('leaderboardModal').style.display = 'flex'; syncCursorVisibility();
}
function closeLeaderboardModal() { document.getElementById('leaderboardModal').style.display = 'none'; syncCursorVisibility(); }
function switchLeaderboardTab(tab) {
    currentLbTab = tab;
    document.getElementById('lbTabSeason').classList.toggle('active', tab === 'season');
    document.getElementById('lbTabAllTime').classList.toggle('active', tab === 'alltime');
    refreshSeasonUI(); renderLeaderboardList();
}
function toggleLbDevManage() {
    if (!activeAccount || !activeAccount.isDev) return;
    lbDevManageMode = !lbDevManageMode;
    document.getElementById('lbDevManageBtn').innerText = lbDevManageMode ? '✓ Done' : '🛠️ Manage';
    renderLeaderboardList();
}
function renderLeaderboardList() {
    const el = document.getElementById('leaderboardListContainer'); if (!el) return;
    const list = currentLbTab === 'season' ? getSeasonLbFor(seasonStatusCache.seasonNum) : lbAllCache;
    if (!list.length) { el.innerHTML = '<div class="recessed-well" style="padding:24px;text-align:center;color:var(--text-muted);">No runs recorded yet.</div>'; return; }
    const medals = ['🥇 #1', '🥈 #2', '🥉 #3'];
    el.innerHTML = list.map((e, i) => {
        const isSelf = activeAccount && activeAccount.uid === e.uid, isTop = i === 0;
        const cls = ['lb-card', e.isPrism ? 'lb-card-prism' : (isTop ? 'lb-card-top5' : ''), isSelf ? 'lb-card-self' : ''].join(' ');
        const devActions = (activeAccount && activeAccount.isDev && lbDevManageMode)
            ? `<div class="row-wrap" style="gap:4px;"><button type="button" class="btn btn-xs btn-amber" onclick="devResetSpecificScore('${escapeHtml(e.uid)}')">Reset Score</button>${e.uid === CANONICAL_DEV_UID ? '' : `<button type="button" class="btn btn-xs btn-danger" onclick="deleteAccountByUid('${escapeHtml(e.uid)}')">Del Acc</button>`}</div>` : '';
        const uidSub = (activeAccount && activeAccount.isDev && lbDevManageMode) ? ` &bull; #${escapeHtml(e.tag)} &bull; ${escapeHtml(e.uid)}` : '';
        return `<div class="${cls}"><div class="row" style="min-width:0;flex:1 1 180px;"><span class="badge mono" style="color:#fff;min-width:44px;justify-content:center;">${medals[i] || '#' + (i + 1)}</span><div style="min-width:0;flex:1;"><div class="row-wrap" style="gap:5px;"><span style="width:8px;height:8px;border-radius:50%;background:${escapeHtml(e.accent || '#38bdf8')};"></span><strong class="truncate" style="font-size:12px;color:#fff;">${escapeHtml(e.name)}</strong>${e.isDev ? '<span class="badge badge-cyan mono">DEV</span>' : ''}${isSelf ? '<span class="badge badge-emerald mono">YOU</span>' : ''}</div><div class="mono truncate" style="font-size:9px;color:var(--text-dim);">Ep ${e.epoch || 1}${uidSub}</div></div></div><div class="row-wrap" style="flex-shrink:0;"><span class="mono" style="font-size:14px;font-weight:800;color:#34d399;">${Number(e.score).toLocaleString()}</span>${devActions}</div></div>`;
    }).join('');
}

// GARAGE
function toggleGarageNitroPreview() {
    garageNitroPreviewOn = !garageNitroPreviewOn;
    const b = document.getElementById('garageNitroPreviewBtn');
    if (b) { b.innerText = garageNitroPreviewOn ? '🔥 Nitro: ON' : '🔥 Nitro: OFF'; b.className = garageNitroPreviewOn ? 'btn btn-xs btn-amber' : 'btn btn-xs'; }
    playSfx(garageNitroPreviewOn ? 'nitro' : 'uiClick');
}
function triggerGarageEmpPreview() { garageEmpPreviewRadius = 10; playSfx('emp'); }
function buildGarageUI() {
    const cust = activeAccount ? activeAccount.custom : DEFAULT_VEHICLE_CUST;
    const nb = document.getElementById('garageNitroPreviewBtn');
    if (nb) { nb.innerText = garageNitroPreviewOn ? '🔥 Nitro: ON' : '🔥 Nitro: OFF'; nb.className = garageNitroPreviewOn ? 'btn btn-xs btn-amber' : 'btn btn-xs'; }

    ['bodyPrimary', 'bodySecondary', 'canopyColor', 'empColor', 'boostColor'].forEach(ch => {
        const inp = document.getElementById(`custColor_${ch}`); if (inp) inp.value = cust[ch] || DEFAULT_VEHICLE_CUST[ch];
        const sw = document.getElementById(`swatch_${ch}`);
        if (sw) sw.innerHTML = COLOR_SWATCHES[ch].map(hex => `<button type="button" class="swatch-btn ${(cust[ch] || '').toLowerCase() === hex.toLowerCase() ? 'active' : ''}" style="background:${hex};" onclick="setCustomVehicleColor('${ch}','${hex}')"></button>`).join('');
    });
    const grid = document.getElementById('nitroSkinSelectorGrid');
    if (grid) {
        grid.innerHTML = SEASON_FX_SKINS.map(sk => {
            const unl = hasNitroSkinUnlocked(activeAccount, sk.id), eq = (cust.nitroSkin || 'standard') === sk.id, statusLbl = getSkinStatusLabel(activeAccount, sk.id);
            const tierBadge = sk.tier === 'alltime1' ? '<span class="badge badge-violet mono" style="font-size:8px;">ALL-TIME #1</span>' : (sk.tier === 'top5' ? '<span class="badge badge-amber mono" style="font-size:8px;">TOP 5</span>' : '');
            if (!unl) return `<div class="recessed-well ${sk.cardClass}" style="padding:8px 10px;opacity:0.56;"><div class="row-between"><span class="mono" style="font-size:10.5px;font-weight:700;color:#cbd5e1;">🔒 ${sk.name}</span>${tierBadge}</div><div style="font-size:9.5px;color:var(--text-muted);margin-top:3px;line-height:1.35;">${sk.desc}</div><div class="mono" style="font-size:8.5px;color:#fcd34d;margin-top:4px;">${statusLbl}</div></div>`;
            return `<button type="button" class="recessed-well ${sk.cardClass}" style="padding:8px 10px;text-align:left;cursor:pointer;border-width:${eq ? '1.8px' : '1px'};box-shadow:${eq ? '0 0 0 1px rgba(56,189,248,0.6)' : 'none'};" onclick="selectNitroSkin('${sk.id}')"><div class="row-between"><strong style="font-size:11px;color:#fff;">${sk.name}</strong><div class="row" style="gap:4px;">${tierBadge}${eq ? '<span class="badge badge-sky mono" style="font-size:8px;">ON</span>' : ''}</div></div><div style="font-size:9.5px;color:#cbd5e1;margin-top:3px;line-height:1.35;">${sk.desc}</div><div class="mono" style="font-size:8.5px;color:#34d399;margin-top:4px;">${statusLbl}</div></button>`;
        }).join('');
    }
    setTextCached('nitroSkinAccessHint', activeAccount && activeAccount.isDev ? 'Dev: All Unlocked' : 'All-Time #1 & Season Top 5');
}
function setCustomVehicleColor(ch, hex) {
    if (!activeAccount) return;
    activeAccount.custom[ch] = hex; activeAccount.updatedAt = Date.now();
    saveAccountsCache(); syncAccountMetaInLeaderboards(activeAccount);
    buildGarageUI(); refreshMenuAccountUI();
    if (colorSyncDebounceTimer) clearTimeout(colorSyncDebounceTimer);
    colorSyncDebounceTimer = setTimeout(() => { if (activeAccount) publishRealtimeEvent('acc_upsert', { acc: packAccountForSync(activeAccount) }); }, 1200);
}
function applyGaragePreset(k) {
    if (!activeAccount || !GARAGE_PRESETS[k]) return;
    activeAccount.custom = { ...activeAccount.custom, ...GARAGE_PRESETS[k] }; activeAccount.updatedAt = Date.now();
    saveAccountsCache(); syncAccountMetaInLeaderboards(activeAccount);
    publishRealtimeEvent('acc_upsert', { acc: packAccountForSync(activeAccount) });
    buildGarageUI(); refreshMenuAccountUI(); playSfx('uiClick');
}
function selectNitroSkin(id) {
    if (!activeAccount || !hasNitroSkinUnlocked(activeAccount, id)) return;
    activeAccount.custom.nitroSkin = id; activeAccount.updatedAt = Date.now();
    saveAccountsCache(); syncAccountMetaInLeaderboards(activeAccount);
    publishRealtimeEvent('acc_upsert', { acc: packAccountForSync(activeAccount) });
    buildGarageUI(); refreshQuickLoadoutStrip();
    const sk = SEASON_FX_SKINS.find(s => s.id === id);
    if (sk) showToast(`Equipped ${sk.name}`, 'ok'); playSfx('pickup');
}
function resetVehicleCustomization() {
    if (!activeAccount) return;
    activeAccount.custom = { ...DEFAULT_VEHICLE_CUST }; activeAccount.updatedAt = Date.now();
    saveAccountsCache(); syncAccountMetaInLeaderboards(activeAccount);
    publishRealtimeEvent('acc_upsert', { acc: packAccountForSync(activeAccount) });
    buildGarageUI(); refreshMenuAccountUI(); showToast('Vehicle colors reset.');
}

// SETTINGS HUB
function openSettingsModal(tab = 'game') {
    if (!activeAccount) { showToast('Sign in or create an account first.', 'err'); return; }
    ensureAudioEngine();
    if (gameState.running && !gameState.paused) { gameState.paused = true; nextGameNoteT = 0; nextMenuNoteT = 0; syncExternalTracks(); updateEnginePitch(); updateEqVisuals(false); }
    setTextCached('settingsModalTitle', gameState.running ? 'PAUSED' : 'SETTINGS');
    document.getElementById('resumeOrCloseSettingsBtn').innerText = gameState.running ? '▶ Resume' : '← Back';
    document.getElementById('inGameRestartBtn').classList.toggle('hidden', !gameState.running);
    document.getElementById('inGameMenuBtn').classList.toggle('hidden', !gameState.running);
    syncDevUiVisibility(); switchSettingsTab(tab);
    buildBiomeSelectorGrid(); buildGarageUI(); buildGraphicsUI(); syncOstButtonsUI(); refreshMenuAccountUI(); renderDevAccountsList(); renderDevCustomSongsList();
    document.getElementById('pauseSettingsModal').style.display = 'flex';
    if (tab === 'garage') setTimeout(syncGarageCanvasResolution, 30);
    syncCursorVisibility();
}
function resumeFromSettings() {
    ensureAudioEngine();
    document.getElementById('pauseSettingsModal').style.display = 'none';
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    if (gameState.running) {
        if (isMobileHardware) requestMobileFullscreenSafe();
        if (globalSettings.controls.mobileMode === 'tilt') calibrateTiltSensor(true);
        gameState.paused = false; nextGameNoteT = 0; nextMenuNoteT = 0;
        syncExternalTracks(); updateEnginePitch(); updateEqVisuals(true);
    }
    syncCursorVisibility();
}
function switchSettingsTab(tab) {
    if (tab === 'dev' && !(activeAccount && activeAccount.isDev)) tab = 'game';
    currentSettingsTab = tab;
    if (tab !== 'profile') { revealState.profTag = false; revealState.profUid = false; }
    ['game', 'garage', 'profile', 'sounds', 'controls', 'graphics', 'dev'].forEach(t => {
        const p = document.getElementById(`setTab_${t}`), b = document.getElementById(`setTabBtn_${t}`);
        if (p) p.classList.toggle('hidden', t !== tab);
        if (b) b.classList.toggle('active', t === tab);
    });
    if (tab === 'garage') setTimeout(syncGarageCanvasResolution, 20);
    if (tab === 'profile') refreshMenuAccountUI();
    if (tab === 'dev') { renderDevAccountsList(); renderDevCustomSongsList(); }
}
function syncDevUiVisibility() {
    const isDev = Boolean(activeAccount && activeAccount.isDev);
    document.getElementById('setTabBtn_dev').classList.toggle('hidden', !isDev);
    document.getElementById('hudDevRefillBtn').classList.toggle('hidden', !isDev);
    const gm = document.getElementById('devGodModeBtn');
    if (gm) { gm.innerText = (devGodModeActive && isDev) ? '⚡ God Mode: ON' : 'God Mode: OFF'; gm.className = (devGodModeActive && isDev) ? 'btn btn-xs btn-god-active' : 'btn btn-xs btn-sky'; }
}

function setDifficulty(key) {
    globalSettings.difficulty = DIFFICULTY_PRESETS[key] ? key : 'easy';
    setTextCached('diffCurrentLabel', DIFFICULTY_PRESETS[globalSettings.difficulty].label);
    ['easy', 'normal', 'hard', 'void'].forEach(k => { const b = document.getElementById(`diffBtn_${k}`); if (b) b.className = k === globalSettings.difficulty ? 'btn btn-sm btn-emerald active' : 'btn btn-sm'; });
    refreshQuickLoadoutStrip(); saveGlobalSettings();
}
function buildBiomeSelectorGrid() {
    const el = document.getElementById('biomeGridSelector'), ab = document.getElementById('autoBiomeToggleBtn');
    if (ab) { ab.innerText = globalSettings.autoCycleBiomes ? 'Auto-Cycle: ON' : 'Auto-Cycle: OFF'; ab.className = globalSettings.autoCycleBiomes ? 'btn btn-xs btn-emerald' : 'btn btn-xs'; }
    if (!el) return;
    el.innerHTML = BIOME_THEMES.map((b, i) => {
        const unl = isBiomeUnlockedForAccount(i);
        if (!unl) return `<button type="button" disabled class="btn btn-xs" style="justify-content:flex-start;opacity:0.45;">🔒 ${b.isEpoch250Special ? 'Ep 250' : 'Ep ' + b.unlockEpoch} • ${b.label}</button>`;
        return `<button type="button" class="btn btn-xs ${i === biomeIdx ? 'btn-sky active' : ''}" style="justify-content:flex-start;" onclick="selectManualBiome(${i})">${b.label}</button>`;
    }).join('');
}
function selectManualBiome(i) { if (!isBiomeUnlockedForAccount(i)) return; biomeIdx = i; globalSettings.selectedBiomeIdx = i; globalSettings.autoCycleBiomes = false; cachedGradients.key = ''; setTextCached('hudBiomeName', BIOME_THEMES[biomeIdx].label); buildBiomeSelectorGrid(); refreshQuickLoadoutStrip(); saveGlobalSettings(); }
function toggleAutoBiomeCycle() { globalSettings.autoCycleBiomes = !globalSettings.autoCycleBiomes; buildBiomeSelectorGrid(); saveGlobalSettings(); }
function resetGameSettingsOnly() { setDifficulty('easy'); globalSettings.autoCycleBiomes = true; globalSettings.selectedBiomeIdx = 0; biomeIdx = 0; cachedGradients.key = ''; setTextCached('hudBiomeName', BIOME_THEMES[0].label); buildBiomeSelectorGrid(); refreshQuickLoadoutStrip(); saveGlobalSettings(); }

function buildVolumeSlidersUI() {
    const sl = [{ k: 'master', l: 'Master' }, { k: 'music', l: 'Game OST' }, { k: 'menuMusic', l: 'Menu Music' }, { k: 'engine', l: 'Engine' }, { k: 'sfx', l: 'SFX & EMP' }, { k: 'uiClick', l: 'UI Clicks' }];
    document.getElementById('volumeSlidersGrid').innerHTML = sl.map(s => { const p = Math.round((globalSettings.audio[s.k] || 0) * 100); return `<div><div class="row-between" style="font-size:10px;"><span style="color:var(--text-muted);">${s.l}</span><span id="volLbl_${s.k}" style="color:#7dd3fc;">${p}%</span></div><input type="range" id="volSld_${s.k}" min="0" max="100" value="${p}" oninput="updateVolumeSetting('${s.k}',this.value)"></div>`; }).join('');
}
function updateVolumeSetting(ch, val) {
    const n = Math.max(0, Math.min(100, parseInt(val, 10) || 0)) / 100;
    globalSettings.audio[ch] = n; setTextCached(`volLbl_${ch}`, `${Math.round(n * 100)}%`);
    const s = document.getElementById(`volSld_${ch}`); if (s && String(s.value) !== String(Math.round(n * 100))) s.value = Math.round(n * 100);
    if (masterGain && audioCtx) masterGain.gain.setTargetAtTime(Math.max(0.0001, globalSettings.audio.master), audioCtx.currentTime, 0.03);
    syncExternalTracks(); updateEnginePitch(); saveGlobalSettings();
}
function syncOstButtonsUI() {
    const canMix = Boolean(activeAccount && activeAccount.isDev);
    document.getElementById('ostBtn_mitadru').classList.toggle('hidden', !canMix);
    document.getElementById('ostButtonsGrid').className = canMix ? 'grid-3' : 'grid-2';
    const cur = globalSettings.audio.ostMode;
    ['synth', 'mitadru', 'custom'].forEach(m => { const b = document.getElementById(`ostBtn_${m}`); if (!b) return; b.style.borderColor = m === cur ? '#38bdf8' : '#1b202b'; b.style.background = m === cur ? 'rgba(56,189,248,0.16)' : '#0b0d13'; });
    setTextCached('hudOstShortLabel', cur === 'mitadru' ? 'MIXTAPE' : (cur === 'custom' ? 'CUSTOM' : 'SYNTH'));
    setTextCached('ostLockStatus', cur === 'mitadru' ? 'Mixtape' : (cur === 'custom' ? 'Custom' : 'Cyber-Synth'));
}
function selectOstMode(mode) { if (mode === 'mitadru' && !(activeAccount && activeAccount.isDev)) mode = 'synth'; if (mode === 'custom' && !customSongObjUrl) { setTextCached('customSongStatusText', 'Upload a song first.'); return; } globalSettings.audio.ostMode = mode; syncOstButtonsUI(); syncExternalTracks(); saveGlobalSettings(); }
function resetSoundSettingsOnly() { const def = getDefaultGlobalSettings().audio; Object.keys(def).forEach(k => { if (k !== 'ostMode') updateVolumeSetting(k, Math.round(def[k] * 100)); }); selectOstMode('synth'); }

function buildGraphicsUI() {
    document.getElementById('gfxPresetButtonsGrid').innerHTML = ['low', 'medium', 'high', 'ultra'].map(k => `<button type="button" class="btn btn-sm ${globalSettings.graphics.preset === k ? 'btn-sky active' : ''}" onclick="applyGraphicsPreset('${k}')">${GRAPHICS_PRESETS[k].title}</button>`).join('');
    document.getElementById('gfxTogglesGrid').innerHTML = GFX_TOGGLE_META.map(t => `<button type="button" class="btn btn-xs ${globalSettings.graphics[t.k] ? 'btn-emerald' : ''}" onclick="toggleGfxOption('${t.k}')">${t.lbl}: ${globalSettings.graphics[t.k] ? 'ON' : 'OFF'}</button>`).join('');
    document.getElementById('gfxFilterButtonsGrid').innerHTML = OPTIC_FILTER_META.map(f => `<button type="button" id="fltBtn_${f.k}" class="btn btn-xs ${globalSettings.graphics.filter === f.k ? 'btn-sky active' : ''}" onclick="setVisualFilter('${f.k}')">${f.lbl}</button>`).join('');
    syncGfxSlidersDOM(); setVisualFilter(globalSettings.graphics.filter, false);
}
function syncGfxSlidersDOM() {
    const g = globalSettings.graphics;
    setTextCached('gfxPresetActiveLabel', (g.preset || 'medium').toUpperCase());
    setTextCached('gfxResLabel', `${g.resScale.toFixed(2)}x`); setTextCached('gfxSlicesLabel', `${g.roadSlices} Seg`); setTextCached('gfxParticleLabel', `${Math.round(g.particles * 100)}%`);
    document.getElementById('gfxResSlider').value = Math.round(g.resScale * 100);
    document.getElementById('gfxSlicesSlider').value = g.roadSlices;
    document.getElementById('gfxParticleSlider').value = Math.round(g.particles * 100);
}
function applyGraphicsPreset(k) { Object.assign(globalSettings.graphics, { preset: k, ...(GRAPHICS_PRESETS[k] || GRAPHICS_PRESETS.medium) }); document.getElementById('atmosphereOverlay').classList.toggle('scanlines-active', globalSettings.graphics.scanlines); buildGraphicsUI(); resizeGameCanvas(); saveGlobalSettings(); }
function updateGfxResolution(v) { globalSettings.graphics.resScale = Math.max(60, Math.min(150, parseInt(v, 10) || 100)) / 100; syncGfxSlidersDOM(); resizeGameCanvas(); saveGlobalSettings(); }
function updateGfxDrawSlices(v) { globalSettings.graphics.roadSlices = Math.max(16, Math.min(48, parseInt(v, 10) || 26)); syncGfxSlidersDOM(); saveGlobalSettings(); }
function updateGfxParticles(v) { const p = parseInt(v, 10); globalSettings.graphics.particles = Math.max(0, Math.min(150, Number.isNaN(p) ? 65 : p)) / 100; syncGfxSlidersDOM(); saveGlobalSettings(); }
function toggleGfxOption(opt) { globalSettings.graphics[opt] = !globalSettings.graphics[opt]; if (opt === 'scanlines') document.getElementById('atmosphereOverlay').classList.toggle('scanlines-active', globalSettings.graphics.scanlines); buildGraphicsUI(); saveGlobalSettings(); }
function setVisualFilter(fc, save = true) {
    const safe = VALID_FILTERS.has(fc) ? fc : 'filter-standard';
    globalSettings.graphics.filter = safe; canvas.className = safe;
    const ov = document.getElementById('atmosphereOverlay');
    OPTIC_FILTER_META.forEach(f => { if (f.atmo) ov.classList.remove(f.atmo); });
    const meta = OPTIC_FILTER_META.find(f => f.k === safe);
    if (meta && meta.atmo) ov.classList.add(meta.atmo);
    OPTIC_FILTER_META.forEach(f => { const b = document.getElementById(`fltBtn_${f.k}`); if (b) b.className = f.k === safe ? 'btn btn-xs btn-sky active' : 'btn btn-xs'; });
    document.getElementById('deactivateOpticFilterBtn').classList.toggle('hidden', safe === 'filter-standard');
    if (save) saveGlobalSettings();
}
function resetGraphicsSettingsOnly() { globalSettings.graphics = getDefaultGlobalSettings().graphics; applyGraphicsPreset('medium'); setVisualFilter('filter-standard'); }

// CONTROLS
function buildKeybindGridUI() {
    const it = [{ k: 'left', l: 'LEFT' }, { k: 'right', l: 'RIGHT' }, { k: 'nitro', l: 'NITRO' }, { k: 'brake', l: 'BRAKE' }, { k: 'emp', l: 'EMP' }, { k: 'hideui', l: 'HUD' }];
    document.getElementById('pcKeybindGrid').innerHTML = it.map(x => `<button type="button" class="recessed-well" style="padding:7px 9px;text-align:left;cursor:pointer;" onclick="startKeyRebind('${x.k}')"><div style="font-size:8.5px;color:var(--text-dim);">${x.l}</div><div id="bindVal_${x.k}" style="font-size:11px;font-weight:700;color:#7dd3fc;margin-top:2px;"></div></button>`).join('');
    refreshKeybindLabels();
}
function startKeyRebind(act) { awaitingRebindAction = act; setTextCached(`bindVal_${act}`, 'PRESS KEY...'); }
function refreshKeybindLabels() {
    Object.entries(globalSettings.controls.binds).forEach(([a, ks]) => setTextCached(`bindVal_${a}`, ks.map(k => k === ' ' ? 'SPACE' : k.toUpperCase()).join(' / ')));
    const k0 = globalSettings.controls.binds.hideui[0];
    setTextCached('pcHideUiHintBadge', `[${k0 === ' ' ? 'SPACE' : k0.toUpperCase()}] UI • [ESC] Pause`);
}

let tiltCenterOffset = 0, lastRawTilt = 0, smoothedGyro = 0, needsGyroZero = true, hasGyroVal = false, lastTapTs = 0, dtBoostTimer = null;

function setMobileControlMode(mode) {
    globalSettings.controls.mobileMode = mode;
    ['buttons', 'drag', 'tilt'].forEach(m => { const b = document.getElementById(`mobCtrl_${m}`); if (b) b.className = m === mode ? 'btn btn-sm btn-sky active' : 'btn btn-sm'; });
    const leftGrp = document.getElementById('mobileLeftTouchGroup');
    if (leftGrp) leftGrp.style.display = mode === 'buttons' ? 'flex' : 'none';
    const gb = document.getElementById('gyroCalibrationBox');
    gb.style.opacity = mode === 'tilt' ? '1' : '0.4'; gb.style.pointerEvents = mode === 'tilt' ? 'auto' : 'none';
    if (mode === 'tilt') { calibrateTiltSensor(true); if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') DeviceOrientationEvent.requestPermission().catch(() => {}); }
    saveGlobalSettings();
}
function toggleInvertGyro() { globalSettings.controls.invertGyro = !globalSettings.controls.invertGyro; needsGyroZero = true; document.getElementById('invertGyroBtn').innerText = `Flip: ${globalSettings.controls.invertGyro ? 'ON' : 'OFF'}`; saveGlobalSettings(); }
function calibrateTiltSensor(silent = true) { if (hasGyroVal) { tiltCenterOffset = lastRawTilt; smoothedGyro = 0; needsGyroZero = false; } else needsGyroZero = true; setTextCached('gyroLiveAngleLabel', '0.0°'); if (!silent) playSfx('pickup'); }
function updateGyroSpeedSetting(val) { const p = Math.max(20, Math.min(100, parseInt(val, 10) || 65)); globalSettings.controls.gyroSensitivity = p / 100; setTextCached('gyroSpeedLabel', `${p}%`); document.getElementById('gyroSpeedSlider').value = p; saveGlobalSettings(); }
function toggleDoubleTapNitro() { globalSettings.controls.doubleTapNitro = !globalSettings.controls.doubleTapNitro; const b = document.getElementById('doubleTapNitroBtn'); b.innerText = globalSettings.controls.doubleTapNitro ? 'ON' : 'OFF'; b.className = globalSettings.controls.doubleTapNitro ? 'btn btn-xs btn-emerald' : 'btn btn-xs'; saveGlobalSettings(); }
function resetControlSettingsOnly() { globalSettings.controls = getDefaultGlobalSettings().controls; setMobileControlMode('buttons'); updateGyroSpeedSetting(65); document.getElementById('doubleTapNitroBtn').innerText = 'ON'; refreshKeybindLabels(); saveGlobalSettings(); }

// =========================================================================
// 13. DEV CONSOLE
// =========================================================================
function showDevFeedback(msg) { const el = document.getElementById('devConsoleFeedback'); if (el) { el.innerText = msg; el.classList.remove('hidden'); } }
function toggleDevGodMode() { if (!activeAccount || !activeAccount.isDev) return; devGodModeActive = !devGodModeActive; if (devGodModeActive) { gameState.armor = 100; gameState.nitroFuel = 100; gameState.empCharge = 100; updateHudDOM(true); } syncDevUiVisibility(); playSfx('pickup'); showDevFeedback(devGodModeActive ? '⚡ God Mode ON' : 'God Mode OFF'); }
function devRefillAllSystems() { if (!activeAccount || !activeAccount.isDev) return; gameState.armor = 100; gameState.nitroFuel = 100; gameState.empCharge = 100; updateHudDOM(true); spawnFloat('⚡ MAX ALL SYSTEMS', '#00f5d4', -45); playSfx('pickup'); }
function devStartAtCustomEpoch() { if (!activeAccount || !activeAccount.isDev) return; startGameSession(Math.max(1, Math.min(99999, parseInt(document.getElementById('devEpochInput').value, 10) || 250))); }
function devFastForwardSeasonPhase() {
    if (!activeAccount || !activeAccount.isDev) return;
    seasonStateCache.devOffsetMs = (Number(seasonStateCache.devOffsetMs) || 0) + seasonStatusCache.remainingMs + 2500;
    saveSeasonState(); syncSeasonLifecycle(); refreshSeasonUI(); refreshMenuAccountUI(); buildGarageUI();
    publishRealtimeEvent('season_sync', { seasonState: seasonStateCache });
    showDevFeedback(`⏩ Season ${seasonStatusCache.seasonNum} (${seasonStatusCache.phase}) synced live.`); showToast(`Advanced to S${seasonStatusCache.seasonNum} (${seasonStatusCache.phase})`, 'ok'); playSfx('pickup');
}
function devBroadcastSystemMail() {
    if (!activeAccount || !activeAccount.isDev) return;
    const t = (document.getElementById('devMailTitleInput').value || '').trim(), b = (document.getElementById('devMailBodyInput').value || '').trim();
    if (!t || !b) { showToast('Enter subject & message.', 'err'); return; }
    const mailObj = pushMailAll({ title: t, sender: 'DEV BROADCAST', body: b });
    publishRealtimeEvent('mail_broadcast', { mail: mailObj });
    document.getElementById('devMailTitleInput').value = ''; document.getElementById('devMailBodyInput').value = '';
    refreshInboxBadgeUI(); showDevFeedback(`✓ Sent "${t}" live to all browsers.`); showToast('Broadcast mail sent live.', 'ok'); playSfx('pickup');
}
async function devResetSpecificScore(uid) {
    if (!activeAccount || !activeAccount.isDev || !uid) return;
    const target = accountsCache[uid];
    const ok = await askConfirm({ title: 'Reset Specific Score?', body: `Reset Season & All-Time scores for "${target ? target.name : uid}" across all browsers?`, okLabel: 'Reset Score' });
    if (!ok) return;
    const now = Date.now(); syncMeta.resetScoreTs[uid] = now; saveSyncMeta();
    applyScoreResetLocally(uid); publishRealtimeEvent('score_reset', { uid, ts: now });
    reconcileAllTimeChampion(); refreshMenuAccountUI(); buildGarageUI(); renderDevAccountsList();
    if (document.getElementById('leaderboardModal').style.display === 'flex') renderLeaderboardList();
    showDevFeedback(`✓ Score reset live for ${target ? target.name : uid}.`); showToast('Specific score reset live.', 'ok'); playSfx('pickup');
}
async function devResetAllScores() {
    if (!activeAccount || !activeAccount.isDev) return;
    const ok = await askConfirm({ title: 'Reset ALL Scores?', body: 'Wipe ALL Season & All-Time leaderboard scores across every browser?', okLabel: 'Reset All Scores' });
    if (!ok) return;
    const now = Date.now(); syncMeta.wipeAllScoresTs = now; saveSyncMeta();
    applyResetAllScoresLocally(); publishRealtimeEvent('score_reset_all', { ts: now });
    refreshMenuAccountUI(); buildGarageUI(); updateTopLeaderBanner(); renderDevAccountsList();
    if (document.getElementById('leaderboardModal').style.display === 'flex') renderLeaderboardList();
    showDevFeedback('✓ All scores reset live.'); showToast('All scores wiped live.', 'ok'); playSfx('pickup');
}
async function devDeleteAllNonDevAccounts() {
    if (!activeAccount || !activeAccount.isDev) return;
    const victims = Object.values(accountsCache).filter(a => !a.isDev);
    if (!victims.length) { showDevFeedback('No player accounts to delete.'); showToast('No player accounts exist.'); return; }
    const ok = await askConfirm({ title: 'Delete ALL Player Accounts?', body: `Permanently delete ALL ${victims.length} non-Dev player account(s), scores, and songs across ALL browsers?\nYour unique Dev account is preserved.`, okLabel: `Delete ${victims.length} Accounts` });
    if (!ok) return;
    const now = Date.now(); syncMeta.wipeAllAccountsTs = now; saveSyncMeta();
    applyDeleteAllNonDevLocally(now, false); publishRealtimeEvent('acc_delete_all', { ts: now });
    reconcileAllTimeChampion(); refreshMenuAccountUI(); buildGarageUI(); renderDevAccountsList(); renderDevCustomSongsList();
    if (document.getElementById('leaderboardModal').style.display === 'flex') renderLeaderboardList();
    showDevFeedback(`✓ Deleted ${victims.length} player accounts live.`); showToast(`Deleted ${victims.length} player accounts live.`, 'ok'); playSfx('pickup');
}
function toggleDevRevealAllIds() {
    devRevealAllIds = !devRevealAllIds; if (!devRevealAllIds) devRowRevealSet.clear();
    const b = document.getElementById('devRevealAllIdsBtn'); if (b) b.innerText = devRevealAllIds ? '🙈 Hide All IDs' : '👁 Show All IDs';
    renderDevAccountsList();
}
function toggleDevRowReveal(uid) { if (devRowRevealSet.has(uid)) devRowRevealSet.delete(uid); else devRowRevealSet.add(uid); renderDevAccountsList(); }
function renderDevAccountsList() {
    const el = document.getElementById('devAccountsList'); if (!el || !activeAccount || !activeAccount.isDev) return;
    const q = ((document.getElementById('devAccSearchInput') || {}).value || '').trim().toLowerCase();
    const all = Object.values(accountsCache); setTextCached('devAccCountBadge', String(all.length));
    const st = seasonStatusCache, filtered = q ? all.filter(a => a.name.toLowerCase().includes(q) || a.tag.toLowerCase().includes(q) || a.uid.includes(q)) : all;
    if (!filtered.length) { el.innerHTML = '<div style="padding:8px;text-align:center;color:var(--text-dim);font-size:10px;">No matching accounts.</div>'; return; }
    el.innerHTML = filtered.map(a => {
        const shown = devRevealAllIds || devRowRevealSet.has(a.uid);
        const sScore = (a.stats.seasonScores && a.stats.seasonScores[st.seasonNum]) || 0, aScore = a.stats.allTimeBest || 0;
        const idText = shown ? `#${escapeHtml(a.tag)} • ${escapeHtml(a.uid)}` : `#•••• • ••••••••••••••••`;
        const copyBtn = shown ? `<button type="button" class="btn btn-xs btn-emerald" style="padding:1px 5px;font-size:9px;" onclick="copyUidDirect('${escapeHtml(a.uid)}')">📋</button>` : '';
        return `<div class="recessed-well" style="padding:6px 8px;display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;"><div style="min-width:0;flex:1;"><div class="row-wrap" style="gap:5px;"><span style="width:7px;height:7px;border-radius:50%;background:${escapeHtml(a.custom.bodySecondary)};"></span><strong style="font-size:11px;color:#fff;">${escapeHtml(a.name)}</strong>${a.isDev ? '<span class="badge badge-cyan mono" style="font-size:8px;">DEV</span>' : ''}<button type="button" class="reveal-pill ${shown ? 'revealed' : ''}" style="font-size:9px;padding:1px 5px;" onclick="toggleDevRowReveal('${escapeHtml(a.uid)}')">${idText} ${shown ? '🙈' : '👁'}</button>${copyBtn}</div><div class="mono" style="font-size:9px;color:var(--text-dim);margin-top:2px;">All: <span style="color:#34d399;">${aScore.toLocaleString()}</span> &bull; S${st.seasonNum}: <span style="color:#fcd34d;">${sScore.toLocaleString()}</span> &bull; Runs: ${a.stats.totalRuns || 0}</div></div><div class="row" style="gap:4px;flex-shrink:0;"><button type="button" class="btn btn-xs btn-amber" onclick="devResetSpecificScore('${escapeHtml(a.uid)}')">Reset Score</button>${a.isDev ? '' : `<button type="button" class="btn btn-xs btn-danger" onclick="deleteAccountByUid('${escapeHtml(a.uid)}')">Del</button>`}</div></div>`;
    }).join('');
}

// =========================================================================
// 14. SESSION, VIEWPORT, MOBILE FULLSCREEN & INPUTS
// =========================================================================
function syncCursorVisibility() {
    const open = ['bootSplashModal', 'startModal', 'gameOverModal', 'inboxModal', 'leaderboardModal', 'pauseSettingsModal', 'confirmModal'].some(id => document.getElementById(id).style.display === 'flex');
    document.body.classList.toggle('gameplay-active', gameState.running && !gameState.paused && !open);
}
function toggleGameHudVisibility() { isHudHidden = !isHudHidden; document.getElementById('gameViewportWrapper').classList.toggle('hud-hidden', isHudHidden); }

function startGameSession(startEp = 1) {
    if (isPortalExiting) return;
    if (!activeAccount) { showToast('Sign in or create an account first.', 'err'); playSfx('hit'); return; }
    hasTrustedGesture = true; isBootSplashDismissed = true;
    document.getElementById('bootSplashModal').style.display = 'none';
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    ensureAudioEngine(); syncSeasonLifecycle();
    if (isMobileHardware) requestMobileFullscreenSafe();
    resizeGameCanvas();
    if (globalSettings.controls.mobileMode === 'tilt') calibrateTiltSensor(true);

    ['startModal', 'pauseSettingsModal', 'leaderboardModal', 'inboxModal', 'gameOverModal', 'confirmModal'].forEach(id => { document.getElementById(id).style.display = 'none'; });
    document.getElementById('atmosphereOverlay').classList.remove('hit-flash');

    const ep = Math.max(1, Math.floor(startEp || 1));
    Object.assign(gameState, {
        running: true, paused: false, score: 0, epoch: ep, combo: 1.0, nearMisses: 0,
        armor: 100, nitroFuel: 100, empCharge: 100, distanceM: getDistanceForEpoch(ep),
        speedMps: 25, targetLane: 0, egoLaneX: 0, egoRoll: 0, boosting: false, braking: false,
        slowMoTimer: 0, invulnTimer: 0, hitFlashTimer: 0, empWaveRadius: 0, empFlashAlpha: 0, screenShake: 0,
        ep250WarnTriggered: ep > 250, ep250WarnTimer: 0, hazards: [], pickups: [], FloatingTexts: [], empFX: []
    });
    nextMenuNoteT = 0; nextGameNoteT = 0;
    syncBiomeForEpoch(true);
    if (ep === 249 || ep === 250) triggerEpoch250Warning(); else syncEpoch250Banners();
    syncExternalTracks(); updateEnginePitch(); updateEqVisuals(true); updateHudDOM(true); renderMiniRadar(); syncCursorVisibility();
}

function returnToMainMenu() {
    gameState.running = false; gameState.paused = false; gameState.ep250WarnTimer = 0; gameState.hitFlashTimer = 0; gameState.boosting = false; gameState.braking = false;
    nextGameNoteT = 0; nextMenuNoteT = 0;
    document.getElementById('atmosphereOverlay').classList.remove('hit-flash');
    syncEpoch250Banners(); syncExternalTracks(); updateEnginePitch(); updateEqVisuals(false);
    ['pauseSettingsModal', 'gameOverModal', 'leaderboardModal', 'inboxModal', 'confirmModal'].forEach(id => { document.getElementById(id).style.display = 'none'; });
    document.getElementById('startModal').style.display = 'flex';
    syncSeasonLifecycle(); refreshMenuAccountUI(); refreshSeasonUI(); refreshInboxBadgeUI(); syncCursorVisibility();
}

function exitGamePortal() {
    if (!activeAccount) { showToast('Sign in or create an account first.', 'err'); return; }
    isPortalExiting = true; gameState.running = false; gameState.paused = true;
    if (musicSchedId) clearInterval(musicSchedId);
    if (rtEventSource) { try { rtEventSource.close(); } catch (e) {} }
    silenceAllAudio();
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    try { window.open('', '_self', ''); window.close(); } catch (e) {}
    setTimeout(() => { document.body.innerHTML = '<div style="position:fixed;inset:0;background:#05070b;color:#94a3b8;display:flex;align-items:center;justify-content:center;font-family:monospace;">SESSION CLOSED</div>'; }, 80);
}

function resizeGameCanvas() {
    detectDeviceHardware();
    const wrap = document.getElementById('gameViewportWrapper'), vv = window.visualViewport;
    const winW = Math.round(vv ? vv.width : window.innerWidth), winH = Math.round(vv ? vv.height : window.innerHeight);
    let w = winW, h = winH;
    const isRotatedPortrait = Boolean(isMobileHardware && winH > winW);
    wrap.classList.toggle('is-rotated-portrait', isRotatedPortrait);
    if (isRotatedPortrait) {
        w = winH; h = winW;
        wrap.style.left = `${winW}px`; wrap.style.width = `${winH}px`; wrap.style.height = `${winW}px`;
        wrap.style.transformOrigin = 'top left'; wrap.style.transform = 'rotate(90deg)';
    } else {
        wrap.style.left = '0px'; wrap.style.width = `${winW}px`; wrap.style.height = `${winH}px`;
        wrap.style.transformOrigin = ''; wrap.style.transform = 'none';
    }
    const baseDpr = Math.min(window.devicePixelRatio || 1, isMobileHardware ? 1.15 : 1.45);
    const effDpr = Math.max(0.6, Math.min(2.0, baseDpr * (globalSettings.graphics.resScale || 1.0)));
    canvas.width = Math.max(1, Math.floor(w * effDpr)); canvas.height = Math.max(1, Math.floor(h * effDpr));
    ctx.setTransform(effDpr, 0, 0, effDpr, 0, 0);
    gameState.viewW = w; gameState.viewH = h; cachedGradients.key = '';
    if (document.getElementById('pauseSettingsModal').style.display === 'flex' && currentSettingsTab === 'garage') syncGarageCanvasResolution();
}

function requestMobileFullscreenSafe() {
    if (!isMobileHardware || isPortalExiting) return;
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) {
        el.requestFullscreen({ navigationUI: 'hide' }).then(() => {
            if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
            setTimeout(resizeGameCanvas, 120);
        }).catch(() => resizeGameCanvas());
    }
}

function enterFromBootSplash() {
    if (isBootSplashDismissed) return;
    isBootSplashDismissed = true; hasTrustedGesture = true;
    mainMenuSplashGuardUntil = performance.now() + 340;
    document.getElementById('bootSplashModal').style.display = 'none';
    document.getElementById('startModal').style.display = 'flex';
    if (isMobileHardware) requestMobileFullscreenSafe();
    const actx = ensureAudioEngine();
    nextMenuNoteT = 0;
    if (actx && actx.state === 'running') tickMusicScheduler();
    playSfx('pickup');
    syncCursorVisibility();
}

['pointerdown', 'click'].forEach(evt => document.getElementById('startModal').addEventListener(evt, e => { if (performance.now() < mainMenuSplashGuardUntil) { e.preventDefault(); e.stopPropagation(); } }, true));
document.getElementById('bootSplashModal').addEventListener('click', () => enterFromBootSplash());
document.getElementById('bootEnterBtn').addEventListener('click', e => { e.stopPropagation(); enterFromBootSplash(); });

canvas.addEventListener('pointerdown', e => {
    if (e.isTrusted) hasTrustedGesture = true;
    if (!gameState.running || gameState.paused) return;
    if (!isMobileHardware) return;
    const now = performance.now(), dtTap = now - lastTapTs;
    if (globalSettings.controls.doubleTapNitro && dtTap > 40 && dtTap < 260) {
        setBoosting(true); if (dtBoostTimer) clearTimeout(dtBoostTimer); dtBoostTimer = setTimeout(() => setBoosting(false), 1100);
    }
    lastTapTs = now;
    if (globalSettings.controls.mobileMode === 'drag') {
        const rot = isMobileHardware && window.innerHeight > window.innerWidth;
        const x = rot ? e.clientY : e.clientX, y = rot ? (window.innerWidth - e.clientX) : e.clientY;
        const W = gameState.viewW, H = gameState.viewH, hY = H * 0.42, rc = Math.sin(gameState.distanceM * 0.012) * 0.65;
        let zTap = EGO_Z_CENTER;
        if (y > hY + 12) zTap = Math.max(1.1, Math.min(18, (H * 0.85) / Math.max(1, (y - hY) / (1.72 * 0.36))));
        let best = Math.round(gameState.targetLane), minD = Infinity;
        for (const l of LANES) { const d = Math.abs(x - projectX(l, zTap, W, H, rc)); if (d < minD) { minD = d; best = l; } }
        setDiscreteTargetLane(best);
    }
});

(function bindMobileTouchSlidersAndScroll() {
    let activeSld = null, activeScr = null, lastX = 0, lastY = 0, dragDist = 0, isDrag = false, suppressUntil = 0, vel = 0, lastTs = 0, rafId = 0;
    const stopMom = () => { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } vel = 0; };
    const findScr = el => { let c = el; while (c && c !== document.body) { if (c.classList && c.classList.contains('modal-scroll') && c.scrollHeight > c.clientHeight + 1) return c; c = c.parentElement; } return null; };
    const setSld = (cx, cy, sld) => {
        const r = sld.getBoundingClientRect(), rot = isMobileHardware && window.innerHeight > window.innerWidth;
        const ratio = Math.max(0, Math.min(1, rot ? (cy - r.top) / Math.max(1, r.height) : (cx - r.left) / Math.max(1, r.width)));
        const mn = parseFloat(sld.min) || 0, mx = parseFloat(sld.max) || 100, st = parseFloat(sld.step) || 1;
        const v = Math.max(mn, Math.min(mx, Math.round((mn + ratio * (mx - mn) - mn) / st) * st + mn));
        if (String(sld.value) !== String(v)) { sld.value = v; sld.dispatchEvent(new Event('input', { bubbles: true })); }
    };
    ['click', 'pointerup'].forEach(ev => document.addEventListener(ev, e => { if (performance.now() < suppressUntil) { e.preventDefault(); e.stopPropagation(); } }, true));
    document.addEventListener('touchstart', e => {
        if (!isMobileHardware || !e.touches[0]) return;
        stopMom(); const t = e.touches[0]; lastX = t.clientX; lastY = t.clientY; dragDist = 0; isDrag = false; lastTs = performance.now();
        const sld = e.target.closest ? e.target.closest('input[type="range"]') : null;
        if (sld) { activeSld = sld; activeScr = null; if (e.cancelable) e.preventDefault(); setSld(t.clientX, t.clientY, sld); return; }
        activeSld = null;
        const rot = window.innerHeight > window.innerWidth;
        activeScr = rot ? findScr(e.target) : null;
    }, { capture: true, passive: false });
    document.addEventListener('touchmove', e => {
        if (!isMobileHardware || !e.touches[0]) return;
        const t = e.touches[0], now = performance.now(), dt = Math.max(4, now - lastTs); lastTs = now;
        if (activeSld) { if (e.cancelable) e.preventDefault(); setSld(t.clientX, t.clientY, activeSld); return; }
        if (activeScr) {
            const dx = t.clientX - lastX, dy = t.clientY - lastY;
            lastX = t.clientX; lastY = t.clientY; dragDist += Math.hypot(dx, dy);
            if (dragDist > 6) isDrag = true;
            if (isDrag) { if (e.cancelable) e.preventDefault(); activeScr.scrollTop += dx; vel = vel * 0.45 + (dx / dt) * 0.55; }
        }
    }, { capture: true, passive: false });
    document.addEventListener('touchend', () => {
        if (isDrag && activeScr) {
            suppressUntil = performance.now() + 300;
            const scr = activeScr; let v = vel * 16;
            const step = () => { if (Math.abs(v) < 0.6) { rafId = 0; return; } scr.scrollTop += v; v *= 0.91; rafId = requestAnimationFrame(step); };
            if (Math.abs(v) > 1.2) rafId = requestAnimationFrame(step);
        }
        activeSld = null; activeScr = null; isDrag = false;
    }, { capture: true, passive: true });
})();

window.addEventListener('deviceorientation', e => {
    if (e.beta === null && e.gamma === null) return;
    const ang = (screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle : 0;
    let raw = ang === 90 ? (e.beta || 0) : (ang === 270 || ang === -90 ? -(e.beta || 0) : (window.innerHeight > window.innerWidth ? (e.beta || 0) : (e.gamma || 0)));
    if (globalSettings.controls.invertGyro) raw = -raw;
    lastRawTilt = raw; hasGyroVal = true;
    if (needsGyroZero) { tiltCenterOffset = raw; smoothedGyro = 0; needsGyroZero = false; }
    const rd = raw - tiltCenterOffset, dz = Math.abs(rd) < 1.1 ? 0 : (rd > 0 ? rd - 1.1 : rd + 1.1);
    smoothedGyro += (dz - smoothedGyro) * 0.42;
    if (globalSettings.controls.mobileMode === 'tilt') setTextCached('gyroLiveAngleLabel', `${smoothedGyro > 0.2 ? '+' : ''}${smoothedGyro.toFixed(1)}°`);
    if (!gameState.running || gameState.paused || globalSettings.controls.mobileMode !== 'tilt') return;
    const maxDeg = 18.0 - globalSettings.controls.gyroSensitivity * 11.0;
    const targetF = Math.max(-2, Math.min(2, (smoothedGyro / Math.max(4.5, maxDeg)) * 2.25));
    if (Math.abs(targetF - Math.round(gameState.targetLane)) >= 0.42) setDiscreteTargetLane(Math.round(targetF));
});

window.addEventListener('keydown', e => {
    if (e.isTrusted) hasTrustedGesture = true;
    if (!isBootSplashDismissed && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); enterFromBootSplash(); return; }
    if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) {
        if (e.key === 'Escape') document.activeElement.blur();
        return;
    }
    if (!activeAccount) return;
    ensureAudioEngine();
    const k = e.key.toLowerCase();
    if (awaitingRebindAction) { e.preventDefault(); if (k !== 'escape') globalSettings.controls.binds[awaitingRebindAction] = [k]; awaitingRebindAction = null; refreshKeybindLabels(); saveGlobalSettings(); return; }
    if (e.key === 'Escape') {
        e.preventDefault();
        if (document.getElementById('confirmModal').style.display === 'flex') { resolveConfirmModal(false); return; }
        if (document.getElementById('leaderboardModal').style.display === 'flex') { closeLeaderboardModal(); return; }
        if (document.getElementById('inboxModal').style.display === 'flex') { closeInboxModal(); return; }
        if (document.getElementById('pauseSettingsModal').style.display === 'flex') { resumeFromSettings(); return; }
        if (gameState.running) openSettingsModal('game');
        return;
    }
    if (!gameState.running || gameState.paused) return;
    if (k === 'r' && activeAccount && activeAccount.isDev) { e.preventDefault(); devRefillAllSystems(); return; }
    const b = globalSettings.controls.binds;
    if (b.hideui.includes(k)) { e.preventDefault(); toggleGameHudVisibility(); return; }
    if (b.left.includes(k)) steerLane(-1);
    else if (b.right.includes(k)) steerLane(1);
    else if (b.nitro.includes(k)) setBoosting(true);
    else if (b.brake.includes(k)) setBraking(true);
    else if (b.emp.includes(k)) { e.preventDefault(); triggerNeuralEmp(); }
});
window.addEventListener('keyup', e => { const k = e.key.toLowerCase(), b = globalSettings.controls.binds; if (b.nitro.includes(k)) setBoosting(false); else if (b.brake.includes(k)) setBraking(false); });
document.addEventListener('click', e => { if (e.isTrusted) hasTrustedGesture = true; const btn = e.target.closest('button'); if (btn && !btn.disabled && !btn.classList.contains('touch-paddle')) playSfx('uiClick'); }, { passive: true });

window.addEventListener('resize', resizeGameCanvas);
if (window.visualViewport) window.visualViewport.addEventListener('resize', resizeGameCanvas);
window.addEventListener('orientationchange', () => { setTimeout(resizeGameCanvas, 70); setTimeout(resizeGameCanvas, 220); });
window.addEventListener('blur', () => { if (gameState.running && !gameState.paused) openSettingsModal('game'); });
window.addEventListener('focus', () => { resizeGameCanvas(); resumeAudioForeground(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { if (gameState.running && !gameState.paused) openSettingsModal('game'); silenceAllAudio(); } else { resizeGameCanvas(); resumeAudioForeground(); } });

Object.assign(window, {
    switchAuthSubTab, createNewPilotAccount, signInWithUid,
    logoutActiveAccount, logoutFromProfile, saveProfileIdentity,
    toggleRevealField, copyCurrentAccountUid, copyPrevAccountUid, copyUidDirect,
    deleteActiveAccountSelf, deleteAccountByUid,
    resolveConfirmModal, forceManualCloudSync,
    startGameSession, returnToMainMenu, exitGamePortal, toggleGameHudVisibility,
    openInboxModal, closeInboxModal, markMailRead, markAllInboxRead, clearReadInboxMail, claimInboxReward,
    openLeaderboardModal, closeLeaderboardModal, switchLeaderboardTab, toggleLbDevManage,
    openSettingsModal, resumeFromSettings, switchSettingsTab,
    setDifficulty, selectManualBiome, toggleAutoBiomeCycle, resetGameSettingsOnly,
    setCustomVehicleColor, applyGaragePreset, selectNitroSkin, resetVehicleCustomization,
    toggleGarageNitroPreview, triggerGarageEmpPreview,
    selectOstMode, updateVolumeSetting, handleCustomSongUpload, removeCurrentPilotCustomSong, deleteCustomSongByUid, resetSoundSettingsOnly,
    setMobileControlMode, toggleInvertGyro, calibrateTiltSensor, updateGyroSpeedSetting, toggleDoubleTapNitro, startKeyRebind, resetControlSettingsOnly,
    applyGraphicsPreset, updateGfxResolution, updateGfxDrawSlices, updateGfxParticles, toggleGfxOption, setVisualFilter, resetGraphicsSettingsOnly,
    toggleDevGodMode, devRefillAllSystems, devStartAtCustomEpoch, devFastForwardSeasonPhase, devBroadcastSystemMail,
    devResetSpecificScore, devResetAllScores, devDeleteAllNonDevAccounts, devRemoveAllCustomSongs,
    toggleDevRevealAllIds, toggleDevRowReveal, renderDevAccountsList,
    steerLane, setBoosting, setBraking, triggerNeuralEmp
});

// =========================================================================
// 15. BOOT, HYBRID INDEXEDDB + FIREBASE DB & FAIL-SAFE 60/120FPS LOOP
// =========================================================================
detectDeviceHardware();
validateAndSanitizeDatabase();
restoreFromIndexedDBIfNeeded();
syncSeasonLifecycle();
reconcileAllTimeChampion();

setDifficulty(globalSettings.difficulty);
buildVolumeSlidersUI();
buildKeybindGridUI();
setMobileControlMode(globalSettings.controls.mobileMode);
updateGyroSpeedSetting(Math.round(globalSettings.controls.gyroSensitivity * 100));
buildGraphicsUI();
document.getElementById('atmosphereOverlay').classList.toggle('scanlines-active', globalSettings.graphics.scanlines);

const savedUid = lsGet(STORAGE_ACTIVE_UID_KEY, '');
if (savedUid && accountsCache[savedUid]) {
    activateAccountSession(savedUid);
} else {
    refreshMenuAccountUI();
    buildBiomeSelectorGrid();
    syncOstButtonsUI();
    syncDevUiVisibility();
}

resizeGameCanvas();
refreshSeasonUI();
renderMiniRadar();
startMusicScheduler();

pullCloudHistoryAndSync(true);
connectRealtimeStream();

setInterval(() => {
    seasonStatusCache = computeSeasonStatus();
    if ((seasonStatusCache.phase === 'GAP' && seasonStateCache.lastFinalizedSeason < seasonStatusCache.seasonNum) ||
        (seasonStatusCache.phase === 'ACTIVE' && (seasonStateCache.lastAnnouncedSeason < seasonStatusCache.seasonNum || seasonStateCache.lastFinalizedSeason < seasonStatusCache.seasonNum - 1))) {
        syncSeasonLifecycle();
    } else if (!gameState.running) {
        refreshSeasonUI();
    }
}, 1000);

let lastLoopTs = performance.now();
function mainLoop(now) {
    requestAnimationFrame(mainLoop);
    try {
        const dt = Math.min(0.05, Math.max(0.001, (now - lastLoopTs) / 1000));
        lastLoopTs = now;
        updateGamePhysics(dt, now);
        renderSceneFrame(now);
    } catch (err) {
        console.error('Frame error:', err);
    }
}
requestAnimationFrame(mainLoop);

})();
