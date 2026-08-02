// ============================================================
// STATE
// ============================================================
let filaments    = [];
let usageLog     = [];
let materials    = [];
let equipment    = [];
let modelKits    = [];
let barcodeDb    = [];
let purchases    = [];
let sellProducts = [];
let sellEvents   = [];
let activeSellTab = 'products';
let purchaseHistory = {}; // keyed by filament id string, newest-first
let activeTab    = 'dashboard';
let activeSection= 'filaments';
let inStockFilter= 0; // 0 = All, 1 = In Stock Only, 2 = Empty Only
let inventoryColourSortActive = false;
let reorderShowHidden = false;
let editingId    = null;
let editingMatId = null;
let editingBcId  = null;
let currentDb    = localStorage.getItem('ff-db') || 'spoolstats';
let sidebarMode  = 'filament'; // 'filament' (current) vs 'print' (grouped usage breakdown)
let usageProjects = [];
let sidebarPrintId = null;
const tableSorts = {};

// ============================================================
// THEME
// ============================================================
function initTheme() {
    const saved = localStorage.getItem('ff-theme') || 'dark';
    document.documentElement.setAttribute('data-theme', saved);
}
function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('ff-theme', next);
}
initTheme();

// ============================================================
// COLOUR HELPERS
// ============================================================
const COLOUR_MAP = {
    'apple green':'#7dc95e','ash grey':'#8a8a8a','bambu lab green':'#00ae42',
    'bambu green':'#00ae42','black':'#1a1a1a','blue':'#1e6fcf',
    'bright green':'#39d353','brown':'#7b4f2e','charcoal':'#3c3c3c',
    'cyan':'#00b4d8','dark green':'#1a5c2a','desert tan':'#c2a97a',
    'gold':'#d4a017','gray':'#8a8a8a','grey':'#8a8a8a',
    'ivory white':'#f5f0e8','jade white':'#e8f5e9','lemon yellow':'#f5e642',
    'light blue':'#6cb4e4','light grey':'#d1d5db','matte black':'#1a1a1a',
    'matte white':'#f0f0f0','navy blue':'#1e3a5f','orange':'#f5890a',
    'pink':'#f472b6','purple':'#9333ea','red':'#dc2626',
    'silver':'#c0c0c0','white':'#f8f8f8','yellow':'#facc15',
    'basic black':'#1a1a1a','basic white':'#f8f8f8',
};
function getColourHex(name) {
    if (!name) return '#4f8ef7';
    const low  = name.toLowerCase();
    if (COLOUR_MAP[low]) return COLOUR_MAP[low];
    const last = low.split(' ').pop();
    return COLOUR_MAP[last] || '#4f8ef7';
}

function parseHexColour(hex) {
    const value = (hex || '').trim();
    const valid = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!valid) return null;
    let n = valid[1];
    if (n.length === 3) n = n.split('').map(ch => ch + ch).join('');
    return {
        r: parseInt(n.slice(0, 2), 16),
        g: parseInt(n.slice(2, 4), 16),
        b: parseInt(n.slice(4, 6), 16),
    };
}

function colourDistance(a, b) {
    if (!a || !b) return Number.MAX_SAFE_INTEGER;
    const dr = a.r - b.r;
    const dg = a.g - b.g;
    const db = a.b - b.b;
    return (dr * dr) + (dg * dg) + (db * db);
}

// ============================================================
// BUY LINK
// ============================================================
function getBuyLink(f) {
    if (f.web_address) return f.web_address;
    const brand = (f.brand || '').toLowerCase();
    const query = encodeURIComponent(`${f.brand||''} ${f.material||''} ${f.color_name||''} ${f.style||''} filament`);
    if (brand.includes('bambu')) {
        return `https://uk.store.bambulab.com/search?type=product&q=${encodeURIComponent(`${f.color_name||''} ${f.material||''} ${f.style||''}`.trim())}`;
    }
    return `https://www.amazon.co.uk/s?k=${query}`;
}

// ============================================================
// MATERIAL BADGE STYLES
// ============================================================
const MAT_COLOURS = {
    'PLA':    { bg:'rgba(79,142,247,0.15)',  text:'#4f8ef7' },
    'PETG':   { bg:'rgba(34,197,94,0.15)',   text:'#22c55e' },
    'ABS':    { bg:'rgba(245,158,11,0.15)',  text:'#f59e0b' },
    'ASA':    { bg:'rgba(239,68,68,0.15)',   text:'#ef4444' },
    'TPU':    { bg:'rgba(168,85,247,0.15)',  text:'#a855f7' },
    'PA':     { bg:'rgba(20,184,166,0.15)',  text:'#14b8a6' },
    'PC':     { bg:'rgba(236,72,153,0.15)',  text:'#ec4899' },
    'PLA-CF': { bg:'rgba(79,142,247,0.15)',  text:'#4f8ef7' },
};
function matStyle(mat) {
    return MAT_COLOURS[(mat||'').toUpperCase()] || { bg:'rgba(124,92,191,0.15)', text:'#7c5cbf' };
}

// ============================================================
// COST HELPERS
// ============================================================
/**
 * Compute effective cost-per-gram using layered/FIFO pricing from purchase history.
 *
 * Each purchase covers qty × spool_weight grams. We consume the filament's
 * current weight from the newest purchase first, then fall back to older ones.
 *
 * Example: 1200g left. Newest: 1000g @ £20 (£0.020/g). Older: 1000g @ £18 (£0.018/g).
 * Cost = (1000×0.020 + 200×0.018) / 1200 = £0.0193/g
 *
 * Returns 0 for spools marked free. Returns null if no price info at all.
 */
function costPerGram(f) {
    const fid = String(f.id);
    const history = purchaseHistory[fid];
    const currentG = parseFloat(f.weight_current) || 0;
    const spoolW = parseFloat(f.spool_weight) || 1000;

    // Free spool: cost is exactly £0
    if (f.price_is_free) return 0;

    if (!history || !history.length) {
        // Fallback: single price_paid divided by spool_weight
        const price = parseFloat(f.price_paid);
        if (price == null || isNaN(price)) return null;
        if (price === 0 && f.price_is_free) return 0;
        if (price <= 0) return null;
        return price / spoolW;
    }

    // Check if any entry is marked free — treat whole spool as free
    if (history.some(p => p.price_is_free)) return 0;

    // Walk newest → oldest consuming grams
    let remaining = currentG;
    let totalCost = 0;
    let totalCovered = 0;

    for (const purchase of history) {
        if (remaining <= 0) break;
        if (purchase.price_paid == null) continue;
        const purchaseGrams = (purchase.qty || 1) * (purchase.spool_weight || spoolW || 1000);
        const cpg = purchase.price_paid / (purchase.spool_weight || spoolW || 1000);
        const consumed = Math.min(remaining, purchaseGrams);
        totalCost    += consumed * cpg;
        totalCovered += consumed;
        remaining    -= consumed;
    }

    // If grams exceed recorded history, use oldest known price for remainder
    if (remaining > 0 && history.length > 0) {
        const oldest = history[history.length - 1];
        if (oldest.price_paid != null) {
            const oldCpg = oldest.price_paid / (oldest.spool_weight || spoolW || 1000);
            totalCost    += remaining * oldCpg;
            totalCovered += remaining;
        }
    }

    if (totalCovered <= 0) return null;
    return totalCost / totalCovered;
}
function formatGBP(val) {
    if (val == null || isNaN(val)) return '—';
    return '£' + parseFloat(val).toFixed(2);
}

function compareSortValues(a, b) {
    const aNil = a === null || a === undefined || a === '';
    const bNil = b === null || b === undefined || b === '';
    if (aNil && bNil) return 0;
    if (aNil) return 1;
    if (bNil) return -1;

    if (typeof a === 'boolean' || typeof b === 'boolean') {
        return Number(a) - Number(b);
    }

    if (a instanceof Date || b instanceof Date) {
        return new Date(a).getTime() - new Date(b).getTime();
    }

    const aNum = typeof a === 'number' ? a : Number(a);
    const bNum = typeof b === 'number' ? b : Number(b);
    if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) {
        return aNum - bNum;
    }

    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

function applyTableSort(rows, tableName, accessors) {
    const sort = tableSorts[tableName];
    if (!sort || !sort.key || !accessors[sort.key]) return rows;
    const dir = sort.dir === 'desc' ? -1 : 1;
    return [...rows].sort((a, b) => dir * compareSortValues(accessors[sort.key](a), accessors[sort.key](b)));
}

function tableSortToggle(tableName, key) {
    const current = tableSorts[tableName];
    if (current && current.key === key) {
        current.dir = current.dir === 'asc' ? 'desc' : 'asc';
    } else {
        tableSorts[tableName] = { key, dir: 'asc' };
    }

    if (tableName === 'reorder') renderReorder();
    if (tableName === 'usage') renderUsageLog();
    if (tableName === 'materials') filterMaterials();
    if (tableName === 'equipment') renderEquipment();
    if (tableName === 'modelkits') renderModelKits();
    if (tableName === 'barcodes') renderBarcodeDb();
    if (tableName === 'purchases') renderPurchases();
}

function updateTableSortHeaders() {
    document.querySelectorAll('th[data-sort-table][data-sort-key]').forEach(th => {
        const tableName = th.dataset.sortTable;
        const key = th.dataset.sortKey;
        const sort = tableSorts[tableName];
        th.dataset.sortDir = sort && sort.key === key ? sort.dir : '';
    });
}

// ============================================================
// NAV
// ============================================================
function showTab(tab) {
    activeTab = tab;
    document.querySelectorAll('section[id^="tab-"]').forEach(s => s.classList.add('hidden'));
    document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
    // The 'Usage' tab now shows the usage log AND the usage graph together.
    const toShow = (tab === 'usage') ? ['usage', 'usage-graph'] : [tab];
    toShow.forEach(t => { const el = document.getElementById('tab-' + t); if (el) el.classList.remove('hidden'); });
    const btn = document.getElementById('btn-' + tab);
    if (btn) btn.classList.add('active');
    if (tab === 'inventory') renderInventory();
    if (tab === 'usage')     { populateUsageFilters(); renderUsageLog(); if (typeof renderUsageGraphTab === 'function') renderUsageGraphTab(); }
    if (tab === 'reorder')   renderReorder();
}

// ============================================================
// MANUAL MULTI-SPOOL USAGE MODAL
// ============================================================
function openManualUsageModal(prefillProject = null, prefillSlots = null) {
    const overlay = document.getElementById('usage-modal-overlay');
    const box     = overlay.querySelector('.modal-box');
    const inStock = filaments.filter(f => (parseFloat(f.weight_current) || 0) > 0);
    const spoolOptions = () => '<option value="">— Select spool —</option>' +
        inStock.map(f => `<option value="${f.id}">${f.brand} ${f.color_name} · ${f.material}${f.style ? ' ' + f.style : ''} (${Math.round(f.weight_current)}g)</option>`).join('');

    const initialSlots = prefillSlots && prefillSlots.length
        ? prefillSlots
        : [{ spoolId: '', grams: '', colour: null, material: null }];

    function buildSlotRow(slot, i) {
        const colourDot = slot.colour
            ? `<span style="width:14px;height:14px;border-radius:4px;background:${slot.colour};border:1px solid rgba(128,128,128,0.3);flex-shrink:0;display:inline-block"></span>`
            : '';
        const label = slot.material ? `Filament ${i + 1} · ${slot.material}` : `Filament ${i + 1}`;
        return `<div id="manual-slot-${i}" class="p-3 rounded-xl relative" style="background:var(--surface2);border:1px solid var(--border)">
            <div class="flex items-center justify-between mb-2">
                <div class="flex items-center gap-2">
                    ${colourDot}
                    <span class="text-xs font-bold mono uppercase" style="color:var(--text2)">${label}</span>
                </div>
                ${i > 0 ? `<button onclick="removeManualSlot(${i})" style="color:var(--muted);font-size:16px;line-height:1;background:none;border:none;cursor:pointer" title="Remove">×</button>` : ''}
            </div>
            <div class="grid grid-cols-2 gap-2">
                <div>
                    <label class="text-[10px] mono uppercase block mb-1" style="color:var(--muted)">Spool</label>
                    <select id="manual-spool-${i}" onchange="updateManualCost()" style="width:100%;font-size:12px">${spoolOptions()}</select>
                </div>
                <div>
                    <label class="text-[10px] mono uppercase block mb-1" style="color:var(--muted)">Grams Used</label>
                    <input type="number" id="manual-grams-${i}" value="${slot.grams || ''}" placeholder="e.g. 12" min="0" step="0.1" oninput="updateManualCost()" style="font-size:12px">
                </div>
            </div>
        </div>`;
    }

    box.innerHTML = `
        <div class="flex justify-between items-center mb-4">
            <h2 class="text-lg font-black mono uppercase" style="color:var(--text)">Log Usage</h2>
            <button onclick="closeUsageModal()" class="text-xl leading-none" style="color:var(--muted)">×</button>
        </div>
        <div class="mb-4">
            <label class="text-xs mono uppercase block mb-1" style="color:var(--muted)">Project Name (optional)</label>
            <input type="text" id="manual-project" value="${prefillProject || ''}" placeholder="My Print" style="width:100%">
        </div>
        <div class="mb-4">
            <label class="text-xs mono uppercase block mb-1" style="color:var(--muted)">Parent Project (optional)</label>
            <input type="text" id="manual-parent-project" placeholder="e.g. Car Project" style="width:100%">
        </div>
        <div id="manual-slot-list" class="space-y-3 mb-3">
            ${initialSlots.map((s, i) => buildSlotRow(s, i)).join('')}
        </div>
        <button onclick="addManualSlot()" class="btn-ghost text-xs w-full mb-4" style="justify-content:center">＋ Add Another Filament</button>
        <div id="manual-cost-preview" class="hidden p-2 rounded-lg text-xs mono mb-4" style="background:var(--surface2);color:var(--muted)"></div>
        <div class="flex gap-3">
            <button onclick="closeUsageModal()" class="btn-ghost flex-1">Cancel</button>
            <button onclick="submitManualUsage()" class="btn-primary flex-1">Log Usage</button>
        </div>`;

    // Pre-select spool IDs if provided
    initialSlots.forEach((slot, i) => {
        if (slot.spoolId) {
            const sel = document.getElementById(`manual-spool-${i}`);
            if (sel) sel.value = slot.spoolId;
        }
    });

    // Store slot count in a data attribute so add/remove can track it
    box.dataset.slotCount = initialSlots.length;
    overlay.classList.add('open');
    setTimeout(() => document.getElementById('manual-project')?.focus(), 60);
    updateManualCost();
}

function addManualSlot() {
    const box = document.querySelector('#usage-modal-overlay .modal-box');
    const count = parseInt(box.dataset.slotCount || 1);
    const inStock = filaments.filter(f => (parseFloat(f.weight_current) || 0) > 0);
    const spoolOptions = '<option value="">— Select spool —</option>' +
        inStock.map(f => `<option value="${f.id}">${f.brand} ${f.color_name} · ${f.material}${f.style ? ' ' + f.style : ''} (${Math.round(f.weight_current)}g)</option>`).join('');

    const div = document.createElement('div');
    div.id = `manual-slot-${count}`;
    div.className = 'p-3 rounded-xl relative';
    div.style.cssText = 'background:var(--surface2);border:1px solid var(--border)';
    div.innerHTML = `
        <div class="flex items-center justify-between mb-2">
            <span class="text-xs font-bold mono uppercase" style="color:var(--text2)">Filament ${count + 1}</span>
            <button onclick="removeManualSlot(${count})" style="color:var(--muted);font-size:16px;line-height:1;background:none;border:none;cursor:pointer" title="Remove">×</button>
        </div>
        <div class="grid grid-cols-2 gap-2">
            <div>
                <label class="text-[10px] mono uppercase block mb-1" style="color:var(--muted)">Spool</label>
                <select id="manual-spool-${count}" onchange="updateManualCost()" style="width:100%;font-size:12px">${spoolOptions}</select>
            </div>
            <div>
                <label class="text-[10px] mono uppercase block mb-1" style="color:var(--muted)">Grams Used</label>
                <input type="number" id="manual-grams-${count}" placeholder="e.g. 12" min="0" step="0.1" oninput="updateManualCost()" style="font-size:12px">
            </div>
        </div>`;
    document.getElementById('manual-slot-list').appendChild(div);
    box.dataset.slotCount = count + 1;
}

function removeManualSlot(i) {
    document.getElementById(`manual-slot-${i}`)?.remove();
    updateManualCost();
}

function updateManualCost() {
    const box = document.querySelector('#usage-modal-overlay .modal-box');
    const count = parseInt(box.dataset.slotCount || 1);
    let totalCost = 0, hasAny = false;
    for (let i = 0; i < count; i++) {
        const sel = document.getElementById(`manual-spool-${i}`);
        const gramsEl = document.getElementById(`manual-grams-${i}`);
        if (!sel || !gramsEl) continue;
        const f = filaments.find(x => x.id == sel.value);
        const g = parseFloat(gramsEl.value);
        const cpg = f ? costPerGram(f) : null;
        if (cpg && g > 0) { totalCost += cpg * g; hasAny = true; }
    }
    const el = document.getElementById('manual-cost-preview');
    if (el) {
        if (hasAny) { el.textContent = `Est. total print cost: ${formatGBP(totalCost)}`; el.classList.remove('hidden'); }
        else el.classList.add('hidden');
    }
}

async function submitManualUsage() {
    const box = document.querySelector('#usage-modal-overlay .modal-box');
    const count = parseInt(box.dataset.slotCount || 1);
    const project = document.getElementById('manual-project')?.value || 'Manual';
    const parentProject = document.getElementById('manual-parent-project')?.value || '';

    const entries = [];
    for (let i = 0; i < count; i++) {
        const sel = document.getElementById(`manual-spool-${i}`);
        const gramsEl = document.getElementById(`manual-grams-${i}`);
        if (!sel || !gramsEl) continue;
        const spoolId = sel.value;
        const grams = parseFloat(gramsEl.value);
        if (!spoolId || !grams || grams <= 0) continue;
        entries.push({ spoolId: parseInt(spoolId), grams });
    }

    if (!entries.length) { showToast('Add at least one spool with grams used.', 'error'); return; }

    // One print group for the whole multi-spool entry.
    let printId;
    try {
        const res = await apiFetch('/api/usage/print', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project, source: 'manual', parent_project: parentProject }),
        });
        printId = res.print_id;
    } catch {
        showToast('Could not create print record.', 'error');
        return;
    }

    let logged = 0, errors = 0;
    for (const e of entries) {
        try {
            await apiFetch('/api/usage', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filament_id: e.spoolId, grams: e.grams, project, print_id: printId }) });
            logged++;
        } catch { errors++; }
    }
    closeUsageModal();
    if (logged > 0) { showToast(`✓ Logged ${logged} spool${logged > 1 ? 's' : ''} for "${project}"`, 'success'); await loadAll(); }
    if (errors > 0) showToast(`${errors} entr${errors > 1 ? 'ies' : 'y'} failed to log`, 'error');
}

// ============================================================
// API
// ============================================================
async function apiFetch(path, opts = {}) {
    const url = path.startsWith('/api/databases')
        ? path
        : path + (path.includes('?') ? '&' : '?') + 'db=' + encodeURIComponent(currentDb);
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

// ============================================================
// LOAD
// ============================================================
async function loadAll() {
    try {
        [filaments, usageLog, purchaseHistory] = await Promise.all([
            apiFetch('/api/filaments'),
            apiFetch('/api/usage'),
            apiFetch('/api/purchases/by-filament'),
        ]);
        updateStats();
        renderDashboard();
        renderCharts();
        populateUsageFilters();
        if (activeTab === 'inventory') renderInventory();
        if (activeTab === 'reorder')   renderReorder();
        if (activeTab === 'usage')     renderUsageLog();
        if (activeSection === 'purchases') loadPurchases();
    } catch {
        showToast('Could not load data.', 'error');
        document.getElementById('db-status').textContent = 'ERROR';
        document.getElementById('db-status').style.color = 'var(--red)';
    }
}

// ============================================================
// STATS
// ============================================================
function updateStats() {
    const total      = filaments.length;
    const totalGrams = filaments.reduce((a, f) => a + (parseFloat(f.weight_current) || 0), 0);
    const lowCount   = filaments.filter(f => (parseFloat(f.weight_current) || 0) < 150).length;
    const mats       = [...new Set(filaments.map(f => f.material).filter(Boolean))].length;

    document.getElementById('stat-count').textContent  = total;
    document.getElementById('stat-weight').innerHTML   = (totalGrams / 1000).toFixed(2) + '<span class="text-sm font-normal ml-1" style="color:var(--muted)">kg</span>';
    document.getElementById('stat-low').textContent    = lowCount;
    document.getElementById('stat-types').textContent  = mats;
    document.getElementById('sys-low').textContent     = lowCount;

    // Total inventory value
    const totalValue = filaments.reduce((a, f) => a + (parseFloat(f.price_paid) || 0), 0);
    const valEl = document.getElementById('sys-inv-value');
    if (valEl) valEl.textContent = totalValue > 0 ? formatGBP(totalValue) : '—';

    const totalUsed = usageLog.reduce((a, u) => a + (parseFloat(u.weight_used) || 0), 0);
    document.getElementById('sys-total-used').textContent = totalUsed > 0 ? (totalUsed / 1000).toFixed(2) + 'kg' : '—';

    // Usage-rate insights: average g/week over the last 8 weeks, and how
    // long the current stock would last at that rate.
    const avgEl = document.getElementById('sys-avg-week');
    const runEl = document.getElementById('sys-runout');
    if (avgEl && runEl) {
        const now = Date.now();
        const windowMs = 8 * 7 * 86400000; // 8 weeks
        let recentUsed = 0;
        usageLog.forEach(u => {
            const raw = u.print_created_at || u.created_at;
            if (!raw) return;
            const d = new Date(raw.length === 10 ? raw + 'T00:00:00' : raw);
            if (isNaN(d.getTime()) || now - d.getTime() > windowMs) return;
            recentUsed += parseFloat(u.weight_used) || 0;
        });
        const perWeek = recentUsed / 8;
        if (perWeek >= 0.5) {
            avgEl.textContent = Math.round(perWeek) + 'g';
            const weeksLeft = perWeek > 0 ? totalGrams / perWeek : Infinity;
            runEl.textContent =
                weeksLeft > 104 ? '2+ years' :
                weeksLeft > 9   ? `~${Math.round(weeksLeft / 4.345)} months` :
                                  `~${Math.round(weeksLeft)} weeks`;
            runEl.style.color = weeksLeft < 4 ? 'var(--orange)' : 'var(--text)';
        } else {
            avgEl.textContent = '—';
            runEl.textContent = '—';
        }
    }

    const wellStocked = filaments.filter(f => (parseFloat(f.weight_current) || 0) >= 150).length;
    const pct = total > 0 ? Math.round((wellStocked / total) * 100) : 0;
    document.getElementById('health-bar').style.width      = pct + '%';
    document.getElementById('health-bar').style.background = pct > 70 ? 'var(--green)' : pct > 40 ? 'var(--orange)' : 'var(--red)';
    document.getElementById('health-label').textContent    = `${pct}% of spools well-stocked`;

    document.getElementById('reorder-dot').classList.toggle('hidden', lowCount === 0);
}

// ============================================================
// DASHBOARD
// ============================================================
function renderDashboard() {
    if (!filaments.length) return;

    const byMat  = {};
    filaments.forEach(f => { const m = f.material || 'Unknown'; byMat[m] = (byMat[m] || 0) + 1; });
    const sorted = Object.entries(byMat).sort((a, b) => b[1] - a[1]);
    const max    = Math.max(...sorted.map(e => e[1]));
    const colours = ['#4f8ef7','#22c55e','#f59e0b','#a855f7','#ec4899','#14b8a6','#ef4444','#f97316'];

    document.getElementById('material-chart').innerHTML = sorted.map(([mat, cnt], i) => {
        const h = Math.max(20, Math.round((cnt / max) * 160));
        return `<div class="flex flex-col items-center gap-1 flex-1">
            <span class="text-xs mono" style="color:var(--text2)">${cnt}</span>
            <div class="chart-bar w-full" style="height:${h}px;background:${colours[i % colours.length]};opacity:0.85"></div>
            <span style="font-size:10px;color:var(--muted);text-align:center;line-height:1.3" class="mono">${mat}</span>
        </div>`;
    }).join('');

    document.getElementById('chart-legend').innerHTML = sorted.map(([mat], i) =>
        `<div class="flex items-center gap-2">
            <div style="width:10px;height:10px;border-radius:3px;background:${colours[i % colours.length]}"></div>
            <span class="text-xs" style="color:var(--text2)">${mat}</span>
        </div>`
    ).join('');

    const low = filaments
        .filter(f => (parseFloat(f.weight_current) || 0) < 150)
        .sort((a, b) => {
            const wa = parseFloat(a.weight_current) || 0;
            const wb = parseFloat(b.weight_current) || 0;
            // Low-but-not-empty first (most urgent to reorder), then empties.
            if ((wa === 0) !== (wb === 0)) return wa === 0 ? 1 : -1;
            return wa - wb;
        });
    const sec = document.getElementById('low-stock-section');
    if (low.length) {
        sec.classList.remove('hidden');
        document.getElementById('low-stock-cards').innerHTML = low.map(f => lowStockMiniHTML(f)).join('');
    } else {
        sec.classList.add('hidden');
    }

    const byBrand   = {};
    filaments.forEach(f => { const b = f.brand || 'Unknown'; byBrand[b] = (byBrand[b] || 0) + 1; });
    const brandSorted = Object.entries(byBrand).sort((a, b) => b[1] - a[1]);
    const brandMax  = Math.max(...brandSorted.map(e => e[1]));
    if (brandSorted.length > 1) {
        document.getElementById('brand-section').classList.remove('hidden');
        document.getElementById('brand-bars').innerHTML = brandSorted.map(([brand, cnt]) =>
            `<div class="flex items-center gap-3">
                <span class="text-xs mono w-24 text-right flex-shrink-0" style="color:var(--text2)">${brand}</span>
                <div class="flex-1 progress-bg"><div class="progress-fill" style="width:${Math.round((cnt/brandMax)*100)}%;background:var(--accent)"></div></div>
                <span class="text-xs mono w-6 flex-shrink-0" style="color:var(--muted)">${cnt}</span>
            </div>`
        ).join('');
    }
}

// ============================================================
// INVENTORY
// ============================================================
function renderInventory() { populateFilters(); filterCards(); }

function populateFilters() {
    const mats   = [...new Set(filaments.map(f => f.material).filter(Boolean))].sort();
    const styles = [...new Set(filaments.map(f => f.style).filter(Boolean))].sort();
    const brands = [...new Set(filaments.map(f => f.brand).filter(Boolean))].sort();

    const setOpts = (id, items) => {
        const el  = document.getElementById(id);
        const cur = el.value;
        const lbl = el.options[0].text;
        el.innerHTML = `<option value="">${lbl}</option>` + items.map(v => `<option value="${v}">${v}</option>`).join('');
        el.value = cur;
    };
    setOpts('filter-material', mats);
    setOpts('filter-style',   styles);
    setOpts('filter-brand',   brands);
}

function toggleInStock() {
    inStockFilter = (inStockFilter + 1) % 3; // Cycle through 0, 1, 2
    const btn = document.getElementById('btn-instock');
    if (inStockFilter === 0) {
        btn.textContent = 'All Spools';
        btn.style.borderColor = '';
        btn.style.color = '';
    } else if (inStockFilter === 1) {
        btn.textContent = 'In Stock Only';
        btn.style.borderColor = 'var(--accent)';
        btn.style.color = 'var(--accent)';
    } else if (inStockFilter === 2) {
        btn.textContent = 'Empty Only';
        btn.style.borderColor = 'var(--orange)';
        btn.style.color = 'var(--orange)';
    }
    filterCards();
}

function filterCards() {
    const search = document.getElementById('search-input').value.toLowerCase();
    const mat    = document.getElementById('filter-material').value;
    const style  = document.getElementById('filter-style').value;
    const brand  = document.getElementById('filter-brand').value;
    const sortBy = document.getElementById('filter-sort')?.value || 'default';
    const invSortHex = document.getElementById('inv-sort-colour')?.value || '';
    const invSortRgb = parseHexColour(invSortHex);

    let filtered = filaments.filter(f => {
        const w = parseFloat(f.weight_current) || 0;
        if (inStockFilter === 1 && w === 0) return false; // In Stock Only: hide empty
        if (inStockFilter === 2 && w > 0) return false;  // Empty Only: hide non-empty
        if (mat   && f.material !== mat)   return false;
        if (style && f.style    !== style) return false;
        if (brand && f.brand    !== brand) return false;
        if (search) {
            const hay = `${f.brand} ${f.color_name} ${f.material} ${f.style}`.toLowerCase();
            if (!hay.includes(search)) return false;
        }
        return true;
    });

    // Pre-compute perceptual colour distance once per spool when colour-sorting,
    // instead of recomputing inside every comparator call (O(n) vs O(n log n)).
    const colourSortOn = inventoryColourSortActive && invSortRgb;
    let distMap = null;
    if (colourSortOn) {
        distMap = new Map();
        for (const f of filtered) {
            distMap.set(f, colourDistance(invSortRgb, parseHexColour(f.color_hex || getColourHex(f.color_name))));
        }
    }

    filtered.sort((a, b) => {
        if (colourSortOn) {
            const d = distMap.get(a) - distMap.get(b);
            if (d !== 0) return d;
        }
        if (sortBy === 'full-desc') return (parseFloat(b.weight_current) || 0) - (parseFloat(a.weight_current) || 0);
        if (sortBy === 'full-asc')  return (parseFloat(a.weight_current) || 0) - (parseFloat(b.weight_current) || 0);
        if (sortBy === 'name-asc') {
            const aName = `${a.brand || ''} ${a.color_name || ''}`.trim().toLowerCase();
            const bName = `${b.brand || ''} ${b.color_name || ''}`.trim().toLowerCase();
            return aName.localeCompare(bName);
        }
        return 0;
    });

    const grid  = document.getElementById('filament-grid');
    const noRes = document.getElementById('no-results');
    document.getElementById('filter-count').textContent = `${filtered.length} spool${filtered.length !== 1 ? 's' : ''}`;

    if (!filtered.length) { grid.innerHTML = ''; noRes.classList.remove('hidden'); return; }
    noRes.classList.add('hidden');
    grid.innerHTML = filtered.map((f, i) =>
        `<div class="fade-up" style="animation-delay:${Math.min(i, 24) * 0.025}s">${spoolCardHTML(f)}</div>`
    ).join('');
}

function setInventoryColourSortActive() {
    inventoryColourSortActive = true;
    filterCards();
}

function clearInventoryColourSort() {
    inventoryColourSortActive = false;
    const picker = document.getElementById('inv-sort-colour');
    if (picker) picker.value = '#4f8ef7';
    filterCards();
}

// ============================================================
// SPOOL CARD
// ============================================================
function spoolCardHTML(f) {
    const w      = parseFloat(f.weight_current) || 0;
    const spoolW = parseFloat(f.spool_weight) || 1000;
    const total  = parseFloat(f.total_purchased) || 0;
    const pct    = Math.min(100, Math.round((w / spoolW) * 100));
    const isLow  = w > 0 && w < 150;
    const isEmpty= w === 0;
    const ms     = matStyle(f.material);
    const hex    = f.color_hex || getColourHex(f.color_name);
    const colourImage = f.color_image || '';
    const buyLink= getBuyLink(f);
    const isAuto = !f.web_address;
    const cpg    = costPerGram(f);
    const costUsed = (cpg != null && cpg > 0 && w < spoolW) ? cpg * (spoolW - w) : null;

    return `<div class="spool-card p-5 ${isLow ? 'low-stock' : ''} ${isEmpty ? 'empty' : ''}"
        style="--card-accent:${hex};cursor:pointer"
        data-id="${f.id}"
        data-brand="${esc(f.brand)}"
        data-material="${esc(f.material)}"
        data-color-name="${esc(f.color_name)}"
        data-style="${esc(f.style)}"
        data-code="${esc(f.code)}"
        data-web-address="${esc(f.web_address)}"
        data-weight-current="${w}"
        data-total-purchased="${total}"
        data-hex="${hex}"
        data-color-image="${esc(colourImage)}"
        data-ams="${f.ams_compatible !== 0 ? '1' : '0'}"
        data-notes="${esc(f.notes || '')}"
        data-price="${f.price_paid ?? ''}"
        data-price-is-free="${f.price_is_free ? '1' : '0'}"
        data-spool-weight="${parseFloat(f.spool_weight) || 1000}"
        onclick="onCardClick(event, this)"
    >
        <label class="card-check-wrap" onclick="event.stopPropagation()">
            <input type="checkbox" class="row-check card-check" data-id="${f.id}" onchange="onCardCheckChange(this)">
        </label>
        <div class="flex justify-between items-start mb-3">
            <div style="flex:1;min-width:0">
                <span class="badge mb-2" style="background:${ms.bg};color:${ms.text}">${esc(f.material || '?')}</span>
                <h3 class="font-black text-lg leading-tight" style="color:var(--text)">${esc(f.color_name || 'Unknown')}${f.style ? ' · ' + esc(f.style) : ''}</h3>
                <p class="text-sm font-medium mt-0.5 truncate" style="color:var(--text2)">${esc(f.brand || '—')}</p>
                ${f.notes ? `<p class="text-xs mt-1 truncate" style="color:var(--muted)" title="${esc(f.notes)}">📝 ${esc(f.notes)}</p>` : ''}
            </div>
            <div class="flex flex-col items-end gap-2 ml-3">
                ${colourImage
                    ? `<img src="${colourImage}" alt="${esc(f.color_name || 'Colour')}" class="color-chip" style="width:64px;height:64px;border-radius:14px;object-fit:cover;border:2px solid rgba(128,128,128,0.3)">`
                    : `<span class="color-chip" style="width:52px;height:52px;border-radius:12px;background:${hex};border:2px solid rgba(128,128,128,0.3)"></span>`}
                ${f.id ? `<span class="text-[10px] mono" style="color:var(--muted)">#${f.id}</span>` : ''}
            </div>
        </div>
        <div class="border-t pt-3 mt-1" style="border-color:var(--border)">
            <div class="flex justify-between items-end mb-2">
                <div>
                    <p class="text-[10px] mono uppercase tracking-widest" style="color:var(--muted)">In Stock</p>
                    <p class="text-2xl font-black mono" style="color:var(--text)">${Math.round(w)}<span class="text-sm font-normal ml-1" style="color:var(--muted)">g</span></p>
                    ${f.price_is_free ? `<p class="text-[10px] mono mt-0.5" style="color:var(--green)">FREE · ${spoolW}g spool</p>` : f.price_paid != null ? `<p class="text-[10px] mono mt-0.5" style="color:var(--muted)">Paid: ${formatGBP(f.price_paid)}${cpg ? ` · ${formatGBP(cpg)}/g` : ''}${spoolW !== 1000 ? ` · ${spoolW}g spool` : ''}</p>` : (spoolW !== 1000 ? `<p class="text-[10px] mono mt-0.5" style="color:var(--muted)">${spoolW}g spool</p>` : '')}
                </div>
                <div class="text-right">
                    ${isEmpty ? `<span class="text-xs mono font-bold" style="color:var(--red)">EMPTY</span>` :
                      isLow  ? `<span class="text-xs mono font-bold" style="color:var(--orange)">LOW STOCK</span>` :
                               `<span class="text-xs mono font-bold" style="color:var(--green)">OK</span>`}
                    ${total > 0 ? `<p class="text-[10px] mono mt-0.5" style="color:var(--muted)">×${total} bought</p>` : ''}
                    ${costUsed ? `<p class="text-[10px] mono mt-0.5" style="color:var(--orange)">${formatGBP(costUsed)} used</p>` : ''}
                </div>
            </div>
            <div class="progress-bg mb-3">
                <div class="progress-fill" style="width:${pct}%;background:${isEmpty ? 'var(--red)' : isLow ? 'var(--orange)' : 'var(--green)'}"></div>
            </div>
            <div class="card-actions justify-between">
                <div class="flex items-center gap-2">
                    ${buyLink ? `<a href="${buyLink}" target="_blank" onclick="event.stopPropagation()"
                        class="text-xs mono hover:underline flex items-center gap-1" style="color:var(--accent)">
                        ↗ ${(f.brand||'').toLowerCase().includes('bambu') ? 'Bambu Store' : 'Amazon UK'}
                        ${isAuto ? '<span style="color:var(--muted);font-size:9px">AUTO</span>' : ''}
                    </a>` : ''}
                </div>
                <div class="flex items-center gap-2">
                    ${f.ams_compatible === 0
                        ? `<span class="text-[9px] mono font-bold px-1.5 py-0.5 rounded" style="background:rgba(239,68,68,0.12);color:var(--red)">NO AMS</span>`
                        : `<span class="text-[9px] mono font-bold px-1.5 py-0.5 rounded" style="background:rgba(34,197,94,0.1);color:var(--green)">AMS ✓</span>`}
                    <button onclick="event.stopPropagation();openRefillModal(${f.id},'${esc2(f.brand)} ${esc2(f.color_name)}',${w},${spoolW})"
                            class="btn-ghost py-1.5 px-2 text-xs" style="color:var(--green)">＋ Refill</button>
                    <button onclick="event.stopPropagation();openEditModal(${f.id})" class="btn-ghost py-1.5 px-2 text-xs">✏️ Edit</button>
                    <button onclick="event.stopPropagation();openUsageModal(${f.id},'${esc2(f.brand)} ${esc2(f.color_name)}',${w})"
                            class="btn-ghost py-1.5 px-2 text-xs" ${isEmpty ? 'disabled style="opacity:0.4;cursor:not-allowed"' : ''}>
                        − Use
                    </button>
                </div>
            </div>
        </div>
    </div>`;
}

// Compact one-line card for the dashboard Low Stock list — shows just the
// colour, name and remaining grams. Click opens the full sidebar.
function lowStockMiniHTML(f) {
    const w       = parseFloat(f.weight_current) || 0;
    const spoolW  = parseFloat(f.spool_weight) || 1000;
    const total   = parseFloat(f.total_purchased) || 0;
    const pct     = Math.min(100, Math.round((w / spoolW) * 100));
    const isEmpty = w === 0;
    const hex     = f.color_hex || getColourHex(f.color_name);
    const colourImage = f.color_image || '';

    return `<div class="low-stock-mini ${isEmpty ? 'empty' : ''}"
        data-id="${f.id}"
        data-brand="${esc(f.brand)}"
        data-material="${esc(f.material)}"
        data-color-name="${esc(f.color_name)}"
        data-style="${esc(f.style)}"
        data-code="${esc(f.code)}"
        data-web-address="${esc(f.web_address)}"
        data-weight-current="${w}"
        data-total-purchased="${total}"
        data-hex="${hex}"
        data-color-image="${esc(colourImage)}"
        data-ams="${f.ams_compatible !== 0 ? '1' : '0'}"
        data-notes="${esc(f.notes || '')}"
        data-price="${f.price_paid ?? ''}"
        data-price-is-free="${f.price_is_free ? '1' : '0'}"
        data-spool-weight="${spoolW}"
        onclick="openSidebar(this)"
        title="${esc(f.brand || '')} ${esc(f.color_name || '')} — click for details">
        ${colourImage
            ? `<img src="${colourImage}" alt="" class="color-chip" style="width:34px;height:34px;border-radius:9px;object-fit:cover">`
            : `<span class="color-chip" style="width:34px;height:34px;border-radius:9px;background:${hex}"></span>`}
        <div style="flex:1;min-width:0">
            <p class="text-sm font-bold truncate" style="color:var(--text)">${esc(f.color_name || 'Unknown')}${f.style ? ' · ' + esc(f.style) : ''}</p>
            <p class="text-[11px] truncate" style="color:var(--muted)">${esc(f.brand || '—')} · ${esc(f.material || '?')}</p>
            <div class="progress-bg mt-1.5" style="height:4px"><div class="progress-fill" style="height:4px;width:${pct}%;background:${isEmpty ? 'var(--red)' : 'var(--orange)'}"></div></div>
        </div>
        <div class="text-right flex-shrink-0">
            <p class="text-base font-black mono" style="color:${isEmpty ? 'var(--red)' : 'var(--orange)'}">${Math.round(w)}<span class="text-[10px] font-normal" style="color:var(--muted)">g</span></p>
            <button onclick="event.stopPropagation();openRefillModal(${f.id},'${esc2(f.brand)} ${esc2(f.color_name)}',${w},${spoolW})"
                    class="btn-ghost text-[10px] py-1 px-2 mt-1" style="color:var(--green)">＋ Refill</button>
        </div>
    </div>`;
}

function esc(s)  {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
function esc2(s) {
    return String(s ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\r?\n/g, ' ');
}

// ============================================================
// REORDER
// ============================================================
function renderReorder() {
    let needReorder = filaments
        .filter(f => (parseFloat(f.weight_current) || 0) < 150)
        .filter(f => reorderShowHidden ? true : f.hide_from_reorder !== 1)
        .sort((a, b) => (parseFloat(a.weight_current) || 0) - (parseFloat(b.weight_current) || 0));
    needReorder = applyTableSort(needReorder, 'reorder', {
        spool: f => `${f.brand || ''} ${f.color_name || ''} ${f.style || ''}`,
        material: f => f.material || '',
        left: f => parseFloat(f.weight_current) || 0,
        price: f => parseFloat(f.price_paid) || 0,
        store: f => (f.brand || '').toLowerCase().includes('bambu') ? 'Bambu Store' : 'Amazon UK',
        status: f => f.hide_from_reorder === 1,
    });

    const body = document.getElementById('reorder-body');
    const hiddenBtn = document.getElementById('reorder-hidden-toggle');
    if (hiddenBtn) hiddenBtn.textContent = reorderShowHidden ? 'Hide Hidden' : 'Show Hidden';
    if (!needReorder.length) {
        body.innerHTML = '<tr><td colspan="8" class="text-center py-12" style="color:var(--muted)">🎉 All spools well stocked!</td></tr>';
        updateTableSortHeaders();
        return;
    }
    body.innerHTML = needReorder.map(f => {
        const w       = parseFloat(f.weight_current) || 0;
        const isEmpty = w === 0;
        const buyLink = getBuyLink(f);
        const store   = (f.brand||'').toLowerCase().includes('bambu') ? 'Bambu Store' : 'Amazon UK';
        return `<tr data-id="${f.id}">
            <td style="width:36px"><input type="checkbox" class="row-check reorder-check" data-id="${f.id}" onchange="reorderCheckChange()"></td>
            <td>
                <div class="flex items-center gap-3">
                    <span style="width:20px;height:20px;border-radius:6px;background:${f.color_hex || getColourHex(f.color_name)};border:2px solid rgba(128,128,128,0.3);flex-shrink:0;display:inline-block"></span>
                    <div>
                        <div class="font-bold text-sm" style="color:var(--text)">${esc(f.brand || '—')}</div>
                        <div class="text-xs" style="color:var(--text2)">${esc(f.color_name || '—')}${f.style ? ' · '+esc(f.style) : ''}</div>
                    </div>
                </div>
            </td>
            <td><span class="badge" style="background:${matStyle(f.material).bg};color:${matStyle(f.material).text}">${esc(f.material || '?')}</span></td>
            <td><span class="mono font-bold text-sm" style="color:${isEmpty ? 'var(--red)' : 'var(--orange)'}">${Math.round(w)}g</span></td>
            <td><span class="text-xs mono" style="color:var(--text2)">${f.price_paid ? formatGBP(f.price_paid) : '—'}</span></td>
            <td><span class="text-xs" style="color:var(--text2)">${esc(store)}</span></td>
            <td>${f.hide_from_reorder === 1 ? '<span class="text-xs mono font-bold" style="color:var(--muted)">HIDDEN</span>' : '<span class="text-xs mono font-bold" style="color:var(--orange)">ACTIVE</span>'}</td>
            <td>
                <div class="flex gap-2">
                    <button onclick="setReorderHidden(${f.id}, ${f.hide_from_reorder === 1 ? 'false' : 'true'})" class="btn-ghost text-xs py-1 px-2">${f.hide_from_reorder === 1 ? '👁 Unhide' : '🙈 Hide'}</button>
                    <a href="${buyLink}" target="_blank" class="btn-primary text-xs" style="padding:6px 12px;text-decoration:none">↗ Buy Now</a>
                </div>
            </td>
        </tr>`;
    }).join('');
    updateTableSortHeaders();
}

function toggleReorderHidden() {
    reorderShowHidden = !reorderShowHidden;
    renderReorder();
}

function copyReorderList() {
    const needReorder = filaments.filter(f => (parseFloat(f.weight_current) || 0) < 150 && f.hide_from_reorder !== 1);
    if (!needReorder.length) { showToast('Nothing to reorder!', 'info'); return; }
    const text = ['=== SpoolStats Reorder List ===', '']
        .concat(needReorder.map(f => `• ${f.brand} ${f.color_name} ${f.material}${f.style ? ' '+f.style : ''} (${Math.round(parseFloat(f.weight_current)||0)}g left)${f.price_paid ? ' — Last paid: '+formatGBP(f.price_paid) : ''}\n  ${getBuyLink(f)}`))
        .join('\n');
    navigator.clipboard.writeText(text).then(() => showToast('Shopping list copied!', 'success'));
}

// ============================================================
// USAGE LOG
// ============================================================
async function loadUsage() {
    try {
        [usageLog, purchaseHistory] = await Promise.all([
            apiFetch('/api/usage'),
            apiFetch('/api/purchases/by-filament'),
        ]);
        updateStats();
        populateUsageFilters();
        renderUsageLog();
        renderCharts();
    } catch {
        showToast('Could not load usage log.', 'error');
    }
}

function populateUsageFilters() {
    const sel = document.getElementById('usage-filter-filament');
    const cur = sel.value;
    const labels = [...new Map(usageLog.filter(u => u.filament_id).map(u => [u.filament_id, u.filament_label || `Spool #${u.filament_id}`])).entries()];
    labels.sort((a,b) => (a[1]||'').localeCompare(b[1]||''));
    sel.innerHTML = '<option value="">All Filaments</option>' + labels.map(([id, lbl]) => `<option value="${id}" ${id==cur?'selected':''}>${lbl}</option>`).join('');
}

function clearUsageFilters() {
    document.getElementById('usage-search').value = '';
    document.getElementById('usage-date-from').value = '';
    document.getElementById('usage-date-to').value = '';
    document.getElementById('usage-filter-filament').value = '';
    document.getElementById('usage-sort').value = 'date-desc';
    document.getElementById('usage-filter-scope') && (document.getElementById('usage-filter-scope').value = 'all');
    renderUsageLog();
}

function renderUsageLog() {
    const search   = (document.getElementById('usage-search')?.value || '').toLowerCase();
    const dateFrom = document.getElementById('usage-date-from')?.value;
    const dateTo   = document.getElementById('usage-date-to')?.value;
    const filament = document.getElementById('usage-filter-filament')?.value;
    const sort     = document.getElementById('usage-sort')?.value || 'date-desc';
    const scope    = document.getElementById('usage-filter-scope')?.value || 'all'; // all | projects | prints | prints_all

    const getPrintId = (u) => u.print_id != null ? u.print_id : u.id;

    // Build print aggregates first.
    const byPrint = new Map();
    usageLog.forEach(u => {
        const pid = getPrintId(u);
        if (pid == null) return;

        let g = byPrint.get(pid);
        if (!g) {
            g = {
                print_id: pid,
                created_at: u.print_created_at || u.created_at,
                print_name: u.print_project_name || u.project_name || 'Manual',
                project_group_id: u.project_group_id || null,
                project_group_name: u.project_group_name || null,
                total_g: 0,
                total_cost: 0,
                filament_ids: new Set(),
                filament_labels: new Set(),
            };
            byPrint.set(pid, g);
        }

        // Update project group fields if this entry has them and the group doesn't yet
        if (!g.project_group_id && u.project_group_id) {
            g.project_group_id = u.project_group_id;
            g.project_group_name = u.project_group_name || null;
        }
        // Update print_name if we got a more specific one from the print record
        if (!g.print_name_from_print && u.print_project_name) {
            g.print_name = u.print_project_name;
            g.print_name_from_print = true;
        }

        g.total_g += parseFloat(u.weight_used) || 0;
        if (u.filament_id != null) g.filament_ids.add(String(u.filament_id));
        g.filament_labels.add(u.filament_label || `Spool #${u.filament_id}`);

        const f = filaments.find(x => x.id == u.filament_id);
        const cpg = f ? costPerGram(f) : null;
        if (cpg) g.total_cost += cpg * (parseFloat(u.weight_used) || 0);
    });

    let prints = [...byPrint.values()].map(p => {
        const labels = [...p.filament_labels].filter(Boolean);
        labels.sort((a, b) => (a || '').localeCompare(b || '', undefined, { numeric: true, sensitivity: 'base' }));
        p.filament_labels = labels;
        p.filament_sort_key = labels[0] || '';
        return p;
    });

    // Apply filters at the print level (projects are derived after).
    prints = prints.filter(p => {
        if (filament && !p.filament_ids.has(String(filament))) return false;
        if (dateFrom && p.created_at && p.created_at.slice(0, 10) < dateFrom) return false;
        if (dateTo && p.created_at && p.created_at.slice(0, 10) > dateTo) return false;
        if (search) {
            const hay = `${p.print_name || ''} ${p.project_group_name || ''} ${p.filament_labels.join(' ')}`.toLowerCase();
            if (!hay.includes(search)) return false;
        }
        return true;
    });

    // Derive project aggregates from filtered prints.
    const projectsById = new Map();
    prints.forEach(p => {
        if (!p.project_group_id) return;
        const id = String(p.project_group_id);
        let pr = projectsById.get(id);
        if (!pr) {
            pr = {
                project_id: p.project_group_id,
                project_name: p.project_group_name || p.project_group_id,
                created_at: p.created_at || '',
                print_count: 0,
                total_g: 0,
                total_cost: 0,
                filament_labels: new Set(),
                filament_sort_key: '',
            };
            projectsById.set(id, pr);
        }
        pr.print_count += 1;
        pr.total_g += parseFloat(p.total_g) || 0;
        pr.total_cost += parseFloat(p.total_cost) || 0;
        if ((p.created_at || '') > (pr.created_at || '')) pr.created_at = p.created_at;
        p.filament_labels.forEach(l => pr.filament_labels.add(l));
    });

    let projectRows = [...projectsById.values()].map(pr => {
        const labels = [...pr.filament_labels].filter(Boolean);
        labels.sort((a, b) => (a || '').localeCompare(b || '', undefined, { numeric: true, sensitivity: 'base' }));
        pr.filament_labels = labels;
        pr.filament_sort_key = labels[0] || '';
        return pr;
    });

    const makeFilamentSummary = (labels) => {
        const cnt = (labels || []).length;
        if (!cnt) return '—';
        if (cnt === 1) return labels[0];
        return `${cnt} filaments`;
    };

    const rowsFromPrint = (p) => ({
        type: 'print',
        created_at: p.created_at || '',
        project_name: p.print_name || '—',
        filament_sort_key: p.filament_sort_key || '',
        total_g: parseFloat(p.total_g) || 0,
        total_cost: p.total_cost != null ? parseFloat(p.total_cost) || 0 : null,
        filament_summary: makeFilamentSummary(p.filament_labels),
        print_id: p.print_id,
        project_group_id: p.project_group_id || null,
    });

    const rowsFromProject = (pr) => ({
        type: 'project',
        created_at: pr.created_at || '',
        project_name: pr.project_name || '—',
        filament_sort_key: pr.filament_sort_key || '',
        total_g: parseFloat(pr.total_g) || 0,
        total_cost: pr.total_cost != null ? parseFloat(pr.total_cost) || 0 : null,
        filament_summary: pr.print_count ? `${pr.print_count} prints · ${makeFilamentSummary(pr.filament_labels)}` : makeFilamentSummary(pr.filament_labels),
        project_id: pr.project_id,
    });

    let rows = [];
    const standalonePrints = prints.filter(p => !p.project_group_id);

    if (scope === 'projects') {
        rows = projectRows.map(rowsFromProject);
    } else if (scope === 'prints') {
        rows = standalonePrints.map(rowsFromPrint);
    } else if (scope === 'prints_all') {
        rows = prints.map(rowsFromPrint);
    } else {
        // all: show projects + standalone prints (prints inside projects are hidden here)
        rows = projectRows.map(rowsFromProject).concat(standalonePrints.map(rowsFromPrint));
    }

    // Sort from dropdown.
    rows = [...rows].sort((a, b) => {
        if (sort === 'date-asc')   return (a.created_at || '').localeCompare(b.created_at || '');
        if (sort === 'date-desc')  return (b.created_at || '').localeCompare(a.created_at || '');
        if (sort === 'grams-desc') return (parseFloat(b.total_g) || 0) - (parseFloat(a.total_g) || 0);
        if (sort === 'grams-asc')  return (parseFloat(a.total_g) || 0) - (parseFloat(b.total_g) || 0);
        if (sort === 'project')    return (a.project_name || '').localeCompare(b.project_name || '');
        if (sort === 'filament')   return (a.filament_sort_key || '').localeCompare(b.filament_sort_key || '');
        return 0;
    });

    // Header sort (clickable table columns).
    rows = applyTableSort(rows, 'usage', {
        date: r => r.created_at || '',
        project: r => r.project_name || '',
        filament: r => r.filament_sort_key || '',
        used: r => parseFloat(r.total_g) || 0,
        cost: r => r.total_cost != null ? r.total_cost : null,
    });

    const totalG = rows.reduce((s, r) => s + (parseFloat(r.total_g) || 0), 0);
    const totalCost = rows.reduce((s, r) => s + (parseFloat(r.total_cost) || 0), 0);

    const countEl = document.getElementById('usage-filter-count');
    if (countEl) countEl.textContent = `${rows.length} record${rows.length !== 1 ? 's' : ''} · ${totalG.toFixed(1)}g total${totalCost > 0 ? ' · ' + formatGBP(totalCost) + ' est. cost' : ''}`;

    const body = document.getElementById('usage-list');
    if (!rows.length) {
        body.innerHTML = '<tr><td colspan="7" class="text-center py-12" style="color:var(--muted)">' + (usageLog.length ? 'No records match filters.' : 'No usage records yet.') + '</td></tr>';
        updateTableSortHeaders();
        return;
    }

    body.innerHTML = rows.map(r => {
        const dateStr = r.created_at ? new Date(r.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
        if (r.type === 'project') {
            return `<tr data-type="project" data-project-id="${r.project_id}" data-weight="${r.total_g}">
                <td style="width:36px"><input type="checkbox" class="row-check usage-check" data-type="project" data-project-id="${r.project_id}" data-weight="${r.total_g}" onchange="usageCheckChange()"></td>
                <td class="mono text-xs" style="color:var(--text2)">${dateStr}</td>
                <td class="font-medium" style="color:var(--text)">${esc(r.project_name || '—')}</td>
                <td style="color:var(--text2)">${esc(r.filament_summary || '—')}</td>
                <td class="mono font-bold" style="color:var(--orange)">${(parseFloat(r.total_g) || 0).toFixed(1)}g</td>
                <td class="mono text-xs" style="color:var(--muted)">${r.total_cost ? formatGBP(r.total_cost) : '—'}</td>
                <td>
                    <button onclick="openProjectSidebar(${r.project_id})" class="btn-ghost py-1 px-2 text-xs">🔎</button>
                </td>
            </tr>`;
        }

        return `<tr data-type="print" data-print-id="${r.print_id}" data-weight="${r.total_g}">
            <td style="width:36px"><input type="checkbox" class="row-check usage-check" data-type="print" data-print-id="${r.print_id}" data-weight="${r.total_g}" onchange="usageCheckChange()"></td>
            <td class="mono text-xs" style="color:var(--text2)">${dateStr}</td>
            <td class="font-medium" style="color:var(--text)">${esc(r.project_name || '—')}</td>
            <td style="color:var(--text2)">${esc(r.filament_summary || '—')}</td>
            <td class="mono font-bold" style="color:var(--orange)">${(parseFloat(r.total_g) || 0).toFixed(1)}g</td>
            <td class="mono text-xs" style="color:var(--muted)">${r.total_cost ? formatGBP(r.total_cost) : '—'}</td>
            <td>
                <button onclick="openPrintSidebar(${r.print_id})" class="btn-ghost py-1 px-2 text-xs">🔎</button>
            </td>
        </tr>`;
    }).join('');

    updateTableSortHeaders();
}

// ============================================================
// CHARTS
// ============================================================
function renderCharts() {
    if (!usageLog.length) return;
    document.getElementById('charts-section').classList.remove('hidden');
    renderUsageTimeChart();
    renderTopFilamentsChart();
}

function renderUsageTimeChart() {
    const weeks = {};
    usageLog.forEach(u => {
        const rawDate = u.print_created_at || u.created_at;
        if (!rawDate) return;
        const d = new Date(rawDate.length === 10 ? rawDate + 'T00:00:00' : rawDate);
        if (isNaN(d.getTime())) return;

        const day = d.getDay() || 7;
        d.setDate(d.getDate() - day + 1);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        weeks[key] = (weeks[key] || 0) + (parseFloat(u.weight_used) || 0);
    });

    const sorted  = Object.entries(weeks).sort((a,b) => a[0].localeCompare(b[0])).slice(-12);
    if (!sorted.length) return;
    const max = Math.max(...sorted.map(e => e[1])) || 1;
    const colours = ['#4f8ef7','#22c55e','#f59e0b','#a855f7'];

    document.getElementById('usage-time-chart').innerHTML = sorted.map(([week, grams], i) => {
        const h = Math.max(4, Math.round((grams / max) * 100));
        const [y, m, day] = week.split('-').map(Number);
        const d = new Date(y, m - 1, day);
        const dateStr = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        return `<div class="flex flex-col justify-end items-center flex-1 gap-1 h-full" title="Week Commencing ${dateStr}: ${grams.toFixed(1)}g">
            <span class="text-[9px] mono" style="color:var(--text2)">${grams.toFixed(0)}</span>
            <div style="height:${h}%;background:${colours[i%colours.length]};border-radius:4px 4px 0 0;width:100%;opacity:0.85;transition:opacity 0.2s" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.85"></div>
        </div>`;
    }).join('');

    document.getElementById('usage-time-labels').innerHTML = sorted.map(([week]) => {
        const [y, m, day] = week.split('-').map(Number);
        const d = new Date(y, m - 1, day);
        const label = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        return `<div class="flex-1 text-center" style="font-size:8px;color:var(--muted);line-height:1.1">w/c<br>${label}</div>`;
    }).join('');
}

function renderUsageGraphTab() {
    const interval = document.getElementById('graph-interval')?.value || 'week';
    const dateFrom = document.getElementById('graph-date-from')?.value;
    const dateTo   = document.getElementById('graph-date-to')?.value;

    const data = {};
    usageLog.forEach(u => {
        const rawDate = u.print_created_at || u.created_at;
        if (!rawDate) return;
        const d = new Date(rawDate.length === 10 ? rawDate + 'T00:00:00' : rawDate);
        if (isNaN(d.getTime())) return;

        const ds = rawDate.slice(0, 10);
        if (dateFrom && ds < dateFrom) return;
        if (dateTo && ds > dateTo) return;

        let key;
        if (interval === 'day') {
            key = ds;
        } else if (interval === 'month') {
            key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        } else {
            const day = d.getDay() || 7;
            d.setDate(d.getDate() - day + 1);
            key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        }
        data[key] = (data[key] || 0) + (parseFloat(u.weight_used) || 0);
    });

    const sorted = Object.entries(data).sort((a, b) => a[0].localeCompare(b[0]));
    const mainChart = document.getElementById('usage-graph-main');
    const labelsEl = document.getElementById('usage-graph-labels');
    
    if (!sorted.length) {
        mainChart.innerHTML = '<div class="flex-1 flex items-center justify-center text-sm" style="color:var(--muted)">No data for selected range</div>';
        labelsEl.innerHTML = '';
        return;
    }

    const max = Math.max(...sorted.map(e => e[1])) || 1;
    const colours = ['#4f8ef7', '#22c55e', '#f59e0b', '#a855f7'];

    mainChart.innerHTML = sorted.map(([key, grams], i) => {
        const h = Math.max(2, Math.round((grams / max) * 100));
        const title = interval === 'week' ? `Week Commencing ${key}` : key;
        return `<div class="flex flex-col justify-end items-center flex-1 gap-1 h-full" title="${title}: ${grams.toFixed(1)}g">
            <span class="text-[10px] mono font-bold" style="color:var(--text2); margin-bottom:4px">${grams >= 1 ? grams.toFixed(0) : ''}</span>
            <div style="height:${h}%;background:${colours[i % colours.length]};border-radius:6px 6px 0 0;width:100%;opacity:0.85;transition:all 0.2s" onmouseover="this.style.opacity=1;this.style.transform='scaleX(1.05)'" onmouseout="this.style.opacity=0.85;this.style.transform='scaleX(1)'"></div>
        </div>`;
    }).join('');

    labelsEl.innerHTML = sorted.map(([key]) => {
        let label = '';
        const parts = key.split('-').map(Number);
        if (interval === 'day') {
            label = new Date(parts[0], parts[1]-1, parts[2]).toLocaleDateString('en-GB', { day:'numeric', month:'short' });
        } else if (interval === 'month') {
            label = new Date(parts[0], parts[1]-1, 1).toLocaleDateString('en-GB', { month:'short', year:'2-digit' });
        } else {
            label = new Date(parts[0], parts[1]-1, parts[2]).toLocaleDateString('en-GB', { day:'numeric', month:'short' });
        }
        const sub = interval === 'week' ? '<div style="font-size:7px;opacity:0.5">w/c</div>' : '';
        return `<div class="flex-1 text-center" style="font-size:9px;color:var(--muted);white-space:nowrap;line-height:1">${sub}${label}</div>`;
    }).join('');
}

function resetGraphFilters() {
    document.getElementById('graph-date-from').value = '';
    document.getElementById('graph-date-to').value = '';
    document.getElementById('graph-interval').value = 'week';
    renderUsageGraphTab();
}

function renderTopFilamentsChart() {
    const byFilament = {};
    usageLog.forEach(u => {
        const key = u.filament_label || `Spool #${u.filament_id}`;
        byFilament[key] = (byFilament[key] || 0) + (parseFloat(u.weight_used) || 0);
    });
    const sorted  = Object.entries(byFilament).sort((a,b) => b[1]-a[1]).slice(0,8);
    if (!sorted.length) return;
    const max     = sorted[0][1];
    const colours = ['#4f8ef7','#22c55e','#f59e0b','#a855f7','#ec4899','#14b8a6','#ef4444','#f97316'];

    document.getElementById('top-filaments-chart').innerHTML = sorted.map(([label, grams], i) => `
        <div>
            <div class="flex justify-between items-center mb-1">
                <span class="text-xs truncate" style="color:var(--text2);max-width:70%">${esc(label)}</span>
                <span class="text-xs mono font-bold" style="color:${colours[i]}">${grams.toFixed(1)}g</span>
            </div>
            <div class="progress-bg">
                <div class="progress-fill" style="width:${Math.round((grams/max)*100)}%;background:${colours[i]}"></div>
            </div>
        </div>`).join('');
}

// ============================================================
// EXCEL IMPORT
// ============================================================
document.getElementById('excel-upload').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    showToast('Reading Excel file…', 'info');
    try {
        const data   = await file.arrayBuffer();
        const wb     = XLSX.read(data);
        const sheet  = wb.Sheets[wb.SheetNames[0]];
        const rowsR0 = XLSX.utils.sheet_to_json(sheet, { defval: null, range: 0 });
        const rowsR1 = XLSX.utils.sheet_to_json(sheet, { defval: null, range: 1 });
        const ownExportHeaders = ['Colour Hex', 'Buy URL', 'Weight (g)', 'AMS Compatible'];
        const headersR0  = rowsR0.length > 0 ? Object.keys(rowsR0[0]) : [];
        const isOwnExport = ownExportHeaders.some(h => headersR0.includes(h));
        const rows   = isOwnExport ? rowsR0 : rowsR1;

        const items = rows.filter(r => r['Brand'] || r['brand']).map(r => {
            if (isOwnExport) {
                const colorName = r['Colour'] || r['color_name'] || '';
                const hexVal    = r['Colour Hex'] || r['color_hex'] || getColourHex(colorName);
                const amsVal    = r['AMS Compatible'];
                return {
                    brand: r['Brand'], material: r['Material'], color_name: colorName,
                    style: r['Style'] || '', code: String(r['Code'] || ''), barcode: String(r['Barcode'] || ''),
                    web_address: r['Buy URL'] || null,
                    color_image: r['Colour Image'] || r['color_image'] || null,
                    total_purchased: parseFloat(r['Total Purchased']) || 0,
                    weight_current: parseFloat(r['Weight (g)']) || 0,
                    color_hex: hexVal,
                    ams_compatible: amsVal === undefined || amsVal === null ? true : (amsVal === true || amsVal === 1 || String(amsVal).toLowerCase() === 'yes' || String(amsVal) === '1'),
                    notes: (r['Notes'] && String(r['Notes']).trim() !== '' && r['Notes'] !== 'NaN') ? r['Notes'] : null,
                    price_paid: parseFloat(r['Price Paid']) || null,
                };
            } else {
                const colorName = r['Colour'] || '';
                const amsVal    = r['AMS Compatible'];
                return {
                    brand: r['Brand'], material: r['Material'], color_name: colorName,
                    style: r['Style'] || '', code: String(r['Code'] || ''), barcode: String(r['Barcode'] || ''),
                    web_address: r['Web Address'] || null,
                    color_image: r['Colour Image'] || r['color_image'] || null,
                    total_purchased: parseFloat(r['Total Purchased']) || 0,
                    weight_current: parseFloat(r['Filament Left']) || 0,
                    color_hex: getColourHex(colorName),
                    ams_compatible: amsVal === undefined || amsVal === null ? true : (amsVal === true || amsVal === 1 || String(amsVal).toLowerCase() === 'yes' || String(amsVal) === '1'),
                    notes: (r['Notes'] && String(r['Notes']).trim() !== '' && r['Notes'] !== 'NaN') ? r['Notes'] : null,
                    price_paid: parseFloat(r['Price Paid']) || null,
                };
            }
        });

        if (!items.length) { showToast('No valid rows found.', 'error'); return; }
        await apiFetch('/api/filaments', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'bulk_import', items })
        });
        showToast(`✓ Imported ${items.length} filaments`, 'success');
        await loadAll();
    } catch (err) {
        showToast('Import failed: ' + err.message, 'error');
    }
    e.target.value = '';
});

// ============================================================
// EXCEL EXPORT
// ============================================================
function exportToExcel(mode = 'full') {
    try {
        const wb = XLSX.utils.book_new();
        if (mode !== 'usage') {
            const invData = [['Brand','Material','Colour','Style','Weight (g)','Total Purchased','Buy URL','Colour Hex','AMS Compatible','Notes','Price Paid','Colour Image','ID']]
                .concat(filaments.map(f => [f.brand, f.material, f.color_name, f.style, parseFloat(f.weight_current)||0, f.total_purchased||'', getBuyLink(f), f.color_hex||getColourHex(f.color_name), f.ams_compatible === 0 ? 'No' : 'Yes', f.notes||'', f.price_paid||'', f.color_image||'', f.id]));
            const invSheet = XLSX.utils.aoa_to_sheet(invData);
            invSheet['!cols'] = [20,10,18,12,14,16,50,14,14,30,10,30,8].map(w => ({wch:w}));
            XLSX.utils.book_append_sheet(wb, invSheet, 'Inventory');
        }
        if (usageLog.length > 0 || mode === 'usage') {
            const usageData = [['Date','Project','Filament','Grams Used','Est. Cost']]
                .concat(usageLog.map(u => {
                    const f   = filaments.find(x => x.id == u.filament_id);
                    const cpg = f ? costPerGram(f) : null;
                    const pc  = cpg ? (cpg * (parseFloat(u.weight_used)||0)).toFixed(2) : '';
                    return [u.created_at ? new Date(u.created_at).toLocaleDateString('en-GB') : '', u.project_name||'', u.filament_label||`Spool #${u.filament_id}`, u.weight_used, pc];
                }));
            const usageSheet = XLSX.utils.aoa_to_sheet(usageData);
            usageSheet['!cols'] = [14,24,30,12,10].map(w => ({wch:w}));
            XLSX.utils.book_append_sheet(wb, usageSheet, 'Usage Log');
        }
        const filename = `SpoolStats_Export_${new Date().toISOString().slice(0,10)}.xlsx`;
        XLSX.writeFile(wb, filename);
        showToast('✓ Exported to ' + filename, 'success');
    } catch (err) {
        showToast('Export failed: ' + err.message, 'error');
    }
}

// ============================================================
// 3MF PARSE
// ============================================================
document.getElementById('threemf-upload').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    showToast('Parsing 3MF…', 'info');
    try {
        const zip      = await JSZip.loadAsync(file);
        const allFiles = Object.keys(zip.files);
        const projectName = file.name.replace(/\.3mf$/i, '');
        let filamentGrams = 0;
        let perSlot = [];

        const projCfgPath = allFiles.find(n => n.toLowerCase().includes('project_settings'));
        if (projCfgPath) {
            try {
                const cfg     = JSON.parse(await zip.files[projCfgPath].async('string'));
                const colours = cfg.filament_colour || [];
                const types   = cfg.filament_type   || [];
                if (colours.length && !perSlot.length) {
                    perSlot = colours.map((colour, i) => ({ grams:0, colour, material: types[i]||'PLA' }));
                }
            } catch(err) { /* ignore */ }
        }

        const sliceInfoPath = allFiles.find(n => n.toLowerCase().includes('slice_info'));
        if (sliceInfoPath) {
            const txt = await zip.files[sliceInfoPath].async('string');
            const filamentTags = [...txt.matchAll(/<filament\s([^>]+)\/>/gi)];
            const usedSlots = filamentTags.map(match => {
                const attrs = match[1];
                const get = key => { const m = attrs.match(new RegExp(key+'\\s*=\\s*"([^"]*)"','i')); return m ? m[1] : null; };
                return { grams: parseFloat(get('used_g'))||0, colour: get('color'), material: get('type')||'PLA' };
            }).filter(s => s.grams > 0);
            if (usedSlots.length) {
                perSlot = usedSlots;
                filamentGrams = usedSlots.reduce((a,b) => a + b.grams, 0);
            } else {
                const wm = txt.match(/key\s*=\s*"weight"\s+value\s*=\s*"([0-9.]+)"/i) || txt.match(/\bweight\s*=\s*"([0-9.]+)"/i);
                if (wm) filamentGrams = parseFloat(wm[1]);
            }
        }

        filamentGrams = Math.round(filamentGrams * 10) / 10;

        if (perSlot.length >= 1 && perSlot.some(s => s.grams > 0)) {
            // Build prefill slots — try to match by colour hex to inventory spools
            const prefillSlots = perSlot.filter(s => s.grams > 0).map(slot => {
                const slotMat = (slot.material || '').toString().trim().toUpperCase();
                // Some 3MFs may store colour without a leading '#'
                const parseMaybeHex = (v) => {
                    const str = (v || '').toString().trim();
                    return parseHexColour(str) || (str && !str.startsWith('#') ? parseHexColour('#' + str) : null);
                };
                const slotRgb = parseMaybeHex(slot.colour);
                let bestId = '';
                if (slotRgb) {
                    const inStock = filaments.filter(f => (parseFloat(f.weight_current) || 0) > 0);

                    const normalizeMat = (m) => (m || '').toString().trim().toUpperCase();
                    const candidatesExact = inStock.filter(f => normalizeMat(f.material) === slotMat);
                    // Allow variants like "PLA-CF" when 3MF says "PLA", but only if the colour match is strong.
                    const candidatesFamily = inStock.filter(f => {
                        const fm = normalizeMat(f.material);
                        return slotMat && (fm === slotMat || fm.startsWith(slotMat + '-') || fm.startsWith(slotMat + ' '));
                    });

                    const candidates = candidatesExact.length ? candidatesExact : candidatesFamily;
                    const maxDist = candidatesExact.length ? 8000 : 4000;

                    let bestDist = Number.MAX_SAFE_INTEGER;
                    let secondBestDist = Number.MAX_SAFE_INTEGER;
                    let bestDistId = '';

                    for (const f of candidates) {
                        const fHex = f.color_hex || getColourHex(f.color_name);
                        const dist = colourDistance(slotRgb, parseMaybeHex(fHex));
                        if (dist < bestDist) {
                            secondBestDist = bestDist;
                            bestDist = dist;
                            bestDistId = f.id;
                        } else if (dist < secondBestDist) {
                            secondBestDist = dist;
                        }
                    }

                    // Only auto-select if both:
                    // 1) Material/type isn't wildly wrong (exact > family)
                    // 2) Colour match is close AND unambiguous (best is meaningfully better than 2nd-best)
                    const uniqueEnough = secondBestDist === Number.MAX_SAFE_INTEGER || secondBestDist > bestDist * 1.25;
                    if (bestDist <= maxDist && uniqueEnough) bestId = bestDistId;
                }
                return { spoolId: bestId, grams: slot.grams, colour: slot.colour, material: slot.material };
            });
            const total = prefillSlots.reduce((a, s) => a + s.grams, 0).toFixed(1);
            showToast(`Found ${total}g across ${prefillSlots.length} filament${prefillSlots.length > 1 ? 's' : ''} — verify spools below`, 'success');
            openManualUsageModal(projectName, prefillSlots);
        } else {
            showToast('No filament data found — enter grams manually', 'info');
            openManualUsageModal(projectName, null);
        }
    } catch (err) {
        showToast('3MF parse failed: ' + err.message, 'error');
    }
    e.target.value = '';
});

// ============================================================
// MULTI-SLOT MODAL
// ============================================================
function openMultiSlotModal(projectName, slots) {
    const overlay = document.getElementById('usage-modal-overlay');
    const box     = overlay.querySelector('.modal-box');
    const inStock = filaments.filter(f => (parseFloat(f.weight_current)||0) > 0);
    const spoolOptions = '<option value="">— skip —</option>' +
        inStock.map(f => `<option value="${f.id}">${f.brand} ${f.color_name} · ${f.material}${f.style?' '+f.style:''} (${Math.round(f.weight_current)}g)</option>`).join('');

    box.innerHTML = `
        <div class="flex justify-between items-center mb-4">
            <h2 class="text-lg font-black mono uppercase" style="color:var(--text)">Log Multi-Colour Print</h2>
            <button onclick="closeUsageModal()" class="text-xl leading-none" style="color:var(--muted)">×</button>
        </div>
        <p class="text-sm mb-5" style="color:var(--text2)">Project: <strong>${esc(projectName)}</strong></p>
        <div class="mb-5">
            <label class="text-xs mono uppercase block mb-1" style="color:var(--muted)">Parent Project (optional)</label>
            <input type="text" id="multi-parent-project" placeholder="e.g. Car Project" style="width:100%">
        </div>
        <div id="slot-rows" class="space-y-4 mb-6">
            ${slots.map((slot, i) => `
                <div class="p-3 rounded-xl" style="background:var(--surface2);border:1px solid var(--border)">
                    <div class="flex items-center gap-3 mb-2">
                        <span style="width:20px;height:20px;border-radius:6px;background:${slot.colour||'#888'};border:2px solid rgba(128,128,128,0.3);flex-shrink:0;display:inline-block"></span>
                        <span class="text-xs font-bold mono uppercase" style="color:var(--text2)">Slot ${i+1} · ${esc(slot.material)}</span>
                    </div>
                    <div class="grid grid-cols-2 gap-2">
                        <div><label class="text-[10px] mono uppercase block mb-1" style="color:var(--muted)">Spool</label><select id="slot-spool-${i}" style="width:100%;font-size:12px">${spoolOptions}</select></div>
                        <div><label class="text-[10px] mono uppercase block mb-1" style="color:var(--muted)">Grams Used</label><input type="number" id="slot-grams-${i}" value="${slot.grams||''}" placeholder="e.g. 5" min="0" step="0.1" style="font-size:12px"></div>
                    </div>
                </div>
            `).join('')}
        </div>
        <div class="flex gap-3">
            <button onclick="closeUsageModal()" class="btn-ghost flex-1">Cancel</button>
            <button onclick="submitMultiSlot('${projectName}', ${slots.length})" class="btn-primary flex-1">Log All Slots</button>
        </div>`;
    overlay.classList.add('open');
}

async function submitMultiSlot(projectName, slotCount) {
    const slotEntries = [];
    for (let i = 0; i < slotCount; i++) {
        const spoolId = document.getElementById(`slot-spool-${i}`)?.value;
        const grams   = parseFloat(document.getElementById(`slot-grams-${i}`)?.value);
        if (!spoolId || !grams || grams <= 0) continue;
        slotEntries.push({ spoolId: parseInt(spoolId), grams });
    }

    if (!slotEntries.length) {
        closeUsageModal();
        showToast('No filament slots selected.', 'info');
        return;
    }

    let printId;
    const parentProject = document.getElementById('multi-parent-project')?.value || '';
    try {
        const res = await apiFetch('/api/usage/print', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project: projectName, source: '3mf', parent_project: parentProject }),
        });
        printId = res.print_id;
    } catch {
        closeUsageModal();
        showToast('Could not create print record for this 3MF import.', 'error');
        return;
    }

    let logged = 0, errors = 0;
    for (const slot of slotEntries) {
        try {
            await apiFetch('/api/usage', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filament_id: slot.spoolId, grams: slot.grams, project: projectName, print_id: printId }),
            });
            logged++;
        } catch { errors++; }
    }

    closeUsageModal();
    if (logged > 0) { showToast(`✓ Logged ${logged} slot${logged>1?'s':''} for "${projectName}"`, 'success'); await loadAll(); }
    if (errors > 0) showToast(`${errors} slot(s) failed to log`, 'error');
}

// ============================================================
// USAGE MODAL
// ============================================================
// (Legacy single-spool USAGE_MODAL_HTML removed — the live modal is built by openManualUsageModal.)

// openUsageModal — legacy entry point (called from spool cards & sidebar)
// Delegates to the unified multi-spool modal, pre-selecting the spool if given.
function openUsageModal(spoolId, name, currentW, prefillGrams=null, prefillProject=null) {
    const slots = spoolId
        ? [{ spoolId, grams: prefillGrams || '', colour: null, material: null }]
        : null;
    openManualUsageModal(prefillProject || null, slots);
}

function closeUsageModal() { document.getElementById('usage-modal-overlay').classList.remove('open'); }


// ============================================================
// ADD / EDIT MODAL
// ============================================================
function setSpoolWeightField(weight) {
    const sel = document.getElementById('add-spool-weight');
    const custom = document.getElementById('add-spool-weight-custom');
    if (!sel) return;
    const standard = ['1000','500','250','200'];
    const str = String(parseInt(weight) || 1000);
    if (standard.includes(str)) {
        sel.value = str;
        custom.classList.add('hidden');
        custom.value = '';
    } else {
        sel.value = 'custom';
        custom.classList.remove('hidden');
        custom.value = str;
    }
}

function getSpoolWeightValue() {
    const sel = document.getElementById('add-spool-weight');
    if (!sel) return 1000;
    if (sel.value === 'custom') {
        return parseInt(document.getElementById('add-spool-weight-custom').value) || 1000;
    }
    return parseInt(sel.value) || 1000;
}

function onFreeToggle() {
    const isFree = document.getElementById('add-price-free').checked;
    const priceEl = document.getElementById('add-price');
    if (isFree) { priceEl.value = ''; priceEl.disabled = true; priceEl.placeholder = 'Free / £0'; }
    else { priceEl.disabled = false; priceEl.placeholder = 'e.g. 19.99'; }
}

function onAlreadyUsedToggle() {
    const isUsed = document.getElementById('add-already-used').checked;
    const weightEl = document.getElementById('add-weight');
    const weightLabel = weightEl.previousElementSibling;
    const modalTitle = document.getElementById('modal-title');
    const submitBtn = document.getElementById('modal-submit-btn');
    
    if (isUsed) {
        weightEl.value = '0';
        weightEl.disabled = true;
        weightEl.placeholder = 'Already used up';
        if (weightLabel) weightLabel.textContent = 'Weight (g) - Already Used';
        if (modalTitle && !editingId) modalTitle.textContent = 'Add Historical Spool';
        if (submitBtn && !editingId) submitBtn.textContent = 'Add Historical Spool';
    } else {
        weightEl.disabled = false;
        weightEl.placeholder = getSpoolWeightValue();
        weightEl.value = getSpoolWeightValue();
        if (weightLabel) weightLabel.textContent = 'Weight (g)';
        if (modalTitle && !editingId) modalTitle.textContent = 'Add Spool';
        if (submitBtn && !editingId) submitBtn.textContent = 'Add Spool';
    }
}

// ── Refill modal ───────────────────────────────────────────────────────────

function openRefillModal(spoolId, spoolName, currentWeight, spoolWeight) {
    const f = filaments.find(x => x.id == spoolId);
    if (!f) return;
    
    document.getElementById('refill-spool-id').value = spoolId;
    document.getElementById('refill-spool-name').textContent = spoolName;
    document.getElementById('refill-current-weight').textContent = Math.round(currentWeight);
    document.getElementById('refill-spool-weight').textContent = spoolWeight;
    document.getElementById('refill-amount').value = spoolWeight; // Default to full spool weight
    document.getElementById('refill-price').value = '';
    document.getElementById('refill-price-free').checked = false;
    document.getElementById('refill-notes').value = '';
    
    document.getElementById('refill-modal').classList.add('open');
}

function closeRefillModal() {
    document.getElementById('refill-modal').classList.remove('open');
}

function onRefillFreeToggle() {
    const isFree = document.getElementById('refill-price-free').checked;
    const priceEl = document.getElementById('refill-price');
    if (isFree) { 
        priceEl.value = ''; 
        priceEl.disabled = true; 
        priceEl.placeholder = 'Free / £0'; 
    } else { 
        priceEl.disabled = false; 
        priceEl.placeholder = 'e.g. 19.99'; 
    }
}

// Submit a spool refill: top up the remaining weight, bump the bought count,
// and (if a price was given) record a purchase-history entry so cost-per-gram stays accurate.
// NOTE: PUT /api/filaments overwrites every column, so we must send the full current
// filament record — only weight_current / total_purchased / price_entry change.
async function submitRefill() {
    const id = document.getElementById('refill-spool-id').value;
    const f  = filaments.find(x => x.id == id);
    if (!f) { showToast('Spool not found.', 'error'); return; }

    const amount = parseFloat(document.getElementById('refill-amount').value);
    if (!amount || amount <= 0) { showToast('Enter a valid refill amount.', 'error'); return; }

    const isFree    = document.getElementById('refill-price-free').checked;
    const priceRaw  = document.getElementById('refill-price').value.trim();
    const parsed    = priceRaw === '' ? null : parseFloat(priceRaw);

    const item = {
        brand:           f.brand,
        material:        f.material,
        color_name:      f.color_name,
        style:           f.style,
        weight_current:  (parseFloat(f.weight_current) || 0) + amount,
        total_purchased: (parseFloat(f.total_purchased) || 0) + 1,
        color_hex:       f.color_hex,
        color_image:     f.color_image || null,
        web_address:     f.web_address || null,
        ams_compatible:  f.ams_compatible !== 0,
        notes:           f.notes || null,
        price_paid:      f.price_paid ?? null,
        price_is_free:   !!f.price_is_free,
        spool_weight:    parseFloat(f.spool_weight) || 1000,
        barcode:         f.barcode || null,
    };

    const today = new Date().toISOString().slice(0, 10) + ' 00:00:00';
    if (isFree) {
        item.price_entry = { price_paid: 0, qty: 1, purchased_at: today };
    } else if (parsed != null && !isNaN(parsed) && parsed >= 0) {
        item.price_entry = { price_paid: parsed, qty: 1, purchased_at: today };
    }

    try {
        await apiFetch(`/api/filaments/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(item),
        });
        showToast(`✓ Refilled +${Math.round(amount)}g`, 'success');
        closeRefillModal();
        await loadAll();
    } catch (err) {
        showToast('Could not refill spool: ' + err.message, 'error');
    }
}

// Add Spool form: typing a positive price clears a stale "got it free" tick.
function onPriceInput() {
    const priceEl = document.getElementById('add-price');
    const freeEl  = document.getElementById('add-price-free');
    if (!priceEl || !freeEl) return;
    const val = parseFloat(priceEl.value);
    if (!isNaN(val) && val > 0 && freeEl.checked) {
        freeEl.checked = false;
        onFreeToggle();
    }
}

// --- Print-Labels preview modal (currently not wired to a data source) ---
function closeLabelPrintModal() {
    document.getElementById('label-print-modal')?.classList.remove('open');
}
function executePrintLabel(/* type */) {
    // This modal has no opener that populates the preview, so there is nothing to
    // print here. Fail gracefully and point at the working per-item label button.
    closeLabelPrintModal();
    showToast('Use the 🏷️ button on a product row to print its label.', 'info');
}

function onPurchaseAddFreeToggle() {
    const isFree = document.getElementById('purchase-add-price-free').checked;
    const priceEl = document.getElementById('purchase-add-price');
    if (isFree) { priceEl.value = ''; priceEl.disabled = true; priceEl.placeholder = 'Free / £0'; }
    else { priceEl.disabled = false; priceEl.placeholder = 'e.g. 19.99'; }
}

function onPurchaseEditFreeToggle() {
    const isFree = document.getElementById('purchase-edit-price-free').checked;
    const priceEl = document.getElementById('purchase-edit-price');
    if (isFree) { priceEl.value = ''; priceEl.disabled = true; priceEl.placeholder = 'Free / £0'; }
    else { priceEl.disabled = false; priceEl.placeholder = ''; }
}

document.getElementById('add-spool-weight')?.addEventListener('change', function() {
    const custom = document.getElementById('add-spool-weight-custom');
    custom.classList.toggle('hidden', this.value !== 'custom');
    if (this.value === 'custom') custom.focus();
});

function openAddModal() {
    editingId = null;
    document.getElementById('modal-title').textContent      = 'Add Spool';
    document.getElementById('modal-submit-btn').textContent = 'Add Spool';
    document.getElementById('edit-id').value = '';
    ['add-brand','add-material','add-colour','add-style','add-hex','add-colour-image','add-url','add-price','add-barcode-field','add-total-purchased'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.value = ''; el.disabled = false; }
    });
    document.getElementById('add-weight').value = '1000';
    document.getElementById('add-total-purchased').value = '1';
    document.getElementById('add-ams').checked  = true;
    document.getElementById('add-notes').value  = '';
    document.getElementById('add-price-free').checked = false;
    document.getElementById('add-price').placeholder = 'e.g. 19.99';
    document.getElementById('add-already-used').checked = false;
    // Reset the weight field label
    const weightLabel = document.getElementById('add-weight').previousElementSibling;
    if (weightLabel) weightLabel.textContent = 'Weight (g)';
    setSpoolWeightField(1000);
    const imgFile = document.getElementById('add-colour-image-file');
    if (imgFile) imgFile.value = '';
    document.getElementById('hex-preview').style.background = 'transparent';
    onAlreadyUsedToggle(); // Apply the toggle effects for initial state
    document.getElementById('modal-overlay').classList.add('open');
}

function openEditModal(id) {
    const f = filaments.find(x => x.id == id);
    if (!f) return;
    editingId = id;
    document.getElementById('modal-title').textContent      = 'Edit Spool';
    document.getElementById('modal-submit-btn').textContent = 'Save Changes';
    document.getElementById('edit-id').value       = id;
    document.getElementById('add-brand').value     = f.brand     || '';
    document.getElementById('add-material').value  = f.material  || '';
    document.getElementById('add-colour').value    = f.color_name|| '';
    document.getElementById('add-style').value     = f.style     || '';
    document.getElementById('add-weight').value    = f.weight_current || 1000;
    document.getElementById('add-total-purchased').value = f.total_purchased || 1;
    document.getElementById('add-hex').value       = f.color_hex || '';
    document.getElementById('add-colour-image').value = f.color_image || '';
    const imgFile = document.getElementById('add-colour-image-file');
    if (imgFile) imgFile.value = '';
    document.getElementById('add-url').value       = f.web_address|| '';
    document.getElementById('add-ams').checked     = f.ams_compatible !== 0;
    document.getElementById('add-notes').value     = f.notes     || '';
    document.getElementById('add-price-free').checked = !!f.price_is_free;
    if (f.price_is_free) {
        document.getElementById('add-price').value = '';
        document.getElementById('add-price').disabled = true;
        document.getElementById('add-price').placeholder = 'Free / £0';
    } else {
        document.getElementById('add-price').value = '';
        document.getElementById('add-price').disabled = false;
        document.getElementById('add-price').placeholder = f.price_paid != null ? `Last paid: ${parseFloat(f.price_paid).toFixed(2)}` : 'e.g. 19.99';
    }
    const bcEl = document.getElementById('add-barcode-field');
    if (bcEl) bcEl.value = f.barcode || '';
    setSpoolWeightField(f.spool_weight || 1000);
    document.getElementById('hex-preview').style.background = f.color_hex || getColourHex(f.color_name);
    // Handle "already used" state
    const isAlreadyUsed = (parseFloat(f.weight_current) || 0) === 0;
    document.getElementById('add-already-used').checked = isAlreadyUsed;
    onAlreadyUsedToggle(); // Apply the toggle effects
    document.getElementById('modal-overlay').classList.add('open');
}

function closeModal() { document.getElementById('modal-overlay').classList.remove('open'); }

function previewHex() {
    const hex = document.getElementById('add-hex').value || getColourHex(document.getElementById('add-colour').value);
    document.getElementById('hex-preview').style.background = hex;
}

async function uploadColourImageFile(inputEl) {
    const file = inputEl?.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    showToast('Uploading colour image…', 'info');
    try {
        const res = await fetch('/api/uploads/color-image', { method: 'POST', body: form });
        const data = await res.json();
        if (!res.ok || !data.url) throw new Error(data.error || `HTTP ${res.status}`);
        const urlEl = document.getElementById('add-colour-image');
        if (urlEl) urlEl.value = data.url;
        showToast('✓ Colour image uploaded', 'success');
    } catch (err) {
        showToast('Upload failed: ' + err.message, 'error');
    }
}

async function submitAddSpool() {
    const priceRaw    = document.getElementById('add-price').value.trim();
    const isFree      = document.getElementById('add-price-free').checked;
    const isAlreadyUsed = document.getElementById('add-already-used').checked;
    const spoolWeight = getSpoolWeightValue();
    const editingFilament = editingId ? filaments.find(f => f.id == editingId) : null;
    const parsedPrice = priceRaw === '' ? null : parseFloat(priceRaw);

    let effectivePrice;
    if (isFree) {
        effectivePrice = 0;
    } else if (editingId) {
        effectivePrice = (parsedPrice == null || isNaN(parsedPrice)) ? (editingFilament?.price_paid ?? null) : parsedPrice;
    } else {
        effectivePrice = (parsedPrice == null || isNaN(parsedPrice)) ? null : parsedPrice;
    }

    const item = {
        brand:          document.getElementById('add-brand').value,
        material:       document.getElementById('add-material').value,
        color_name:     document.getElementById('add-colour').value,
        style:          document.getElementById('add-style').value,
        weight_current: isAlreadyUsed ? 0 : (parseFloat(document.getElementById('add-weight').value) || spoolWeight),
        total_purchased: parseFloat(document.getElementById('add-total-purchased').value) || 1,
        color_hex:      document.getElementById('add-hex').value || getColourHex(document.getElementById('add-colour').value),
        color_image:    document.getElementById('add-colour-image').value || null,
        web_address:    document.getElementById('add-url').value || null,
        ams_compatible: document.getElementById('add-ams').checked,
        notes:          document.getElementById('add-notes').value || null,
        price_paid:     effectivePrice,
        price_is_free:  isFree,
        spool_weight:   spoolWeight,
        barcode:        document.getElementById('add-barcode-field')?.value || null,
    };
    if (!item.brand) { showToast('Brand is required.', 'error'); return; }
    try {
        if (editingId) {
            if (isFree) {
                item.price_entry = { price_paid: 0, qty: 1, purchased_at: new Date().toISOString().slice(0, 10) + ' 00:00:00' };
            } else if (priceRaw !== '' && !isNaN(parsedPrice) && parsedPrice >= 0) {
                item.price_entry = { price_paid: parsedPrice, qty: 1, purchased_at: new Date().toISOString().slice(0, 10) + ' 00:00:00' };
            }
            await apiFetch(`/api/filaments/${editingId}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(item) });
            showToast('✓ Spool updated', 'success');
        } else {
            await apiFetch('/api/filaments', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'add_single', item }) });
            showToast('✓ Spool added', 'success');
        }
        closeModal();
        await loadAll();
        if (activeTab === 'inventory') renderInventory();
    } catch (err) {
        showToast('Could not save spool: ' + err.message, 'error');
    }
}

// ============================================================
// USB BARCODE SCANNER
// ============================================================
function findInventoryFilamentByBarcode(barcode) {
    const target = String(barcode || '').trim();
    if (!target) return null;
    const matches = filaments.filter(f => String(f.barcode || '').trim() === target);
    if (!matches.length) return null;
    return matches.sort((a, b) => {
        const aTime = Date.parse(a.last_updated || '') || 0;
        const bTime = Date.parse(b.last_updated || '') || 0;
        if (aTime !== bTime) return bTime - aTime;
        return (parseInt(b.id, 10) || 0) - (parseInt(a.id, 10) || 0);
    })[0];
}

function fillSaveBarcodeFromInventory(f) {
    if (!f) return false;
    const typeEl = document.getElementById('bc-save-type');
    if (typeEl) typeEl.value = 'filament';
    document.getElementById('bc-save-brand').value    = f.brand || '';
    document.getElementById('bc-save-material').value = f.material || '';
    document.getElementById('bc-save-colour').value   = f.color_name || '';
    document.getElementById('bc-save-style').value    = f.style || '';
    document.getElementById('bc-save-hex').value      = f.color_hex || getColourHex(f.color_name);
    document.getElementById('bc-save-price').value    = f.price_paid || '';
    document.getElementById('bc-save-weight').value   = '1000';
    document.getElementById('bc-save-ams').checked    = f.ams_compatible !== 0;
    bcSavePreviewHex();
    return true;
}

function normalizeBarcodeItemType(type) {
    const val = String(type || '').trim().toLowerCase();
    if (val === 'materials') return 'material';
    if (val === 'equip' || val === 'equipments') return 'equipment';
    if (val === 'model_kit' || val === 'modelkit' || val === 'model kit' || val === 'modelkits') return 'model_kit';
    if (val === 'material' || val === 'equipment' || val === 'filament') return val;
    return 'filament';
}

function labelForBarcodeItemType(type) {
    const t = normalizeBarcodeItemType(type);
    if (t === 'material') return 'Material';
    if (t === 'equipment') return 'Equipment';
    if (t === 'model_kit') return 'Model Kit';
    return 'Filament';
}

function inferBarcodeTypeFromActiveSection() {
    if (activeSection === 'materials') return 'material';
    if (activeSection === 'equipment') return 'equipment';
    if (activeSection === 'modelkits') return 'model_kit';
    return 'filament';
}

function toggleBarcodeTypeFields(type, modalKind) {
    const normalizedType = normalizeBarcodeItemType(type);
    const filamentOnlyClass = modalKind === 'save' ? '.bc-filament-only-save' : '.bc-filament-only-manual';
    const showFilamentFields = normalizedType === 'filament';
    document.querySelectorAll(filamentOnlyClass).forEach(el => {
        el.classList.toggle('hidden', !showFilamentFields);
    });
}

function applyBarcodeTypeUi(type, modalKind) {
    const t = normalizeBarcodeItemType(type);
    toggleBarcodeTypeFields(t, modalKind);

    if (modalKind === 'save') {
        const materialLabel = document.getElementById('bc-save-material-label');
        const materialInput = document.getElementById('bc-save-material');
        const helpText      = document.getElementById('bc-save-type-help');
        const addBtn        = document.getElementById('bc-save-add-btn');
        const kitNameRow    = document.getElementById('bc-save-kit-name-row');

        if (materialLabel) materialLabel.textContent = t === 'equipment' ? 'Category' : t === 'model_kit' ? 'Model No' : 'Material/Type';
        if (materialInput) {
            materialInput.placeholder = t === 'equipment'
                ? 'Build Plate / Hotend / Printer'
                : (t === 'material' ? 'Vinyl / Cardstock / Resin' : t === 'model_kit' ? 'BAS5057946' : 'PLA');
        }
        if (kitNameRow) kitNameRow.classList.toggle('hidden', t !== 'model_kit');
        if (helpText) {
            helpText.textContent = t === 'filament'
                ? 'Fill in filament details to save this barcode.'
                : `Fill in ${labelForBarcodeItemType(t).toLowerCase()} details to save this barcode.`;
        }
        if (addBtn) {
            addBtn.textContent = t === 'filament'
                ? 'Save & Add Spool →'
                : `Save & Add ${labelForBarcodeItemType(t)} →`;
        }
        return;
    }

    // manual modal
    const materialLabel = document.getElementById('bc-material-label');
    const materialInput = document.getElementById('bc-material');
    const kitNameRow    = document.getElementById('bc-kit-name-row');
    if (materialLabel) materialLabel.textContent = t === 'equipment' ? 'Category' : t === 'model_kit' ? 'Model No' : 'Material/Type';
    if (materialInput) {
        materialInput.placeholder = t === 'equipment'
            ? 'Build Plate / Hotend / Printer'
            : (t === 'material' ? 'Vinyl / Cardstock / Resin' : t === 'model_kit' ? 'BAS5057946' : 'PLA');
    }
    if (kitNameRow) kitNameRow.classList.toggle('hidden', t !== 'model_kit');
}

function prefillMaterialFromBarcodeEntry(d, barcode) {
    openAddMaterialModal();
    const b = document.getElementById('mat-brand');
    const t = document.getElementById('mat-type');
    const m = document.getElementById('mat-model');
    const bc = document.getElementById('mat-barcode');
    if (b) b.value = d.brand || '';
    if (t) t.value = d.material || '';
    if (m) m.value = [d.color_name, d.style].filter(Boolean).join(' ') || '';
    if (bc) bc.value = barcode;
}

function prefillEquipmentFromBarcodeEntry(d, barcode) {
    openAddEquipmentModal();
    const b = document.getElementById('eq-brand');
    const m = document.getElementById('eq-model');
    const v = document.getElementById('eq-variant');
    const bc = document.getElementById('eq-barcode');
    setEquipmentCategoryValue(d.material || '');
    if (b) b.value = d.brand || '';
    if (m) m.value = d.color_name || '';
    if (v) v.value = d.style || '';
    if (bc) bc.value = barcode;
}

function prefillModelKitFromBarcodeEntry(d, barcode) {
    openAddModelKitModal();
    const b  = document.getElementById('mk-brand');
    const n  = document.getElementById('mk-name');
    const bc = document.getElementById('mk-barcode');
    if (b)  b.value  = d.brand      || '';
    if (n)  n.value  = d.color_name || d.kit_name || '';
    if (bc) bc.value = barcode;
}

function openTargetFormForBarcodeType(type, data, barcode) {
    const t = normalizeBarcodeItemType(type);
    if (t === 'material') {
        prefillMaterialFromBarcodeEntry(data || {}, barcode);
        showToast(`✓ Found ${labelForBarcodeItemType(t)} barcode — opening Add Material`, 'success');
        return;
    }
    if (t === 'equipment') {
        prefillEquipmentFromBarcodeEntry(data || {}, barcode);
        showToast(`✓ Found ${labelForBarcodeItemType(t)} barcode — opening Add Equipment`, 'success');
        return;
    }
    if (t === 'model_kit') {
        prefillModelKitFromBarcodeEntry(data || {}, barcode);
        showToast(`✓ Found ${labelForBarcodeItemType(t)} barcode — opening Add Model Kit`, 'success');
        return;
    }
    const d = data || {};
    showToast(`✓ Found ${labelForBarcodeItemType(t)} barcode — opening Add Spool`, 'success');
    openAddModal();
    document.getElementById('add-brand').value    = d.brand    || '';
    document.getElementById('add-material').value = d.material || '';
    document.getElementById('add-colour').value   = d.color_name || '';
    document.getElementById('add-style').value    = d.style    || '';
    document.getElementById('add-hex').value      = d.color_hex || getColourHex(d.color_name);
    document.getElementById('add-weight').value   = d.weight_full || 1000;
    document.getElementById('add-url').value      = d.web_address || '';
    document.getElementById('add-ams').checked    = d.ams_compatible !== 0;
    document.getElementById('add-price').value    = d.price    || '';
    const bcEl = document.getElementById('add-barcode-field');
    if (bcEl) bcEl.value = barcode;
    previewHex();
}

// USB scanners act as keyboards — they type the barcode then press Enter.
// We buffer keystrokes and treat rapid sequences ending in Enter as a scan.
let _scanBuffer = '';
let _scanTimer  = null;

document.addEventListener('keydown', async (e) => {
    // Only listen if no input/textarea is focused (or the dedicated scan field is focused)
    const activeEl   = document.activeElement;
    const isScanField= activeEl && activeEl.id === 'scan-listen-field';
    const isInput    = activeEl && ['INPUT','TEXTAREA','SELECT'].includes(activeEl.tagName) && !isScanField;
    if (isInput) return;

    // Ignore modifier keys
    if (e.key.length > 1 && e.key !== 'Enter') return;

    if (e.key === 'Enter') {
        const barcode = _scanBuffer.trim();
        _scanBuffer   = '';
        clearTimeout(_scanTimer);
        if (barcode.length >= 4) {
            e.preventDefault();
            await handleBarcodeScan(barcode);
        }
        return;
    }

    _scanBuffer += e.key;
    clearTimeout(_scanTimer);
    // If no Enter within 150ms, clear (human typing is slower)
    _scanTimer = setTimeout(() => { _scanBuffer = ''; }, 150);
});

async function handleBarcodeScan(barcode) {
    showToast(`🔍 Scanning: ${barcode}`, 'info');
    try {
        const res = await apiFetch(`/api/barcodedb/lookup/${encodeURIComponent(barcode)}`);
        if (res.found) {
            const d = res.data || {};
            openTargetFormForBarcodeType(d.item_type, d, barcode);
        } else {
            // Unknown barcode — open the "save to barcode DB" modal
            showToast(`Unknown barcode — save it to your database`, 'info');
            openSaveBarcodeModal(barcode);
        }
    } catch (err) {
        showToast('Barcode lookup failed: ' + err.message, 'error');
    }
}

// ============================================================
// SAVE BARCODE MODAL (unknown scan)
// ============================================================
function openSaveBarcodeModal(barcode) {
    const overlay = document.getElementById('bc-save-modal-overlay');
    document.getElementById('bc-save-barcode-display').textContent = barcode;
    document.getElementById('bc-save-barcode-val').value   = barcode;
    const typeEl = document.getElementById('bc-save-type');
    if (typeEl) typeEl.value = inferBarcodeTypeFromActiveSection();
    document.getElementById('bc-save-brand').value         = '';
    document.getElementById('bc-save-material').value      = '';
    document.getElementById('bc-save-colour').value        = '';
    document.getElementById('bc-save-style').value         = '';
    document.getElementById('bc-save-hex').value           = '';
    document.getElementById('bc-save-price').value         = '';
    document.getElementById('bc-save-weight').value        = '1000';
    document.getElementById('bc-save-ams').checked         = true;
    document.getElementById('bc-save-hex-preview').style.background = 'transparent';

    const invMatch = findInventoryFilamentByBarcode(barcode);
    if (fillSaveBarcodeFromInventory(invMatch)) {
        showToast('Auto-filled from inventory for this barcode', 'success');
    }

    applyBarcodeTypeUi(typeEl?.value, 'save');

    overlay.classList.add('open');
    setTimeout(() => document.getElementById('bc-save-brand').focus(), 60);
}

function closeSaveBarcodeModal() {
    document.getElementById('bc-save-modal-overlay').classList.remove('open');
}

function bcSavePreviewHex() {
    const hex = document.getElementById('bc-save-hex').value || getColourHex(document.getElementById('bc-save-colour').value);
    document.getElementById('bc-save-hex-preview').style.background = hex;
}

async function submitSaveBarcode(addSpool) {
    const barcode = document.getElementById('bc-save-barcode-val').value.trim();
    const itemType = normalizeBarcodeItemType(document.getElementById('bc-save-type')?.value);
    const item = {
        barcode,
        item_type:      itemType,
        brand:          document.getElementById('bc-save-brand').value,
        material:       document.getElementById('bc-save-material').value,
        color_name:     document.getElementById('bc-save-colour').value,
        style:          document.getElementById('bc-save-style').value,
        color_hex:      document.getElementById('bc-save-hex').value || getColourHex(document.getElementById('bc-save-colour').value),
        weight_full:    parseFloat(document.getElementById('bc-save-weight').value) || 1000,
        ams_compatible: document.getElementById('bc-save-ams').checked,
        price:          parseFloat(document.getElementById('bc-save-price').value) || null,
    };
    try {
        await apiFetch('/api/barcodedb', { method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ action:'upsert', item }) });
        showToast('✓ Saved to barcode database', 'success');
        await loadBarcodeDb();
        closeSaveBarcodeModal();
        if (addSpool) {
            openTargetFormForBarcodeType(item.item_type, item, barcode);
        }
    } catch (err) {
        showToast('Could not save: ' + err.message, 'error');
    }
}

// ============================================================
// BARCODE DATABASE UI
// ============================================================
async function loadBarcodeDb() {
    try {
        barcodeDb = await apiFetch('/api/barcodedb');
        if (activeSection === 'barcodes') renderBarcodeDb();
    } catch(e) {
        showToast('Could not load barcode DB.', 'error');
    }
}

function renderBarcodeDb() {
    const search = (document.getElementById('bc-search')?.value || '').toLowerCase();
    let filtered = barcodeDb.filter(b => {
        if (!search) return true;
        return `${b.barcode} ${b.item_type || 'filament'} ${b.brand} ${b.material} ${b.color_name}`.toLowerCase().includes(search);
    });
    filtered = applyTableSort(filtered, 'barcodes', {
        barcode: b => b.barcode || '',
        type: b => labelForBarcodeItemType(b.item_type),
        brand: b => b.brand || '',
        material: b => b.material || '',
        colour: b => `${b.color_name || ''} ${b.style || ''}`,
        weight: b => parseFloat(b.weight_full) || 0,
        price: b => parseFloat(b.price) || 0,
        ams: b => b.ams_compatible !== 0,
    });
    document.getElementById('bc-filter-count').textContent = `${filtered.length} entr${filtered.length !== 1 ? 'ies' : 'y'}`;

    const body = document.getElementById('bc-list');
    if (!filtered.length) {
        body.innerHTML = '<tr><td colspan="9" class="text-center py-12" style="color:var(--muted)">No barcode entries yet. Scan a box or add manually.</td></tr>';
        updateTableSortHeaders();
        return;
    }
    body.innerHTML = filtered.map(b => `<tr data-id="${b.id}">
        <td class="mono text-xs font-bold" style="color:var(--accent)">${b.barcode}</td>
        <td><span class="badge">${labelForBarcodeItemType(b.item_type)}</span></td>
        <td>
            <div class="flex items-center gap-2">
                <span style="width:16px;height:16px;border-radius:4px;background:${b.color_hex||getColourHex(b.color_name)};border:1px solid rgba(128,128,128,0.3);flex-shrink:0;display:inline-block"></span>
                <span style="color:var(--text)">${esc(b.brand || '—')}</span>
            </div>
        </td>
        <td><span class="badge" style="background:${matStyle(b.material).bg};color:${matStyle(b.material).text}">${esc(b.material || '?')}</span></td>
        <td style="color:var(--text2)">${esc(b.color_name || '—')}${b.style ? ' · '+esc(b.style) : ''}</td>
        <td class="mono text-xs" style="color:var(--text2)">${b.weight_full || 1000}g</td>
        <td class="mono text-sm font-bold" style="color:var(--green)">${b.price ? formatGBP(b.price) : '—'}</td>
        <td><span style="color:${b.ams_compatible ? 'var(--green)' : 'var(--red)'};font-size:11px">${b.ams_compatible ? 'Yes ✓' : 'No'}</span></td>
        <td>
            <div class="flex gap-2">
                <button onclick="openEditBarcodeModal(${b.id})" class="btn-ghost py-1 px-2 text-xs">✏️</button>
                <button onclick="deleteBarcodeEntry(${b.id})" class="btn-danger py-1 px-2 text-xs">🗑</button>
            </div>
        </td>
    </tr>`).join('');
    updateTableSortHeaders();
}

function openAddBarcodeModal() {
    editingBcId = null;
    document.getElementById('bc-modal-title').textContent = 'Add Barcode Entry';
    document.getElementById('bc-modal-submit-btn').textContent = 'Save Entry';
    ['bc-barcode','bc-brand','bc-material','bc-colour','bc-style','bc-hex','bc-price','bc-bc-notes','bc-url'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const typeEl = document.getElementById('bc-type');
    if (typeEl) typeEl.value = inferBarcodeTypeFromActiveSection();
    document.getElementById('bc-weight').value  = '1000';
    document.getElementById('bc-ams').checked   = true;
    document.getElementById('bc-hex-preview').style.background = 'transparent';
    applyBarcodeTypeUi(typeEl?.value, 'manual');
    document.getElementById('bc-modal-overlay').classList.add('open');
    setTimeout(() => document.getElementById('bc-barcode').focus(), 60);
}

function openEditBarcodeModal(id) {
    const b = barcodeDb.find(x => x.id === id);
    if (!b) return;
    editingBcId = id;
    document.getElementById('bc-modal-title').textContent = 'Edit Barcode Entry';
    document.getElementById('bc-modal-submit-btn').textContent = 'Save Changes';
    document.getElementById('bc-barcode').value   = b.barcode    || '';
    const typeEl = document.getElementById('bc-type');
    if (typeEl) typeEl.value = normalizeBarcodeItemType(b.item_type);
    document.getElementById('bc-brand').value     = b.brand      || '';
    document.getElementById('bc-material').value  = b.material   || '';
    document.getElementById('bc-colour').value    = b.color_name || '';
    document.getElementById('bc-style').value     = b.style      || '';
    document.getElementById('bc-hex').value       = b.color_hex  || '';
    document.getElementById('bc-weight').value    = b.weight_full|| 1000;
    document.getElementById('bc-ams').checked     = b.ams_compatible !== 0;
    document.getElementById('bc-price').value     = b.price      || '';
    const notesEl = document.getElementById('bc-bc-notes');
    if (notesEl) notesEl.value = b.notes || '';
    const urlEl = document.getElementById('bc-url');
    if (urlEl) urlEl.value = b.web_address || '';
    document.getElementById('bc-hex-preview').style.background = b.color_hex || getColourHex(b.color_name);
    applyBarcodeTypeUi(typeEl?.value, 'manual');
    document.getElementById('bc-modal-overlay').classList.add('open');
}

function closeBcModal() { document.getElementById('bc-modal-overlay').classList.remove('open'); }

function bcPreviewHex() {
    const hex = document.getElementById('bc-hex').value || getColourHex(document.getElementById('bc-colour').value);
    document.getElementById('bc-hex-preview').style.background = hex;
}

async function submitBarcodeEntry() {
    const barcode = document.getElementById('bc-barcode').value.trim();
    if (!barcode) { showToast('Barcode is required.', 'error'); return; }
    const item = {
        barcode,
        item_type:      normalizeBarcodeItemType(document.getElementById('bc-type')?.value),
        brand:          document.getElementById('bc-brand').value,
        material:       document.getElementById('bc-material').value,
        color_name:     document.getElementById('bc-colour').value,
        style:          document.getElementById('bc-style').value,
        color_hex:      document.getElementById('bc-hex').value || getColourHex(document.getElementById('bc-colour').value),
        weight_full:    parseFloat(document.getElementById('bc-weight').value) || 1000,
        ams_compatible: document.getElementById('bc-ams').checked,
        price:          parseFloat(document.getElementById('bc-price').value) || null,
        notes:          document.getElementById('bc-bc-notes')?.value || null,
        web_address:    document.getElementById('bc-url')?.value || null,
    };
    try {
        if (editingBcId) {
            await apiFetch(`/api/barcodedb/${editingBcId}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(item) });
            showToast('✓ Entry updated', 'success');
        } else {
            await apiFetch('/api/barcodedb', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'upsert', item }) });
            showToast('✓ Entry saved', 'success');
        }
        closeBcModal();
        await loadBarcodeDb();
        if (activeSection === 'barcodes') renderBarcodeDb();
    } catch(e) {
        showToast('Could not save: ' + e.message, 'error');
    }
}

async function deleteBarcodeEntry(id) {
    if (!confirm('Delete this barcode entry?')) return;
    try {
        await apiFetch(`/api/barcodedb/${id}`, { method:'DELETE' });
        showToast('✓ Deleted', 'success');
        await loadBarcodeDb();
    } catch { showToast('Delete failed', 'error'); }
}

function exportBarcodesExcel() {
    try {
        const wb   = XLSX.utils.book_new();
        const data = [['Barcode','Type','Brand','Material','Colour','Style','Weight (g)','Price','AMS','Notes','Buy URL']]
            .concat(barcodeDb.map(b => [b.barcode, normalizeBarcodeItemType(b.item_type), b.brand, b.material, b.color_name, b.style, b.weight_full, b.price||'', b.ams_compatible ? 'Yes' : 'No', b.notes||'', b.web_address||'']));
        const sheet = XLSX.utils.aoa_to_sheet(data);
        sheet['!cols'] = [16,12,20,10,18,12,10,8,6,24,40].map(w => ({wch:w}));
        XLSX.utils.book_append_sheet(wb, sheet, 'Barcode DB');
        XLSX.writeFile(wb, `SpoolStats_BarcodeDB_${new Date().toISOString().slice(0,10)}.xlsx`);
        showToast('✓ Barcode DB exported', 'success');
    } catch(e) { showToast('Export failed: ' + e.message, 'error'); }
}

document.getElementById('bc-excel-upload')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    showToast('Reading Excel file…', 'info');
    try {
        const data = await file.arrayBuffer();
        const wb   = XLSX.read(data);
        const sheet= wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
        const items = rows.filter(r => r['Barcode']).map(r => ({
            barcode:    String(r['Barcode']),
            item_type:  normalizeBarcodeItemType(r['Type'] || r['Item Type']),
            brand:      r['Brand']    || '',
            material:   r['Material'] || '',
            color_name: r['Colour']   || '',
            style:      r['Style']    || '',
            color_hex:  r['Colour Hex'] || getColourHex(r['Colour']||''),
            weight_full:parseFloat(r['Weight (g)']) || 1000,
            ams_compatible: String(r['AMS']||'yes').toLowerCase() === 'yes',
            price:      parseFloat(r['Price']) || null,
            notes:      r['Notes'] || null,
            web_address:r['Buy URL'] || null,
        }));
        if (!items.length) { showToast('No valid rows.', 'error'); return; }
        await apiFetch('/api/barcodedb', { method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ action:'bulk_import', items }) });
        showToast(`✓ Imported ${items.length} barcode entries`, 'success');
        await loadBarcodeDb();
    } catch(err) { showToast('Import failed: ' + err.message, 'error'); }
    e.target.value = '';
});

document.getElementById('bc-save-type')?.addEventListener('change', (e) => {
    applyBarcodeTypeUi(e.target.value, 'save');
});

document.getElementById('bc-type')?.addEventListener('change', (e) => {
    applyBarcodeTypeUi(e.target.value, 'manual');
});

// ============================================================
// TOAST
// ============================================================
let toastTimer;
function showToast(msg, type = 'success') {
    const t   = document.getElementById('toast');
    t.textContent = msg;
    t.className   = 'show ' + type;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = ''; }, 3800);
}

// ============================================================
// INVENTORY SELECTION
// ============================================================
function onCardClick(e, cardEl) {
    const anyChecked = document.querySelector('.card-check:checked');
    const cb = cardEl.querySelector('.card-check');
    if (anyChecked || e.target.tagName === 'INPUT') {
        if (cb) { cb.checked = !cb.checked; onCardCheckChange(cb); }
        return;
    }
    openSidebar(cardEl);
}

function onCardCheckChange(cb) {
    const card = cb.closest('.spool-card');
    if (card) card.classList.toggle('card-selected', cb.checked);
    invUpdateToolbar();
}

function invUpdateToolbar() {
    const checked = document.querySelectorAll('.card-check:checked');
    document.getElementById('inv-toolbar').classList.toggle('hidden', checked.length === 0);
    document.getElementById('inv-sel-count').textContent = `${checked.length} selected`;
}

function invSelectAll() {
    document.querySelectorAll('.card-check').forEach(cb => { cb.checked = true; cb.closest('.spool-card')?.classList.add('card-selected'); });
    invUpdateToolbar();
}

function invSelectNone() {
    document.querySelectorAll('.card-check').forEach(cb => { cb.checked = false; cb.closest('.spool-card')?.classList.remove('card-selected'); });
    invUpdateToolbar();
}

async function invDeleteSelected() {
    const checked = [...document.querySelectorAll('.card-check:checked')];
    if (!checked.length) return;
    const ids = checked.map(cb => cb.dataset.id);
    if (!confirm(`Delete ${ids.length} spool${ids.length>1?'s':''}? This cannot be undone.`)) return;
    let ok = 0, fail = 0;
    for (const id of ids) {
        try { await apiFetch(`/api/filaments/${id}`, { method:'DELETE' }); ok++; } catch { fail++; }
    }
    if (ok)   showToast(`✓ Deleted ${ok} spool${ok>1?'s':''}`, 'success');
    if (fail) showToast(`${fail} deletion(s) failed`, 'error');
    await loadAll(); renderInventory();
}

// ============================================================
// REORDER SELECTION
// ============================================================
function reorderCheckChange() {
    const checked = document.querySelectorAll('.reorder-check:checked');
    const all     = document.querySelectorAll('.reorder-check');
    document.getElementById('reorder-toolbar').classList.toggle('hidden', checked.length === 0);
    document.getElementById('reorder-sel-count').textContent = `${checked.length} selected`;
    const mc = document.getElementById('reorder-check-all');
    if (mc) { mc.indeterminate = checked.length > 0 && checked.length < all.length; mc.checked = checked.length === all.length && all.length > 0; }
}
function reorderToggleAll(state) { document.querySelectorAll('.reorder-check').forEach(cb => cb.checked = state); reorderCheckChange(); }
function reorderSelectAll()  { reorderToggleAll(true);  }
function reorderSelectNone() { reorderToggleAll(false); }

async function reorderDeleteSelected() {
    const checked = [...document.querySelectorAll('.reorder-check:checked')];
    if (!checked.length) return;
    const ids = checked.map(cb => cb.dataset.id);
    if (!confirm(`Delete ${ids.length} spool${ids.length>1?'s':''}? This cannot be undone.`)) return;
    let ok = 0, fail = 0;
    for (const id of ids) {
        try { await apiFetch(`/api/filaments/${id}`, { method:'DELETE' }); ok++; } catch { fail++; }
    }
    if (ok)   showToast(`✓ Deleted ${ok} spool${ok>1?'s':''}`, 'success');
    if (fail) showToast(`${fail} deletion(s) failed`, 'error');
    await loadAll(); renderReorder();
}

async function setReorderHidden(id, hidden) {
    try {
        await apiFetch(`/api/filaments/${id}/reorder`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hidden }),
        });
        showToast(hidden ? 'Hidden from reorder list' : 'Restored to reorder list', 'success');
        await loadAll();
        renderReorder();
    } catch (err) {
        showToast('Could not update reorder status: ' + err.message, 'error');
    }
}

async function reorderHideSelected(hidden) {
    const checked = [...document.querySelectorAll('.reorder-check:checked')];
    if (!checked.length) return;
    let ok = 0, fail = 0;
    for (const cb of checked) {
        try {
            await apiFetch(`/api/filaments/${cb.dataset.id}/reorder`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ hidden }),
            });
            ok++;
        } catch {
            fail++;
        }
    }
    if (ok) showToast(`${hidden ? 'Hidden' : 'Unhidden'} ${ok} spool${ok > 1 ? 's' : ''}`, 'success');
    if (fail) showToast(`${fail} update(s) failed`, 'error');
    await loadAll();
    renderReorder();
}

// ============================================================
// USAGE SELECTION
// ============================================================
function usageCheckChange() {
    const checked = document.querySelectorAll('.usage-check:checked');
    const all     = document.querySelectorAll('.usage-check');
    document.getElementById('usage-toolbar').classList.toggle('hidden', checked.length === 0);
    const totalG = [...checked].reduce((s, cb) => s + parseFloat(cb.dataset.weight||0), 0);
    document.getElementById('usage-sel-count').textContent = `${checked.length} selected (${Math.round(totalG)}g total)`;
    const mc = document.getElementById('usage-check-all');
    if (mc) { mc.indeterminate = checked.length > 0 && checked.length < all.length; mc.checked = checked.length === all.length && all.length > 0; }
}
function usageToggleAll(state) { document.querySelectorAll('.usage-check').forEach(cb => cb.checked = state); usageCheckChange(); }
function usageSelectAll()  { usageToggleAll(true);  }
function usageSelectNone() { usageToggleAll(false); }

async function usageDeleteSelected(restoreFilament) {
    const checked = [...document.querySelectorAll('.usage-check:checked')];
    if (!checked.length) return;
    const selectedPrintIds = new Set();
    const selectedProjectIds = new Set();
    checked.forEach(cb => {
        if (cb.dataset.type === 'project') {
            selectedProjectIds.add(String(cb.dataset.projectId));
        } else {
            selectedPrintIds.add(String(cb.dataset.printId));
        }
    });

    const getPrintId = (u) => u.print_id != null ? u.print_id : u.id;
    const entries = usageLog.filter(u => {
        const pid = String(getPrintId(u));
        const pgid = u.project_group_id != null ? String(u.project_group_id) : '';
        if (selectedPrintIds.has(pid)) return true;
        if (selectedProjectIds.has(pgid)) return true;
        return false;
    });

    const selectedRowCount = checked.length;
    const totalG = entries.reduce((s, e) => s + (parseFloat(e.weight_used) || 0), 0);
    const entriesCount = entries.length;

    const action = restoreFilament
        ? `Delete ${selectedRowCount} log group${selectedRowCount > 1 ? 's' : ''} (${entriesCount} filament entr${entriesCount > 1 ? 'ies' : 'y'}) and add ${Math.round(totalG)}g back to the relevant spool(s)?`
        : `Delete ${selectedRowCount} log group${selectedRowCount > 1 ? 's' : ''} (${entriesCount} filament entr${entriesCount > 1 ? 'ies' : 'y'}) without restoring filament?`;
    if (!confirm(action)) return;
    let ok = 0, fail = 0;
    for (const entry of entries) {
        try {
            await apiFetch(`/api/usage/${entry.id}`, { method:'DELETE', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ restore: restoreFilament }) });
            ok++;
        } catch { fail++; }
    }
    if (ok)   showToast(`✓ Deleted ${selectedRowCount} log group${selectedRowCount > 1 ? 's' : ''} · ${ok} filament entr${ok > 1 ? 'ies' : 'y'}${restoreFilament?' — filament restored':''}`, 'success');
    if (fail) showToast(`${fail} deletion(s) failed`, 'error');
    await loadAll(); await loadUsage();
}

function openEditUsageModal(id) {
    const entry = usageLog.find(u => u.id == id);
    if (!entry) return;
    const spoolSel = document.getElementById('usage-edit-spool');
    spoolSel.innerHTML = filaments.map(f =>
        `<option value="${f.id}" ${String(f.id) === String(entry.filament_id) ? 'selected' : ''}>${f.brand} ${f.color_name} · ${f.material}${f.style ? ' ' + f.style : ''}</option>`
    ).join('');
    document.getElementById('usage-edit-id').value = entry.id;
    document.getElementById('usage-edit-grams').value = parseFloat(entry.weight_used || 0).toFixed(1);
    document.getElementById('usage-edit-project').value = entry.project_name || '';
    document.getElementById('usage-edit-date').value = entry.created_at ? entry.created_at.slice(0, 10) : '';
    document.getElementById('usage-edit-modal-overlay').classList.add('open');
}

function closeUsageEditModal() {
    document.getElementById('usage-edit-modal-overlay').classList.remove('open');
}

async function submitUsageEdit() {
    const id = document.getElementById('usage-edit-id').value;
    const filamentId = parseInt(document.getElementById('usage-edit-spool').value, 10);
    const grams = parseFloat(document.getElementById('usage-edit-grams').value);
    const project = document.getElementById('usage-edit-project').value || 'Manual';
    const date = document.getElementById('usage-edit-date').value || null;
    if (!id || !filamentId) { showToast('Please select a spool.', 'error'); return; }
    if (!grams || grams <= 0) { showToast('Enter a valid weight.', 'error'); return; }
    try {
        await apiFetch(`/api/usage/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filament_id: filamentId, grams, project, date }),
        });
        showToast('✓ Usage entry updated', 'success');
        closeUsageEditModal();
        await loadAll();
    } catch (err) {
        showToast('Could not update usage entry: ' + err.message, 'error');
    }
}

// ============================================================
// SIDEBAR
// ============================================================
function openSidebar(cardEl) {
    sidebarMode = 'filament';
    document.getElementById('sb-filament-mode')?.classList.remove('hidden');
    document.getElementById('sb-print-mode')?.classList.add('hidden');

    // Restore footer actions for filament mode.
    document.getElementById('sb-use-btn').style.display  = 'block';
    document.getElementById('sb-edit-btn').style.display = 'block';
    document.getElementById('sb-buy-link').style.display = 'inline-block';
    document.getElementById('sb-chip-wrap').style.display = 'block';

    const id        = cardEl.dataset.id;
    const brand     = cardEl.dataset.brand;
    const material  = cardEl.dataset.material;
    const colorName = cardEl.dataset.colorName;
    const style     = cardEl.dataset.style;
    const code      = cardEl.dataset.code;
    const webAddr   = cardEl.dataset.webAddress;
    const weight    = parseFloat(cardEl.dataset.weightCurrent) || 0;
    const total     = parseFloat(cardEl.dataset.totalPurchased) || 0;
    const hex       = cardEl.dataset.hex || '#4f8ef7';
    const colorImage= cardEl.dataset.colorImage || '';
    const price     = parseFloat(cardEl.dataset.price) || 0;
    const priceIsFree = cardEl.dataset.priceIsFree === '1';
    const spoolW    = parseFloat(cardEl.dataset.spoolWeight) || 1000;

    document.getElementById('sb-accent-bar').style.background = hex;
    const chipImg = document.getElementById('sb-chip-img');
    const chipFallback = document.getElementById('sb-chip-fallback');
    if (chipImg && chipFallback) {
        if (colorImage) {
            chipImg.src = colorImage;
            chipImg.style.display = 'block';
            chipFallback.style.display = 'none';
        } else {
            chipImg.removeAttribute('src');
            chipImg.style.display = 'none';
            chipFallback.style.display = 'block';
            chipFallback.style.background = hex;
        }
    }

    const ms = matStyle(material);
    const badge = document.getElementById('sb-badge');
    badge.textContent    = material || '?';
    badge.style.background = ms.bg;
    badge.style.color      = ms.text;

    document.getElementById('sb-brand').textContent = brand || 'Unknown';
    document.getElementById('sb-label').textContent = [colorName, style].filter(Boolean).join(' · ') || '—';

    const pct    = Math.min(100, Math.round((weight / spoolW) * 100));
    const isLow  = weight > 0 && weight < 150;
    const isEmpty= weight === 0;
    document.getElementById('sb-weight').innerHTML             = Math.round(weight) + '<span class="text-sm font-normal ml-1" style="color:var(--muted)">g</span>';
    document.getElementById('sb-progress').style.width         = pct + '%';
    document.getElementById('sb-progress').style.background    = isEmpty ? 'var(--red)' : isLow ? 'var(--orange)' : 'var(--green)';
    document.getElementById('sb-status').textContent           = isEmpty ? 'EMPTY' : isLow ? 'LOW STOCK' : 'OK';
    document.getElementById('sb-status').style.color           = isEmpty ? 'var(--red)' : isLow ? 'var(--orange)' : 'var(--green)';
    document.getElementById('sb-pct').textContent              = pct + '% remaining';

    document.getElementById('sb-material').textContent = material || '—';
    document.getElementById('sb-style').textContent    = style    || '—';
    document.getElementById('sb-code').textContent     = code     || '—';
    document.getElementById('sb-total').textContent    = total > 0 ? total + ' spools' : '—';

    const amsEl = document.getElementById('sb-ams');
    const isAms = cardEl.dataset.ams !== '0';
    if (amsEl) { amsEl.textContent = isAms ? 'Yes ✓' : 'No'; amsEl.style.color = isAms ? 'var(--green)' : 'var(--red)'; }

    // Cost info in sidebar
    const priceEl = document.getElementById('sb-price');
    if (priceEl) {
        const f   = filaments.find(x => x.id == id);
        const cpg = f ? costPerGram(f) : null;
        if (priceIsFree) {
            priceEl.textContent = 'FREE' + (cpg === 0 ? ' · £0.00/g' : '');
            priceEl.style.color = 'var(--green)';
        } else if (price > 0) {
            priceEl.textContent = `${formatGBP(price)}${cpg != null ? ` · ${formatGBP(cpg)}/g` : ''}${spoolW !== 1000 ? ` (${spoolW}g spool)` : ''}`;
            priceEl.style.color = '';
        } else {
            priceEl.textContent = '—';
            priceEl.style.color = '';
        }
    }

    const notes = cardEl.dataset.notes || '';
    const notesWrap = document.getElementById('sb-notes-wrap');
    const notesEl   = document.getElementById('sb-notes');
    if (notes) { notesWrap.classList.remove('hidden'); notesEl.textContent = notes; }
    else        { notesWrap.classList.add('hidden'); }

    const f = filaments.find(x => x.id == id) || { brand, material, color_name: colorName, style, web_address: webAddr };
    document.getElementById('sb-buy-link').href = getBuyLink(f);

    document.getElementById('sb-use-btn').onclick  = () => { closeSidebar(); openUsageModal(id, `${brand} ${colorName}`, weight); };
    document.getElementById('sb-edit-btn').onclick = () => { closeSidebar(); openEditModal(parseInt(id)); };

    const usageContainer = document.getElementById('sb-usage-list');
    usageContainer.innerHTML = '<p class="text-sm" style="color:var(--muted)">Loading…</p>';
    fetch('/api/usage?db=' + encodeURIComponent(currentDb)).then(r => r.json()).then(logs => {
        const mine = logs.filter(u => u.filament_id == id).slice(0, 6);
        if (!mine.length) { usageContainer.innerHTML = '<p class="text-sm" style="color:var(--muted)">No usage logged yet.</p>'; return; }
        const fObj = filaments.find(x => x.id == id);
        const cpg  = fObj ? costPerGram(fObj) : null;
        usageContainer.innerHTML = mine.map(u => {
            const pc = cpg ? cpg * (parseFloat(u.weight_used)||0) : null;
            return `<div class="flex justify-between items-center py-2.5" style="border-bottom:1px solid var(--border)">
                <div>
                    <p class="text-sm font-medium" style="color:var(--text)">${u.project_name || 'Manual'}</p>
                    <p class="text-xs mono" style="color:var(--muted)">${u.created_at ? new Date(u.created_at).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}) : ''}</p>
                </div>
                <div class="text-right">
                    <span class="text-sm font-black mono" style="color:var(--orange)">−${u.weight_used}g</span>
                    ${pc ? `<p class="text-xs mono" style="color:var(--muted)">${formatGBP(pc)}</p>` : ''}
                </div>
            </div>`;
        }).join('');
    }).catch(() => { usageContainer.innerHTML = '<p class="text-sm" style="color:var(--muted)">Could not load usage.</p>'; });

    document.getElementById('sidebar-overlay').style.display = 'block';
    document.getElementById('sidebar').style.transform       = 'translateX(0)';
}

function openPrintSidebar(printId) {
    sidebarMode = 'print';
    sidebarPrintId = printId;
    document.getElementById('sb-filament-mode')?.classList.add('hidden');
    document.getElementById('sb-print-mode')?.classList.remove('hidden');

    // Hide filament-specific actions, keep Edit btn for renaming.
    document.getElementById('sb-use-btn').style.display  = 'none';
    document.getElementById('sb-buy-link').style.display  = 'none';
    document.getElementById('sb-chip-wrap').style.display = 'none';
    const editBtn = document.getElementById('sb-edit-btn');
    editBtn.style.display = 'block';
    editBtn.textContent = '✏️ Rename';
    editBtn.onclick = () => renamePrintFromSidebar();

    // Hide the project-prints-section (only used in project view)
    document.getElementById('sb-project-prints-section')?.classList.add('hidden');

    const pidStr = String(printId);
    const rows = usageLog.filter(u => String(u.print_id != null ? u.print_id : u.id) === pidStr);

    const totalG = rows.reduce((s, u) => s + (parseFloat(u.weight_used) || 0), 0);
    const first = rows[0];
    const project = first?.print_project_name || first?.project_name || 'Manual';
    const parentProjectName = first?.project_group_name || null;
    const parentProjectId = first?.project_group_id || null;
    const dateRaw = first?.print_created_at || first?.created_at;
    const dateLabel = dateRaw
        ? new Date(dateRaw.length === 10 ? dateRaw + 'T00:00:00' : dateRaw)
            .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
        : '—';

    // Header area
    document.getElementById('sb-accent-bar').style.background = '#4f8ef7';
    const badge = document.getElementById('sb-badge');
    if (badge) { badge.textContent = 'PRINT'; badge.style.background = 'rgba(79,142,247,0.15)'; badge.style.color = '#4f8ef7'; }
    document.getElementById('sb-brand').textContent = project || '—';
    document.getElementById('sb-label').textContent = dateLabel;

    // Print summary area
    document.getElementById('sb-print-project').textContent = project || '—';
    document.getElementById('sb-print-date').textContent    = dateLabel;
    document.getElementById('sb-print-total-used').textContent = totalG.toFixed(1);

    // Timelapse Section
    const timelapseWrap = document.getElementById('sb-print-timelapse-section');
    if (timelapseWrap) {
        timelapseWrap.classList.remove('hidden');
        const videoFile = first?.print_timelapse;
        renderTimelapseUI(videoFile);
    }

    // Wire up "Change Date" button if it exists in the HTML
    const changeDateBtn = document.getElementById('sb-change-date-btn');
    if (changeDateBtn) {
        changeDateBtn.style.display = 'inline-block';
        changeDateBtn.onclick = () => changePrintDateFromSidebar();
    }

    const parentWrap = document.getElementById('sb-print-parent-project-wrap');
    if (parentWrap) parentWrap.style.display = 'block';
    const parentEl = document.getElementById('sb-print-parent-project');
    if (parentEl) parentEl.textContent = parentProjectName ? parentProjectName : '—';

    const list = document.getElementById('sb-print-filament-list');
    if (!list) return;
    if (!rows.length) {
        list.innerHTML = '<p class="text-sm" style="color:var(--muted)">No filaments found for this print.</p>';
    } else {
        list.innerHTML = rows
            .slice()
            .sort((a, b) => String(a.filament_label || '').localeCompare(String(b.filament_label || '')))
            .map(u => {
                const fObj = filaments.find(x => x.id == u.filament_id);
                const cpg = fObj ? costPerGram(fObj) : null;
                const pc  = cpg ? cpg * (parseFloat(u.weight_used) || 0) : null;
                const hex = fObj?.color_hex || getColourHex(fObj?.color_name || '');
                const label = u.filament_label || `Spool #${u.filament_id}`;
                const dateLine = u.created_at
                    ? new Date(u.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
                    : '';

                return `<div class="flex justify-between items-start gap-3 py-2" style="border-bottom:1px solid var(--border)">
                    <div class="min-w-0">
                        <div class="flex items-center gap-2">
                            <span style="width:14px;height:14px;border-radius:4px;background:${hex};border:2px solid rgba(128,128,128,0.25);flex-shrink:0;display:inline-block"></span>
                            <p class="text-sm font-medium truncate" style="color:var(--text)">${esc(label)}</p>
                        </div>
                        <p class="text-xs mono mt-0.5" style="color:var(--muted)">${dateLine}</p>
                    </div>
                    <div class="text-right">
                        <p class="text-sm mono font-black" style="color:var(--orange)">${(parseFloat(u.weight_used)||0).toFixed(1)}g</p>
                        <p class="text-xs mono" style="color:var(--muted)">${pc ? formatGBP(pc) : '—'}</p>
                        <button onclick="openEditUsageModal(${u.id})" class="btn-ghost text-xs py-1 px-2 mt-1">✏️</button>
                    </div>
                </div>`;
            })
            .join('');
    }

    document.getElementById('sidebar-overlay').style.display = 'block';
    document.getElementById('sidebar').style.transform       = 'translateX(0)';
}

function renderTimelapseUI(videoFile) {
    const container = document.getElementById('sb-print-timelapse-container');
    if (!container) return;

    if (videoFile) {
        container.innerHTML = `
            <div class="relative rounded-xl overflow-hidden border border-border bg-black">
                <video src="/uploads/${videoFile}" controls class="w-full block" style="max-height:300px"></video>
                <button onclick="removeTimelapseFromPrint()" class="absolute top-2 right-2 bg-black/50 hover:bg-red-600/80 text-white rounded-full w-6 h-6 flex items-center justify-center text-xs transition-colors">✕</button>
            </div>
        `;
    } else {
        container.innerHTML = `
            <div class="p-6 border-2 border-dashed border-border rounded-xl text-center">
                <p class="text-xs mb-3" style="color:var(--muted)">No timelapse attached.</p>
                <input type="file" id="timelapse-upload-input" accept="video/*" class="hidden" onchange="handleTimelapseUpload(this)">
                <button onclick="document.getElementById('timelapse-upload-input').click()" class="btn-ghost text-xs py-1 px-3">
                    🎬 Upload Video
                </button>
                <p class="text-[10px] mt-2" style="color:var(--muted)">MP4 / WebM (Max 50MB)</p>
            </div>
        `;
    }
}

async function handleTimelapseUpload(input) {
    const file = input.files[0];
    if (!file || !sidebarPrintId) return;

    const formData = new FormData();
    formData.append('file', file);

    showToast('Uploading timelapse...', 'info');
    
    try {
        const res = await fetch('/api/upload/timelapse', { method: 'POST', body: formData });
        const data = await res.json();
        
        if (!res.ok) throw new Error(data.error);

        await apiFetch(`/api/usage/prints/${sidebarPrintId}/timelapse`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: data.filename })
        });

        showToast('✓ Timelapse added', 'success');
        await loadUsage();
        openPrintSidebar(sidebarPrintId);
    } catch (err) {
        showToast('Upload failed: ' + err.message, 'error');
    }
}

async function removeTimelapseFromPrint() {
    if (!confirm('Remove this timelapse video?')) return;
    if (!sidebarPrintId) return;

    try {
        await apiFetch(`/api/usage/prints/${sidebarPrintId}/timelapse`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: null })
        });
        
        showToast('✓ Timelapse removed', 'success');
        await loadUsage();
        openPrintSidebar(sidebarPrintId);
    } catch (err) {
        showToast('Could not remove timelapse.', 'error');
    }
}

async function loadUsageProjectsIfNeeded() {
    if (usageProjects && usageProjects.length) return;
    try {
        usageProjects = await apiFetch('/api/usage/projects');
    } catch {
        usageProjects = [];
    }
}

async function setPrintParentProjectFromSidebar() {
    if (!sidebarPrintId) return;
    const current = document.getElementById('sb-print-parent-project')?.textContent || '';
    const name = prompt('Parent project name (blank to clear):', current && current !== '—' ? current : '');
    if (name === null) return;
    const trimmed = (name || '').trim();
    if (!trimmed) {
        await clearPrintParentProjectFromSidebar();
        return;
    }

    await loadUsageProjectsIfNeeded();
    let existing = usageProjects.find(p => (p.project_name || p.name) === trimmed);
    if (!existing) {
        const res = await apiFetch('/api/usage/projects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project_name: trimmed }),
        });
        if (res?.id) existing = { id: res.id, project_name: trimmed };
    }

    try {
        await apiFetch(`/api/usage/prints/${sidebarPrintId}/project`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project_name: trimmed, project_id: existing?.id ?? null }),
        });
        await loadUsage();
        openPrintSidebar(sidebarPrintId);
    } catch {
        showToast('Could not assign print to project.', 'error');
    }
}

async function clearPrintParentProjectFromSidebar() {
    if (!sidebarPrintId) return;
    try {
        await apiFetch(`/api/usage/prints/${sidebarPrintId}/project`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project_id: null }),
        });
        await loadUsage();
        openPrintSidebar(sidebarPrintId);
    } catch {
        showToast('Could not clear print project.', 'error');
    }
}

async function renamePrintFromSidebar() {
    if (!sidebarPrintId) return;
    const current = document.getElementById('sb-print-project')?.textContent || '';
    const newName = prompt('Rename print:', current !== '—' ? current : '');
    if (newName === null) return;
    const trimmed = (newName || '').trim();
    if (!trimmed) { showToast('Print name cannot be empty.', 'error'); return; }
    try {
        await apiFetch(`/api/usage/prints/${sidebarPrintId}/rename`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project_name: trimmed }),
        });
        showToast('✓ Print renamed', 'success');
        await loadUsage();
        openPrintSidebar(sidebarPrintId);
    } catch (err) {
        showToast('Could not rename print: ' + err.message, 'error');
    }
}

async function changePrintDateFromSidebar() {
    if (!sidebarPrintId) return;
    const rows = usageLog.filter(u => String(u.print_id != null ? u.print_id : u.id) === String(sidebarPrintId));
    const existing = rows[0]?.print_created_at || rows[0]?.created_at || '';
    const currentVal = existing ? existing.slice(0, 10) : new Date().toISOString().slice(0, 10);
    const newDate = prompt('Set print date (YYYY-MM-DD):', currentVal);
    if (newDate === null) return;
    const trimmed = (newDate || '').trim();
    if (!trimmed.match(/^\d{4}-\d{2}-\d{2}$/)) { showToast('Enter a valid date (YYYY-MM-DD).', 'error'); return; }
    try {
        await apiFetch(`/api/usage/prints/${sidebarPrintId}/date`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date: trimmed }),
        });
        showToast('✓ Print date updated', 'success');
        await loadAll();
        openPrintSidebar(sidebarPrintId);
    } catch (err) {
        showToast('Could not update date: ' + err.message, 'error');
    }
}

function openProjectSidebar(projectId) {
    sidebarMode = 'print';
    // Hide filament-specific section and footer actions.
    document.getElementById('sb-filament-mode')?.classList.add('hidden');
    document.getElementById('sb-print-mode')?.classList.remove('hidden');
    document.getElementById('sb-use-btn').style.display  = 'none';
    document.getElementById('sb-buy-link').style.display  = 'none';
    document.getElementById('sb-chip-wrap').style.display = 'none';
    const editBtnP = document.getElementById('sb-edit-btn');
    editBtnP.style.display = 'none';
    editBtnP.textContent = '✏️ Edit';

    const projectIdStr = String(projectId);
    const rows = usageLog.filter(u => String(u.project_group_id || '') === projectIdStr);

    const totalG = rows.reduce((s, u) => s + (parseFloat(u.weight_used) || 0), 0);
    const projectName = rows[0]?.project_group_name || `Project #${projectId}`;
    const latest = rows.reduce((max, u) => {
        const dt = u.print_created_at || u.created_at || '';
        return (dt > max) ? dt : max;
    }, '');
    const dateLabel = latest
        ? new Date(latest).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
        : '—';

    document.getElementById('sb-accent-bar').style.background = '#4f8ef7';
    const badge = document.getElementById('sb-badge');
    if (badge) { badge.textContent = 'PROJECT'; badge.style.background = 'rgba(79,142,247,0.15)'; badge.style.color = '#4f8ef7'; }
    document.getElementById('sb-brand').textContent = projectName || '—';
    document.getElementById('sb-label').textContent = dateLabel;

    // Hide the parent-project controls when viewing a project.
    const parentWrap = document.getElementById('sb-print-parent-project-wrap');
    if (parentWrap) parentWrap.style.display = 'none';

    // Show the label as PROJECT
    const modeLabel = document.getElementById('sb-print-mode-label');
    if (modeLabel) modeLabel.textContent = 'Project';

    document.getElementById('sb-print-project').textContent = projectName || '—';
    document.getElementById('sb-print-date').textContent    = dateLabel;
    document.getElementById('sb-print-total-used').textContent = totalG.toFixed(1);

    // ── Prints within this project ────────────────────────────────────────────
    const printSection = document.getElementById('sb-project-prints-section');
    const printsList   = document.getElementById('sb-project-prints-list');
    if (printSection && printsList) {
        const printMap = new Map();
        rows.forEach(u => {
            const pid = u.print_id != null ? u.print_id : u.id;
            let p = printMap.get(pid);
            if (!p) p = { print_id: pid, name: u.print_project_name || u.project_name || 'Manual', created_at: u.print_created_at || u.created_at, total_g: 0 };
            p.total_g += parseFloat(u.weight_used) || 0;
            if (u.print_project_name) p.name = u.print_project_name;
            printMap.set(pid, p);
        });
        const prints = [...printMap.values()].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
        if (prints.length) {
            printSection.classList.remove('hidden');
            printsList.innerHTML = prints.map(p => {
                const d = p.created_at
                    ? new Date(p.created_at.length === 10 ? p.created_at + 'T00:00:00' : p.created_at)
                        .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
                    : '—';
                return `<div class="flex justify-between items-center gap-3 py-2" style="border-bottom:1px solid var(--border)">
                    <div class="min-w-0">
                        <p class="text-sm font-medium truncate" style="color:var(--text)">${esc(p.name)}</p>
                        <p class="text-xs mono mt-0.5" style="color:var(--muted)">${d} · ${p.total_g.toFixed(1)}g</p>
                    </div>
                    <button onclick="openPrintSidebar(${p.print_id})" class="btn-ghost text-xs py-1 px-2 flex-shrink-0" title="View &amp; edit this print">🔎</button>
                </div>`;
            }).join('');
        } else {
            printSection.classList.add('hidden');
        }
    }

    // Aggregate filament breakdown across all prints in the project.
    const byFil = new Map();
    rows.forEach(u => {
        const fid = u.filament_id;
        if (fid == null) return;
        let g = byFil.get(fid);
        if (!g) g = { filament_id: fid, weight: 0 };
        g.weight += parseFloat(u.weight_used) || 0;
        byFil.set(fid, g);
    });

    const list = document.getElementById('sb-print-filament-list');
    if (!list) return;
    if (!rows.length || !byFil.size) {
        list.innerHTML = '<p class="text-sm" style="color:var(--muted)">No filament usage found for this project.</p>';
    } else {
        list.innerHTML = [...byFil.values()]
            .map(g => {
                const fObj = filaments.find(x => x.id == g.filament_id);
                const cpg = fObj ? costPerGram(fObj) : null;
                const pc = cpg ? cpg * g.weight : null;
                const hex = fObj?.color_hex || getColourHex(fObj?.color_name || '');
                const label = uLabelForFilament(fObj, g.filament_id);
                return `<div class="flex justify-between items-start gap-3 py-2" style="border-bottom:1px solid var(--border)">
                    <div class="min-w-0">
                        <div class="flex items-center gap-2">
                            <span style="width:14px;height:14px;border-radius:4px;background:${hex};border:2px solid rgba(128,128,128,0.25);flex-shrink:0;display:inline-block"></span>
                            <p class="text-sm font-medium truncate" style="color:var(--text)">${esc(label)}</p>
                        </div>
                    </div>
                    <div class="text-right">
                        <p class="text-sm mono font-black" style="color:var(--orange)">${(g.weight||0).toFixed(1)}g</p>
                        <p class="text-xs mono" style="color:var(--muted)">${pc ? formatGBP(pc) : '—'}</p>
                    </div>
                </div>`;
            })
            .join('');
    }

    document.getElementById('sidebar-overlay').style.display = 'block';
    document.getElementById('sidebar').style.transform       = 'translateX(0)';
}

function uLabelForFilament(fObj, fid) {
    if (!fObj) return `Spool #${fid}`;
    return fObj.brand ? `${fObj.brand} · ${fObj.color_name || ''}`.trim() : (fObj.color_name || `Spool #${fid}`);
}

function closeSidebar() {
    document.getElementById('sidebar').style.transform       = 'translateX(100%)';
    document.getElementById('sidebar-overlay').style.display = 'none';
}

// ============================================================
// SECTION SWITCHER
// ============================================================
function switchSection(section) {
    activeSection = section;
    ['filaments','materials','equipment','modelkits','barcodes','purchases','selling','nozzles'].forEach(s => {
        document.getElementById(`section-${s}`)?.classList.toggle('hidden', section !== s);
        document.getElementById(`section-btn-${s}`)?.classList.toggle('active', section === s);
    });
    if (section === 'materials') loadMaterials();
    if (section === 'equipment') loadEquipment();
    if (section === 'modelkits') loadModelKits();
    if (section === 'barcodes')  { loadBarcodeDb(); renderBarcodeDb(); }
    if (section === 'purchases') loadPurchases();
    if (section === 'selling')   loadSelling();
    if (section === 'nozzles')   loadNozzles();
    updateHeaderAddButton(section);
}

// Relabel / show-hide the prominent header Add button for the active section
const HEADER_ADD_LABELS = {
    filaments: 'Add Spool',
    materials: 'Add Material',
    equipment: 'Add Equipment',
    modelkits: 'Add Model Kit',
    barcodes:  'Add Entry',
    purchases: 'Add Purchase',
};
function updateHeaderAddButton(section) {
    const btn = document.getElementById('header-add-btn');
    if (!btn) return;
    const label = HEADER_ADD_LABELS[section];
    if (label) {
        const span = document.getElementById('header-add-label');
        if (span) span.textContent = label;
        btn.classList.remove('hidden');
    } else {
        btn.classList.add('hidden');
    }
}

// ============================================================
// APP SETTINGS (Filaments section toggle, etc.)
// ============================================================
async function loadAppSettings() {
    try {
        const settings = await apiFetch('/api/settings');
        applyFilamentsVisibility(settings.filaments_enabled !== false);
    } catch {
        // if it fails, leave the default (filaments visible) alone
    }
}

function applyFilamentsVisibility(enabled) {
    const btn = document.getElementById('section-btn-filaments');
    if (btn) btn.classList.toggle('hidden', !enabled);
    const checkbox = document.getElementById('settings-filaments-enabled');
    if (checkbox) checkbox.checked = enabled;
    if (!enabled && activeSection === 'filaments') {
        switchSection('materials');
    }
}

function openSettingsModal() {
    apiFetch('/api/settings').then(settings => {
        const checkbox = document.getElementById('settings-filaments-enabled');
        if (checkbox) checkbox.checked = settings.filaments_enabled !== false;
    }).catch(() => {});
    document.getElementById('settings-modal-overlay').classList.add('open');
}

function closeSettingsModal() {
    document.getElementById('settings-modal-overlay').classList.remove('open');
}

async function toggleFilamentsSection(checked) {
    applyFilamentsVisibility(checked);
    try {
        await apiFetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filaments_enabled: checked }),
        });
    } catch (err) {
        showToast('Could not save setting: ' + err.message, 'error');
    }
}

async function loadPurchases() {
    try {
        purchases = await apiFetch('/api/purchases');
        renderPurchases();
    } catch {
        showToast('Could not load purchase history.', 'error');
    }
}

function renderPurchases() {
    const search   = (document.getElementById('purch-search')?.value || '').toLowerCase();
    const dateFrom = document.getElementById('purch-date-from')?.value || '';
    const dateTo   = document.getElementById('purch-date-to')?.value   || '';
    const brand    = document.getElementById('purch-filter-brand')?.value    || '';
    const category = document.getElementById('purch-filter-category')?.value || '';
    const validation = document.getElementById('purch-filter-validation')?.value || '';

    const brands = [...new Set(purchases.map(p => p.brand).filter(Boolean))].sort();
    const setOpts = (id, items) => {
        const el = document.getElementById(id);
        if (!el) return;
        const current = el.value;
        const first = el.options[0]?.text || 'All';
        el.innerHTML = `<option value="">${first}</option>` + items.map(v => `<option value="${v}">${v}</option>`).join('');
        el.value = current;
    };
    setOpts('purch-filter-brand', brands);

    const catLabel = { filament: 'Filament', material: 'Material', equipment: 'Equipment', model_kit: 'Model Kit' };
    const catStyle = {
        filament:  { bg:'rgba(79,142,247,0.15)',  text:'#4f8ef7' },
        material:  { bg:'rgba(34,197,94,0.15)',   text:'#22c55e' },
        equipment: { bg:'rgba(245,158,11,0.15)',  text:'#f59e0b' },
        model_kit: { bg:'rgba(168,85,247,0.15)',  text:'#a855f7' },
    };

    let displayList = purchases.map(p => ({ ...p }));

    if (validation === 'orphaned') {
        displayList = displayList.filter(p => {
            if (p.item_category !== 'filament' || !p.source_filament_id) return false;
            const f = filaments.find(x => x.id == p.source_filament_id);
            if (f) return false;
            p.validation_msg = 'Spool ID not found (Orphaned)';
            return true;
        });
    } else if (validation === 'no-history') {
        displayList = filaments
            .filter(f => {
                const history = purchaseHistory[String(f.id)] || [];
                return (parseFloat(f.total_purchased) || 0) > 0 && history.length === 0;
            })
            .map(f => ({
                id: `miss-${f.id}`,
                source_filament_id: f.id,
                item_category: 'filament',
                brand: f.brand,
                material: f.material,
                color_name: f.color_name,
                style: f.style,
                qty: 0,
                notes: '!! MISSING LOG ENTRY !!',
                is_validation_error: true,
                validation_msg: `Spool says ${f.total_purchased} bought, but log is empty`
            }));
    } else if (validation === 'mismatch') {
        const mismatchFids = filaments.filter(f => {
            const history = purchaseHistory[String(f.id)] || [];
            const sum = history.reduce((s, h) => s + (parseFloat(h.qty) || 0), 0);
            return Math.abs(sum - (parseFloat(f.total_purchased) || 0)) > 0.001;
        }).map(f => String(f.id));

        const logRows = displayList.filter(p => p.item_category === 'filament' && mismatchFids.includes(String(p.source_filament_id)));
        logRows.forEach(p => {
            const f = filaments.find(x => x.id == p.source_filament_id);
            const history = purchaseHistory[String(f.id)] || [];
            const sum = history.reduce((s, h) => s + (parseFloat(h.qty) || 0), 0);
            p.validation_msg = `Total Qty Mismatch (Log Sum: ${sum} vs Spool Card: ${f.total_purchased})`;
        });

        const zeroHistoryRows = filaments
            .filter(f => (parseFloat(f.total_purchased) || 0) > 0 && (purchaseHistory[String(f.id)] || []).length === 0)
            .map(f => ({
                id: `miss-${f.id}`,
                source_filament_id: f.id,
                item_category: 'filament',
                brand: f.brand,
                material: f.material,
                color_name: f.color_name,
                style: f.style,
                qty: 0,
                notes: '!! NO LOG ENTRIES !!',
                is_validation_error: true,
                validation_msg: `Spool says ${f.total_purchased} bought, but log is empty`
            }));
        displayList = [...logRows, ...zeroHistoryRows];
    }

    const filtered = displayList.filter(p => {
        if (brand && p.brand !== brand) return false;
        if (category && (p.item_category || 'filament') !== category) return false;
        if (dateFrom && p.purchased_at && p.purchased_at.slice(0,10) < dateFrom) return false;
        if (dateTo   && p.purchased_at && p.purchased_at.slice(0,10) > dateTo)   return false;
        if (search) {
            const hay = `${p.brand||''} ${p.material||''} ${p.color_name||''} ${p.style||''} ${p.barcode||''} ${p.notes||''} ${p.validation_msg||''}`.toLowerCase();
            if (!hay.includes(search)) return false;
        }
        return true;
    });

    const sorted = applyTableSort(filtered, 'purchases', {
        date:     p => p.purchased_at || '',
        category: p => p.item_category || 'filament',
        brand:    p => p.brand || '',
        item:     p => `${p.material||''} ${p.color_name||''} ${p.style||''}`,
        notes:    p => (p.validation_msg || '') + (p.notes || ''),
        qty:      p => parseFloat(p.qty) || 0,
        price:    p => parseFloat(p.price_paid) || 0,
        total:    p => (parseFloat(p.price_paid)||0) * (parseFloat(p.qty)||1),
    });

    const countEl = document.getElementById('purch-filter-count');
    if (countEl) countEl.textContent = `${filtered.length} purchase${filtered.length !== 1 ? 's' : ''}`;
    const totalSpent = filtered.reduce((sum,p) => sum + ((parseFloat(p.price_paid)||0)*(parseFloat(p.qty)||1)), 0);
    const totalEl = document.getElementById('purch-total-spent');
    if (totalEl) totalEl.textContent = formatGBP(totalSpent);

    const body = document.getElementById('purch-list');
    if (!body) return;
    if (!sorted.length) {
        let emptyMsg = 'No purchases match your filters.';
        if (validation === 'mismatch')   emptyMsg = '✨ No quantity mismatches found! Inventory and logs are in sync.';
        if (validation === 'no-history') emptyMsg = '✨ Every spool with a purchase count has a history entry.';
        if (validation === 'orphaned')   emptyMsg = '✨ No orphaned log entries found.';

        body.innerHTML = `<tr><td colspan="10" class="text-center py-12" style="color:var(--muted)">${emptyMsg}</td></tr>`;
        purchCheckChange();
        updateTableSortHeaders();
        return;
    }

    body.innerHTML = sorted.map(p => {
        const cat  = p.item_category || 'filament';
        const cs   = catStyle[cat] || catStyle.filament;
        const hex  = p.color_hex && /^#[0-9a-f]{3,6}$/i.test(p.color_hex.trim()) ? p.color_hex.trim() : null;
        const swatch = hex ? `<span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${hex};border:1px solid rgba(128,128,128,0.3);margin-right:4px;flex-shrink:0;vertical-align:middle"></span>` : '';

        // Build item description based on category
        let itemDesc = '';
        if (cat === 'filament') {
            itemDesc = [p.material, p.color_name, p.style].filter(Boolean).join(' · ');
        } else if (cat === 'material') {
            itemDesc = [p.material, p.color_name].filter(Boolean).join(' · ');
        } else if (cat === 'equipment') {
            itemDesc = [p.material, p.color_name].filter(Boolean).join(' · ');
        } else if (cat === 'model_kit') {
            itemDesc = [p.color_name, p.style].filter(Boolean).join(' · ');
        }
        
        const errorStyle = p.validation_msg 
            ? 'border-left: 4px solid var(--red); background: rgba(239, 68, 68, 0.05);' 
            : '';
            
        const notesContent = p.validation_msg 
            ? `<span style="color:var(--red); font-weight:bold;">[ISSUE: ${p.validation_msg}]</span> ${esc(p.notes||'')}`
            : esc(p.notes||'');

        return `<tr style="${errorStyle}">
        <td class="px-2" style="width:36px">${p.is_validation_error ? '' : `<input type="checkbox" class="purch-check" data-id="${p.id}" onchange="purchCheckChange()">`}</td>
        <td class="mono text-xs" style="color:var(--text2)">${p.purchased_at ? new Date(p.purchased_at).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}) : '—'}</td>
        <td><span class="badge" style="background:${cs.bg};color:${cs.text}">${catLabel[cat]||cat}</span></td>
        <td style="color:var(--text)">${esc(p.brand||'—')}</td>
        <td style="color:var(--text2)">${swatch}${esc(itemDesc||'—')}</td>
        <td class="text-xs" style="color:var(--text2)">${notesContent}</td>
        <td class="mono font-bold" style="color:var(--accent)">${parseFloat(p.qty||1).toFixed(1)}</td>
        <td class="mono text-xs" style="color:var(--green)">${p.price_paid!=null ? formatGBP(p.price_paid) : '—'}</td>
        <td class="mono text-xs" style="color:var(--green)">${p.price_paid!=null ? formatGBP((parseFloat(p.price_paid)||0)*(parseFloat(p.qty)||1)) : '—'}</td>
        <td><div class="flex gap-2">${p.is_validation_error ? '' : `
            <button onclick="openPurchaseEditModal(${p.id})" class="btn-ghost py-1 px-2 text-xs">✏️</button>
            <button onclick="deletePurchaseEntry(${p.id})" class="btn-danger py-1 px-2 text-xs">🗑</button>
        `}</div></td>
    </tr>`;
    }).join('');

    purchCheckChange();
    updateTableSortHeaders();
}

async function syncPurchaseTotals() {
    if (!confirm("This will update all Spool Cards to match the quantities in your Purchase Log. Proceed?")) return;
    try {
        await apiFetch('/api/purchases/sync-all', { method: 'POST' });
        showToast('✓ All spool totals synced with purchase logs', 'success');
        await loadAll();
        renderPurchases();
    } catch (err) {
        showToast('Sync failed: ' + err.message, 'error');
    }
}

// ============================================================
// PURCHASE SELECTION
// ============================================================
function purchCheckChange() {
    const checked = document.querySelectorAll('#purch-list .purch-check:checked');
    const all     = document.querySelectorAll('#purch-list .purch-check');
    const toolbar = document.getElementById('purch-toolbar');
    if (toolbar) toolbar.classList.toggle('hidden', checked.length === 0);

    const countEl = document.getElementById('purch-sel-count');
    if (countEl) countEl.textContent = `${checked.length} selected`;

    const mc = document.getElementById('purch-check-all');
    if (mc) {
        mc.indeterminate = checked.length > 0 && checked.length < all.length;
        mc.checked = checked.length === all.length && all.length > 0;
    }
}
function purchToggleAll(state) {
    document.querySelectorAll('#purch-list .purch-check').forEach(cb => cb.checked = state);
    purchCheckChange();
}
function purchSelectAll()  { purchToggleAll(true);  }
function purchSelectNone() { purchToggleAll(false); }

async function purchDeleteSelected() {
    const checked = [...document.querySelectorAll('#purch-list .purch-check:checked')];
    if (!checked.length) return;

    const ids = checked
        .map(cb => parseInt(cb.dataset.id, 10))
        .filter(id => !Number.isNaN(id));

    if (!ids.length) return;

    const count = ids.length;
    if (!confirm(`Delete ${count} purchase entr${count > 1 ? 'ies' : 'y'}?`)) return;

    let ok = 0, fail = 0;
    for (const pid of ids) {
        try {
            await apiFetch(`/api/purchases/${pid}`, { method: 'DELETE' });
            ok++;
        } catch {
            fail++;
        }
    }

    if (ok) showToast(`✓ Deleted ${ok} purchase entr${ok > 1 ? 'ies' : 'y'}`, 'success');
    if (fail) showToast(`${fail} deletion(s) failed`, 'error');

    await loadPurchases();
}

function openPurchaseEditModal(id) {
    const p = purchases.find(x => x.id == id);
    if (!p) return;
    document.getElementById('purchase-edit-id').value = id;
    const isFree = p.price_paid === 0 && p.price_is_free;
    document.getElementById('purchase-edit-price-free').checked = isFree;
    if (isFree) {
        document.getElementById('purchase-edit-price').value = '';
        document.getElementById('purchase-edit-price').disabled = true;
        document.getElementById('purchase-edit-price').placeholder = 'Free / £0';
    } else {
        document.getElementById('purchase-edit-price').value = p.price_paid ?? '';
        document.getElementById('purchase-edit-price').disabled = false;
        document.getElementById('purchase-edit-price').placeholder = '';
    }
    document.getElementById('purchase-edit-qty').value = p.qty ?? 1;
    document.getElementById('purchase-edit-date').value = p.purchased_at ? p.purchased_at.slice(0, 10) : '';
    document.getElementById('purchase-edit-notes').value = p.notes ?? '';
    document.getElementById('purchase-edit-modal-overlay').classList.add('open');
}

function closePurchaseEditModal() {
    document.getElementById('purchase-edit-modal-overlay').classList.remove('open');
}

function onPurchaseAddCategoryChange() {
    const cat = document.getElementById('purchase-add-category').value;
    document.getElementById('purchase-add-spool-row').classList.toggle('hidden',     cat !== 'filament');
    document.getElementById('purchase-add-material-row').classList.toggle('hidden',  cat !== 'material');
    document.getElementById('purchase-add-equipment-row').classList.toggle('hidden', cat !== 'equipment');
    document.getElementById('purchase-add-modelkit-row').classList.toggle('hidden',  cat !== 'model_kit');
    // Pre-fill price from selected item
    onPurchaseAddItemChange();
}

function onPurchaseAddSpoolChange() {
    const id  = parseInt(document.getElementById('purchase-add-spool').value, 10);
    const f   = filaments.find(x => x.id === id);
    if (f && f.price_paid) document.getElementById('purchase-add-price').value = f.price_paid;
}

function onPurchaseAddItemChange() {
    const cat = document.getElementById('purchase-add-category').value;
    let price = null;
    if (cat === 'material') {
        const id = parseInt(document.getElementById('purchase-add-material-sel').value, 10);
        const m  = materials.find(x => x.id === id);
        if (m && m.price_paid) price = m.price_paid;
    } else if (cat === 'equipment') {
        const id = parseInt(document.getElementById('purchase-add-equipment-sel').value, 10);
        const e  = equipment.find(x => x.id === id);
        if (e && e.price_paid) price = e.price_paid;
    } else if (cat === 'model_kit') {
        const id = parseInt(document.getElementById('purchase-add-modelkit-sel').value, 10);
        const k  = modelKits.find(x => x.id === id);
        if (k && k.price_paid) price = k.price_paid;
    }
    if (price != null) document.getElementById('purchase-add-price').value = price;
}

function openPurchaseAddModal() {
    // Populate all dropdowns
    const spoolSel = document.getElementById('purchase-add-spool');
    spoolSel.innerHTML = filaments.map(f =>
        `<option value="${f.id}">${esc(f.brand||'—')} ${esc(f.color_name||'—')} · ${esc(f.material||'?')}</option>`
    ).join('');

    const matSel = document.getElementById('purchase-add-material-sel');
    matSel.innerHTML = materials.map(m =>
        `<option value="${m.id}">${esc(m.brand||'—')} ${esc(m.type||'—')}</option>`
    ).join('');

    const eqSel = document.getElementById('purchase-add-equipment-sel');
    eqSel.innerHTML = equipment.map(e =>
        `<option value="${e.id}">${esc(e.category||'—')} · ${esc(e.brand||'')} ${esc(e.model||'')}</option>`
    ).join('');

    const mkSel = document.getElementById('purchase-add-modelkit-sel');
    mkSel.innerHTML = modelKits.map(k =>
        `<option value="${k.id}">${esc(k.brand||'—')} ${esc(k.kit_name||'—')}</option>`
    ).join('');

    document.getElementById('purchase-add-category').value = 'filament';
    onPurchaseAddCategoryChange();
    document.getElementById('purchase-add-date').value = new Date().toISOString().slice(0, 10);
    document.getElementById('purchase-add-qty').value  = '1';
    document.getElementById('purchase-add-price').value = '';
    document.getElementById('purchase-add-price').disabled = false;
    document.getElementById('purchase-add-price').placeholder = 'e.g. 19.99';
    document.getElementById('purchase-add-price-free').checked = false;
    document.getElementById('purchase-add-notes').value = '';
    // Pre-fill price from first spool
    onPurchaseAddSpoolChange();
    document.getElementById('purchase-add-modal-overlay').classList.add('open');
}

function closePurchaseAddModal() {
    document.getElementById('purchase-add-modal-overlay').classList.remove('open');
}

async function submitPurchaseAdd() {
    const cat    = document.getElementById('purchase-add-category').value;
    const date   = document.getElementById('purchase-add-date').value;
    const qty    = parseFloat(document.getElementById('purchase-add-qty').value);
    const isFree = document.getElementById('purchase-add-price-free').checked;
    const price  = isFree ? 0 : parseFloat(document.getElementById('purchase-add-price').value);
    const notes  = (document.getElementById('purchase-add-notes')?.value || '').trim();

    if (!isFree && (isNaN(price) || price < 0)) { showToast('Enter a valid price.', 'error'); return; }
    if (isNaN(qty) || qty <= 0) { showToast('Enter a valid quantity.', 'error'); return; }

    const body = {
        item_category: cat,
        price_paid: price,
        price_is_free: isFree,
        qty,
        purchased_at: date ? `${date} 00:00:00` : null,
        notes: notes || null,
    };

    if (cat === 'filament') {
        const sourceId = parseInt(document.getElementById('purchase-add-spool').value, 10);
        if (!sourceId) { showToast('Please select a spool.', 'error'); return; }
        body.source_filament_id = sourceId;
    } else if (cat === 'material') {
        const id = parseInt(document.getElementById('purchase-add-material-sel').value, 10);
        if (!id) { showToast('Please select a material.', 'error'); return; }
        const m = materials.find(x => x.id === id);
        if (m) { body.brand = m.brand; body.material = m.type; body.color_hex = m.color_hex || null; }
    } else if (cat === 'equipment') {
        const id = parseInt(document.getElementById('purchase-add-equipment-sel').value, 10);
        if (!id) { showToast('Please select equipment.', 'error'); return; }
        const e = equipment.find(x => x.id === id);
        if (e) { body.brand = e.brand; body.material = e.category; body.color_name = e.model; }
    } else if (cat === 'model_kit') {
        const id = parseInt(document.getElementById('purchase-add-modelkit-sel').value, 10);
        if (!id) { showToast('Please select a model kit.', 'error'); return; }
        const k = modelKits.find(x => x.id === id);
        if (k) { body.brand = k.brand; body.color_name = k.kit_name; body.style = k.model_no || ''; }
    }

    try {
        await apiFetch('/api/purchases', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        showToast('✓ Purchase entry added', 'success');
        closePurchaseAddModal();
        await loadAll();
        await loadPurchases();
    } catch (err) {
        showToast('Could not add entry: ' + err.message, 'error');
    }
}

async function submitPurchaseEdit() {
    const id = document.getElementById('purchase-edit-id').value;
    const isFree = document.getElementById('purchase-edit-price-free').checked;
    const price = isFree ? 0 : parseFloat(document.getElementById('purchase-edit-price').value);
    const qty = parseFloat(document.getElementById('purchase-edit-qty').value);
    const date = document.getElementById('purchase-edit-date').value;
    const rawNotes = document.getElementById('purchase-edit-notes')?.value || '';
    const notes = rawNotes.trim();
    if (!id) return;
    if (!isFree && (isNaN(price) || price < 0)) { showToast('Enter a valid price.', 'error'); return; }
    if (isNaN(qty) || qty <= 0) { showToast('Enter a valid quantity.', 'error'); return; }
    try {
        await apiFetch(`/api/purchases/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                price_paid: price,
                price_is_free: isFree,
                qty,
                purchased_at: date ? `${date} 00:00:00` : null,
                notes: notes ? notes : null,
            }),
        });
        showToast('✓ Price entry updated', 'success');
        closePurchaseEditModal();
        await loadAll();
        await loadPurchases();
    } catch (err) {
        showToast('Could not update entry: ' + err.message, 'error');
    }
}

async function deletePurchaseEntry(id) {
    if (!confirm('Delete this price history entry?')) return;
    try {
        await apiFetch(`/api/purchases/${id}`, { method: 'DELETE' });
        showToast('✓ Entry deleted', 'success');
        await loadAll();
        await loadPurchases();
    } catch (err) {
        showToast('Could not delete entry: ' + err.message, 'error');
    }
}

// ============================================================
// DATABASE MANAGEMENT
// ============================================================
async function loadDatabases() {
    try {
        const dbs = await fetch('/api/databases').then(r => r.json());
        const sel = document.getElementById('db-selector');
        sel.innerHTML = dbs.map(d => `<option value="${d}" ${d === currentDb ? 'selected' : ''}>${d}</option>`).join('');
        document.getElementById('db-status').textContent = currentDb.toUpperCase();
    } catch(e) {
        console.error('Could not load databases', e);
    }
}

function switchDatabase(name) {
    currentDb = name;
    localStorage.setItem('ff-db', name);
    document.getElementById('db-status').textContent = name.toUpperCase();
    loadAll();
    if (activeSection === 'materials') loadMaterials();
    if (activeSection === 'equipment') loadEquipment();
    if (activeSection === 'modelkits') loadModelKits();
    if (activeSection === 'barcodes')  loadBarcodeDb();
    if (activeSection === 'purchases') loadPurchases();
}

function downloadAllCsv() {
    window.location.href = '/api/export/all.csv?db=' + encodeURIComponent(currentDb);
}

function downloadBambuddyCsv() {
    window.location.href = '/api/export/bambuddy.csv?db=' + encodeURIComponent(currentDb);
}

document.getElementById('bambuddy-csv-upload')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    showToast('Importing Bambuddy CSV…', 'info');
    try {
        const csvText = await file.text();
        const res = await apiFetch('/api/import/bambuddy-csv', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ csv_text: csvText }),
        });
        if (res.error) { showToast(res.error, 'error'); return; }
        showToast(`✓ Bambuddy import: ${res.colours_created} new, ${res.colours_updated} updated (${res.spool_rows_processed} spool rows)`, 'success');
        await loadAll();
        await loadPurchases();
    } catch (err) {
        showToast('Bambuddy import failed: ' + err.message, 'error');
    } finally {
        e.target.value = '';
    }
});

document.getElementById('global-csv-upload')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    showToast('Importing global CSV…', 'info');
    try {
        const csvText = await file.text();
        const res = await apiFetch('/api/import/global-csv', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ csv_text: csvText }),
        });
        showToast(`✓ Imported global CSV (${res.rows || 0} rows)`, 'success');
        await loadAll();
        await loadMaterials();
        await loadEquipment();
        await loadModelKits();
        await loadBarcodeDb();
        await loadPurchases();
    } catch (err) {
        showToast('Global import failed: ' + err.message, 'error');
    }
    e.target.value = '';
});

// ── Header "Import / Export" dropdown ──────────────────────
function toggleDataMenu(e) {
    if (e) e.stopPropagation();
    document.getElementById('data-menu-list')?.classList.toggle('hidden');
}
function closeDataMenu() {
    document.getElementById('data-menu-list')?.classList.add('hidden');
}
document.addEventListener('click', (e) => {
    const menu = document.getElementById('data-menu');
    if (menu && !menu.contains(e.target)) closeDataMenu();
});

function headerImportExcel() {
    if (activeSection === 'filaments') document.getElementById('excel-upload')?.click();
    else if (activeSection === 'materials') document.getElementById('mat-excel-upload')?.click();
    else if (activeSection === 'barcodes') document.getElementById('bc-excel-upload')?.click();
    else showToast('Import is available for Filaments, Materials, and Barcode DB.', 'info');
}

function headerAddEntry() {
    if (activeSection === 'filaments') openAddModal();
    else if (activeSection === 'materials') openAddMaterialModal();
    else if (activeSection === 'equipment') openAddEquipmentModal();
    else if (activeSection === 'modelkits') openAddModelKitModal();
    else if (activeSection === 'barcodes') openAddBarcodeModal();
    else if (activeSection === 'purchases') openPurchaseAddModal();
}

function headerExport() {
    if (activeSection === 'filaments') exportToExcel();
    else if (activeSection === 'materials') exportMaterialsToExcel();
    else if (activeSection === 'barcodes') exportBarcodesExcel();
    else showToast('Use Global CSV for this section.', 'info');
}

function openNewDbModal() {
    document.getElementById('newdb-name').value = '';
    document.getElementById('newdb-preview').textContent = 'Will be saved as: spoolstats.db';
    document.getElementById('newdb-modal-overlay').classList.add('open');
    setTimeout(() => document.getElementById('newdb-name').focus(), 60);
}
function closeNewDbModal() { document.getElementById('newdb-modal-overlay').classList.remove('open'); }

function previewDbName() {
    const val  = document.getElementById('newdb-name').value.trim() || 'spoolstats';
    const safe = val.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    document.getElementById('newdb-preview').textContent = `Will be saved as: ${safe}.db`;
}

async function submitNewDb() {
    const val = document.getElementById('newdb-name').value.trim();
    if (!val) { showToast('Enter a name.', 'error'); return; }
    try {
        const res  = await fetch('/api/databases', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name: val }) });
        const data = await res.json();
        closeNewDbModal();
        showToast(`✓ Created database "${data.name}"`, 'success');
        await loadDatabases();
        switchDatabase(data.name);
    } catch(e) { showToast('Could not create database.', 'error'); }
}

function downloadCurrentDb() { window.location.href = `/api/databases/${encodeURIComponent(currentDb)}/download`; }

// ============================================================
// MATERIALS
// ============================================================
function formatQty(val) {
    const num = parseFloat(val || 0);
    if (Number.isNaN(num)) return '0';
    if (Math.abs(num - Math.round(num)) < 0.001) return String(Math.round(num));
    return num.toFixed(1).replace(/\.0$/, '');
}

function materialUnit(m) {
    return (m.stock_unit || 'items') === 'm' ? 'm' : 'items';
}

function materialAmountPerPurchase(m) {
    const amount = parseFloat(m.amount_per_purchase);
    return amount > 0 ? amount : 1;
}

function materialPurchased(m) {
    const amount = parseFloat(m.purchased);
    return Number.isNaN(amount) ? 0 : amount;
}

function materialUsed(m) {
    const amount = parseFloat(m.used);
    return Number.isNaN(amount) ? 0 : amount;
}

function materialTotal(m) {
    return materialPurchased(m) * materialAmountPerPurchase(m);
}

function materialRemaining(m) {
    return Math.max(0, materialTotal(m) - materialUsed(m));
}

function formatMaterialAmount(value, unit) {
    return unit === 'm' ? `${formatQty(value)}m` : formatQty(value);
}

async function loadMaterials() {
    try {
        materials = await apiFetch('/api/materials');
        renderMaterials();
        updateMatStats();
    } catch(e) { showToast('Could not load materials.', 'error'); }
}

function updateMatStats() {
    document.getElementById('mat-stat-count').textContent  = materials.length || '—';
    const brands = [...new Set(materials.map(m => m.brand).filter(Boolean))].length;
    document.getElementById('mat-stat-brands').textContent = brands || '—';
    const itemsRemaining = materials.filter(m => materialUnit(m) === 'items').reduce((sum, m) => sum + materialRemaining(m), 0);
    const metresRemaining = materials.filter(m => materialUnit(m) === 'm').reduce((sum, m) => sum + materialRemaining(m), 0);
    const remEl = document.getElementById('mat-stat-remaining');
    if (remEl) {
        const parts = [];
        if (itemsRemaining > 0) parts.push(`${formatQty(itemsRemaining)} items`);
        if (metresRemaining > 0) parts.push(`${formatQty(metresRemaining)}m`);
        remEl.textContent = parts.length ? parts.join(' / ') : '0';
    }
}

function renderMaterials() { populateMatFilters(); filterMaterials(); }

function populateMatFilters() {
    const brands = [...new Set(materials.map(m => m.brand).filter(Boolean))].sort();
    const types  = [...new Set(materials.map(m => m.type).filter(Boolean))].sort();
    const setOpts = (id, items) => {
        const el  = document.getElementById(id);
        const cur = el.value;
        el.innerHTML = `<option value="">${el.options[0].text}</option>` + items.map(v => `<option value="${v}">${v}</option>`).join('');
        el.value = cur;
    };
    setOpts('mat-filter-brand', brands);
    setOpts('mat-filter-type',  types);
}

function filterMaterials() {
    const search = document.getElementById('mat-search').value.toLowerCase();
    const brand  = document.getElementById('mat-filter-brand').value;
    const type   = document.getElementById('mat-filter-type').value;
    let filtered = materials.filter(m => {
        if (brand && m.brand !== brand) return false;
        if (type  && m.type  !== type)  return false;
        if (search) {
            if (!`${m.brand} ${m.type} ${m.model_no} ${m.barcode} ${m.notes || ''}`.toLowerCase().includes(search)) return false;
        }
        return true;
    });
    filtered = applyTableSort(filtered, 'materials', {
        brand: m => m.brand || '',
        type: m => m.type || '',
        colour: m => m.color_name || '',
        model: m => m.model_no || '',
        barcode: m => m.barcode || '',
        bought: m => materialTotal(m),
        used: m => materialUsed(m),
        remaining: m => materialRemaining(m),
        price: m => parseFloat(m.price_paid) || 0,
        notes: m => m.notes || '',
    });
    document.getElementById('mat-filter-count').textContent = `${filtered.length} item${filtered.length !== 1 ? 's' : ''}`;
    const body = document.getElementById('materials-list');
    if (!filtered.length) {
        body.innerHTML = '<tr><td colspan="11" class="text-center py-12" style="color:var(--muted)">No materials match your filters.</td></tr>';
        updateTableSortHeaders();
        return;
    }
    body.innerHTML = filtered.map(m => {
        const hex = m.color_hex || (m.color_name ? getColourHex(m.color_name) : '');
        const swatch = hex ? `<span style="display:inline-block;width:14px;height:14px;border-radius:4px;background:${hex};border:1px solid rgba(128,128,128,0.3);margin-right:6px;vertical-align:middle;flex-shrink:0"></span>` : '';
        return `<tr data-id="${m.id}">
        <td style="width:36px"><input type="checkbox" class="row-check mat-check" data-id="${m.id}" onchange="matCheckChange()"></td>
        <td class="font-medium" style="color:var(--text)">${esc(m.brand || '—')}</td>
        <td style="color:var(--text2)">${esc(m.type || '—')}</td>
        <td style="color:var(--text2)"><div class="flex items-center">${swatch}${esc(m.color_name || '—')}</div></td>
        <td class="mono text-xs" style="color:var(--muted)">${esc(m.model_no || '—')}</td>
        <td class="mono text-xs" style="color:var(--muted)">${esc(m.barcode || '—')}</td>
        <td class="mono text-xs" style="color:var(--accent)">
            <div class="font-bold">${formatMaterialAmount(materialTotal(m), materialUnit(m))}</div>
            <div style="color:var(--muted)">${formatQty(materialPurchased(m))} x ${formatMaterialAmount(materialAmountPerPurchase(m), materialUnit(m))}</div>
        </td>
        <td class="mono font-bold text-center" style="color:var(--orange)">${formatMaterialAmount(materialUsed(m), materialUnit(m))}</td>
        <td class="mono font-bold text-center" style="color:var(--green)">${formatMaterialAmount(materialRemaining(m), materialUnit(m))}</td>
        <td class="mono text-xs" style="color:var(--green)">${m.price_paid ? formatGBP(m.price_paid) : '—'}</td>
        <td class="text-xs" style="color:var(--text2)">${esc(m.notes || '')}</td>
        <td>
            <div class="flex gap-2">
                <button onclick="openMaterialUsageModal(${m.id})" class="btn-primary py-1 px-2 text-xs">− Use</button>
                <button onclick="openEditMaterialModal(${m.id})" class="btn-ghost py-1 px-2 text-xs">✏️</button>
                <button onclick="deleteMaterial(${m.id})" class="btn-danger py-1 px-2 text-xs">🗑</button>
            </div>
        </td>
    </tr>`;
    }).join('');
    updateTableSortHeaders();
}

function matCheckChange() {
    const checked = document.querySelectorAll('.mat-check:checked');
    const all     = document.querySelectorAll('.mat-check');
    document.getElementById('mat-toolbar').classList.toggle('hidden', checked.length === 0);
    document.getElementById('mat-sel-count').textContent = `${checked.length} selected`;
    const mc = document.getElementById('mat-check-all');
    if (mc) { mc.indeterminate = checked.length > 0 && checked.length < all.length; mc.checked = checked.length === all.length && all.length > 0; }
}
function matToggleAll(state) { document.querySelectorAll('.mat-check').forEach(cb => cb.checked = state); matCheckChange(); }
function matSelectAll()  { matToggleAll(true);  }
function matSelectNone() { matToggleAll(false); }

async function matDeleteSelected() {
    const checked = [...document.querySelectorAll('.mat-check:checked')];
    if (!checked.length) return;
    if (!confirm(`Delete ${checked.length} item(s)?`)) return;
    let ok = 0, fail = 0;
    for (const cb of checked) {
        try { await apiFetch(`/api/materials/${cb.dataset.id}`, { method:'DELETE' }); ok++; } catch { fail++; }
    }
    if (ok)   showToast(`✓ Deleted ${ok} item(s)`, 'success');
    if (fail) showToast(`${fail} deletion(s) failed`, 'error');
    await loadMaterials();
}

async function deleteMaterial(id) {
    if (!confirm('Delete this material?')) return;
    try { await apiFetch(`/api/materials/${id}`, { method:'DELETE' }); showToast('✓ Deleted', 'success'); await loadMaterials(); }
    catch { showToast('Delete failed', 'error'); }
}

function openAddMaterialModal() {
    editingMatId = null;
    document.getElementById('mat-modal-title').textContent = 'Add Material';
    document.getElementById('mat-modal-submit-btn').textContent = 'Add Material';
    document.getElementById('mat-edit-id').value = '';
    ['mat-brand','mat-type','mat-model','mat-barcode','mat-notes','mat-price','mat-roll-width','mat-roll-length','mat-colour-name','mat-colour-hex'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    document.getElementById('mat-purchased').value = '1';
    document.getElementById('mat-used').value = '0';
    document.getElementById('mat-stock-unit').value = 'items';
    document.getElementById('mat-amount-per-purchase').value = '1';
    const prev = document.getElementById('mat-colour-preview');
    if (prev) prev.style.background = 'transparent';
    document.getElementById('mat-modal-overlay').classList.add('open');
    setTimeout(() => document.getElementById('mat-brand').focus(), 60);
}

function openEditMaterialModal(id) {
    const m = materials.find(x => x.id == id);
    if (!m) return;
    editingMatId = id;
    document.getElementById('mat-modal-title').textContent = 'Edit Material';
    document.getElementById('mat-modal-submit-btn').textContent = 'Save Changes';
    document.getElementById('mat-edit-id').value    = id;
    document.getElementById('mat-brand').value      = m.brand      || '';
    document.getElementById('mat-type').value       = m.type       || '';
    document.getElementById('mat-model').value      = m.model_no   || '';
    document.getElementById('mat-barcode').value    = m.barcode    || '';
    document.getElementById('mat-purchased').value  = m.purchased  ?? 1;
    document.getElementById('mat-used').value       = m.used       ?? 0;
    document.getElementById('mat-stock-unit').value = materialUnit(m);
    document.getElementById('mat-amount-per-purchase').value = m.amount_per_purchase ?? 1;
    document.getElementById('mat-roll-width').value = m.roll_width ?? '';
    document.getElementById('mat-roll-length').value = m.roll_length ?? '';
    document.getElementById('mat-price').value      = m.price_paid || '';
    document.getElementById('mat-notes').value      = m.notes      || '';
    const nameEl = document.getElementById('mat-colour-name');
    const hexEl  = document.getElementById('mat-colour-hex');
    const prev   = document.getElementById('mat-colour-preview');
    if (nameEl) nameEl.value = m.color_name || '';
    if (hexEl)  hexEl.value  = m.color_hex  || '';
    if (prev)   prev.style.background = m.color_hex || (m.color_name ? getColourHex(m.color_name) : 'transparent');
    document.getElementById('mat-modal-overlay').classList.add('open');
}

function closeMatModal() { document.getElementById('mat-modal-overlay').classList.remove('open'); }

function previewMatColour() {
    const nameEl = document.getElementById('mat-colour-name');
    const hexEl  = document.getElementById('mat-colour-hex');
    const prev   = document.getElementById('mat-colour-preview');
    if (!prev) return;
    const hex = (hexEl && hexEl.value) || (nameEl && nameEl.value ? getColourHex(nameEl.value) : '');
    prev.style.background = hex || 'transparent';
    if (hexEl && !hexEl.value && nameEl && nameEl.value) hexEl.value = hex;
}

async function submitMaterial() {
    const stockUnit = document.getElementById('mat-stock-unit').value || 'items';
    const rollLength = parseFloat(document.getElementById('mat-roll-length').value);
    const amountPerPurchaseInput = parseFloat(document.getElementById('mat-amount-per-purchase').value);
    const colourName = document.getElementById('mat-colour-name')?.value || '';
    const colourHex  = document.getElementById('mat-colour-hex')?.value  || (colourName ? getColourHex(colourName) : null);
    const item = {
        brand:     document.getElementById('mat-brand').value,
        type:      document.getElementById('mat-type').value,
        model_no:  document.getElementById('mat-model').value,
        barcode:   document.getElementById('mat-barcode').value,
        purchased: parseFloat(document.getElementById('mat-purchased').value) || 1,
        used: parseFloat(document.getElementById('mat-used').value) || 0,
        stock_unit: stockUnit,
        amount_per_purchase: (stockUnit === 'm' && !Number.isNaN(rollLength) && rollLength > 0) ? rollLength : (amountPerPurchaseInput || 1),
        roll_width: parseFloat(document.getElementById('mat-roll-width').value) || null,
        roll_length: Number.isNaN(rollLength) ? null : rollLength,
        price_paid: parseFloat(document.getElementById('mat-price').value) || null,
        notes:     document.getElementById('mat-notes').value || null,
        color_name: colourName || null,
        color_hex:  colourHex  || null,
    };
    if (item.used < 0) { showToast('Used amount cannot be negative.', 'error'); return; }
    if ((item.purchased * item.amount_per_purchase) < item.used) { showToast('Used amount cannot exceed bought stock.', 'error'); return; }
    if (!item.brand && !item.type) { showToast('Enter at least a brand or type.', 'error'); return; }
    try {
        if (editingMatId) {
            await apiFetch(`/api/materials/${editingMatId}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(item) });
            showToast('✓ Material updated', 'success');
        } else {
            await apiFetch('/api/materials', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'add_single', item }) });
            showToast('✓ Material added', 'success');
        }
        closeMatModal();
        await loadMaterials();
    } catch(e) { showToast('Could not save: ' + e.message, 'error'); }
}

function exportMaterialsToExcel() {
    try {
        const wb   = XLSX.utils.book_new();
        const data = [['Brand','Type','Model No','Barcode','Purchased','Used','Tracking Unit','Amount Per Purchase','Roll Width','Roll Length','Price Paid','Notes']]
            .concat(materials.map(m => [
                m.brand, m.type, m.model_no, m.barcode, m.purchased, m.used || 0,
                materialUnit(m), m.amount_per_purchase || 1, m.roll_width || '', m.roll_length || '', m.price_paid || '', m.notes || '',
            ]));
        const sheet = XLSX.utils.aoa_to_sheet(data);
        sheet['!cols'] = [20,30,14,16,10,10,12,18,12,12,10,30].map(w => ({wch:w}));
        XLSX.utils.book_append_sheet(wb, sheet, 'Materials');
        XLSX.writeFile(wb, `SpoolStats_Materials_${new Date().toISOString().slice(0,10)}.xlsx`);
        showToast('✓ Materials exported', 'success');
    } catch(e) { showToast('Export failed: ' + e.message, 'error'); }
}

document.getElementById('mat-excel-upload').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    showToast('Reading Excel file…', 'info');
    try {
        const data = await file.arrayBuffer();
        const wb   = XLSX.read(data);
        const sheetName = wb.SheetNames.find(n => /material/i.test(n)) || wb.SheetNames[1] || wb.SheetNames[0];
        const sheet = wb.Sheets[sheetName];
        const rows  = XLSX.utils.sheet_to_json(sheet, { defval: null });
        const items = rows.filter(r => r['Brand'] || r['Type']).map(r => ({
            brand:     r['Brand']    || r['brand']    || '',
            type:      r['Type']     || r['type']     || '',
            model_no:  r['Model No'] || r['model_no'] || r['Model'] || '',
            barcode:   String(r['Barcode'] || r['barcode'] || ''),
            purchased: parseFloat(r['Purchased'] || r['purchased'] || 1) || 1,
            used: parseFloat(r['Used'] || r['used'] || 0) || 0,
            stock_unit: r['Tracking Unit'] || r['stock_unit'] || 'items',
            amount_per_purchase: parseFloat(r['Amount Per Purchase'] || r['amount_per_purchase'] || 1) || 1,
            roll_width: parseFloat(r['Roll Width'] || r['roll_width']) || null,
            roll_length: parseFloat(r['Roll Length'] || r['roll_length']) || null,
            price_paid: parseFloat(r['Price Paid'] || r['price_paid']) || null,
            notes:     r['Notes']    || r['notes']    || null,
        }));
        if (!items.length) { showToast('No valid rows found.', 'error'); return; }
        await apiFetch('/api/materials', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'bulk_import', items }) });
        showToast(`✓ Imported ${items.length} materials`, 'success');
        await loadMaterials();
    } catch(err) { showToast('Import failed: ' + err.message, 'error'); }
    e.target.value = '';
});

function openMaterialUsageModal(id) {
    const m = materials.find(x => x.id == id);
    if (!m) return;
    document.getElementById('mat-usage-id').value = id;
    document.getElementById('mat-usage-amount').value = '';
    document.getElementById('mat-usage-label').textContent = `${m.brand || '—'} ${m.type || ''}`.trim();
    document.getElementById('mat-usage-hint').textContent = `Remaining: ${formatMaterialAmount(materialRemaining(m), materialUnit(m))}`;
    document.getElementById('mat-usage-modal-overlay').classList.add('open');
}

function closeMaterialUsageModal() {
    document.getElementById('mat-usage-modal-overlay').classList.remove('open');
}

async function submitMaterialUsage() {
    const id = parseInt(document.getElementById('mat-usage-id').value, 10);
    const amount = parseFloat(document.getElementById('mat-usage-amount').value);
    if (!id) return;
    if (Number.isNaN(amount) || amount <= 0) { showToast('Enter a valid amount used.', 'error'); return; }
    try {
        await apiFetch(`/api/materials/${id}/usage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ delta: amount }),
        });
        closeMaterialUsageModal();
        showToast('✓ Material usage logged', 'success');
        await loadMaterials();
    } catch (err) {
        showToast('Could not log usage: ' + err.message, 'error');
    }
}

// ============================================================
// EQUIPMENT
// ============================================================
let editingEqId = null;
const EQ_DEFAULT_CATEGORIES = ['Printer', 'AMS', 'Build Plate', 'Hotend', 'Nozzle', 'Extruder', 'Spare Part', 'Accessory'];

function syncEquipmentCategoryHidden() {
    const sel = document.getElementById('eq-category-select');
    const custom = document.getElementById('eq-category-custom');
    const hidden = document.getElementById('eq-category');
    if (!sel || !custom || !hidden) return;
    const v = sel.value || '';
    hidden.value = v === 'Custom' ? (custom.value || '').trim() : v;
}

function onEquipmentCategoryChange() {
    const sel = document.getElementById('eq-category-select');
    const custom = document.getElementById('eq-category-custom');
    const brand = document.getElementById('eq-brand');
    if (!sel || !custom) return;
    const isCustom = sel.value === 'Custom';
    custom.classList.toggle('hidden', !isCustom);
    if (isCustom) custom.focus();
    if (!isCustom && sel.value && brand && !(brand.value || '').trim()) {
        brand.value = 'Bambu Lab';
    }
    syncEquipmentCategoryHidden();
}

function setEquipmentCategoryValue(category) {
    const sel = document.getElementById('eq-category-select');
    const custom = document.getElementById('eq-category-custom');
    const hidden = document.getElementById('eq-category');
    if (!sel || !custom || !hidden) return;
    const val = (category || '').trim();
    if (!val) {
        sel.value = '';
        custom.value = '';
        custom.classList.add('hidden');
        hidden.value = '';
        return;
    }
    if (EQ_DEFAULT_CATEGORIES.includes(val)) {
        sel.value = val;
        custom.value = '';
        custom.classList.add('hidden');
        hidden.value = val;
        return;
    }
    sel.value = 'Custom';
    custom.value = val;
    custom.classList.remove('hidden');
    hidden.value = val;
}

async function loadEquipment() {
    try {
        equipment = await apiFetch('/api/equipment');
        renderEquipment();
    } catch (e) {
        showToast('Could not load equipment.', 'error');
    }
}

function renderEquipment() {
    const search = (document.getElementById('eq-search')?.value || '').toLowerCase();
    const cat = document.getElementById('eq-filter-category')?.value || '';
    const cats = [...new Set(equipment.map(e => e.category).filter(Boolean))].sort();
    const catSel = document.getElementById('eq-filter-category');
    if (catSel) {
        const cur = catSel.value;
        catSel.innerHTML = '<option value="">All Categories</option>' + cats.map(c => `<option value="${c}">${c}</option>`).join('');
        catSel.value = cur;
    }
    let filtered = equipment.filter(e => {
        if (cat && e.category !== cat) return false;
        if (search) {
            const hay = `${e.category || ''} ${e.brand || ''} ${e.model || ''} ${e.variant || ''} ${e.barcode || ''} ${e.notes || ''}`.toLowerCase();
            if (!hay.includes(search)) return false;
        }
        return true;
    });
    filtered = applyTableSort(filtered, 'equipment', {
        category: e => e.category || '',
        brand: e => e.brand || '',
        model: e => e.model || '',
        variant: e => e.variant || '',
        barcode: e => e.barcode || '',
        qty: e => parseFloat(e.purchased) || 0,
        price: e => parseFloat(e.price_paid) || 0,
        notes: e => e.notes || '',
    });
    const countEl = document.getElementById('eq-filter-count');
    if (countEl) countEl.textContent = `${filtered.length} item${filtered.length !== 1 ? 's' : ''}`;
    const body = document.getElementById('equipment-list');
    if (!body) return;
    if (!filtered.length) {
        body.innerHTML = '<tr><td colspan="9" class="text-center py-12" style="color:var(--muted)">No equipment matches your filters.</td></tr>';
        updateTableSortHeaders();
        return;
    }
    body.innerHTML = filtered.map(e => `<tr>
        <td><span class="badge" style="background:var(--surface2);color:var(--text2)">${esc(e.category || '—')}</span></td>
        <td style="color:var(--text)">${esc(e.brand || '—')}</td>
        <td style="color:var(--text2)">${esc(e.model || '—')}</td>
        <td style="color:var(--text2)">${esc(e.variant || '—')}</td>
        <td class="mono text-xs" style="color:var(--muted)">${esc(e.barcode || '—')}</td>
        <td class="mono font-bold" style="color:var(--accent)">${e.purchased ?? 1}</td>
        <td class="mono text-xs" style="color:var(--green)">${e.price_paid ? formatGBP(e.price_paid) : '—'}</td>
        <td class="text-xs" style="color:var(--text2)">${esc(e.notes || '')}</td>
        <td>
            <div class="flex gap-2">
                <button onclick="openEditEquipmentModal(${e.id})" class="btn-ghost py-1 px-2 text-xs">✏️</button>
                <button onclick="deleteEquipment(${e.id})" class="btn-danger py-1 px-2 text-xs">🗑</button>
            </div>
        </td>
    </tr>`).join('');
    updateTableSortHeaders();
}

function openAddEquipmentModal() {
    editingEqId = null;
    document.getElementById('eq-modal-title').textContent = 'Add Equipment';
    document.getElementById('eq-modal-submit-btn').textContent = 'Add Equipment';
    document.getElementById('eq-edit-id').value = '';
    ['eq-brand','eq-model','eq-variant','eq-barcode','eq-notes','eq-price'].forEach(id => document.getElementById(id).value = '');
    setEquipmentCategoryValue('');
    document.getElementById('eq-purchased').value = '1';
    document.getElementById('eq-modal-overlay').classList.add('open');
}

function openEditEquipmentModal(id) {
    const e = equipment.find(x => x.id == id);
    if (!e) return;
    editingEqId = id;
    document.getElementById('eq-modal-title').textContent = 'Edit Equipment';
    document.getElementById('eq-modal-submit-btn').textContent = 'Save Changes';
    document.getElementById('eq-edit-id').value = id;
    setEquipmentCategoryValue(e.category || '');
    document.getElementById('eq-brand').value = e.brand || '';
    document.getElementById('eq-model').value = e.model || '';
    document.getElementById('eq-variant').value = e.variant || '';
    document.getElementById('eq-barcode').value = e.barcode || '';
    document.getElementById('eq-notes').value = e.notes || '';
    document.getElementById('eq-purchased').value = e.purchased ?? 1;
    document.getElementById('eq-price').value = e.price_paid || '';
    document.getElementById('eq-modal-overlay').classList.add('open');
}

function closeEquipmentModal() { document.getElementById('eq-modal-overlay').classList.remove('open'); }

async function submitEquipment() {
    syncEquipmentCategoryHidden();
    const item = {
        category: document.getElementById('eq-category').value,
        brand: document.getElementById('eq-brand').value,
        model: document.getElementById('eq-model').value,
        variant: document.getElementById('eq-variant').value || null,
        barcode: document.getElementById('eq-barcode').value,
        notes: document.getElementById('eq-notes').value || null,
        purchased: parseInt(document.getElementById('eq-purchased').value) || 1,
        price_paid: parseFloat(document.getElementById('eq-price').value) || null,
    };
    if (!item.category && !item.brand && !item.model) { showToast('Enter at least category, brand or model.', 'error'); return; }
    try {
        if (editingEqId) {
            await apiFetch(`/api/equipment/${editingEqId}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(item) });
            showToast('✓ Equipment updated', 'success');
        } else {
            await apiFetch('/api/equipment', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'add_single', item }) });
            showToast('✓ Equipment added', 'success');
        }
        closeEquipmentModal();
        await loadEquipment();
    } catch (e) {
        showToast('Could not save equipment: ' + e.message, 'error');
    }
}

async function deleteEquipment(id) {
    if (!confirm('Delete this equipment item?')) return;
    try {
        await apiFetch(`/api/equipment/${id}`, { method:'DELETE' });
        showToast('✓ Deleted', 'success');
        await loadEquipment();
    } catch {
        showToast('Delete failed', 'error');
    }
}

// ============================================================
// MODEL KITS
// ============================================================
let editingMkId = null;

async function loadModelKits() {
    try {
        modelKits = await apiFetch('/api/modelkits');
        renderModelKits();
    } catch (e) {
        showToast('Could not load model kits.', 'error');
    }
}

function renderModelKits() {
    const search = (document.getElementById('mk-search')?.value || '').toLowerCase();
    const brand = document.getElementById('mk-filter-brand')?.value || '';
    const brands = [...new Set(modelKits.map(k => k.brand).filter(Boolean))].sort();
    const brandSel = document.getElementById('mk-filter-brand');
    if (brandSel) {
        const cur = brandSel.value;
        brandSel.innerHTML = '<option value="">All Brands</option>' + brands.map(b => `<option value="${b}">${b}</option>`).join('');
        brandSel.value = cur;
    }

    let filtered = modelKits.filter(k => {
        if (brand && k.brand !== brand) return false;
        if (search) {
            const hay = `${k.brand || ''} ${k.kit_name || ''} ${k.barcode || ''} ${k.notes || ''}`.toLowerCase();
            if (!hay.includes(search)) return false;
        }
        return true;
    });
    filtered = applyTableSort(filtered, 'modelkits', {
        brand: k => k.brand || '',
        name: k => k.kit_name || '',
        barcode: k => k.barcode || '',
        bought: k => parseInt(k.purchased, 10) || 0,
        used: k => parseInt(k.used, 10) || 0,
        remaining: k => Math.max(0, (parseInt(k.purchased, 10) || 0) - (parseInt(k.used, 10) || 0)),
        price: k => parseFloat(k.price_paid) || 0,
        notes: k => k.notes || '',
    });

    const countEl = document.getElementById('mk-filter-count');
    if (countEl) countEl.textContent = `${filtered.length} kit${filtered.length !== 1 ? 's' : ''}`;

    const body = document.getElementById('modelkits-list');
    if (!body) return;
    if (!filtered.length) {
        body.innerHTML = '<tr><td colspan="10" class="text-center py-12" style="color:var(--muted)">No model kits match your filters.</td></tr>';
        updateTableSortHeaders();
        return;
    }

    body.innerHTML = filtered.map(k => `<tr>
        <td style="color:var(--text)">${esc(k.brand || '—')}</td>
        <td style="color:var(--text2)">${esc(k.kit_name || '—')}</td>
        <td class="mono text-xs" style="color:var(--muted)">${esc(k.barcode || '—')}</td>
        <td class="mono font-bold" style="color:var(--accent)">${k.purchased ?? 1}</td>
        <td class="mono font-bold" style="color:var(--orange)">${k.used ?? 0}</td>
        <td class="mono font-bold" style="color:var(--green)">${Math.max(0, (parseInt(k.purchased, 10) || 0) - (parseInt(k.used, 10) || 0))}</td>
        <td class="mono text-xs" style="color:var(--green)">${k.price_paid ? formatGBP(k.price_paid) : '—'}</td>
        <td class="text-xs" style="color:var(--text2)">${esc(k.notes || '')}</td>
        <td>
            <div class="flex gap-2">
                <button onclick="adjustModelKitUsed(${k.id}, 1)" class="btn-primary py-1 px-2 text-xs">Use 1</button>
                <button onclick="adjustModelKitUsed(${k.id}, -1)" class="btn-ghost py-1 px-2 text-xs">Undo</button>
                <button onclick="openEditModelKitModal(${k.id})" class="btn-ghost py-1 px-2 text-xs">✏️</button>
                <button onclick="deleteModelKit(${k.id})" class="btn-danger py-1 px-2 text-xs">🗑</button>
            </div>
        </td>
    </tr>`).join('');
    updateTableSortHeaders();
}

function openAddModelKitModal() {
    editingMkId = null;
    document.getElementById('mk-modal-title').textContent = 'Add Model Kit';
    document.getElementById('mk-modal-submit-btn').textContent = 'Add Model Kit';
    document.getElementById('mk-edit-id').value = '';
    ['mk-brand', 'mk-name', 'mk-barcode', 'mk-notes', 'mk-price'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    document.getElementById('mk-purchased').value = '1';
    document.getElementById('mk-used').value = '0';
    document.getElementById('mk-modal-overlay').classList.add('open');
}

function openEditModelKitModal(id) {
    const k = modelKits.find(x => x.id == id);
    if (!k) return;
    editingMkId = id;
    document.getElementById('mk-modal-title').textContent = 'Edit Model Kit';
    document.getElementById('mk-modal-submit-btn').textContent = 'Save Changes';
    document.getElementById('mk-edit-id').value = id;
    document.getElementById('mk-brand').value = k.brand || '';
    document.getElementById('mk-name').value = k.kit_name || '';
    document.getElementById('mk-barcode').value = k.barcode || '';
    document.getElementById('mk-notes').value = k.notes || '';
    document.getElementById('mk-purchased').value = k.purchased ?? 1;
    document.getElementById('mk-used').value = k.used ?? 0;
    document.getElementById('mk-price').value = k.price_paid || '';
    document.getElementById('mk-modal-overlay').classList.add('open');
}

function closeModelKitModal() {
    document.getElementById('mk-modal-overlay').classList.remove('open');
}

async function submitModelKit() {
    const item = {
        brand: document.getElementById('mk-brand').value,
        kit_name: document.getElementById('mk-name').value,
        barcode: document.getElementById('mk-barcode').value,
        notes: document.getElementById('mk-notes').value || null,
        purchased: parseInt(document.getElementById('mk-purchased').value, 10) || 1,
        used: parseInt(document.getElementById('mk-used').value, 10) || 0,
        price_paid: parseFloat(document.getElementById('mk-price').value) || null,
    };
    if (item.used < 0 || item.used > item.purchased) {
        showToast('Used kits must be between 0 and bought quantity.', 'error');
        return;
    }
    if (!item.brand && !item.kit_name) {
        showToast('Enter at least brand or kit name.', 'error');
        return;
    }
    try {
        if (editingMkId) {
            await apiFetch(`/api/modelkits/${editingMkId}`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(item),
            });
            showToast('✓ Model kit updated', 'success');
        } else {
            await apiFetch('/api/modelkits', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ action: 'add_single', item }),
            });
            showToast('✓ Model kit added', 'success');
        }
        closeModelKitModal();
        await loadModelKits();
    } catch (e) {
        showToast('Could not save model kit: ' + e.message, 'error');
    }
}

async function deleteModelKit(id) {
    if (!confirm('Delete this model kit?')) return;
    try {
        await apiFetch(`/api/modelkits/${id}`, { method: 'DELETE' });
        showToast('✓ Deleted', 'success');
        await loadModelKits();
    } catch {
        showToast('Delete failed', 'error');
    }
}

async function adjustModelKitUsed(id, delta) {
    try {
        await apiFetch(`/api/modelkits/${id}/used`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ delta }),
        });
        await loadModelKits();
    } catch (err) {
        showToast('Could not update kit usage: ' + err.message, 'error');
    }
}

// ============================================================
// KEYBOARD SHORTCUTS
// ============================================================
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        closeModal(); closeUsageModal(); closeSidebar(); closeMatModal();
        closeNewDbModal(); closeBcModal(); closeSaveBarcodeModal(); closeUsageEditModal(); closePurchaseEditModal(); closePurchaseAddModal(); closeEquipmentModal(); closeModelKitModal(); closeMaterialUsageModal(); closeSettingsModal(); closeBambuModal(); closeBambuddyModal();
    }
    if ((e.metaKey||e.ctrlKey) && e.key === 'e') { e.preventDefault(); exportToExcel(); }
    if ((e.metaKey||e.ctrlKey) && e.key === 'k') { e.preventDefault(); openAddModal(); }
});

// ============================================================
// INIT
// ============================================================
loadDatabases();
loadAll();
loadBarcodeDb();
loadPurchases();
loadAppSettings();

// ============================================================
// SELLING
// ============================================================

function showSellTab(tab) {
    activeSellTab = tab;
    ['products','events'].forEach(t => {
        document.getElementById(`sell-tab-${t}`)?.classList.toggle('hidden', t !== tab);
        document.getElementById(`sell-btn-${t}`)?.classList.toggle('active', t === tab);
    });
    const actionBtn = document.getElementById('sell-action-btn');
    if (actionBtn) {
        if (tab === 'products') {
            actionBtn.textContent = '＋ Add Product';
            actionBtn.onclick = openSellProductModal;
        } else {
            actionBtn.textContent = '＋ Add Event / Sale';
            actionBtn.onclick = openSellEventModal;
        }
    }
}

async function loadSelling() {
    try {
        [sellProducts, sellEvents] = await Promise.all([
            apiFetch('/api/sell/products'),
            apiFetch('/api/sell/events'),
        ]);
        renderSellStats();
        renderSellProducts();
        renderSellEvents();
    } catch (err) {
        showToast('Could not load selling data.', 'error');
    }
}

function renderSellStats() {
    const totalStock  = sellProducts.reduce((s, p) => s + (parseInt(p.stock) || 0), 0);
    const totalProfit = sellEvents.reduce((s, e) => s + (parseFloat(e.profit) || 0), 0);
    const totalCost   = sellEvents.reduce((s, e) => s + (parseFloat(e.cost) || 0) + (parseFloat(e.stand_cost) || 0), 0);

    document.getElementById('sell-stat-products').textContent = sellProducts.length;
    document.getElementById('sell-stat-stock').textContent    = totalStock;
    document.getElementById('sell-stat-events').textContent   = sellEvents.length;
    document.getElementById('sell-stat-cost').textContent     = formatGBP(totalCost);

    const profitEl = document.getElementById('sell-stat-profit');
    profitEl.textContent  = formatGBP(totalProfit);
    profitEl.style.color  = totalProfit >= 0 ? 'var(--green)' : 'var(--red)';
}

function renderSellProducts() {
    const body = document.getElementById('sell-products-list');
    if (!sellProducts.length) {
        body.innerHTML = '<tr><td colspan="8" class="text-center py-12" style="color:var(--muted)">No products yet. Add one above.</td></tr>';
        return;
    }
    body.innerHTML = sellProducts.map(p => {
        const hex = p.color_hex || (p.color_name ? getColourHex(p.color_name) : '');
        const swatch = hex ? `<span style="display:inline-block;width:14px;height:14px;border-radius:4px;background:${hex};border:1px solid rgba(128,128,128,0.3);margin-right:6px;flex-shrink:0;vertical-align:middle"></span>` : '';
        const imgThumb = p.image ? `<img src="/uploads/${p.image}" alt="${esc(p.name)}" style="width:32px;height:32px;border-radius:6px;object-fit:cover;border:1px solid var(--border);margin-right:8px;flex-shrink:0">` : '';
        const stockValue = (parseFloat(p.cost_per_item) || 0) * (parseInt(p.stock) || 0);
        return `
        <tr>
            <td class="font-medium" style="color:var(--text)"><div class="flex items-center">${imgThumb}<span>${esc(p.name)}</span></div></td>
            <td><span class="mono text-xs px-2 py-0.5 rounded" style="background:var(--surface2);color:var(--text2);border:1px solid var(--border);letter-spacing:0.04em">${esc(p.sku || '—')}</span></td>
            <td class="text-sm" style="color:var(--text2)">${esc(p.description || '—')}</td>
            <td><div class="flex items-center">${swatch}<span class="text-sm" style="color:var(--text2)">${esc(p.color_name || '—')}</span></div></td>
            <td class="mono text-sm" style="color:var(--green)">${formatGBP(p.cost_per_item)}</td>
            <td class="mono text-sm" style="color:var(--orange)">${formatGBP(stockValue)}</td>
            <td>
                <div class="flex items-center gap-2">
                    <button onclick="sellAdjustStock(${p.id}, -1)" class="btn-ghost py-0.5 px-2 text-base leading-none" title="Remove one">−</button>
                    <span class="mono font-bold text-sm" style="color:var(--accent);min-width:28px;text-align:center">${p.stock}</span>
                    <button onclick="sellAdjustStock(${p.id}, 1)"  class="btn-ghost py-0.5 px-2 text-base leading-none" title="Add one">＋</button>
                </div>
            </td>
            <td class="text-sm" style="color:var(--text2)">${esc(p.notes || '—')}</td>
            <td>
                <div class="flex gap-1">
                    <button onclick="printProductLabel(${p.id})" class="btn-ghost py-1 px-2 text-xs" title="Print Label">🏷️</button>
                    <button onclick="openSellProductModal(${p.id})" class="btn-ghost py-1 px-2 text-xs">✏️ Edit</button>
                    <button onclick="deleteSellProduct(${p.id})"    class="btn-ghost py-1 px-2 text-xs" style="color:var(--red)">🗑</button>
                </div>
            </td>
        </tr>`;
    }).join('');
}

function renderSellEvents() {
    const container = document.getElementById('sell-events-list');
    if (!sellEvents.length) {
        container.innerHTML = '<p class="text-center py-12 text-sm" style="color:var(--muted)">No events yet. Add one above.</p>';
        return;
    }
    container.innerHTML = sellEvents.map(e => {
        const dateStr  = e.event_date ? new Date(e.event_date).toLocaleDateString('en-GB', {day:'numeric',month:'short',year:'numeric'}) : '—';
        const profitCol = (parseFloat(e.profit) || 0) >= 0 ? 'var(--green)' : 'var(--red)';
        const salesRows = (e.sales || []).map(s => {
            const prod = sellProducts.find(x => x.id === s.product_id);
            const hex = s.color_hex || (prod?.color_hex) || (prod?.color_name ? getColourHex(prod.color_name) : '');
            const swatch = hex ? `<span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${hex};border:1px solid rgba(128,128,128,0.3);margin-right:5px;flex-shrink:0;vertical-align:middle"></span>` : '';
            return `
            <tr>
                <td class="text-sm" style="color:var(--text)"><div class="flex items-center">${swatch}${esc(s.product_name)}</div></td>
                <td class="mono text-sm text-center" style="color:var(--accent)">${s.qty_sold}</td>
                <td class="mono text-sm" style="color:var(--green)">${formatGBP(s.sale_price)}</td>
                <td class="mono text-sm font-bold" style="color:var(--text)">${formatGBP((s.qty_sold||0)*(s.sale_price||0))}</td>
                <td class="mono text-xs" style="color:var(--muted)">${formatGBP(s.cost_per_item)} / item · cost: ${formatGBP((s.qty_sold||0)*(s.cost_per_item||0))}</td>
                <td>
                    <div class="flex gap-1">
                        <button onclick="openSellSaleModal(${e.id}, ${s.id})" class="btn-ghost py-1 px-2 text-xs">✏️</button>
                        <button onclick="deleteSellSale(${s.id}, ${e.id})"    class="btn-ghost py-1 px-2 text-xs" style="color:var(--red)">🗑</button>
                    </div>
                </td>
            </tr>`;
        }).join('');

        return `
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;overflow:hidden">
            <div class="flex flex-wrap items-start justify-between gap-4 p-5" style="border-bottom:1px solid var(--border)">
                <div>
                    <h3 class="text-base font-black" style="color:var(--text)">${esc(e.name)}</h3>
                    <p class="text-xs mono mt-0.5" style="color:var(--muted)">${dateStr}${e.location ? ' · ' + esc(e.location) : ''}${e.notes ? ' · ' + esc(e.notes) : ''}</p>
                </div>
                <div class="flex flex-wrap gap-4 items-center">
                    <div class="text-right">
                        <p class="text-xs mono" style="color:var(--muted)">Revenue</p>
                        <p class="text-sm font-bold mono" style="color:var(--green)">${formatGBP(e.revenue)}</p>
                    </div>
                    <div class="text-right">
                        <p class="text-xs mono" style="color:var(--muted)">Item Costs</p>
                        <p class="text-sm font-bold mono" style="color:var(--orange)">${formatGBP(e.cost)}</p>
                    </div>
                    <div class="text-right">
                        <p class="text-xs mono" style="color:var(--muted)">Stand Cost</p>
                        <p class="text-sm font-bold mono" style="color:var(--orange)">${formatGBP(e.stand_cost)}</p>
                    </div>
                    <div class="text-right">
                        <p class="text-xs mono" style="color:var(--muted)">Profit</p>
                        <p class="text-sm font-bold mono" style="color:${profitCol}">${formatGBP(e.profit)}</p>
                    </div>
                    <div class="flex gap-1">
                        <button onclick="openSellSaleModal(${e.id})"    class="btn-primary text-xs py-1 px-2">＋ Sale</button>
                        <button onclick="openSellEventModal(${e.id})"   class="btn-ghost text-xs py-1 px-2">✏️</button>
                        <button onclick="deleteSellEvent(${e.id})"      class="btn-ghost text-xs py-1 px-2" style="color:var(--red)">🗑</button>
                    </div>
                </div>
            </div>
            ${e.sales && e.sales.length ? `
            <div style="overflow-x:auto">
                <table class="data-table" style="min-width:600px">
                    <thead><tr>
                        <th>Product</th><th class="text-center">Qty Sold</th><th>Sale Price</th><th>Line Revenue</th><th>Cost Info</th><th>Actions</th>
                    </tr></thead>
                    <tbody>${salesRows}</tbody>
                </table>
            </div>` : `<p class="text-sm text-center py-4" style="color:var(--muted)">No sales logged yet — click ＋ Sale to add one.</p>`}
        </div>`;
    }).join('');
}

// ── Product modal ─────────────────────────────────────────────────────────

function _skuFromName(name) {
    const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, '').split(/\s+/).filter(Boolean);
    const prefix = words.slice(0, 3).map(w => w.slice(0, 3)).join('') || name.slice(0, 4).toUpperCase();
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const suffix = Array.from({length: 4}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    return `${prefix}-${suffix}`;
}

function generateSellProductSku() {
    const name = document.getElementById('sell-product-name').value.trim();
    const skuEl = document.getElementById('sell-product-sku');
    skuEl.value = name ? _skuFromName(name) : _skuFromName('PROD');
}

function onSellProductNameInput() {
    // Only auto-fill SKU if it hasn't been manually set yet
    const skuEl = document.getElementById('sell-product-sku');
    const isEditing = !!document.getElementById('sell-product-id').value;
    if (!isEditing && !skuEl.dataset.userEdited) {
        const name = document.getElementById('sell-product-name').value.trim();
        if (name.length >= 3) skuEl.value = _skuFromName(name);
    }
}

function openSellProductModal(id) {
    const p = id ? sellProducts.find(x => x.id === id) : null;
    document.getElementById('sell-product-modal-title').textContent = p ? 'Edit Product' : 'Add Product';
    document.getElementById('sell-product-submit-btn').textContent  = p ? 'Save Changes' : 'Add Product';
    
    // Clear and populate calculator list
    document.getElementById('sell-product-calc-list').innerHTML = '';
    if (p && p.filament_breakdown) {
        try {
            const breakdown = JSON.parse(p.filament_breakdown);
            breakdown.forEach(item => addSellProductCalcRow(item.filament_id, item.grams));
        } catch (e) { console.error("Failed to parse filament breakdown:", e); }
    }
    document.getElementById('sell-product-id').value         = p ? p.id : '';
    document.getElementById('sell-product-name').value       = p ? p.name : '';
    document.getElementById('sell-product-sku').value        = p ? (p.sku || '') : '';
    document.getElementById('sell-product-sku').dataset.userEdited = p ? '1' : '';
    document.getElementById('sell-product-desc').value       = p ? (p.description || '') : '';
    document.getElementById('sell-product-cost').value       = p ? p.cost_per_item : '';
    document.getElementById('sell-product-stock').value      = p ? p.stock : '';
    document.getElementById('sell-product-colour-name').value = p ? (p.color_name || '') : '';
    document.getElementById('sell-product-colour-hex').value  = p ? (p.color_hex  || '') : '';
    document.getElementById('sell-product-notes').value      = p ? (p.notes || '') : '';
    document.getElementById('sell-product-image').value      = p ? (p.image || '') : '';
    const prev = document.getElementById('sell-product-colour-preview');
    if (prev) prev.style.background = (p?.color_hex) || (p?.color_name ? getColourHex(p.color_name) : 'transparent');
    // Display existing image if present
    if (p && p.image) {
        const imgEl = document.getElementById('sell-product-image-img');
        if (imgEl) imgEl.src = `/uploads/${p.image}`;
        document.getElementById('sell-product-image-preview').style.display = 'block';
        document.getElementById('sell-product-image-clear').style.display = 'block';
    } else {
        document.getElementById('sell-product-image-preview').style.display = 'none';
        document.getElementById('sell-product-image-clear').style.display = 'none';
    }
    // Set up file input handler
    const fileInput = document.getElementById('sell-product-image-input');
    fileInput.onchange = handleSellProductImageUpload;
    document.getElementById('sell-product-modal').classList.add('open');
    updateSellProductCost(); // Trigger initial calculation
}

function addSellProductCalcRow(prefillFilamentId = '', prefillGrams = '') {
    const container = document.getElementById('sell-product-calc-list');
    const rowId = Date.now() + Math.random();
    const div = document.createElement('div');
    div.id = `calc-row-${rowId}`;
    div.className = 'flex gap-2 items-center';
    
    const spoolOptions = filaments.map(f => `<option value="${f.id}" ${f.id == prefillFilamentId ? 'selected' : ''}>${esc(f.brand)} ${esc(f.color_name)} · ${esc(f.material)}</option>`).join('');
    
    div.innerHTML = `
        <select onchange="updateSellProductCost()" style="flex:1; font-size:11px; padding:4px; height:28px">
            <option value="">— Select Filament —</option>
            ${spoolOptions}
        </select>
        <input type="number" placeholder="grams" value="${prefillGrams}" oninput="updateSellProductCost()" style="width:70px; font-size:11px; padding:4px; height:28px">
        <button onclick="this.parentElement.remove(); updateSellProductCost();" class="text-muted hover:text-red px-1">✕</button>
    `;
    container.appendChild(div);
}

function updateSellProductCost() {
    const rows = document.querySelectorAll('#sell-product-calc-list > div');
    let total = 0;
    let firstFilament = null;
    rows.forEach(row => {
        const fid = row.querySelector('select').value;
        const grams = parseFloat(row.querySelector('input').value) || 0;
        const f = filaments.find(x => x.id == fid);
        if (f) {
            if (!firstFilament) firstFilament = f;
            if (grams > 0) total += (costPerGram(f) || 0) * grams;
        }
    });
    document.getElementById('sell-product-cost').value = total.toFixed(2);

    // Auto-fill color if empty
    const nameEl = document.getElementById('sell-product-colour-name');
    const hexEl = document.getElementById('sell-product-colour-hex');
    if (firstFilament && !nameEl.value) {
        nameEl.value = firstFilament.color_name || '';
        hexEl.value = firstFilament.color_hex || getColourHex(firstFilament.color_name);
        previewSellProductColour();
    }
}

function previewSellProductColour() {
    const nameEl = document.getElementById('sell-product-colour-name');
    const hexEl  = document.getElementById('sell-product-colour-hex');
    const prev   = document.getElementById('sell-product-colour-preview');
    if (!prev) return;
    const hex = (hexEl && hexEl.value) || (nameEl && nameEl.value ? getColourHex(nameEl.value) : '');
    prev.style.background = hex || 'transparent';
    if (hexEl && !hexEl.value && nameEl && nameEl.value) hexEl.value = hex;
}

function closeSellProductModal() {
    document.getElementById('sell-product-modal').classList.remove('open');
}

async function handleSellProductImageUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    // Show uploading state
    document.getElementById('sell-product-image-uploading').style.display = 'flex';
    
    try {
        const formData = new FormData();
        formData.append('file', file);
        
        const response = await fetch('/api/upload/product-image', {
            method: 'POST',
            body: formData
        });
        
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Upload failed');
        }
        
        const data = await response.json();
        const filename = data.filename;
        
        // Store filename in hidden input
        document.getElementById('sell-product-image').value = filename;
        
        // Show preview
        const imgEl = document.getElementById('sell-product-image-img');
        imgEl.src = `/uploads/${filename}`;
        document.getElementById('sell-product-image-preview').style.display = 'block';
        document.getElementById('sell-product-image-clear').style.display = 'block';
        
        showToast('✓ Image uploaded', 'success');
    } catch (err) {
        showToast('Could not upload image: ' + err.message, 'error');
    } finally {
        document.getElementById('sell-product-image-uploading').style.display = 'none';
        // Reset file input
        e.target.value = '';
    }
}

function clearSellProductImage() {
    document.getElementById('sell-product-image').value = '';
    document.getElementById('sell-product-image-preview').style.display = 'none';
    document.getElementById('sell-product-image-clear').style.display = 'none';
    document.getElementById('sell-product-image-input').value = '';
}

async function submitSellProduct() {
    const id   = document.getElementById('sell-product-id').value;
    const name = document.getElementById('sell-product-name').value.trim();
    if (!name) { showToast('Product name is required.', 'error'); return; }
    
    const colourName = document.getElementById('sell-product-colour-name').value.trim();
    const colourHex  = document.getElementById('sell-product-colour-hex').value.trim() || (colourName ? getColourHex(colourName) : null);
    const sku = document.getElementById('sell-product-sku').value.trim().toUpperCase() || null;

    const filamentBreakdown = [];
    document.querySelectorAll('#sell-product-calc-list > div').forEach(row => {
        const fid = row.querySelector('select').value;
        const grams = parseFloat(row.querySelector('input').value) || 0;
        if (fid && grams > 0) filamentBreakdown.push({ filament_id: parseInt(fid), grams: grams });
    });

    const body = {
        name,
        sku,
        description:   document.getElementById('sell-product-desc').value.trim() || null,
        cost_per_item: parseFloat(document.getElementById('sell-product-cost').value) || 0,
        stock:         parseInt(document.getElementById('sell-product-stock').value)  || 0,
        color_name:    colourName || null,
        color_hex:     colourHex  || null,
        notes:         document.getElementById('sell-product-notes').value.trim() || null,
        image:         document.getElementById('sell-product-image').value || null,
        filament_breakdown: JSON.stringify(filamentBreakdown),
        sku: sku
    };
    try {
        if (id) {
            await apiFetch(`/api/sell/products/${id}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
            showToast('✓ Product updated', 'success');
        } else {
            await apiFetch('/api/sell/products', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
            showToast('✓ Product added', 'success');
        }
        closeSellProductModal();
        await loadSelling();
    } catch (err) {
        showToast('Could not save product: ' + err.message, 'error');
    }
}

async function sellAdjustStock(id, delta) {
    try {
        const res = await apiFetch(`/api/sell/products/${id}/adjust`, {
            method: 'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ delta }),
        });
        const p = sellProducts.find(x => x.id === id);
        if (p) p.stock = res.stock;
        renderSellProducts();
        renderSellStats();
    } catch (err) {
        showToast('Could not adjust stock.', 'error');
    }
}

async function deleteSellProduct(id) {
    if (!confirm('Delete this product? This cannot be undone.')) return;
    try {
        await apiFetch(`/api/sell/products/${id}`, { method:'DELETE' });
        showToast('✓ Product deleted', 'success');
        await loadSelling();
    } catch (err) {
        showToast('Could not delete product.', 'error');
    }
}

// ── Event modal ───────────────────────────────────────────────────────────

function openSellEventModal(id) {
    const e = id ? sellEvents.find(x => x.id === id) : null;
    document.getElementById('sell-event-modal-title').textContent = e ? 'Edit Event' : 'Add Event';
    document.getElementById('sell-event-submit-btn').textContent  = e ? 'Save Changes' : 'Add Event';
    document.getElementById('sell-event-id').value       = e ? e.id : '';
    document.getElementById('sell-event-name').value     = e ? e.name : '';
    document.getElementById('sell-event-date').value     = e ? (e.event_date ? e.event_date.slice(0,10) : '') : '';
    document.getElementById('sell-event-stand').value    = e ? (e.stand_cost || '') : '';
    document.getElementById('sell-event-location').value = e ? (e.location || '') : '';
    document.getElementById('sell-event-notes').value    = e ? (e.notes || '') : '';
    document.getElementById('sell-event-modal').classList.add('open');
}

function closeSellEventModal() {
    document.getElementById('sell-event-modal').classList.remove('open');
}

async function submitSellEvent() {
    const id   = document.getElementById('sell-event-id').value;
    const name = document.getElementById('sell-event-name').value.trim();
    if (!name) { showToast('Event name is required.', 'error'); return; }
    const body = {
        name,
        event_date: document.getElementById('sell-event-date').value || null,
        stand_cost: parseFloat(document.getElementById('sell-event-stand').value) || 0,
        location:   document.getElementById('sell-event-location').value.trim() || null,
        notes:      document.getElementById('sell-event-notes').value.trim() || null,
    };
    try {
        if (id) {
            await apiFetch(`/api/sell/events/${id}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
            showToast('✓ Event updated', 'success');
        } else {
            await apiFetch('/api/sell/events', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
            showToast('✓ Event added', 'success');
        }
        closeSellEventModal();
        await loadSelling();
    } catch (err) {
        showToast('Could not save event: ' + err.message, 'error');
    }
}

async function deleteSellEvent(id) {
    if (!confirm('Delete this event and all its sales? This cannot be undone.')) return;
    try {
        await apiFetch(`/api/sell/events/${id}`, { method:'DELETE' });
        showToast('✓ Event deleted', 'success');
        await loadSelling();
    } catch (err) {
        showToast('Could not delete event.', 'error');
    }
}

// ── Sale line modal ───────────────────────────────────────────────────────

function openSellSaleModal(eventId, saleId) {
    const event = sellEvents.find(x => x.id === eventId);
    const sale  = saleId ? (event?.sales || []).find(s => s.id === saleId) : null;

    document.getElementById('sell-sale-modal-title').textContent = sale ? 'Edit Sale' : 'Add Sale';
    document.getElementById('sell-sale-submit-btn').textContent  = sale ? 'Save Changes' : 'Add Sale';
    document.getElementById('sell-sale-id').value       = sale ? sale.id : '';
    document.getElementById('sell-sale-event-id').value = eventId;
    document.getElementById('sell-sale-qty').value      = sale ? sale.qty_sold : '';
    document.getElementById('sell-sale-price').value    = sale ? sale.sale_price : '';

    // Populate product dropdown
    const sel = document.getElementById('sell-sale-product');
    sel.innerHTML = sellProducts.map(p =>
        `<option value="${p.id}" ${sale && sale.product_id === p.id ? 'selected' : ''}>${esc(p.name)} (cost: ${formatGBP(p.cost_per_item)})</option>`
    ).join('');
    if (!sellProducts.length) sel.innerHTML = '<option value="">— No products yet —</option>';

    document.getElementById('sell-sale-modal').classList.add('open');
}

function closeSellSaleModal() {
    document.getElementById('sell-sale-modal').classList.remove('open');
}

async function submitSellSale() {
    const saleId   = document.getElementById('sell-sale-id').value;
    const eventId  = document.getElementById('sell-sale-event-id').value;
    const productId = document.getElementById('sell-sale-product').value;
    const qty      = parseInt(document.getElementById('sell-sale-qty').value) || 0;
    const price    = parseFloat(document.getElementById('sell-sale-price').value) || 0;
    if (!productId) { showToast('Select a product.', 'error'); return; }
    const body = { product_id: parseInt(productId), qty_sold: qty, sale_price: price };
    try {
        if (saleId) {
            await apiFetch(`/api/sell/sales/${saleId}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
            showToast('✓ Sale updated', 'success');
        } else {
            await apiFetch(`/api/sell/events/${eventId}/sales`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
            showToast('✓ Sale added', 'success');
        }
        closeSellSaleModal();
        await loadSelling();
        showSellTab('events');
    } catch (err) {
        showToast('Could not save sale: ' + err.message, 'error');
    }
}

async function deleteSellSale(saleId, eventId) {
    if (!confirm('Remove this sale line?')) return;
    try {
        await apiFetch(`/api/sell/sales/${saleId}`, { method:'DELETE' });
        showToast('✓ Sale removed', 'success');
        await loadSelling();
        showSellTab('events');
    } catch (err) {
        showToast('Could not delete sale.', 'error');
    }
}

/**
 * Generates and prints a product label sized for 62mm wide tape.
 * Optimized for Black & White label printers.
 */
function printProductLabel(pid) {
    const p = sellProducts.find(x => x.id === pid);
    if (!p) return;

    const generateIframe = (contentHtml) => {
        const iframe = document.createElement('iframe');
        iframe.style.position = 'fixed'; iframe.style.right = '0'; iframe.style.bottom = '0';
        iframe.style.width = '0'; iframe.style.height = '0'; iframe.style.border = '0';
        document.body.appendChild(iframe);
        const doc = iframe.contentWindow.document;
        doc.write(contentHtml);
        doc.close();
        setTimeout(() => { document.body.removeChild(iframe); }, 10000);
    };

    // 1. Product Name Label (Thin strip)
    const nameLabelHtml = `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                @page { margin: 0; size: 62mm 6mm landscape; }
                body { margin: 0; padding: 0; font-family: 'Arial', sans-serif; width: 62mm; height: 6mm; background: #fff; color: #000; }
                .label {
                    width: 62mm;
                    height: 6mm;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 0 1.5mm;
                    box-sizing: border-box;
                    overflow: hidden;
                }
                .name { font-size: 14pt; font-weight: 900; text-align: center; width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            </style>
        </head>
        <body><div class="label"><div class="name">${esc(p.name).toUpperCase()}</div></div>
        <script>setTimeout(() => { window.print(); }, 500);</script></body></html>
    `;

    // 2. Large QR Code Label
    const qrLabelHtml = `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                @page { margin: 0; size: 62mm 25mm landscape; }
                body { margin: 0; padding: 0; font-family: 'Arial', sans-serif; width: 62mm; height: 25mm; background: #fff; color: #000; }
                .label {
                    width: 62mm; height: 25mm;
                    display: flex; flex-direction: column; align-items: center; justify-content: center;
                    padding: 2mm; box-sizing: border-box;
                }
                #qrcode { width: 18mm; height: 18mm; }
                #qrcode img { width: 18mm; height: 18mm; }
                .sku-text { font-size: 8pt; font-weight: bold; margin-top: 1mm; font-family: monospace; }
            </style>
            <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
        </head>
        <body>
            <div class="label">
                <div id="qrcode"></div>
                <div class="sku-text">${esc(p.sku || 'NO-SKU')}</div>
            </div>
            <script>
                new QRCode(document.getElementById("qrcode"), {
                    text: "${esc(p.sku || p.name)}",
                    width: 128,
                    height: 128,
                    colorDark : "#000000",
                    colorLight : "#ffffff",
                    correctLevel : QRCode.CorrectLevel.H
                });
                setTimeout(() => { window.print(); }, 800);
            </script>
        </body>
        </html>
    `;

    // Trigger both print jobs
    generateIframe(nameLabelHtml);
    // Slight delay for the second job so the browser/printer queue doesn't choke
    setTimeout(() => generateIframe(qrLabelHtml), 1000);
}

// ============================================================
// BAMBU LAB CLOUD AUTO-SYNC
// ============================================================
let bambuState = { connected: false, need_code: false };

function openBambuModal() {
    document.getElementById('bambu-modal-overlay').classList.add('open');
    refreshBambu();
}
function closeBambuModal() {
    document.getElementById('bambu-modal-overlay').classList.remove('open');
}

// Bambu endpoints operate on the database you're currently viewing, so spool
// matching uses your real inventory (and tokens are stored alongside it).
async function bambuApi(path, opts) {
    const db = (typeof currentDb !== 'undefined' && currentDb) ? currentDb : 'spoolstats';
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch('/api/bambu/' + path + sep + 'db=' + encodeURIComponent(db), opts);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
}

async function refreshBambu() {
    const { data } = await bambuApi('status');
    bambuState = Object.assign({ need_code: bambuState.need_code }, data);
    if (data.connected) bambuState.need_code = false;
    renderBambuBody();
    updateBambuDot(data.connected);
    if (data.connected) loadBambuPending();
}

function updateBambuDot(connected) {
    const dot = document.getElementById('bambu-dot');
    if (dot) dot.style.background = connected ? 'var(--green)' : 'var(--muted)';
}

function renderBambuBody() {
    const b = document.getElementById('bambu-body');
    if (!b) return;
    const s = bambuState;

    if (s.need_code) {
        b.innerHTML = `
            <div class="p-3 rounded-lg" style="background:var(--surface2);border:1px solid var(--border)">
                <p class="text-sm" style="color:var(--text)">We emailed a 6-digit code to <b>${s.email || 'your email'}</b>. Enter it below to finish connecting.</p>
            </div>
            <div><label class="text-xs mono uppercase block mb-1" style="color:var(--muted)">Verification code</label>
                <input id="bambu-code" type="text" inputmode="numeric" placeholder="123456"></div>
            <button class="btn-primary w-full" onclick="bambuVerify()">Verify &amp; Connect</button>
            <button class="btn-ghost w-full text-xs" onclick="bambuStartOver()">← Start over</button>`;
        return;
    }

    if (!s.connected) {
        b.innerHTML = `
            <p class="text-sm" style="color:var(--muted)">Connect your Bambu Lab account to automatically subtract filament from the matching spool after every print.</p>
            <div><label class="text-xs mono uppercase block mb-1" style="color:var(--muted)">Bambu email</label>
                <input id="bambu-email" type="email" placeholder="you@example.com" value="${s.email || ''}"></div>
            <div><label class="text-xs mono uppercase block mb-1" style="color:var(--muted)">Password</label>
                <input id="bambu-password" type="password" placeholder="••••••••"></div>
            <div><label class="text-xs mono uppercase block mb-1" style="color:var(--muted)">Region</label>
                <select id="bambu-region">
                    <option value="global" ${s.region === 'china' ? '' : 'selected'}>Global</option>
                    <option value="china" ${s.region === 'china' ? 'selected' : ''}>China</option>
                </select></div>
            <button class="btn-primary w-full" onclick="bambuLogin()">Send code &amp; connect</button>
            <p class="text-[11px] mono" style="color:var(--muted)">Your password is sent once to Bambu to log in, and is never stored by SpoolStats.</p>`;
        return;
    }

    const last = s.last_sync ? new Date(s.last_sync).toLocaleString() : 'never';
    const _ymd = d => d.toISOString().slice(0, 10);
    const _today = new Date();
    const _yest = new Date(_today); _yest.setDate(_today.getDate() - 1);
    const _wk = new Date(_today); _wk.setDate(_today.getDate() + 7);
    b.innerHTML = `
        <div class="p-3 rounded-lg flex items-center justify-between" style="background:var(--surface2);border:1px solid var(--border)">
            <div><p class="text-xs mono uppercase" style="color:var(--muted)">Connected</p>
                <p class="text-sm font-bold" style="color:var(--green)">${s.email || ''}</p></div>
            <button class="btn-ghost text-xs" onclick="bambuLogout()">Disconnect</button>
        </div>
        <label class="flex items-center gap-3 p-3 rounded-lg cursor-pointer" style="background:var(--surface2);border:1px solid var(--border)">
            <input type="checkbox" id="bambu-auto" ${s.auto_sync ? 'checked' : ''} onchange="bambuToggleAuto(this.checked)" style="width:16px;height:16px;accent-color:var(--green);flex-shrink:0">
            <div class="text-sm" style="color:var(--text)">Auto-sync every
                <input id="bambu-interval" type="number" min="2" value="${s.interval_min || 15}" onchange="bambuSetInterval(this.value)" style="width:64px;display:inline-block;margin:0 4px;padding:4px 6px"> minutes</div>
        </label>
        <label class="flex items-center gap-3 p-3 rounded-lg cursor-pointer" style="background:var(--surface2);border:1px solid var(--border)">
            <input type="checkbox" id="bambu-autodeduct" ${s.auto_deduct ? 'checked' : ''} onchange="bambuToggleAutoDeduct(this.checked)" style="width:16px;height:16px;accent-color:var(--green);flex-shrink:0">
            <div class="text-sm" style="color:var(--text)">Auto-deduct confident matches
                <span class="text-xs mono block" style="color:var(--muted)">Off = every print waits for you to confirm</span></div>
        </label>
        <div class="grid grid-cols-2 gap-2">
            <div><label class="text-xs mono uppercase block mb-1" style="color:var(--muted)">Import from</label><input type="date" id="bambu-from" value="${_ymd(_yest)}"></div>
            <div><label class="text-xs mono uppercase block mb-1" style="color:var(--muted)">to</label><input type="date" id="bambu-to" value="${_ymd(_wk)}"></div>
        </div>
        <button class="btn-primary w-full" onclick="bambuSyncNow()">🔄 Sync now</button>
        <p class="text-xs mono" style="color:var(--muted)">Last sync: ${last}${s.last_result ? ' · ' + s.last_result : ''}</p>
        <div id="bambu-pending"></div>
        <button class="btn-ghost w-full text-xs" onclick="bambuRestoreSkipped()">↩︎ Restore skipped prints</button>`;
}

async function bambuLogin() {
    const email = (document.getElementById('bambu-email').value || '').trim();
    const password = document.getElementById('bambu-password').value || '';
    const region = document.getElementById('bambu-region').value;
    if (!email || !password) { showToast('Enter email and password', 'error'); return; }
    showToast('Contacting Bambu…');
    const { data } = await bambuApi('login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, region }) });
    if (data.error) { showToast(data.error, 'error'); return; }
    if (data.need_code) { bambuState.need_code = true; bambuState.email = email; renderBambuBody(); showToast('Code emailed — check your inbox'); return; }
    if (data.connected) { showToast('Connected to Bambu', 'success'); refreshBambu(); }
}

async function bambuVerify() {
    const code = (document.getElementById('bambu-code').value || '').trim();
    if (!code) { showToast('Enter the code', 'error'); return; }
    showToast('Verifying…');
    const { data } = await bambuApi('verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    if (data.error) { showToast(data.error, 'error'); return; }
    if (data.connected) { showToast('Connected to Bambu', 'success'); bambuState.need_code = false; refreshBambu(); }
}

function bambuStartOver() { bambuState.need_code = false; renderBambuBody(); }

async function bambuLogout() {
    await bambuApi('logout', { method: 'POST' });
    showToast('Disconnected from Bambu');
    refreshBambu();
}

async function bambuToggleAuto(on) {
    await bambuApi('settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auto_sync: on }) });
    showToast(on ? 'Auto-sync turned on' : 'Auto-sync turned off');
}
async function bambuSetInterval(v) {
    await bambuApi('settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ interval_min: parseInt(v) || 15 }) });
}

async function bambuSyncNow() {
    showToast('Syncing with Bambu…');
    const from = (document.getElementById('bambu-from') || {}).value || '';
    const to = (document.getElementById('bambu-to') || {}).value || '';
    const { data } = await bambuApi('sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to }) });
    if (data.error) { showToast(data.error, 'error'); return; }
    showToast(`Synced: ${data.deducted} deducted, ${data.pending} need a spool`);
    if (typeof loadAll === 'function') loadAll();
    refreshBambu();
}

function nozMatBase(m) { const x = (m || '').toUpperCase().match(/[A-Z]+/); return x ? x[0] : ''; }

function bambuUpdatePendingCount() {
    const el = document.getElementById('bambu-pending');
    if (!el) return;
    const n = el.querySelectorAll('[id^="bp-print-"]').length;
    const c = document.getElementById('bambu-pending-count');
    if (c) c.textContent = n ? `${n} print(s) need a spool` : 'All caught up — nothing to confirm.';
}

async function loadBambuPending() {
    const { data } = await bambuApi('pending');
    const el = document.getElementById('bambu-pending');
    if (!el) return;
    if (!Array.isArray(data) || !data.length) { el.innerHTML = ''; return; }
    const inStock = (filaments || []).filter(f => (parseFloat(f.weight_current) || 0) > 0);
    // Dropdown limited to the same material family (PLA shows PLA/PLA+/PLA Matte,
    // never PETG/TPU). Falls back to all spools if nothing in that family.
    const optsFor = (printMat, sel) => {
        const base = nozMatBase(printMat);
        let pool = inStock;
        if (base) {
            const fam = inStock.filter(f => nozMatBase(f.material) === base);
            if (fam.length) pool = fam;
        }
        return '<option value="">— pick spool —</option>' + pool.map(f =>
            `<option value="${f.id}" ${String(f.id) === String(sel) ? 'selected' : ''}>${f.brand || ''} ${f.color_name || ''} · ${f.material || ''} (${Math.round(f.weight_current)}g)</option>`).join('');
    };
    let html = `<p id="bambu-pending-count" class="text-xs mono uppercase mt-3 mb-2" style="color:var(--orange)">${data.length} print(s) need a spool</p>`;
    data.forEach(pr => {
        const tid = pr.task_id;
        const fils = pr.filaments || [];
        const multi = fils.length > 1;
        const thumb = pr.cover_url
            ? `<img src="${pr.cover_url}" referrerpolicy="no-referrer" onerror="this.style.display='none'" style="width:52px;height:52px;object-fit:cover;border-radius:8px;border:1px solid var(--border);flex-shrink:0">`
            : '';
        html += `<div id="bp-print-${tid}" class="p-3 rounded-lg mb-2" style="background:var(--surface2);border:1px solid var(--border)">
            <div class="flex gap-3 mb-2 items-start">
                ${thumb}
                <div class="flex-1 min-w-0">
                    <p class="text-sm font-bold" style="color:var(--text)">${pr.title || 'Bambu print'}${multi ? ` <span class="text-xs mono" style="color:var(--muted)">· ${fils.length} colours</span>` : ''}</p>
                    <p class="text-xs mono" style="color:var(--muted)">${pr.printer || ''}${pr.finished_at ? ' · ' + String(pr.finished_at).slice(0, 10) : ''}</p>
                </div>
                <button class="btn-ghost text-xs" onclick="bambuDismiss('${tid}')">Skip</button>
            </div>`;
        fils.forEach((f, fi) => {
            const mat = (f.material || '').replace(/'/g, '');
            const col = (f.colour || '').replace(/'/g, '');
            const sw = f.colour ? `<span style="display:inline-block;width:14px;height:14px;border-radius:4px;border:1px solid var(--border);background:${f.colour};vertical-align:middle;margin-right:6px"></span>` : '';
            const colourLabel = f.colour ? f.colour : 'colour unknown';
            html += `
                <div id="bp-row-${tid}-${fi}" class="mb-2">
                    <p class="text-xs mono" style="color:var(--muted)">${sw}${Math.round(f.grams)}g · ${f.material || 'material ?'} · ${colourLabel}</p>
                    <div class="flex gap-2 mt-1">
                        <select id="bp-${tid}-${fi}" style="flex:1">${optsFor(f.material, f.suggested_id)}</select>
                        <button class="btn-primary text-xs" onclick="bambuAssign('${tid}',${fi},${f.grams},'${mat}','${col}')">Assign</button>
                    </div>
                </div>`;
        });
        html += `</div>`;
    });
    el.innerHTML = html;
}

async function bambuAssign(task_id, fi, grams, material, colour) {
    const sel = document.getElementById(`bp-${task_id}-${fi}`);
    const fid = sel && sel.value;
    if (!fid) { showToast('Pick a spool first', 'error'); return; }
    const { data } = await bambuApi('assign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task_id, filament_id: parseInt(fid), grams, material, colour, learn: true }) });
    if (data.error) { showToast(data.error, 'error'); return; }
    showToast('Deducted ✓');
    const row = document.getElementById(`bp-row-${task_id}-${fi}`);
    if (row) row.remove();
    const block = document.getElementById(`bp-print-${task_id}`);
    if (block && !block.querySelector('[id^="bp-row-"]')) block.remove();
    bambuUpdatePendingCount();
    if (typeof loadAll === 'function') loadAll();   // refresh stock weights quietly
}

async function bambuDismiss(task_id) {
    await bambuApi('dismiss', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task_id }) });
    const block = document.getElementById(`bp-print-${task_id}`);
    if (block) block.remove();
    bambuUpdatePendingCount();
    showToast('Skipped — restore it any time');
}

async function bambuToggleAutoDeduct(on) {
    await bambuApi('settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auto_deduct: on }) });
    showToast(on ? 'Auto-deduct on' : 'Review mode — every print waits for confirmation');
}

async function bambuRestoreSkipped() {
    const { data } = await bambuApi('restore_skipped', { method: 'POST' });
    showToast(`Restored ${(data && data.restored) || 0} skipped print(s)`);
    refreshBambu();
}

// Light up the header dot if already connected (after the app has loaded the db)
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => { try { bambuApi('status').then(r => updateBambuDot(r.data && r.data.connected)); } catch (e) {} }, 1500);
    setTimeout(() => { try { bambuddyApi('status').then(r => updateBambuddyDot(r.data && r.data.connected)); } catch (e) {} }, 1500);
});

// ============================================================
// BAMBUDDY SYNC — pulls print history + nozzle hours from a
// self-hosted Bambuddy instance over its REST API. Sits alongside
// the Bambu Cloud sync above; both feed the same Nozzles tab.
// ============================================================
let bambuddyState = {};

function openBambuddyModal() {
    document.getElementById('bambuddy-modal-overlay').classList.add('open');
    refreshBambuddy();
}
function closeBambuddyModal() {
    document.getElementById('bambuddy-modal-overlay').classList.remove('open');
}

async function bambuddyApi(path, opts) {
    const db = (typeof currentDb !== 'undefined' && currentDb) ? currentDb : 'spoolstats';
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch('/api/bambuddy/' + path + sep + 'db=' + encodeURIComponent(db), opts);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
}

async function refreshBambuddy() {
    const { data } = await bambuddyApi('status');
    bambuddyState = data || {};
    renderBambuddyBody();
    updateBambuddyDot(data.connected);
}

function updateBambuddyDot(connected) {
    const dot = document.getElementById('bambuddy-dot');
    if (dot) dot.style.background = connected ? 'var(--green)' : 'var(--muted)';
}

function renderBambuddyBody() {
    const b = document.getElementById('bambuddy-body');
    if (!b) return;
    const s = bambuddyState;

    if (!s.connected) {
        b.innerHTML = `
            <p class="text-sm" style="color:var(--muted)">Connect your self-hosted Bambuddy instance to pull finished prints and log nozzle hours automatically — on top of (not instead of) Bambu Cloud sync.</p>
            <div><label class="text-xs mono uppercase block mb-1" style="color:var(--muted)">Bambuddy URL</label>
                <input id="bambuddy-url" type="text" placeholder="http://192.168.1.50:8000" value="${s.url || ''}"></div>
            <div><label class="text-xs mono uppercase block mb-1" style="color:var(--muted)">API key</label>
                <input id="bambuddy-key" type="password" placeholder="bb_..."></div>
            <button class="btn-primary w-full" onclick="bambuddyConnect()">Connect</button>
            <p class="text-[11px] mono" style="color:var(--muted)">Create a key in Bambuddy under Settings → API Keys, with the "Read Status" scope enabled.</p>`;
        return;
    }

    const last = s.last_sync ? new Date(s.last_sync).toLocaleString() : 'never';
    b.innerHTML = `
        <div class="p-3 rounded-lg flex items-center justify-between" style="background:var(--surface2);border:1px solid var(--border)">
            <div><p class="text-xs mono uppercase" style="color:var(--muted)">Connected</p>
                <a href="${s.url}" target="_blank" rel="noopener" class="text-sm font-bold" style="color:var(--green)">${s.url || ''} ↗</a></div>
            <button class="btn-ghost text-xs" onclick="bambuddyDisconnect()">Disconnect</button>
        </div>
        <label class="flex items-center gap-3 p-3 rounded-lg cursor-pointer" style="background:var(--surface2);border:1px solid var(--border)">
            <input type="checkbox" id="bambuddy-auto" ${s.auto_sync ? 'checked' : ''} onchange="bambuddyToggleAuto(this.checked)" style="width:16px;height:16px;accent-color:var(--green);flex-shrink:0">
            <div class="text-sm" style="color:var(--text)">Auto-sync every
                <input id="bambuddy-interval" type="number" min="2" value="${s.interval_min || 15}" onchange="bambuddySetInterval(this.value)" style="width:64px;display:inline-block;margin:0 4px;padding:4px 6px"> minutes</div>
        </label>
        <button class="btn-primary w-full" onclick="bambuddySyncNow()">🔄 Sync now</button>
        <p class="text-xs mono" style="color:var(--muted)">Last sync: ${last}${s.last_result ? ' · ' + s.last_result : ''}</p>
        <a href="${s.url}" target="_blank" rel="noopener" class="btn-ghost w-full text-xs" style="display:block;text-align:center;text-decoration:none">🖨 Open Bambuddy — prints, spools &amp; printers</a>`;
}

async function bambuddyConnect() {
    const url = (document.getElementById('bambuddy-url').value || '').trim();
    const api_key = (document.getElementById('bambuddy-key').value || '').trim();
    if (!url || !api_key) { showToast('Enter the Bambuddy URL and API key', 'error'); return; }
    showToast('Connecting to Bambuddy…');
    const { data } = await bambuddyApi('connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, api_key }) });
    if (data.error) { showToast(data.error, 'error'); return; }
    showToast('Connected to Bambuddy', 'success');
    refreshBambuddy();
}

async function bambuddyDisconnect() {
    await bambuddyApi('disconnect', { method: 'POST' });
    showToast('Disconnected from Bambuddy');
    refreshBambuddy();
}

async function bambuddyToggleAuto(on) {
    await bambuddyApi('settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auto_sync: on }) });
    showToast(on ? 'Auto-sync turned on' : 'Auto-sync turned off');
}
async function bambuddySetInterval(v) {
    await bambuddyApi('settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ interval_min: parseInt(v) || 15 }) });
}

async function bambuddySyncNow() {
    showToast('Syncing with Bambuddy…');
    const { data } = await bambuddyApi('sync', { method: 'POST' });
    if (data.error) { showToast(data.error, 'error'); return; }
    showToast(`Synced: ${data.new} new print(s), ${data.logged} logged to nozzle hours`);
    refreshBambuddy();
}


// ============================================================
// NOZZLES — print hours per printer + nozzle + size
// ============================================================
function nozHrs(sec) { return (Number(sec || 0) / 3600).toFixed(1); }
function nozDur(sec) {
    sec = Number(sec || 0);
    const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m}m`;
}

async function loadNozzles() {
    try {
        const data = await apiFetch('/api/nozzles');
        renderNozzles(data);
    } catch {
        showToast('Could not load nozzle data.', 'error');
    }
}

function renderNozzles(data) {
    const totals = data.totals || [], recent = data.recent || [], manual = data.manual || [];
    const totalSec = totals.reduce((a, t) => a + Number(t.total_s || 0), 0);
    const prints = totals.reduce((a, t) => a + Number(t.prints || 0), 0);
    const printers = new Set(totals.map(t => t.printer || '—'));
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    set('noz-stat-count', totals.length);
    set('noz-stat-hours', nozHrs(totalSec));
    set('noz-stat-prints', prints);
    set('noz-stat-printers', printers.size);

    const tEl = document.getElementById('nozzle-totals');
    if (tEl) {
        if (!totals.length) {
            tEl.innerHTML = '<p class="text-sm" style="color:var(--muted)">No nozzle data yet. Sync Bambu prints or add hours manually.</p>';
        } else {
            tEl.innerHTML = `<table class="w-full text-sm"><thead><tr class="text-xs mono uppercase" style="color:var(--muted)">
                <th class="text-left pb-2">Printer</th><th class="text-left pb-2">Nozzle</th><th class="text-left pb-2">Size</th>
                <th class="text-right pb-2">Hours</th><th class="text-right pb-2">Prints</th></tr></thead><tbody>` +
                totals.map(t => {
                    const eqName = [t.eq_brand, t.eq_model, t.eq_variant].filter(Boolean).join(' ');
                    const label = t.label || ('Nozzle ' + (t.nozzle_pos ?? '—'));
                    const esc = v => String(v || '').replace(/'/g, "\\'");
                    return `<tr style="border-top:1px solid var(--border)">
                    <td class="py-2" style="color:var(--text)">${t.printer || '—'}</td>
                    <td class="py-2" style="color:var(--text)">${label}
                        <button onclick="openNozzleNameModal('${esc(t.printer)}','${esc(t.nozzle_pos)}','${esc(t.label)}','${t.equipment_id || ''}')" title="Name / link to equipment" style="color:var(--accent);background:none;border:none;cursor:pointer;font-size:12px">✎</button>
                        ${eqName ? `<span class="text-xs mono block" style="color:var(--muted)">🔧 ${eqName}</span>` : ''}</td>
                    <td class="py-2" style="color:var(--text2)">${t.nozzle_size ? t.nozzle_size + 'mm' : '—'}</td>
                    <td class="py-2 text-right font-bold mono" style="color:var(--accent)">${nozHrs(t.total_s)}h</td>
                    <td class="py-2 text-right mono" style="color:var(--muted)">${t.prints}</td></tr>`;
                }).join('') +
                `</tbody></table>`;
        }
    }

    const mEl = document.getElementById('nozzle-manual-list');
    if (mEl) {
        mEl.innerHTML = manual.length
            ? ('<p class="text-xs mono uppercase mb-2 mt-2" style="color:var(--muted)">Manual entries</p>' +
                manual.map(m => `<div class="flex items-center justify-between text-xs py-1" style="color:var(--text2)">
                    <span>${m.printer || '—'} ${m.nozzle_pos || ''} ${m.nozzle_size ? m.nozzle_size + 'mm' : ''} · ${nozHrs(m.time_s)}h</span>
                    <button onclick="deleteNozzleManual(${m.id})" title="Remove" style="color:var(--red);background:none;border:none;cursor:pointer;font-size:14px">×</button></div>`).join(''))
            : '';
    }

    const rEl = document.getElementById('nozzle-recent');
    if (rEl) {
        if (!recent.length) {
            rEl.innerHTML = '<p class="text-sm" style="color:var(--muted)">No prints synced yet.</p>';
        } else {
            const esc = v => String(v || '').replace(/'/g, "\\'");
            rEl.innerHTML = `<div class="flex items-center justify-between mb-2">
                    <label class="text-xs mono flex items-center gap-2 cursor-pointer" style="color:var(--muted)"><input type="checkbox" id="np-selall" onchange="nozzleSelectAll(this.checked)" style="accent-color:var(--accent)"> Select all</label>
                    <button class="btn-ghost text-xs" style="color:var(--red)" onclick="deleteSelectedPrints()">Delete selected</button>
                </div>` +
                recent.map(r => {
                    const mins = Math.round((r.print_time_s || 0) / 60);
                    return `<div class="flex items-center justify-between py-2 gap-2" style="border-top:1px solid var(--border)">
                        <div class="flex items-center gap-2 min-w-0">
                            <input type="checkbox" class="np-check" value="${r.task_id}" style="accent-color:var(--accent);flex-shrink:0">
                            <div class="min-w-0">
                                <p class="text-sm font-bold" style="color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.title || 'Print'}</p>
                                <p class="text-xs mono" style="color:var(--muted)">${r.printer || ''}${r.nozzle_size ? ' · ' + r.nozzle_size + 'mm' : ''}${r.finished_at ? ' · ' + String(r.finished_at).slice(0, 10) : ''}</p>
                            </div>
                        </div>
                        <div class="flex items-center gap-2 flex-shrink-0">
                            <span class="text-sm mono" style="color:var(--accent)">${nozDur(r.print_time_s)}</span>
                            <button onclick="openPrintEditModal('${esc(r.task_id)}','${esc(r.title)}',${mins},'${esc(r.nozzle_size)}','${esc(r.printer)}')" title="Edit print" style="color:var(--accent);background:none;border:none;cursor:pointer;font-size:12px">✎</button>
                        </div></div>`;
                }).join('');
        }
    }
}

async function addNozzleHours() {
    const printer = (document.getElementById('noz-printer').value || '').trim();
    const pos = (document.getElementById('noz-pos').value || '').trim();
    const size = document.getElementById('noz-size').value;
    const hours = parseFloat(document.getElementById('noz-hours').value);
    if (!hours || hours <= 0) { showToast('Enter a number of hours', 'error'); return; }
    try {
        await apiFetch('/api/nozzles/manual', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ printer, nozzle_pos: pos, nozzle_size: size, hours })
        });
        showToast('Hours added');
        document.getElementById('noz-hours').value = '';
        loadNozzles();
    } catch { showToast('Could not add hours', 'error'); }
}

async function deleteNozzleManual(id) {
    try { await apiFetch('/api/nozzles/manual/' + id, { method: 'DELETE' }); loadNozzles(); } catch {}
}


// ---- Nozzle naming / equipment linking ----
async function openNozzleNameModal(printer, pos, label, eqId) {
    document.getElementById('nn-printer').value = printer || '';
    document.getElementById('nn-pos').value = pos || '';
    document.getElementById('nn-label').value = label || '';
    document.getElementById('nn-context').textContent =
        `${printer || 'Printer'} · nozzle position ${pos} (this always maps to the same physical nozzle)`;
    const sel = document.getElementById('nn-equipment');
    sel.innerHTML = '<option value="">— none —</option>';
    try {
        const eq = await apiFetch('/api/equipment');
        (eq || []).forEach(e => {
            const name = [e.brand, e.model, e.variant].filter(Boolean).join(' ') || ('Equipment #' + e.id);
            const o = document.createElement('option');
            o.value = e.id; o.textContent = name;
            if (String(e.id) === String(eqId)) o.selected = true;
            sel.appendChild(o);
        });
    } catch {}
    document.getElementById('nozzle-name-modal').classList.add('open');
}
function closeNozzleNameModal() { document.getElementById('nozzle-name-modal').classList.remove('open'); }

async function saveNozzleName() {
    const body = {
        printer: document.getElementById('nn-printer').value,
        nozzle_pos: document.getElementById('nn-pos').value,
        label: document.getElementById('nn-label').value.trim(),
        equipment_id: document.getElementById('nn-equipment').value || null
    };
    try {
        await apiFetch('/api/nozzles/name', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        showToast('Nozzle saved');
        closeNozzleNameModal();
        loadNozzles();
    } catch { showToast('Could not save', 'error'); }
}


// ---- Recent print edit / bulk delete (Nozzles tab) ----
function nozzleSelectAll(on) { document.querySelectorAll('.np-check').forEach(c => { c.checked = on; }); }

async function deleteSelectedPrints() {
    const ids = Array.from(document.querySelectorAll('.np-check:checked')).map(c => c.value);
    if (!ids.length) { showToast('Tick some prints first', 'error'); return; }
    if (!confirm(`Remove ${ids.length} print(s) from nozzle tracking? Their hours stop counting.`)) return;
    try {
        await apiFetch('/api/nozzles/print/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task_ids: ids }) });
        showToast(`Removed ${ids.length} print(s)`);
        loadNozzles();
    } catch { showToast('Could not delete', 'error'); }
}

function openPrintEditModal(taskId, title, minutes, size, printer) {
    document.getElementById('np-task').value = taskId;
    document.getElementById('np-title').textContent = title || '';
    document.getElementById('np-minutes').value = minutes || 0;
    document.getElementById('np-size').value = (size || '').split(',')[0] || '';
    document.getElementById('np-printer').value = printer || '';
    document.getElementById('nozzle-print-modal').classList.add('open');
}
function closePrintEditModal() { document.getElementById('nozzle-print-modal').classList.remove('open'); }

async function savePrintEdit() {
    const taskId = document.getElementById('np-task').value;
    const body = {
        minutes: parseFloat(document.getElementById('np-minutes').value) || 0,
        nozzle_size: document.getElementById('np-size').value,
        printer: document.getElementById('np-printer').value.trim()
    };
    try {
        await apiFetch('/api/nozzles/print/' + encodeURIComponent(taskId), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        showToast('Print updated');
        closePrintEditModal();
        loadNozzles();
    } catch { showToast('Could not save', 'error'); }
}

async function deletePrintSingle() {
    const taskId = document.getElementById('np-task').value;
    if (!confirm('Remove this print from nozzle tracking?')) return;
    try {
        await apiFetch('/api/nozzles/print/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task_id: taskId }) });
        showToast('Removed');
        closePrintEditModal();
        loadNozzles();
    } catch { showToast('Could not delete', 'error'); }
}
