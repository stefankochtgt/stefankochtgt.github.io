// Document Desk (SFM-254, Mini Tools plugin): PDFs, Excel workbooks, CSV files and images shown as windows on one
// stage, for screen sharing. Each window keeps its own place -- stored as fractions of the stage, so the arrangement
// holds when the browser window changes or goes full screen -- and its own zoom; nothing re-fits by itself. Arrange
// leaves locked windows where they are and fills the largest free part of the stage. Files are read in this browser
// (pdf.js for PDFs, readXlsx() below for workbooks) and kept with the desk in IndexedDB, so the desk comes back after
// a reload; they are never uploaded.
import * as pdfjsLib from '../vendor/pdfjs/pdf.min.js';

// pdf.js files relative to this script, so the same file works in the app (/static/js/) and in the standalone
// Document Desk (SFM-262, js/ next to vendor/)
const PDFJS = new URL('../vendor/pdfjs/', import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
const PT = 4 / 3;                      // CSS px per PDF point: 100 % = the size Acrobat shows at 100 %
const SNAP = 8, GAP = 6, MIN_W = 180, MIN_H = 110;
// Edge draws canvases in graphics memory; when that runs out the whole page goes black (user, 2026-11-06, two PDFs
// and a sheet). So a PDF page gets at most this many pixels and only pages near the view are kept.
const MAX_CANVAS_PIXELS = 8e6;
const ON_TOP = 100000;                 // z-index offset of "always on top" windows
const DIRS = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'];
const KIND_LABEL = {pdf: 'PDF', sheet: 'XLSX', csv: 'CSV', image: 'IMG'};

const stage = $('dd-stage');
const desk = {windows: [], arrange: '', layouts: {}, slim: false, clean: false, nextId: 1, z: 1};
const live = new Map();                // window id -> runtime state (DOM, open document); never saved
const files = new Map();               // file id -> {id, name, type, blob}
let activeId = null;

// ---------------------------------------------------------------- storage (IndexedDB: the files and the desk)

const db = (() => {
    let opening = null;
    const open = () => opening || (opening = new Promise((resolve, reject) => {
        const req = indexedDB.open('documentDesk', 1);
        req.onupgradeneeded = () => {
            req.result.createObjectStore('files', {keyPath: 'id'});
            req.result.createObjectStore('state');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    }));
    const run = (name, mode, fn) => open().then(base => new Promise((resolve, reject) => {
        const tx = base.transaction(name, mode);
        const req = fn(tx.objectStore(name));
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = tx.onabort = () => reject(tx.error);
    }));
    return {
        getFile: id => run('files', 'readonly', s => s.get(id)),
        putFile: file => run('files', 'readwrite', s => s.put(file)),
        deleteFile: id => run('files', 'readwrite', s => s.delete(id)),
        getState: () => run('state', 'readonly', s => s.get('desk')),
        putState: value => run('state', 'readwrite', s => s.put(value, 'desk')),
    };
})();

let storageWarned = false;
function storageFailed(e) {
    console.warn('Document Desk storage', e);
    if (storageWarned) return;
    storageWarned = true;
    status('This browser does not keep the desk (storage blocked) -- it is gone after a reload.', true);
}

let saveTimer = 0;
const saveNow = () => { clearTimeout(saveTimer); saveTimer = 0; db.putState(JSON.parse(JSON.stringify(desk))).catch(storageFailed); };
const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 250); };
window.addEventListener('pagehide', () => { if (saveTimer) saveNow(); });

function status(msg, warn = false) {
    $('dd-status').textContent = msg;
    $('dd-status').classList.toggle('warn', warn);
}

// ---------------------------------------------------------------- files

function kindOf(file) {
    const ext = (/\.([^.]+)$/.exec(file.name) || [, ''])[1].toLowerCase();
    if (ext === 'pdf' || file.type === 'application/pdf') return 'pdf';
    if (['xlsx', 'xlsm', 'xltx', 'xltm'].includes(ext)) return 'sheet';
    if (ext === 'csv' || ext === 'tsv') return 'csv';
    if (/^(png|jpe?g|gif|webp|bmp|svg)$/.test(ext) || (file.type || '').startsWith('image/')) return 'image';
    return null;
}

// The record keeps the file's handle where the browser gives one (Edge / Chrome: drop, Add files…), so Save can write
// the changes back into that file.
async function keepFile(file, handle = null) {
    const id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const rec = {id, name: file.name, type: file.type, handle, blob: new Blob([await file.arrayBuffer()], {type: file.type})};
    files.set(id, rec);
    await putRecord(rec);
    return id;
}

const putRecord = rec => db.putFile(rec)
    .catch(e => e && e.name === 'DataCloneError' ? db.putFile({...rec, handle: null}) : Promise.reject(e))
    .catch(storageFailed);

function forgetFileIfUnused(id) {
    if (desk.windows.some(w => w.fileId === id)) return;
    files.delete(id);
    db.deleteFile(id).catch(() => {});
}

async function addFiles(list, replaceId = null, handles = []) {
    const accepted = [], refused = [];
    const handleOf = f => handles.find(h => h && h.name === f.name) || null;
    for (const f of list) {
        const kind = kindOf(f);
        if (kind) accepted.push([f, kind]); else refused.push(f.name);
    }
    if (refused.length) status(`Not shown: ${refused.join(', ')} -- PDF, Excel (.xlsx / .xlsm), CSV and images only `
        + '(an old .xls: save it as .xlsx in Excel).', true);
    else status('');
    const target = replaceId != null ? desk.windows.find(w => w.id === replaceId) : null;
    let replaced = true;
    if (target && accepted.length) {
        const [f, kind] = accepted.shift();
        replaced = await replaceDocument(target, f, kind, handleOf(f));
    }
    if (!accepted.length) { saveSoon(); return replaced; }
    const added = [];
    for (const [f, kind] of accepted) {
        added.push({id: desk.nextId++, fileId: await keepFile(f, handleOf(f)), name: f.name, kind, x: 0, y: 0, w: 0.5, h: 0.6,
                    zoom: 0, locked: false, onTop: false, z: desk.z++, view: null, max: null, dirty: false});
    }
    place(added);
    desk.windows.push(...added);
    added.forEach(mount);
    if (desk.arrange) arrange(desk.arrange, added);
    activate(added[added.length - 1]);
    refreshEmpty();
    saveSoon();
    return replaced;
}

// New windows when no arrangement is active: cascaded in the largest free part of the stage.
function place(added) {
    const r = freeRect() || {x: 0, y: 0, w: 1, h: 1};
    const w = Math.min(r.w, 0.55), h = Math.min(r.h, 0.8);
    added.forEach((win, i) => {
        const step = (desk.windows.length + i) % 6 * 0.03;
        Object.assign(win, {w, h, x: Math.min(r.x + step, r.x + r.w - w), y: Math.min(r.y + step, r.y + r.h - h)});
    });
}

// false: the window has unsaved changes and the user kept them
async function replaceDocument(w, file, kind, handle = null) {
    if (w.dirty && !confirm(`"${w.name}" has changes that are not saved into its file. Replace it anyway?`)) return false;
    const rt = live.get(w.id);
    VIEWERS[w.kind].close(rt);
    const old = w.fileId;
    w.fileId = await keepFile(file, handle);
    if (kind !== w.kind) w.zoom = 0;          // same kind of document: the zoom stays
    w.name = file.name;
    w.kind = kind;
    w.view = null;
    w.dirty = false;
    labelWindow(w);
    forgetFileIfUnused(old);
    paint(w);
    openDocument(w);
    return true;
}

// ---------------------------------------------------------------- windows

const EDITABLE = {sheet: true, csv: true};

function mount(w) {
    const el = document.createElement('div');
    el.className = 'dd-win';
    el.dataset.id = w.id;
    el.innerHTML = `<div class="dd-head"><span class="dd-kind"></span><span class="dd-name"></span><span class="dd-info"></span>
        <span class="dd-tools">
        <button type="button" data-act="lib" title="Show a document of the Library in this window instead">📚</button>
        <button type="button" data-act="save" title="Save the changes into the file (Ctrl+S)">💾</button>
        <button type="button" data-act="out" title="Zoom out (Ctrl + mouse wheel, Ctrl + −)">−</button><button type="button" data-act="zoom" class="dd-zoom" title="Zoom: a level, fit width or fit page"></button><button type="button" data-act="in" title="Zoom in (Ctrl + mouse wheel, Ctrl + +)">+</button>
        <button type="button" data-act="fit" title="Fit the width once (the zoom then stays as it is)">↔</button>
        <button type="button" data-act="top" title="Always on top of the other windows">📌</button>
        <button type="button" data-act="lock" title="Lock place and size -- Arrange leaves the window where it is">🔓</button>
        <button type="button" data-act="max" title="Fill the desk / back (or double-click the title bar)">▢</button>
        <button type="button" data-act="close" title="Close">✕</button></span></div>
        <div class="dd-body" tabindex="-1"></div><div class="dd-tabs" hidden></div>`
        + DIRS.map(d => `<i class="dd-rs" data-dir="${d}"></i>`).join('');
    stage.appendChild(el);
    const rt = {el, head: el.querySelector('.dd-head'), body: el.querySelector('.dd-body'), info: el.querySelector('.dd-info'),
                tabs: el.querySelector('.dd-tabs'), gen: 0};
    live.set(w.id, rt);
    rt.head.querySelector('[data-act="lib"]').hidden = !$('dd-lib');
    rt.head.title = 'Drag to move -- Ctrl + drag onto another window to swap the two';
    labelWindow(w);

    el.addEventListener('pointerdown', () => activate(w), true);
    rt.head.addEventListener('pointerdown', e => { if (!e.target.closest('button')) startDrag(e, w, 'move'); });
    rt.head.addEventListener('dblclick', e => { if (!e.target.closest('button')) toggleMax(w); });
    el.querySelectorAll('.dd-rs').forEach(h => h.addEventListener('pointerdown', e => startDrag(e, w, h.dataset.dir)));
    rt.head.querySelector('.dd-tools').addEventListener('click', e => {
        const act = e.target.closest('button')?.dataset.act;
        if (act) ACTIONS[act](w);
    });
    rt.body.addEventListener('scroll', () => {
        if (rt.tracking) return;
        rt.tracking = true;
        requestAnimationFrame(() => { rt.tracking = false; if (VIEWERS[w.kind].ready(rt)) VIEWERS[w.kind].track(w, rt); });
    });
    // Ctrl + wheel (and a touchpad pinch, which the browser sends as one) zooms this window around the mouse; the
    // small steps of a pinch are added up, so it zooms smoothly instead of not at all
    el.addEventListener('wheel', e => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        const box = rt.body.getBoundingClientRect();
        const step = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
        rt.wheelZoom = (rt.wheelZoom || w.zoom || 1) * Math.exp(-step * 0.0015);
        clearTimeout(rt.wheelTimer);
        rt.wheelTimer = setTimeout(() => { rt.wheelZoom = 0; }, 300);
        setZoom(w, rt.wheelZoom, {x: Math.max(0, e.clientX - box.left), y: Math.max(0, e.clientY - box.top)});
    }, {passive: false});
    paint(w);
    openDocument(w);
}

function labelWindow(w) {
    const rt = live.get(w.id);
    rt.el.dataset.kind = w.kind;
    rt.head.querySelector('.dd-kind').textContent = KIND_LABEL[w.kind];
    rt.head.querySelector('[data-act="save"]').hidden = !EDITABLE[w.kind];
    rt.info.textContent = '';
    rt.tabs.hidden = true;
}

function paint(w) {
    const rt = live.get(w.id);
    if (!rt) return;
    const s = rt.el.style;
    s.left = w.x * 100 + '%';
    s.top = w.y * 100 + '%';
    s.width = w.w * 100 + '%';
    s.height = w.h * 100 + '%';
    s.zIndex = (w.onTop ? ON_TOP : 0) + w.z;
    rt.el.classList.toggle('locked', !!w.locked);
    rt.el.classList.toggle('active', activeId === w.id);
    rt.el.classList.toggle('dirty', !!w.dirty);
    const name = rt.head.querySelector('.dd-name');
    name.textContent = w.name;
    name.title = w.dirty ? `${w.name} -- changed, not saved into the file yet (💾 / Ctrl+S)` : w.name;
    const btn = act => rt.head.querySelector(`[data-act="${act}"]`);
    btn('save').classList.toggle('on', !!w.dirty);
    btn('top').classList.toggle('on', !!w.onTop);
    btn('lock').classList.toggle('on', !!w.locked);
    btn('lock').textContent = w.locked ? '🔒' : '🔓';
    btn('max').classList.toggle('on', !!w.max);
    btn('zoom').textContent = w.zoom ? Math.round(w.zoom * 100) + '%' : '…';
}

function activate(w) {
    if (desk.z > 90000) {                     // keep the z-indexes small
        [...desk.windows].sort((a, b) => a.z - b.z).forEach((o, i) => { o.z = i + 1; });
        desk.z = desk.windows.length + 1;
    }
    const before = activeId;
    activeId = w.id;
    if (w.z !== desk.z - 1) w.z = desk.z++;
    desk.windows.forEach(o => { if (o === w || o.id === before) paint(o); else live.get(o.id).el.style.zIndex = (o.onTop ? ON_TOP : 0) + o.z; });
    saveSoon();
}

function closeWindow(w, force = false) {
    if (w.dirty && !force && !confirm(`"${w.name}" has changes that are not saved into its file. Close it anyway?`)) return;
    const rt = live.get(w.id);
    VIEWERS[w.kind].close(rt);
    rt.gen++;
    rt.el.remove();
    live.delete(w.id);
    desk.windows = desk.windows.filter(o => o !== w);
    forgetFileIfUnused(w.fileId);
    if (activeId === w.id) activeId = null;
    refreshEmpty();
    saveSoon();
    findDocsChanged();
}

function toggleMax(w) {
    if (w.locked) return;
    if (w.max) { Object.assign(w, w.max); w.max = null; }
    else { w.max = {x: w.x, y: w.y, w: w.w, h: w.h}; Object.assign(w, {x: 0, y: 0, w: 1, h: 1}); }
    desk.arrange = '';
    markArrange();
    paint(w);
    saveSoon();
}

const ACTIONS = {
    save: w => saveFile(w),
    lib: w => openLibrary(w),
    out: w => stepZoom(w, -1),
    in: w => stepZoom(w, 1),
    zoom: w => zoomMenu(w),
    fit: w => { const rt = live.get(w.id); if (VIEWERS[w.kind].ready(rt)) setZoom(w, VIEWERS[w.kind].fit(w, rt)); },
    top: w => { w.onTop = !w.onTop; paint(w); saveSoon(); },
    lock: w => { w.locked = !w.locked; paint(w); saveSoon(); },
    max: toggleMax,
    close: w => closeWindow(w),
};

const clampZoom = z => Math.min(4, Math.max(0.1, Math.round(z * 100) / 100));

// A new zoom for one window. `anchor` (px in the window's body) stays where it is, e.g. the point under the mouse.
// PDF pages are drawn again only when the zooming has paused for a moment.
function setZoom(w, z, anchor = null) {
    z = clampZoom(z);
    const rt = live.get(w.id), viewer = VIEWERS[w.kind];
    if (Math.abs(z - w.zoom) < 0.001) return;
    if (!viewer.ready(rt)) { w.zoom = z; paint(w); saveSoon(); return; }
    if (!rt.zoomFrom) { viewer.track(w, rt, false); rt.zoomFrom = w.zoom; }
    w.zoom = z;
    rt.zoomAnchor = anchor;
    paint(w);
    clearTimeout(rt.zoomTimer);
    const apply = () => {
        const k = w.zoom / rt.zoomFrom, a = rt.zoomAnchor;
        rt.zoomFrom = 0;
        viewer.rezoom(w, rt);
        if (a) {
            rt.body.scrollTop += a.y * (k - 1);
            rt.body.scrollLeft += a.x * (k - 1);
        }
        viewer.track(w, rt);
    };
    if (viewer.slowZoom) rt.zoomTimer = setTimeout(apply, 150); else apply();
    saveSoon();
}

function stepZoom(w, dir) {
    const z = w.zoom || 1;
    const next = dir > 0 ? ZOOMS.find(s => s > z + 0.001) : [...ZOOMS].reverse().find(s => s < z - 0.001);
    if (next) setZoom(w, next);
}

function closeMenus() { document.querySelectorAll('.dd-menu').forEach(m => m.remove()); }
document.addEventListener('pointerdown', e => { if (!e.target.closest('.dd-menu, [data-act="zoom"]')) closeMenus(); }, true);

function zoomMenu(w) {
    const rt = live.get(w.id), viewer = VIEWERS[w.kind];
    if (rt.el.querySelector('.dd-menu')) { closeMenus(); return; }
    closeMenus();
    const menu = document.createElement('div');
    menu.className = 'dd-menu';
    menu.innerHTML = [0.5, 0.75, 1, 1.25, 1.5, 2, 3].map(z => `<button type="button" data-z="${z}">${z * 100} %</button>`).join('')
        + '<button type="button" data-fit="width">Fit width</button>'
        + (viewer.fitPage ? '<button type="button" data-fit="page">Fit page</button>' : '');
    menu.addEventListener('click', e => {
        const b = e.target.closest('button');
        if (!b) return;
        closeMenus();
        if (b.dataset.z) setZoom(w, +b.dataset.z);
        else if (viewer.ready(rt)) setZoom(w, b.dataset.fit === 'page' ? viewer.fitPage(w, rt) : viewer.fit(w, rt));
    });
    menu.style.left = Math.max(0, rt.head.querySelector('.dd-zoom').offsetLeft - 20) + 'px';
    rt.el.appendChild(menu);
}

// The windows along one border of `w` (edge 'l' / 'r' / 't' / 'b'): those whose same edge lies on it and those on the
// other side of it (up to one gap away), next to each other along the border. Dragging the border moves all of them.
function borderGroup(w, edge, start) {
    const TOL = 3, vertical = edge === 'l' || edge === 'r', a = start.get(w), X = a[edge];
    const opp = {l: 'r', r: 'l', t: 'b', b: 't'}[edge], facing = edge === 'r' || edge === 'b' ? 1 : -1;
    const lo = vertical ? 't' : 'l', hi = vertical ? 'b' : 'r';
    let span = [a[lo], a[hi]];
    const group = [[w, edge]], seen = new Set([w]);
    for (let grew = true; grew;) {
        grew = false;
        for (const o of desk.windows) {
            if (seen.has(o)) continue;
            const b = start.get(o);
            if (b[lo] >= span[1] + GAP + TOL || b[hi] <= span[0] - GAP - TOL) continue;
            let side = null;
            if (Math.abs(b[edge] - X) <= TOL) side = edge;
            else { const d = (b[opp] - X) * facing; if (d >= -TOL && d <= GAP + TOL) side = opp; }
            if (!side) continue;
            group.push([o, side]);
            seen.add(o);
            span = [Math.min(span[0], b[lo]), Math.max(span[1], b[hi])];
            grew = true;
        }
    }
    return group;
}

// Move (dir 'move') or resize (dir = edges, e.g. 'se') by mouse. A resized edge takes the windows sharing that border
// along (Alt: this window alone); a window alone snaps to the stage and to the other windows.
function startDrag(e, w, dir) {
    if (e.button === 0 && dir === 'move' && (e.ctrlKey || e.metaKey) && desk.windows.length > 1) return startSwap(e, w);
    if (e.button !== 0 || w.locked) return;
    e.preventDefault();
    const box = stage.getBoundingClientRect(), W = box.width, H = box.height;
    const start = new Map(desk.windows.map(o => [o, {l: o.x * W, t: o.y * H, r: (o.x + o.w) * W, b: (o.y + o.h) * H}]));
    const r0 = start.get(w);
    const xs = [0, W], ys = [0, H];
    for (const o of desk.windows) {
        if (o === w) continue;
        const {l, r, t, b} = start.get(o);
        xs.push(l, r, l - GAP, r + GAP);
        ys.push(t, b, t - GAP, b + GAP);
    }
    const near = (v, list) => list.reduce((best, s) => Math.abs(s - v) < Math.abs(best - v) ? s : best, Infinity);
    const snap = (v, list) => { const s = near(v, list); return Math.abs(s - v) <= SNAP ? s : v; };
    const snapMove = (from, size, list) => {
        const a = near(from, list) - from, b = near(from + size, list) - (from + size);
        const d = Math.abs(a) <= Math.abs(b) ? a : b;
        return Math.abs(d) <= SNAP ? from + d : from;
    };
    const movers = [];
    if (dir !== 'move') {
        for (const side of dir) {
            const edge = {e: 'r', w: 'l', s: 'b', n: 't'}[side];
            const group = e.altKey ? [[w, edge]] : borderGroup(w, edge, start);
            if (group.some(([o]) => o.locked)) status('A locked window shares this border -- unlock it (🔒), or hold Alt to resize this window alone.', true);
            else movers.push(...group);
        }
    }
    // how far the movers' edges may go: no window below its smallest size, none out of the stage
    const solve = (list, d, size, snapList) => {
        if (!list.length) return 0;
        if (list.length === 1) { const [o, s] = list[0], v = start.get(o)[s]; d = snap(v + d, snapList) - v; }
        let lo = -Infinity, hi = Infinity;
        for (const [o, s] of list) {
            const b = start.get(o), min = s === 'l' || s === 'r' ? MIN_W : MIN_H;
            if (s === 'r' || s === 'b') { lo = Math.max(lo, (s === 'r' ? b.l : b.t) + min - b[s]); hi = Math.min(hi, size - b[s]); }
            else { hi = Math.min(hi, (s === 'l' ? b.r : b.b) - min - b[s]); lo = Math.max(lo, -b[s]); }
        }
        return Math.max(lo, Math.min(hi, d));
    };
    const x0 = e.clientX, y0 = e.clientY, handle = e.target;
    handle.setPointerCapture(e.pointerId);
    stage.classList.add('moving');
    const put = (o, b) => { Object.assign(o, {x: b.l / W, y: b.t / H, w: (b.r - b.l) / W, h: (b.b - b.t) / H}); paint(o); };
    const move = ev => {
        const dx = ev.clientX - x0, dy = ev.clientY - y0;
        if (dir === 'move') {
            const ww = r0.r - r0.l, hh = r0.b - r0.t;
            const l = Math.max(0, Math.min(W - ww, snapMove(r0.l + dx, ww, xs)));
            const t = Math.max(0, Math.min(H - hh, snapMove(r0.t + dy, hh, ys)));
            put(w, {l, t, r: l + ww, b: t + hh});
            return;
        }
        const across = movers.filter(([, s]) => s === 'l' || s === 'r'), along = movers.filter(([, s]) => s === 't' || s === 'b');
        const ddx = solve(across, dx, W, xs), ddy = solve(along, dy, H, ys);
        for (const o of new Set(movers.map(([o]) => o))) {
            const b = {...start.get(o)};
            for (const [m, s] of movers) if (m === o) b[s] += s === 'l' || s === 'r' ? ddx : ddy;
            put(o, b);
        }
    };
    const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        stage.classList.remove('moving');
        for (const o of new Set([w, ...movers.map(([o]) => o)])) { o.max = null; paint(o); }
        desk.arrange = '';
        markArrange();
        saveSoon();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
}

// Ctrl + drag by the title bar onto another window (SFM-260): the two swap places. Place, size, lock and the
// "fill the desk" state belong to the place; document, zoom, scroll position and "on top" stay with the window.
// Released anywhere else (or Esc), the window goes back. Works for locked windows too -- the lock stays in its place.
function startSwap(e, w) {
    e.preventDefault();
    const box = stage.getBoundingClientRect(), rt = live.get(w.id);
    const x0 = e.clientX, y0 = e.clientY, handle = e.target;
    handle.setPointerCapture(e.pointerId);
    stage.classList.add('moving', 'swapping');
    rt.el.classList.add('dd-swap-src');
    status('Release over another window to swap the two -- elsewhere (or Esc) to leave them.');
    let target = null;
    const stack = o => (o.onTop ? ON_TOP : 0) + o.z;
    const under = ev => {
        const x = (ev.clientX - box.left) / box.width, y = (ev.clientY - box.top) / box.height;
        return desk.windows.filter(o => o !== w && x >= o.x && x <= o.x + o.w && y >= o.y && y <= o.y + o.h)
            .sort((a, b) => stack(b) - stack(a))[0] || null;
    };
    const mark = t => {
        if (t === target) return;
        if (target) live.get(target.id)?.el.classList.remove('dd-swap-target');
        target = t;
        if (target) live.get(target.id).el.classList.add('dd-swap-target');
    };
    // the dragged window shrinks around the grabbed point, so the window under it stays visible
    const own = rt.el.getBoundingClientRect();
    rt.el.style.transformOrigin = `${x0 - own.left}px ${y0 - own.top}px`;
    const move = ev => {
        rt.el.style.transform = `translate(${ev.clientX - x0}px, ${ev.clientY - y0}px) scale(.4)`;
        mark(under(ev));
    };
    const end = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', cancel);
        document.removeEventListener('keydown', key, true);
        if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
        rt.el.style.transform = rt.el.style.transformOrigin = '';
        rt.el.classList.remove('dd-swap-src');
        stage.classList.remove('moving', 'swapping');
        const t = target;
        mark(null);
        if (t) swapPlaces(w, t); else status('');
    };
    const up = ev => { mark(under(ev)); end(); };
    const cancel = () => { mark(null); end(); };
    const key = ev => { if (ev.key === 'Escape') { ev.preventDefault(); cancel(); } };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', cancel);
    document.addEventListener('keydown', key, true);
}

function swapPlaces(a, b) {
    for (const k of ['x', 'y', 'w', 'h', 'locked', 'max']) [a[k], b[k]] = [b[k], a[k]];
    paint(a);
    paint(b);
    status(`Swapped “${a.name}” and “${b.name}”.`);
    saveSoon();
}

// ---------------------------------------------------------------- arranging

// The largest empty rectangle of the stage not covered by a locked window (fractions), or null.
function freeRect() {
    const locked = desk.windows.filter(w => w.locked);
    if (!locked.length) return {x: 0, y: 0, w: 1, h: 1};
    const N = 96, eps = 1e-6;
    const blocked = (i, j) => locked.some(w => w.x < (j + 1) / N - eps && w.x + w.w > j / N + eps
                                            && w.y < (i + 1) / N - eps && w.y + w.h > i / N + eps);
    const heights = new Array(N).fill(0);
    let best = null;
    for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) heights[j] = blocked(i, j) ? 0 : heights[j] + 1;
        const stack = [];                     // largest rectangle in the histogram of free cells
        for (let j = 0; j <= N; j++) {
            const h = j < N ? heights[j] : 0;
            let start = j;
            while (stack.length && stack[stack.length - 1][1] >= h) {
                const [s, sh] = stack.pop();
                if (sh && (!best || sh * (j - s) > best.area)) best = {area: sh * (j - s), x0: s, x1: j, y0: i + 1 - sh, y1: i + 1};
                start = s;
            }
            stack.push([start, h]);
        }
    }
    if (!best) return null;
    let x = best.x0 / N, y = best.y0 / N, r = best.x1 / N, b = best.y1 / N;
    // the cell grid leaves up to one cell between the region and a locked window: move the edges onto the window's
    const across = w => w.y < b && w.y + w.h > y, along = w => w.x < r && w.x + w.w > x;
    for (const w of locked) {
        if (across(w) && w.x + w.w <= x + eps && w.x + w.w > x - 1 / N) x = w.x + w.w;
        if (across(w) && w.x >= r - eps && w.x < r + 1 / N) r = w.x;
        if (along(w) && w.y + w.h <= y + eps && w.y + w.h > y - 1 / N) y = w.y + w.h;
        if (along(w) && w.y >= b - eps && w.y < b + 1 / N) b = w.y;
    }
    return {x, y, w: r - x, h: b - y};
}

function cells(r, n, cols, gx, gy) {
    const rows = Math.ceil(n / cols), out = [];
    const h = (r.h - gy * (rows - 1)) / rows;
    for (let row = 0; row < rows; row++) {
        const inRow = Math.min(cols, n - row * cols);   // a shorter last row is widened to the full width
        const w = (r.w - gx * (inRow - 1)) / inRow;
        for (let c = 0; c < inRow; c++) out.push({x: r.x + c * (w + gx), y: r.y + row * (h + gy), w, h});
    }
    return out;
}

const LAYOUTS = {
    columns: (n, r, gx, gy) => cells(r, n, n, gx, gy),
    rows: (n, r, gx, gy) => cells(r, n, 1, gx, gy),
    grid: (n, r, gx, gy) => cells(r, n, Math.ceil(Math.sqrt(n)), gx, gy),
    main: (n, r, gx, gy) => {
        if (n === 1) return [r];
        const mw = (r.w - gx) * 0.62;
        return [{x: r.x, y: r.y, w: mw, h: r.h},
                ...cells({x: r.x + mw + gx, y: r.y, w: r.w - mw - gx, h: r.h}, n - 1, 1, gx, gy)];
    },
};

// Arrange every unlocked window by `kind` in the free part of the stage. Order: the current reading order (new
// windows last); for "main" the active window comes first.
function arrange(kind, fresh = []) {
    const box = stage.getBoundingClientRect();
    const region = freeRect();
    const ws = desk.windows.filter(w => !w.locked);
    if (!ws.length) return;
    if (!region || region.w * box.width < MIN_W || region.h * box.height < MIN_H) {
        status('No room left: locked windows cover the desk. Unlock one (🔒) to arrange the others.', true);
        return;
    }
    const isNew = w => fresh.includes(w);
    const cx = w => w.x + w.w / 2, cy = w => w.y + w.h / 2;
    const order = {
        columns: (a, b) => cx(a) - cx(b) || cy(a) - cy(b),
        rows: (a, b) => cy(a) - cy(b) || cx(a) - cx(b),
        grid: (a, b) => Math.round(cy(a) * 8) - Math.round(cy(b) * 8) || cx(a) - cx(b),
        main: (a, b) => (b.id === activeId) - (a.id === activeId) || cy(a) - cy(b) || cx(a) - cx(b),
    }[kind];
    ws.sort((a, b) => isNew(a) - isNew(b) || order(a, b) || a.id - b.id);
    const gx = GAP / box.width, gy = GAP / box.height;
    const r = {x: region.x + gx, y: region.y + gy, w: region.w - 2 * gx, h: region.h - 2 * gy};
    LAYOUTS[kind](ws.length, r, gx, gy).forEach((rect, i) => { Object.assign(ws[i], rect); ws[i].max = null; paint(ws[i]); });
    desk.arrange = kind;
    markArrange();
    saveSoon();
}

function markArrange() {
    document.querySelectorAll('[data-arrange]').forEach(b => b.classList.toggle('on', b.dataset.arrange === desk.arrange));
}

// ---------------------------------------------------------------- saved layouts

function fillLayouts(selected = '') {
    const sel = $('dd-layouts');
    sel.innerHTML = '<option value="">Saved layouts…</option>' + Object.keys(desk.layouts).sort()
        .map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    sel.value = selected in desk.layouts ? selected : '';
}

function saveLayout() {
    if (!desk.windows.length) { status('Nothing to save: the desk is empty.', true); return; }
    const name = (prompt('Name of the layout (e.g. "Review: plan left, FMEA right"):', $('dd-layouts').value) || '').trim();
    if (!name) return;
    desk.layouts[name] = [...desk.windows].sort((a, b) => a.z - b.z).map(w => ({
        fileId: w.fileId, name: w.name, kind: w.kind, x: w.x, y: w.y, w: w.w, h: w.h, zoom: w.zoom,
        locked: w.locked, onTop: w.onTop}));
    fillLayouts(name);
    saveSoon();
    status(`Layout "${name}" saved (${desk.layouts[name].length} windows).`);
}

// Puts the windows back: a window takes the entry of the same file (else the same name, else the same kind of
// document, else the next one left) -- so a layout also works for the next set of documents.
function applyLayout(name) {
    const entries = desk.layouts[name];
    if (!entries) return;
    const free = [...desk.windows].sort((a, b) => a.z - b.z), pairs = [];
    const take = test => { for (const e of entries) {
        if (e.taken) continue;
        const w = free.find(o => test(o, e));
        if (w) { e.taken = true; free.splice(free.indexOf(w), 1); pairs.push([w, e]); }
    } };
    take((o, e) => o.fileId === e.fileId);
    take((o, e) => o.name === e.name);
    take((o, e) => o.kind === e.kind);
    take(() => true);
    entries.forEach(e => delete e.taken);
    for (const [w, e] of pairs) {
        Object.assign(w, {x: e.x, y: e.y, w: e.w, h: e.h, locked: !!e.locked, onTop: !!e.onTop, max: null, z: desk.z++});
        if (e.zoom) setZoom(w, e.zoom);
        paint(w);
    }
    desk.arrange = '';
    markArrange();
    saveSoon();
    status(`Layout "${name}" applied to ${pairs.length} window${pairs.length === 1 ? '' : 's'}.`);
}

// ---------------------------------------------------------------- opening a document

async function openDocument(w) {
    const rt = live.get(w.id);
    const gen = ++rt.gen;
    rt.el.dataset.state = 'opening';
    rt.body.innerHTML = '<div class="dd-msg">Opening …</div>';
    try {
        let rec = files.get(w.fileId);
        if (!rec) {
            rec = await db.getFile(w.fileId).catch(() => null);
            if (rec) files.set(rec.id, rec);
        }
        if (gen !== rt.gen) return;
        if (!rec) {
            rt.body.innerHTML = '<div class="dd-msg">This browser did not keep the file. Drop it on this window again -- it keeps its place.</div>';
            rt.el.dataset.state = 'missing';
            return;
        }
        await VIEWERS[w.kind].open(w, rt, rec.blob, gen);
        if (gen !== rt.gen) return;
        rt.el.dataset.state = 'ready';
        paint(w);
        findDocsChanged();
    } catch (e) {
        if (gen !== rt.gen) return;
        rt.body.innerHTML = `<div class="dd-msg">This file can't be shown: ${esc(e.message || e)}</div>`;
        rt.el.dataset.state = 'error';
    }
}

// A canvas set to 0 x 0 gives its graphics memory back now, not when the garbage collector gets to it
const releaseCanvases = el => el.querySelectorAll('canvas').forEach(c => { c.width = 0; c.height = 0; });

// ---------------------------------------------------------------- PDF (pdf.js, pages drawn when near the view)

const pdfViewer = {
    async open(w, rt, blob, gen) {
        const pdf = await pdfjsLib.getDocument({
            data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false,
            cMapUrl: PDFJS + 'cmaps/', cMapPacked: true,
            standardFontDataUrl: PDFJS + 'standard_fonts/',
        }).promise;
        if (gen !== rt.gen) { pdf.destroy(); return; }
        rt.pdf = pdf;
        const n = pdf.numPages;
        const size = async i => { const v = (await pdf.getPage(i)).getViewport({scale: 1}); return [v.width, v.height]; };
        const first = await size(1);
        rt.sizes = [null, first];
        const rest = n <= 500 ? await Promise.all(Array.from({length: n - 1}, (_, i) => size(i + 2)))
                              : Array.from({length: n - 1}, () => first);
        rt.sizes.push(...rest);
        if (gen !== rt.gen) return;
        if (!w.zoom) w.zoom = this.fit(w, rt);
        this.build(w, rt);
    },
    ready: rt => !!rt.pages,
    fit(w, rt) {
        const widest = Math.max(...rt.sizes.slice(1).map(s => s[0]));
        return clampZoom((rt.body.clientWidth - 40) / (widest * PT));
    },
    build(w, rt) {
        this.stopAll(rt);
        rt.renderGen = (rt.renderGen || 0) + 1;
        const scale = w.zoom * PT;
        const box = document.createElement('div');
        box.className = 'dd-pages';
        rt.pages = [];
        for (let i = 1; i < rt.sizes.length; i++) {
            const div = document.createElement('div');
            div.className = 'dd-page';
            div.dataset.page = i;
            div.style.width = Math.floor(rt.sizes[i][0] * scale) + 'px';
            div.style.height = Math.floor(rt.sizes[i][1] * scale) + 'px';
            box.appendChild(div);
            rt.pages[i] = {div, shown: false, task: null};
        }
        rt.body.replaceChildren(box);
        rt.observer = new IntersectionObserver(entries => {
            for (const en of entries) {
                const n = +en.target.dataset.page;
                if (en.isIntersecting) this.render(w, rt, n); else this.unrender(rt, n);
            }
        }, {root: rt.body, rootMargin: '600px'});
        rt.pages.forEach(p => rt.observer.observe(p.div));
        const v = w.view;
        if (v && v.page) {
            const p = rt.pages[Math.min(v.page, rt.pages.length - 1)];
            rt.body.scrollTop = p.div.offsetTop + (v.frac || 0) * p.div.offsetHeight;
            rt.body.scrollLeft = (v.left || 0) * rt.body.scrollWidth;
        }
        this.track(w, rt, false);
    },
    rezoom(w, rt) { this.build(w, rt); },
    slowZoom: true,
    fitPage(w, rt) {
        const [pw, ph] = rt.sizes[(w.view && w.view.page) || 1];
        return clampZoom(Math.min((rt.body.clientWidth - 40) / (pw * PT), (rt.body.clientHeight - 24) / (ph * PT)));
    },
    pageAt(rt, y) {
        let lo = 1, hi = rt.pages.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (rt.pages[mid].div.offsetTop <= y) lo = mid; else hi = mid - 1;
        }
        return lo;
    },
    track(w, rt, save = true) {
        const top = rt.body.scrollTop, n = this.pageAt(rt, top + 1), div = rt.pages[n].div;
        w.view = {page: n, frac: Math.max(0, (top - div.offsetTop) / div.offsetHeight),
                  left: rt.body.scrollWidth ? rt.body.scrollLeft / rt.body.scrollWidth : 0};
        rt.info.textContent = `p. ${this.pageAt(rt, top + rt.body.clientHeight / 3)} / ${rt.pages.length - 1}`;
        if (save) saveSoon();
    },
    async render(w, rt, n) {
        const p = rt.pages[n];
        if (!p || p.shown) return;
        p.shown = true;
        const gen = rt.renderGen;
        try {
            const page = await rt.pdf.getPage(n);
            if (gen !== rt.renderGen || !p.shown) return;
            const viewport = page.getViewport({scale: w.zoom * PT});
            const dpr = Math.min(window.devicePixelRatio || 1,
                                 Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)));
            const canvas = document.createElement('canvas');
            canvas.width = Math.floor(viewport.width * dpr);
            canvas.height = Math.floor(viewport.height * dpr);
            canvas.style.width = Math.floor(viewport.width) + 'px';
            canvas.style.height = Math.floor(viewport.height) + 'px';
            const text = document.createElement('div');
            text.className = 'textLayer';
            p.div.style.setProperty('--scale-factor', viewport.scale);
            p.div.replaceChildren(canvas, text);
            p.task = page.render({canvasContext: canvas.getContext('2d'), viewport,
                                  transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
                                  annotationMode: pdfjsLib.AnnotationMode.DISABLE});
            await p.task.promise;
            p.task = null;
            if (gen !== rt.renderGen || !p.shown) return;
            const layer = new pdfjsLib.TextLayer({textContentSource: page.streamTextContent(), container: text, viewport});
            await layer.render();
            if (gen !== rt.renderGen || !p.shown) return;
            p.layer = layer;
            p.div.dataset.drawn = '1';
            markPdfPage(w, rt, n);
        } catch (e) {
            if (!e || e.name !== 'RenderingCancelledException') console.warn('Document Desk: page', n, e);
        }
    },
    unrender(rt, n) {
        const p = rt.pages[n];
        if (!p || !p.shown) return;
        p.shown = false;
        p.layer = null;
        if (p.task) { p.task.cancel(); p.task = null; }
        delete p.div.dataset.drawn;
        releaseCanvases(p.div);
        p.div.replaceChildren();
    },
    stopAll(rt) {
        if (rt.observer) rt.observer.disconnect();
        rt.observer = null;
        (rt.pages || []).forEach(p => { if (p && p.task) p.task.cancel(); if (p) releaseCanvases(p.div); });
    },
    close(rt) {
        this.stopAll(rt);
        if (rt.pdf) rt.pdf.destroy();
        rt.pdf = rt.pages = rt.sizes = rt.textCache = null;
    },
};

// ---------------------------------------------------------------- image

const imageViewer = {
    async open(w, rt, blob) {
        rt.url = URL.createObjectURL(blob);
        const img = new Image();
        img.alt = '';
        img.src = rt.url;
        await img.decode();
        rt.img = img;
        rt.natural = [img.naturalWidth || 800, img.naturalHeight || 600];
        rt.info.textContent = `${rt.natural[0]} × ${rt.natural[1]}`;
        if (!w.zoom) w.zoom = Math.min(1, this.fit(w, rt));
        const box = document.createElement('div');
        box.className = 'dd-imgbox';
        box.appendChild(img);
        rt.body.replaceChildren(box);
        this.rezoom(w, rt);
    },
    ready: rt => !!rt.img,
    fit: (w, rt) => clampZoom((rt.body.clientWidth - 40) / rt.natural[0]),
    fitPage: (w, rt) => clampZoom(Math.min((rt.body.clientWidth - 40) / rt.natural[0], (rt.body.clientHeight - 24) / rt.natural[1])),
    rezoom(w, rt) {
        rt.img.style.width = rt.natural[0] * w.zoom + 'px';
        rt.img.style.height = rt.natural[1] * w.zoom + 'px';
        restoreScroll(w, rt);
    },
    track: (w, rt, save = true) => trackScroll(w, rt, {}, save),
    close(rt) {
        if (rt.url) URL.revokeObjectURL(rt.url);
        rt.url = rt.img = null;
    },
};

// Sheets and images remember the scroll position unzoomed, so it holds across zoom changes.
function trackScroll(w, rt, extra, save) {
    w.view = {...extra, top: rt.body.scrollTop / w.zoom, left: rt.body.scrollLeft / w.zoom};
    if (save) saveSoon();
}
function restoreScroll(w, rt) {
    if (!w.view) return;
    rt.body.scrollTop = (w.view.top || 0) * w.zoom;
    rt.body.scrollLeft = (w.view.left || 0) * w.zoom;
}

// ---------------------------------------------------------------- sheet (.xlsx / .csv)

const sheetViewer = {
    async open(w, rt, blob) {
        const buffer = await blob.arrayBuffer();
        rt.book = w.kind === 'csv' ? readCsv(buffer, w.name) : await readXlsx(buffer);
        if (!rt.book.sheets.length) throw new Error('the workbook has no visible sheet');
        if (!w.zoom) w.zoom = 1;
        rt.undo = [];
        rt.sel = null;
        rt.tabs.hidden = rt.book.sheets.length < 2;
        rt.tabs.innerHTML = rt.book.sheets.map((s, i) => `<button type="button" data-sheet="${i}">${esc(s.name)}</button>`).join('');
        rt.tabs.onclick = e => {
            const b = e.target.closest('[data-sheet]');
            if (!b) return;
            commitEdit(w, rt);
            w.view = {sheet: +b.dataset.sheet, top: 0, left: 0};
            rt.sel = null;
            this.show(w, rt);
            saveSoon();
        };
        rt.body.onpointerdown = e => {
            const td = e.target.closest('td[data-k]');
            if (!td || e.target.closest('.dd-edit')) return;
            commitEdit(w, rt);
            selectCell(w, rt, +td.dataset.k);
        };
        rt.body.ondblclick = e => { if (e.target.closest('td[data-k]') && !rt.editor) startEdit(w, rt); };
        rt.body.onkeydown = e => sheetKey(w, rt, e);
        rt.onCopy = e => {
            const td = rt.sel && cellTd(rt, rt.sel.k);
            e.clipboardData.setData('text/plain', td ? td.innerText : '');
            e.preventDefault();
        };
        rt.onPaste = e => {           // a block copied from Excel: rows by line, cells by tab
            e.preventDefault();
            const text = e.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n').replace(/\n$/, '');
            const {r, c} = rt.sel;
            writeCells(w, rt, text.split('\n').flatMap((line, i) => line.split('\t').map((v, j) => [r + i, c + j, v])));
        };
        this.show(w, rt);
    },
    ready: rt => !!rt.book,
    show(w, rt) {
        const index = Math.min((w.view && w.view.sheet) || 0, rt.book.sheets.length - 1);
        rt.sheet = index;
        rt.tabs.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', i === index));
        drawSheet(w, rt, (w.view && w.view.top) || 0);
        showCellInfo(rt);
        restoreScroll(w, rt);
    },
    fit(w, rt) { return clampZoom((rt.body.clientWidth - 24) / rt.book.sheets[rt.sheet].width); },
    rezoom(w, rt) {
        rt.body.firstElementChild.style.zoom = w.zoom;
        restoreScroll(w, rt);
    },
    track(w, rt, save = true) {
        trackScroll(w, rt, {sheet: rt.sheet}, save);
        if (rt.editor || !rt.range) return;
        const sh = sheetOf(rt), L = sh.layout, top = rt.body.scrollTop / w.zoom, viewH = rt.body.clientHeight / w.zoom;
        if ((rt.range.a > sh.freezeR + 1 && top - ROW_MARGIN / 4 < L.yOf[rt.range.a])
            || (rt.range.b < L.lastR && top + viewH + ROW_MARGIN / 4 > L.yOf[rt.range.b + 1])) {
            const st = rt.body.scrollTop, sl = rt.body.scrollLeft;
            drawSheet(w, rt, top);
            rt.body.scrollTop = st;
            rt.body.scrollLeft = sl;
        }
    },
    close(rt) {
        clearTimeout(rt.storeTimer);
        rt.book = rt.editor = rt.sel = rt.onCopy = rt.onPaste = null;
        rt.tabs.onclick = rt.body.onpointerdown = rt.body.ondblclick = rt.body.onkeydown = null;
    },
};

// ---- editing a sheet: Excel's keys; every change goes into the sheet's XML (or the CSV cells) at once and into the
// browser's storage shortly after; Save (💾 / Ctrl+S) writes the file.

const cellTd = (rt, k) => rt.body.querySelector(`td[data-k="${k}"]`);
const sheetOf = rt => rt.book.sheets[rt.sheet];

// focus false: the search box keeps the keyboard (Enter = next match)
function selectCell(w, rt, k, scroll = false, focus = true) {
    rt.body.querySelectorAll('td.sel').forEach(td => td.classList.remove('sel'));
    showRow(w, rt, Math.floor(k / KEY));
    const td = cellTd(rt, k);
    if (!td) return;
    td.classList.add('sel');
    rt.sel = {k, r: Math.floor(k / KEY), c: k % KEY};
    if (scroll === 'center') bringIntoView(rt, td);
    else if (scroll) td.scrollIntoView({block: 'nearest', inline: 'nearest'});
    showCellInfo(rt);
    if (focus) rt.body.focus({preventScroll: true});
}

function showCellInfo(rt) {
    const sh = sheetOf(rt);
    if (!rt.sel) { rt.info.textContent = sh.note; return; }
    const cell = sh.cells.get(rt.sel.k), text = editText(cell, cell && cellStyle(rt.book, cell.s));
    rt.info.textContent = `${colName(rt.sel.c)}${rt.sel.r}${text ? ': ' + (text.length > 40 ? text.slice(0, 40) + '…' : text) : ''}`;
}

function moveSel(w, rt, dr, dc) {
    if (!rt.sel) return;
    const L = sheetOf(rt).layout;
    let {r, c} = rt.sel;
    for (let i = 0; i < 500; i++) {           // over hidden rows / columns and merged cells
        r += dr; c += dc;
        if (r < 1 || c < 1 || r > L.lastR || c > L.lastC) return;
        if (!L.rowH(r) || !L.colW(c) || L.covered.has(r * KEY + c)) continue;
        selectCell(w, rt, r * KEY + c, true);
        return;
    }
}

// Rows around row r drawn (and scrolled to) when it is not among the drawn ones
function showRow(w, rt, r) {
    const sh = sheetOf(rt);
    if (r <= sh.freezeR || (rt.range && r >= rt.range.a && r <= rt.range.b)) return;
    const top = Math.max(0, sh.layout.yOf[r] - rt.body.clientHeight / w.zoom / 2);
    drawSheet(w, rt, top);
    rt.body.scrollTop = top * w.zoom;
}

function sheetKey(w, rt, e) {
    if (rt.editor || !rt.sel) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && !e.altKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undoEdit(w, rt); return; }
    if (ctrl || e.altKey) return;             // copy / paste / save / zoom: the document's handlers
    const moves = {ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1]};
    if (moves[e.key]) { e.preventDefault(); moveSel(w, rt, ...moves[e.key]); }
    else if (e.key === 'Enter') { e.preventDefault(); moveSel(w, rt, e.shiftKey ? -1 : 1, 0); }
    else if (e.key === 'Tab') { e.preventDefault(); moveSel(w, rt, 0, e.shiftKey ? -1 : 1); }
    else if (e.key === 'F2') { e.preventDefault(); startEdit(w, rt); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); writeCells(w, rt, [[rt.sel.r, rt.sel.c, '']]); }
    else if (e.key.length === 1) { e.preventDefault(); startEdit(w, rt, e.key); }
}

function startEdit(w, rt, typed = null) {
    if (!rt.sel) return;
    const sh = sheetOf(rt), {k} = rt.sel, td = cellTd(rt, k);
    const why = td && lockedReason(sh, k);
    if (!td || why) { if (why) status(why, true); return; }
    const cell = sh.cells.get(k);
    const input = document.createElement('input');
    input.className = 'dd-edit';
    input.value = typed ?? editText(cell, cell && cellStyle(rt.book, cell.s));
    rt.editor = input;
    rt.editK = k;
    rt.editBefore = td.innerHTML;
    td.classList.add('editing');
    td.replaceChildren(input);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    input.onkeydown = e => {
        e.stopPropagation();
        const ctrl = e.ctrlKey || e.metaKey;
        if (e.key === 'Enter') { e.preventDefault(); commitEdit(w, rt); moveSel(w, rt, e.shiftKey ? -1 : 1, 0); }
        else if (e.key === 'Tab') { e.preventDefault(); commitEdit(w, rt); moveSel(w, rt, 0, e.shiftKey ? -1 : 1); }
        else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(rt); }
        else if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); commitEdit(w, rt); saveFile(w); }
    };
    input.onblur = () => { if (rt.editor === input) commitEdit(w, rt); };
}

function cancelEdit(rt) {
    const input = rt.editor;
    if (!input) return null;
    rt.editor = null;
    const td = cellTd(rt, rt.editK);
    if (td) { td.classList.remove('editing'); td.innerHTML = rt.editBefore; }
    rt.body.focus({preventScroll: true});
    return input.value;
}

function commitEdit(w, rt) {
    const k = rt.editK, value = cancelEdit(rt);
    if (value === null) return;
    const cell = sheetOf(rt).cells.get(k);
    if (value !== editText(cell, cell && cellStyle(rt.book, cell.s))) writeCells(w, rt, [[Math.floor(k / KEY), k % KEY, value]]);
}

function lockedReason(sh, k, text = null) {
    const f = sh.cellEls && kid(sh.cellEls.get(k), 'f');
    if (f && (f.getAttribute('t') === 'array' || (f.getAttribute('t') === 'shared' && f.hasAttribute('ref'))))
        return 'This cell holds an array formula or the source of a shared (filled-down) formula -- change it in Excel.';
    if (text !== null && !text.trim() && tableHeader(sh, Math.floor(k / KEY), k % KEY)) return 'A table heading can\'t be empty.';
    return '';
}

const tableHeader = (sh, r, c) => (sh.tables || []).find(t => t.header && r === t.r1 && c >= t.c1 && c <= t.c2);

// Text typed into a cell -> {v, t, f}: a formula (=…), TRUE / FALSE, a number (the browser's separators, %), a date
// in a date-formatted cell, else text. null = empty.
function parseInput(text, st) {
    if (text.trim() === '') return null;
    if (text[0] === '=' && text.length > 1) return {v: null, t: 'n', f: text.slice(1)};
    if (/^(true|false|wahr|falsch)$/i.test(text.trim())) return {v: /^(true|wahr)$/i.test(text.trim()), t: 'b'};
    const n = parseNumber(text);
    if (n !== null) return {v: n, t: 'n'};
    if (st && isDateCode(st.fmt)) { const d = parseDate(text); if (d !== null) return {v: d, t: 'n'}; }
    return {v: text, t: 'inlineStr'};
}

function parseNumber(text) {
    let s = text.trim().replace(/\s/g, ''), scale = 1;
    if (s.endsWith('%')) { scale = 0.01; s = s.slice(0, -1); }
    const group = DECIMAL === ',' ? '.' : ',', g = `\\${group}`, d = `\\${DECIMAL}`;
    if (new RegExp(`^[-+]?(\\d{1,3}(${g}\\d{3})+|\\d+)(${d}\\d*)?([eE][-+]?\\d+)?$`).test(s)) s = s.split(group).join('').replace(DECIMAL, '.');
    else if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n * scale : null;
}

function parseDate(text) {
    let m = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/.exec(text.trim()), y, mo, d;
    if (m) [d, mo, y] = [+m[1], +m[2], +m[3]];
    else if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text.trim()))) [y, mo, d] = [+m[1], +m[2], +m[3]];
    else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text.trim()))) [mo, d, y] = [+m[1], +m[2], +m[3]];
    else return null;
    if (y < 100) y += 2000;
    const ms = Date.UTC(y, mo - 1, d);
    return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? ms / 86400000 + 25569 : null;
}

// What the cell editor shows: the formula, else the value as it would be typed
function editText(cell, st) {
    if (!cell) return '';
    if (cell.f) return '=' + cell.f;
    if (cell.v === null || cell.v === undefined) return '';
    if (cell.t === 'b') return cell.v ? 'TRUE' : 'FALSE';
    if (typeof cell.v === 'number' && st) {
        if (isDateCode(st.fmt) && cell.v >= 1) return formatDate(Math.floor(cell.v), DECIMAL === ',' ? 'dd.mm.yyyy' : 'yyyy-mm-dd');
        if (/%/.test(st.fmt.replace(/"[^"]*"/g, ''))) return general(cell.v * 100) + '%';
        return general(cell.v);
    }
    return String(cell.v);
}

// [[row, column, typed text], ...] into the open sheet, as one step to undo
function writeCells(w, rt, list) {
    const book = rt.book, sh = sheetOf(rt), undo = [];
    for (const [r, c, text] of list) {
        const k = r * KEY + c, why = lockedReason(sh, k, text);
        if (why) { status(why, true); continue; }
        const old = sh.cells.get(k);
        undo.push({sheet: rt.sheet, r, c, cell: old ? {...old} : null});
        const val = book.csv ? (text === '' ? null : {v: text, t: 'str'}) : parseInput(text, old && cellStyle(book, old.s));
        setCell(book, sh, r, c, val);
    }
    if (!undo.length) return;
    rt.undo.push(undo);
    afterEdit(w, rt, undo.map(u => u.r));
}

function undoEdit(w, rt) {
    const group = rt.undo.pop();
    if (!group) return;
    if (group[0].sheet !== rt.sheet) { w.view = {sheet: group[0].sheet, top: 0, left: 0}; rt.sel = null; sheetViewer.show(w, rt); }
    const sh = sheetOf(rt);
    for (const u of [...group].reverse()) {
        const c = u.cell;
        setCell(rt.book, sh, u.r, u.c, c && (c.v !== null || c.f) ? {v: c.v, t: c.t, f: c.f} : null);
    }
    afterEdit(w, rt, group.map(u => u.r));
    selectCell(w, rt, group[0].r * KEY + group[0].c, true);
}

function setCell(book, sh, r, c, val) {
    const k = r * KEY + c, old = sh.cells.get(k), header = tableHeader(sh, r, c);
    if (header && val) {                      // a table's heading is text and names its column
        val = {v: val.f ? '=' + val.f : String(val.v), t: 'inlineStr'};
        header.cols[c - header.c1]?.setAttribute('name', val.v);
        header.edited = true;
    }
    if (sh.doc) writeCellXml(sh, r, c, val);
    const s = old ? old.s : +(sh.cellEls?.get(k)?.getAttribute('s') || 0);
    if (val) {
        sh.cells.set(k, {v: val.v ?? null, t: val.t, s, f: val.f || null, num: book.csv ? NUMERIC.test(val.v) : false});
        sh.maxR = Math.max(sh.maxR, r);
        sh.maxC = Math.max(sh.maxC, c);
    } else if (old && old.s) sh.cells.set(k, {v: null, t: 'n', s: old.s, f: null});
    else sh.cells.delete(k);
    sh.edited = true;
    sh.stale = true;                        // extents may have grown: laid out again at the next drawing
}

function newEl(doc, name) {
    const root = doc.documentElement;
    return doc.createElementNS(root.namespaceURI, root.prefix ? `${root.prefix}:${name}` : name);
}

function writeCellXml(sh, r, c, val) {
    const doc = sh.doc, k = r * KEY + c;
    let el = sh.cellEls.get(k);
    if (!el) {
        if (!val) return;
        let row = sh.rowEls.get(r);
        if (!row) {
            row = newEl(doc, 'row');
            row.setAttribute('r', r);
            const next = [...sh.rowEls].filter(([rr]) => rr > r).sort((a, b) => a[0] - b[0])[0];
            all(doc, 'sheetData')[0].insertBefore(row, next ? next[1] : null);
            sh.rowEls.set(r, row);
        }
        el = newEl(doc, 'c');
        el.setAttribute('r', colName(c) + r);
        el.ddCol = c;
        row.insertBefore(el, kids(row, 'c').find(x => x.ddCol > c) || null);
        sh.cellEls.set(k, el);
    }
    while (el.firstChild) el.firstChild.remove();
    el.removeAttribute('t');
    if (!val) {
        if (!el.hasAttribute('s')) { el.remove(); sh.cellEls.delete(k); }
        return;
    }
    const add = (name, text) => { const x = newEl(doc, name); x.textContent = text; el.appendChild(x); return x; };
    if (val.f) {
        add('f', val.f);
        if (val.v === null || val.v === undefined) return;      // Excel calculates it when it opens the file
    }
    if (val.t === 'b') { el.setAttribute('t', 'b'); add('v', val.v ? '1' : '0'); }
    else if (val.t === 'e' || val.t === 'd') { el.setAttribute('t', val.t); add('v', String(val.v)); }
    else if (typeof val.v === 'number') add('v', String(val.v));
    else if (val.f) { el.setAttribute('t', 'str'); add('v', String(val.v)); }
    else {
        el.setAttribute('t', 'inlineStr');
        const is = newEl(doc, 'is');
        el.appendChild(is);
        const tx = newEl(doc, 't');
        tx.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
        tx.textContent = String(val.v);
        is.appendChild(tx);
    }
}

function afterEdit(w, rt, rows) {
    const sh = sheetOf(rt);
    for (const r of new Set(rows)) {
        const tr = rt.body.querySelector(`tr[data-r="${r}"]`);
        if (tr) tr.outerHTML = rowHtml(sh, rt.book, r, r <= sh.freezeR ? sh.freezeR : rt.range.b);
    }
    if (rt.sel) cellTd(rt, rt.sel.k)?.classList.add('sel');
    showCellInfo(rt);
    w.dirty = true;
    paint(w);
    saveSoon();
    findDocsChanged();
    clearTimeout(rt.storeTimer);
    rt.storeTimer = setTimeout(() => keepEdits(w, rt), 800);
}

// The changed workbook replaces the desk's copy, so a reload shows the changes (still marked as not saved)
async function keepEdits(w, rt) {
    const rec = files.get(w.fileId);
    if (!rt.book || !rec) return null;
    try {
        rec.blob = await exportBook(rt.book, w.name);
        await putRecord(rec);
        return rec;
    } catch (e) {
        status('Changes not kept: ' + e.message, true);
        return null;
    }
}

async function saveFile(w) {
    const rt = live.get(w.id);
    if (!EDITABLE[w.kind] || !rt || !rt.book) return;
    commitEdit(w, rt);
    clearTimeout(rt.storeTimer);
    const rec = await keepEdits(w, rt);
    if (!rec) return;
    let handle = rec.handle;
    if (!handle && window.showSaveFilePicker) {
        try { handle = await window.showSaveFilePicker({suggestedName: w.name}); }
        catch (e) { if (e.name !== 'AbortError') status('Not saved: ' + e.message, true); return; }
        rec.handle = handle;
        w.name = handle.name;
    }
    try {
        if (handle) {
            const opts = {mode: 'readwrite'};
            if ((await handle.queryPermission(opts)) !== 'granted' && (await handle.requestPermission(opts)) !== 'granted')
                throw new Error('the browser was not allowed to write the file');
            const out = await handle.createWritable();
            await out.write(rec.blob);
            await out.close();
        } else {                              // no file access in this browser: a download instead
            const a = document.createElement('a');
            a.href = URL.createObjectURL(rec.blob);
            a.download = w.name;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        }
    } catch (e) {
        const busy = /NoModificationAllowed|InvalidState|InvalidModification|NotReadable/.test(e.name || '');
        status(`Not saved into the file: ${busy ? 'it is open in Excel or read-only -- close it there and save again' : e.message}. `
            + 'The changes stay on the desk.', true);
        return;
    }
    await putRecord(rec);
    w.dirty = false;
    paint(w);
    saveSoon();
    status(handle ? `Saved into ${handle.name}.` : `Downloaded ${w.name}.`);
}

const VIEWERS = {pdf: pdfViewer, image: imageViewer, sheet: sheetViewer, csv: sheetViewer};

// ---- reading .xlsx: a zip of XML parts (ECMA-376). Values, shared strings, number formats, fonts, fills, borders,
// alignment, column widths / row heights, hidden rows / columns / sheets, merged cells, frozen panes. Formulas show
// the value Excel saved with them; charts, pictures and conditional formats are not drawn.

async function unzip(buffer) {
    const dv = new DataView(buffer), bytes = new Uint8Array(buffer), utf8 = new TextDecoder();
    let end = -1;
    for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
        if (dv.getUint32(i, true) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) throw new Error('not an .xlsx file (no zip directory)');
    const entries = new Map();
    let p = dv.getUint32(end + 16, true);
    for (let k = dv.getUint16(end + 10, true); k > 0; k--) {
        if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('damaged .xlsx file (zip directory)');
        const nameLen = dv.getUint16(p + 28, true), name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen));
        entries.set(name.toLowerCase(), {name, method: dv.getUint16(p + 10, true), time: dv.getUint16(p + 12, true),
            date: dv.getUint16(p + 14, true), crc: dv.getUint32(p + 16, true), size: dv.getUint32(p + 20, true),
            usize: dv.getUint32(p + 24, true), offset: dv.getUint32(p + 42, true)});
        p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
    }
    const raw = e => {
        const start = e.offset + 30 + dv.getUint16(e.offset + 26, true) + dv.getUint16(e.offset + 28, true);
        return bytes.subarray(start, start + e.size);
    };
    const read = async path => {
        const e = entries.get(path.toLowerCase());
        if (!e) return null;
        if (e.method === 0) return utf8.decode(raw(e));
        if (e.method !== 8) throw new Error('unsupported compression in the .xlsx file');
        const stream = new Blob([raw(e)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return utf8.decode(await new Response(stream).arrayBuffer());
    };
    return Object.assign(read, {entries, raw});
}

const CRC_TABLE = Array.from({length: 256}, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
function crc32(data) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

// The zip written again: `changed` parts (lower-case path -> bytes, null = left out) stored as they are, every other
// part copied byte for byte (still compressed), in the same order.
function rezip(read, changed, type) {
    const enc = new TextEncoder(), parts = [], dir = [];
    let offset = 0;
    for (const [key, e] of read.entries) {
        if (changed.get(key) === null) continue;
        const name = enc.encode(e.name), mine = changed.get(key);
        const data = mine || read.raw(e);
        const f = {method: mine ? 0 : e.method, crc: mine ? crc32(mine) : e.crc, size: data.length,
                   usize: mine ? mine.length : e.usize, time: e.time, date: e.date, offset};
        const h = new DataView(new ArrayBuffer(30));
        h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
        h.setUint16(8, f.method, true); h.setUint16(10, f.time, true); h.setUint16(12, f.date, true);
        h.setUint32(14, f.crc, true); h.setUint32(18, f.size, true); h.setUint32(22, f.usize, true);
        h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
        parts.push(new Uint8Array(h.buffer), name, data);
        dir.push([name, f]);
        offset += 30 + name.length + data.length;
    }
    let dirSize = 0;
    for (const [name, f] of dir) {
        const h = new DataView(new ArrayBuffer(46));
        h.setUint32(0, 0x02014b50, true); h.setUint16(4, 20, true); h.setUint16(6, 20, true); h.setUint16(8, 0x0800, true);
        h.setUint16(10, f.method, true); h.setUint16(12, f.time, true); h.setUint16(14, f.date, true);
        h.setUint32(16, f.crc, true); h.setUint32(20, f.size, true); h.setUint32(24, f.usize, true);
        h.setUint16(28, name.length, true); h.setUint32(42, f.offset, true);
        parts.push(new Uint8Array(h.buffer), name);
        dirSize += 46 + name.length;
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, dir.length, true); end.setUint16(10, dir.length, true);
    end.setUint32(12, dirSize, true); end.setUint32(16, offset, true);
    parts.push(new Uint8Array(end.buffer));
    return new Blob(parts, {type});
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const XLSX_TYPE = {xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12', xltm: 'application/vnd.ms-excel.template.macroEnabled.12',
                   xltx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.template'};
const relsPathOf = path => { const i = path.lastIndexOf('/') + 1; return `${path.slice(0, i)}_rels/${path.slice(i)}.rels`; };

// The edited workbook: changed sheets (and table parts) written from their XML, the rest of the file untouched.
// Formulas are recalculated by Excel when it opens the file (fullCalcOnLoad); the calculation chain is left out,
// Excel builds it again.
async function exportBook(book, name) {
    if (book.csv) return exportCsv(book);
    const enc = new TextEncoder(), ser = new XMLSerializer(), changed = new Map();
    const put = (path, doc) => changed.set(path.toLowerCase(), enc.encode(XML_HEAD + ser.serializeToString(doc.documentElement)));
    for (const sh of book.sheets) {
        if (!sh.edited) continue;
        put(sh.path, sh.doc);
        for (const tb of sh.tables) if (tb.edited) put(tb.path, tb.doc);
    }
    if (changed.size) {
        const wb = book.wbDoc;
        let calc = all(wb, 'calcPr')[0];
        if (!calc) {
            calc = newEl(wb, 'calcPr');
            const later = ['oleSize', 'customWorkbookViews', 'pivotCaches', 'smartTagPr', 'smartTagTypes', 'webPublishing',
                           'fileRecoveryPr', 'webPublishObjects', 'extLst'];
            wb.documentElement.insertBefore(calc, Array.from(wb.documentElement.children).find(c => later.includes(c.localName)) || null);
        }
        calc.setAttribute('fullCalcOnLoad', '1');
        put(book.wbPath, wb);
        const chain = book.rels.find(r => r.type.endsWith('/calcChain'));
        if (chain) {
            changed.set(chain.target.toLowerCase(), null);
            const rels = await book.parse(relsPathOf(book.wbPath));
            all(rels, 'Relationship').filter(r => r.getAttribute('Id') === chain.id).forEach(r => r.remove());
            put(relsPathOf(book.wbPath), rels);
            const types = await book.parse('[Content_Types].xml');
            if (types) {
                all(types, 'Override').filter(o => (o.getAttribute('PartName') || '').toLowerCase() === '/' + chain.target.toLowerCase())
                    .forEach(o => o.remove());
                put('[Content_Types].xml', types);
            }
        }
    }
    const ext = (/\.([^.]+)$/.exec(name || '') || [, ''])[1].toLowerCase();
    return rezip(book.read, changed, XLSX_TYPE[ext] || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

function exportCsv(book) {
    const sh = book.sheets[0], d = book.csv.delim, lines = [];
    for (let r = 1; r <= sh.maxR; r++) {
        const row = [];
        for (let c = 1; c <= sh.maxC; c++) {
            const cell = sh.cells.get(r * KEY + c), v = cell && cell.v != null ? String(cell.v) : '';
            row.push(/["\r\n]/.test(v) || v.includes(d) ? `"${v.replace(/"/g, '""')}"` : v);
        }
        lines.push(row.join(d));
    }
    return new Blob([(book.csv.bom ? '\uFEFF' : '') + lines.join('\r\n') + '\r\n'], {type: 'text/csv'});
}

const all = (node, name) => Array.from(node.getElementsByTagNameNS('*', name));
const kids = (node, name) => Array.from(node.children).filter(c => c.localName === name);
const kid = (node, name) => node && kids(node, name)[0];

function resolvePath(dir, target) {
    if (target.startsWith('/')) return target.slice(1);
    const out = [];
    for (const part of (dir + target).split('/')) {
        if (part === '..') out.pop(); else if (part && part !== '.') out.push(part);
    }
    return out.join('/');
}

const INDEXED = ('000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF 000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF '
    + '00FFFF 800000 008000 000080 808000 800080 008080 C0C0C0 808080 9999FF 993366 FFFFCC CCFFFF 660066 FF8080 0066CC '
    + 'CCCCFF 000080 FF00FF FFFF00 00FFFF 800080 800000 008080 0000FF 00CCFF CCFFFF CCFFCC FFFF99 99CCFF FF99CC CC99FF '
    + 'FFCC99 3366FF 33CCCC 99CC00 FFCC00 FF9900 FF6600 666699 969696 003366 339966 003300 333300 993300 993366 333399 '
    + '333333').split(' ');
// theme colour index -> clrScheme entry (Excel swaps the first two pairs)
const THEME_ORDER = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
const DEFAULT_THEME = ['FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47', '0563C1', '954F72'];

function readTheme(doc) {
    const scheme = doc && all(doc, 'clrScheme')[0];
    if (!scheme) return DEFAULT_THEME;
    return THEME_ORDER.map((name, i) => {
        const c = kid(scheme, name)?.firstElementChild;
        return (c && (c.getAttribute('lastClr') || c.getAttribute('val'))) || DEFAULT_THEME[i];
    });
}

function tint(hex, t) {
    let [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
        h /= 6;
    }
    l = t < 0 ? l * (1 + t) : l * (1 - t) + t;
    const f = n => {
        const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
        return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0');
    };
    return f(0) + f(8) + f(4);
}

function colorOf(el, theme) {
    if (!el || el.getAttribute('auto') === '1') return null;
    let hex = null;
    if (el.hasAttribute('rgb')) hex = el.getAttribute('rgb').slice(-6);
    else if (el.hasAttribute('theme')) hex = theme[+el.getAttribute('theme')];
    else if (el.hasAttribute('indexed')) hex = INDEXED[+el.getAttribute('indexed')];
    if (!hex) return null;
    const t = parseFloat(el.getAttribute('tint') || '0');
    return '#' + (t ? tint(hex, t) : hex);
}

const BORDER_CSS = {thin: '1px double', hair: '1px dotted', dotted: '1px dotted', dashed: '1px dashed',
    dashDot: '1px dashed', dashDotDot: '1px dashed', medium: '2px solid', mediumDashed: '2px dashed',
    mediumDashDot: '2px dashed', mediumDashDotDot: '2px dashed', slantDashDot: '2px dashed', thick: '3px solid',
    double: '3px double'};

function readStyles(doc, theme) {
    const st = {fmts: {}, fonts: [], fills: [], borders: [], xfs: []};
    if (!doc) return st;
    for (const f of all(doc, 'numFmt')) st.fmts[f.getAttribute('numFmtId')] = f.getAttribute('formatCode');
    const on = (f, n) => { const e = kid(f, n); return !!e && !/^(0|false|none)$/.test(e.getAttribute('val') || ''); };
    for (const f of kids(all(doc, 'fonts')[0] || doc, 'font')) {
        st.fonts.push({b: on(f, 'b'), i: on(f, 'i'), u: on(f, 'u'), strike: on(f, 'strike'),
                       size: parseFloat(kid(f, 'sz')?.getAttribute('val') || '0'),
                       name: kid(f, 'name')?.getAttribute('val') || '', color: colorOf(kid(f, 'color'), theme)});
    }
    for (const f of kids(all(doc, 'fills')[0] || doc, 'fill')) {
        const p = kid(f, 'patternFill');
        st.fills.push(p && p.getAttribute('patternType') === 'solid' ? colorOf(kid(p, 'fgColor'), theme) : null);
    }
    for (const b of kids(all(doc, 'borders')[0] || doc, 'border')) {
        const side = name => {
            const e = kid(b, name), style = e && e.getAttribute('style');
            return style && style !== 'none' ? `${BORDER_CSS[style] || '1px solid'} ${colorOf(kid(e, 'color'), theme) || '#000'}` : null;
        };
        st.borders.push({left: side('left') || side('start'), right: side('right') || side('end'), top: side('top'), bottom: side('bottom')});
    }
    for (const x of kids(all(doc, 'cellXfs')[0] || doc, 'xf')) {
        const a = kid(x, 'alignment');
        st.xfs.push({fmt: x.getAttribute('numFmtId') || '0', font: +(x.getAttribute('fontId') || 0),
                     fill: +(x.getAttribute('fillId') || 0), border: +(x.getAttribute('borderId') || 0),
                     h: a?.getAttribute('horizontal') || '', v: a?.getAttribute('vertical') || '',
                     wrap: /^(1|true)$/.test(a?.getAttribute('wrapText') || ''), indent: +(a?.getAttribute('indent') || 0)});
    }
    return st;
}

const parseRef = ref => {
    const m = /^\$?([A-Z]+)\$?(\d+)$/i.exec(ref || '');
    if (!m) return null;
    let c = 0;
    for (const ch of m[1].toUpperCase()) c = c * 26 + ch.charCodeAt(0) - 64;
    return [+m[2], c];
};
function colName(c) {
    let s = '';
    for (; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + (c - 1) % 26) + s;
    return s;
}
const KEY = 20000;                     // cell key = row * KEY + column (Excel has 16384 columns)

async function readXlsx(buffer) {
    const read = await unzip(buffer);
    const parse = async path => {
        const text = await read(path);
        return text == null ? null : new DOMParser().parseFromString(text, 'application/xml');
    };
    const relsOf = async path => {
        const doc = await parse(relsPathOf(path));
        const dir = path.slice(0, path.lastIndexOf('/') + 1);
        return doc ? all(doc, 'Relationship').map(r => ({id: r.getAttribute('Id'), type: r.getAttribute('Type') || '',
                                                         target: resolvePath(dir, r.getAttribute('Target') || '')})) : [];
    };
    const root = await relsOf('');
    const wbPath = root.find(r => /\/officeDocument$/.test(r.type))?.target || 'xl/workbook.xml';
    const wb = await parse(wbPath);
    if (!wb || !all(wb, 'sheets').length) throw new Error('not an Excel workbook');
    const rels = await relsOf(wbPath);
    const part = (type, fallback) => rels.find(r => r.type.endsWith('/' + type))?.target || fallback;
    const theme = readTheme(await parse(part('theme', 'xl/theme/theme1.xml')));
    const book = {...readStyles(await parse(part('styles', 'xl/styles.xml')), theme), sheets: [], css: [],
                  read, parse, wbPath, wbDoc: wb, rels};
    const pr = all(wb, 'workbookPr')[0];
    book.date1904 = /^(1|true)$/.test(pr?.getAttribute('date1904') || '');
    const ss = await parse(part('sharedStrings', 'xl/sharedStrings.xml'));
    const strings = ss ? all(ss, 'si').map(si => all(si, 't').filter(t => t.parentNode.localName !== 'rPh')
                                                      .map(t => t.textContent).join('')) : [];
    for (const s of all(wb, 'sheet')) {
        if (/hidden/i.test(s.getAttribute('state') || '')) continue;
        const rid = Array.from(s.attributes).find(a => a.localName === 'id' && a.prefix)?.value;
        const rel = rels.find(r => r.id === rid);
        if (!rel || !/\/worksheet$/.test(rel.type)) continue;          // chart sheets, dialog sheets: not shown
        const doc = await parse(rel.target);
        if (!doc) continue;
        const sh = readSheet(doc, s.getAttribute('name') || 'Sheet', strings, book);
        sh.path = rel.target;
        for (const tr of (await relsOf(rel.target)).filter(r => r.type.endsWith('/table'))) {
            const tdoc = await parse(tr.target), el = tdoc && tdoc.documentElement;
            const [a, b] = (el?.getAttribute('ref') || '').split(':').map(parseRef);
            if (!a || !b) continue;
            sh.tables.push({path: tr.target, doc: tdoc, r1: a[0], c1: a[1], r2: b[0], c2: b[1],
                            header: el.getAttribute('headerRowCount') !== '0', cols: all(tdoc, 'tableColumn')});
        }
        book.sheets.push(sh);
    }
    return book;
}

function blankSheet(name) {
    return {name, cells: new Map(), rows: {}, colW: {}, merges: [], maxR: 0, maxC: 0, freezeR: 0, freezeC: 0,
            grid: true, defColW: 64, defRowH: 20, note: '', width: 0, tables: [], rowEls: new Map(), cellEls: new Map()};
}

function readSheet(doc, name, strings, book) {
    const sh = blankSheet(name);
    sh.doc = doc;
    const fp = all(doc, 'sheetFormatPr')[0];
    if (fp) {
        if (fp.getAttribute('defaultColWidth')) sh.defColW = Math.round(+fp.getAttribute('defaultColWidth') * 7);
        else if (fp.getAttribute('baseColWidth')) sh.defColW = Math.ceil((+fp.getAttribute('baseColWidth') * 7 + 5) / 8) * 8;
        if (fp.getAttribute('defaultRowHeight')) sh.defRowH = Math.round(+fp.getAttribute('defaultRowHeight') * PT);
    }
    const view = all(doc, 'sheetView')[0];
    if (view) {
        sh.grid = !/^(0|false)$/.test(view.getAttribute('showGridLines') || '');
        const pane = kid(view, 'pane');
        if (pane && /frozen/i.test(pane.getAttribute('state') || '')) {
            sh.freezeC = Math.floor(+(pane.getAttribute('xSplit') || 0));
            sh.freezeR = Math.floor(+(pane.getAttribute('ySplit') || 0));
        }
    }
    for (const col of all(doc, 'col')) {
        const min = +col.getAttribute('min'), max = Math.min(+col.getAttribute('max'), 1000);
        const px = /^(1|true)$/.test(col.getAttribute('hidden') || '') ? 0
            : col.getAttribute('width') != null ? Math.round(+col.getAttribute('width') * 7) : null;
        if (px != null) for (let c = min; c <= max; c++) sh.colW[c] = px;
    }
    const visible = s => {                      // an empty cell still counts when it has a fill or a border
        const xf = book.xfs[s];
        if (!xf) return false;
        const b = book.borders[xf.border];
        return !!book.fills[xf.fill] || !!(b && (b.left || b.right || b.top || b.bottom));
    };
    let r = 0;
    for (const row of all(doc, 'row')) {
        r = row.getAttribute('r') ? +row.getAttribute('r') : r + 1;
        sh.rowEls.set(r, row);
        const hidden = /^(1|true)$/.test(row.getAttribute('hidden') || '');
        if (hidden || row.getAttribute('ht')) sh.rows[r] = {hidden, h: Math.round(+(row.getAttribute('ht') || 15) * PT)};
        let c = 0;
        for (const cell of kids(row, 'c')) {
            const ref = parseRef(cell.getAttribute('r'));
            c = ref ? ref[1] : c + 1;
            cell.ddCol = c;
            sh.cellEls.set(r * KEY + c, cell);
            const t = cell.getAttribute('t') || 'n', s = +(cell.getAttribute('s') || 0);
            const raw = kid(cell, 'v')?.textContent, f = kid(cell, 'f')?.textContent || null;
            let v = null;
            if (t === 's') v = raw != null ? strings[+raw] ?? '' : null;
            else if (t === 'inlineStr') v = all(cell, 't').map(x => x.textContent).join('');
            else if (t === 'b') v = raw === '1' || raw === 'true';
            else if (t === 'n') v = raw != null && raw !== '' ? +raw : null;
            else v = raw ?? null;               // str, e, d
            const empty = v === null || v === '';
            if (empty && !f && !visible(s)) continue;
            sh.cells.set(r * KEY + c, {v: empty ? null : v, t, s, f});
            sh.maxR = Math.max(sh.maxR, r);
            sh.maxC = Math.max(sh.maxC, c);
        }
    }
    for (const m of all(doc, 'mergeCell')) {
        const [a, b] = (m.getAttribute('ref') || '').split(':').map(parseRef);
        if (!a || !b) continue;
        sh.merges.push({r1: Math.min(a[0], b[0]), c1: Math.min(a[1], b[1]), r2: Math.max(a[0], b[0]), c2: Math.max(a[1], b[1])});
    }
    return sh;
}

const NUMERIC = /^[-+]?[\d.,\s]*\d[\d.,]*\s*%?$/;

function readCsv(buffer, name) {
    let text, utf8 = true;
    try { text = new TextDecoder('utf-8', {fatal: true}).decode(buffer); }
    catch { text = new TextDecoder('windows-1252').decode(buffer); utf8 = false; }
    const bom = text.startsWith('\uFEFF');
    text = text.replace(/^\uFEFF/, '');
    const head = text.slice(0, Math.max(0, text.indexOf('\n')) || text.length);
    const delim = /\.tsv$/i.test(name) ? '\t'
        : [';', ',', '\t'].map(d => [d, head.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const sh = blankSheet(name.replace(/\.[^.]+$/, ''));
    let r = 1, c = 1, field = '', quoted = false, i = 0;
    const put = () => {
        if (field !== '') {
            sh.cells.set(r * KEY + c, {v: field, t: 'str', s: 0, num: NUMERIC.test(field)});
            sh.maxR = Math.max(sh.maxR, r);
            sh.maxC = Math.max(sh.maxC, c);
        }
        field = '';
    };
    for (; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
            else if (ch === '"') quoted = false;
            else field += ch;
        } else if (ch === '"' && field === '') quoted = true;
        else if (ch === delim) { put(); c++; }
        else if (ch === '\n' || ch === '\r') {
            put();
            if (ch === '\r' && text[i + 1] === '\n') i++;
            r++; c = 1;
        } else field += ch;
    }
    put();
    // written back as UTF-8; with a BOM when the file had one or was not UTF-8, so Excel reads the characters right
    return {fmts: {}, fonts: [], fills: [], borders: [], xfs: [], css: [], date1904: false, sheets: [sh],
            csv: {delim, bom: bom || !utf8}};
}

// ---- number formats

const BUILTIN_FMT = {0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00',
    12: '# ?/?', 13: '# ??/??', 14: 'DATE', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM',
    19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'DATETIME', 37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)',
    39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)', 45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mm:ss.0',
    48: '##0.0E+0', 49: '@'};

function serialToDate(v, date1904) {
    const days = date1904 ? v + 1462 : v < 60 ? v + 1 : v;          // Excel's 1900 calendar has a 29 Feb 1900
    return new Date(Math.round((days - 25569) * 86400000));
}

const DECIMAL = new Intl.NumberFormat().formatToParts(1.5).find(p => p.type === 'decimal')?.value || '.';

function general(v) {
    const a = Math.abs(v);
    if (a !== 0 && (a >= 1e11 || a < 1e-9)) return v.toExponential(5).replace(/\.?0+e/, 'e').replace('e', 'E').replace('.', DECIMAL);
    return new Intl.NumberFormat(undefined, {maximumSignificantDigits: 11, useGrouping: false}).format(v);
}

function splitSections(code) {
    const out = [''];
    for (let i = 0; i < code.length; i++) {
        const ch = code[i];
        if (ch === '"') { const j = code.indexOf('"', i + 1); const end = j < 0 ? code.length : j; out[out.length - 1] += code.slice(i, end + 1); i = end; }
        else if (ch === '\\') { out[out.length - 1] += code.slice(i, i + 2); i++; }
        else if (ch === ';') out.push('');
        else out[out.length - 1] += ch;
    }
    return out;
}

const isDateCode = sec => /[ymdhs]/i.test(sec.replace(/"[^"]*"|\\.|_.|\*./g, ''));

const DATE_TOKEN = /"[^"]*"|\\.|_.|\*.|\[h+\]|\[m+\]|\[s+\]|yyyy|yy|mmmmm|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|am\/pm|a\/p|\.0+|./gi;

function formatDate(serial, code, date1904) {
    const tokens = code.match(DATE_TOKEN) || [];
    const low = tokens.map(t => t.toLowerCase());
    const ampm = low.some(t => t === 'am/pm' || t === 'a/p');
    const isMinute = i => {                     // m / mm right after an hour or right before a second = minutes
        for (let j = i - 1; j >= 0; j--) { if (/^(h+|\[h+\])$/.test(low[j])) return true; if (/^[ymdhs]|^\[/.test(low[j])) break; }
        for (let j = i + 1; j < low.length; j++) { if (/^(s+|\[s+\])$/.test(low[j])) return true; if (/^[ymdhs]|^\[/.test(low[j])) break; }
        return false;
    };
    const d = serialToDate(serial, date1904);
    const pad = n => String(n).padStart(2, '0');
    const name = opts => new Intl.DateTimeFormat(undefined, {...opts, timeZone: 'UTC'}).format(d);
    const hours = d.getUTCHours();
    return tokens.map((t, i) => {
        const l = low[i];
        if ((l === 'm' || l === 'mm') && isMinute(i)) return l === 'mm' ? pad(d.getUTCMinutes()) : String(d.getUTCMinutes());
        switch (l) {
            case 'yyyy': return String(d.getUTCFullYear());
            case 'yy': return pad(d.getUTCFullYear() % 100);
            case 'mmmmm': return name({month: 'long'}).charAt(0);
            case 'mmmm': return name({month: 'long'});
            case 'mmm': return name({month: 'short'});
            case 'mm': return pad(d.getUTCMonth() + 1);
            case 'm': return String(d.getUTCMonth() + 1);
            case 'dddd': return name({weekday: 'long'});
            case 'ddd': return name({weekday: 'short'});
            case 'dd': return pad(d.getUTCDate());
            case 'd': return String(d.getUTCDate());
            case 'hh': return pad(ampm ? hours % 12 || 12 : hours);
            case 'h': return String(ampm ? hours % 12 || 12 : hours);
            case 'ss': return pad(d.getUTCSeconds());
            case 's': return String(d.getUTCSeconds());
            case 'am/pm': return hours < 12 ? 'AM' : 'PM';
            case 'a/p': return hours < 12 ? 'A' : 'P';
        }
        if (/^\[h+\]$/.test(l)) return String(Math.floor(serial * 24));
        if (/^\[m+\]$/.test(l)) return String(Math.floor(serial * 1440));
        if (/^\[s+\]$/.test(l)) return String(Math.floor(serial * 86400));
        if (/^\.0+$/.test(l)) {
            const n = l.length - 1;
            return '.' + String(Math.floor((serial * 86400 % 1) * 10 ** n)).padStart(n, '0');
        }
        if (t[0] === '"') return t.slice(1, -1);
        if (t[0] === '\\') return t.slice(1);
        if (t[0] === '_') return ' ';
        if (t[0] === '*' || t === '@') return '';
        return t;
    }).join('');
}

function formatNumeric(val, sec) {
    let pre = '', post = '', pat = '', percent = 0;
    for (let i = 0; i < sec.length;) {
        const ch = sec[i];
        let lit;
        if (ch === '"') { const j = sec.indexOf('"', i + 1); lit = sec.slice(i + 1, j < 0 ? undefined : j); i = j < 0 ? sec.length : j + 1; }
        else if (ch === '\\') { lit = sec[i + 1] || ''; i += 2; }
        else if (ch === '_') { lit = ' '; i += 2; }
        else if (ch === '*') { lit = ''; i += 2; }
        else if (/[0#?]/.test(ch) || (/[.,]/.test(ch) && (pat || /[0#?]/.test(sec[i + 1] || '')))) { pat += ch; i++; continue; }
        else if (pat && /e/i.test(ch) && /[+-]/.test(sec[i + 1] || '')) { pat += 'E' + sec[i + 1]; i += 2; continue; }
        else if (ch === '%') { percent++; lit = '%'; i++; }
        else if (ch === '@') { lit = ''; i++; }
        else { lit = ch; i++; }
        if (pat) post += lit; else pre += lit;
    }
    if (!pat) return pre + post;
    let x = val * 100 ** percent;
    const sci = /E[+-]/.exec(pat);
    if (sci) {
        const decimals = (pat.slice(0, sci.index).split('.')[1] || '').replace(/[^0#?]/g, '').length;
        const [m, e] = x.toExponential(decimals).split('e');
        const digits = pat.slice(sci.index + 2).length;
        return pre + m.replace('.', DECIMAL) + 'E' + (e[0] === '-' ? '-' : '+') + e.replace(/^[+-]/, '').padStart(digits, '0') + post;
    }
    let p = pat;
    while (p.endsWith(',')) { x /= 1000; p = p.slice(0, -1); }
    const [intPart, decPart = ''] = p.split('.');
    const text = new Intl.NumberFormat(undefined, {
        minimumFractionDigits: (decPart.match(/0/g) || []).length,
        maximumFractionDigits: decPart.replace(/[^0#?]/g, '').length,
        minimumIntegerDigits: Math.max(1, Math.min(21, (intPart.match(/0/g) || []).length)),
        useGrouping: intPart.includes(','),
    }).format(x);
    return pre + text + post;
}

// A number in an Excel number format -> {text, color}
function formatNumber(v, code, date1904 = false) {
    if (!code || /^general$/i.test(code) || code === '@') return {text: general(v)};
    if (code === 'DATE') return {text: serialToDate(v, date1904).toLocaleDateString(undefined, {timeZone: 'UTC'})};
    if (code === 'DATETIME') return {text: serialToDate(v, date1904).toLocaleString(undefined, {timeZone: 'UTC',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'})};
    const sections = splitSections(code);
    let sec = sections[0], val = v;
    if (v < 0 && sections.length > 1 && sections[1] !== '') { sec = sections[1]; val = -v; }
    else if (v === 0 && sections.length > 2 && sections[2] !== '') sec = sections[2];
    let color;
    sec = sec.replace(/\[(red|blue|green|black|white|yellow|magenta|cyan)\]/gi, (m, c) => { color = c.toLowerCase(); return ''; })
             .replace(/\[\$([^\]-]*)(-[0-9a-f]+)?\]/gi, '$1')
             .replace(/\[(?!h+\]|m+\]|s+\])[^\]]*\]/gi, '');
    if (/^general$/i.test(sec.trim())) return {text: general(val), color};
    if (isDateCode(sec)) return {text: formatDate(val, sec, date1904), color};
    return {text: formatNumeric(val, sec), color};
}

// ---- drawing a sheet

function cellStyle(book, s) {
    if (book.css[s]) return book.css[s];
    const xf = book.xfs[s] || {}, base = book.fonts[0] || {};
    const font = book.fonts[xf.font] || base, css = [];
    if (font.b) css.push('font-weight:700');
    if (font.i) css.push('font-style:italic');
    if (font.u || font.strike) css.push(`text-decoration:${[font.u && 'underline', font.strike && 'line-through'].filter(Boolean).join(' ')}`);
    if (font.size && font.size !== base.size) css.push(`font-size:${(font.size * PT).toFixed(2)}px`);
    if (font.name && font.name !== base.name) css.push(`font-family:"${font.name.replace(/"/g, '')}",Calibri,Arial,sans-serif`);
    if (font.color && font.color !== base.color) css.push(`color:${font.color}`);
    const fill = book.fills[xf.fill];
    if (fill) css.push(`background:${fill}`);
    const b = book.borders[xf.border];
    if (b) for (const side of ['left', 'right', 'top', 'bottom']) if (b[side]) css.push(`border-${side}:${b[side]}`);
    if (xf.v === 'top') css.push('vertical-align:top');
    else if (xf.v === 'center') css.push('vertical-align:middle');
    if (xf.indent) css.push(`padding-left:${2 + xf.indent * 9}px`);
    return (book.css[s] = {css: css.join(';'), h: xf.h || '', wrap: !!xf.wrap,
                           fmt: book.fmts[xf.fmt] ?? BUILTIN_FMT[xf.fmt] ?? 'General'});
}

function cellText(cell, st, book) {
    const v = cell.v;
    if (v === null) return ['', 'left'];
    if (cell.t === 'b') return [v ? 'TRUE' : 'FALSE', 'center'];
    if (cell.t === 'e') return [String(v), 'center'];
    if (typeof v === 'number') { const f = formatNumber(v, st.fmt, book.date1904); return [f.text, 'right', f.color]; }
    if (cell.t === 'd') {
        const d = new Date(v);
        if (!isNaN(d)) return [isDateCode(st.fmt) ? formatDate(d / 86400000 + 25569, st.fmt) : d.toISOString().slice(0, 10), 'right'];
    }
    return [String(v), cell.num ? 'right' : 'left'];
}

// What is drawn of a sheet: the used range plus some empty rows / columns to type into, as in Excel
function sheetLayout(sh) {
    const fullR = Math.max(sh.maxR, 0, ...sh.merges.map(m => m.r2)), fullC = Math.max(sh.maxC, 0, ...sh.merges.map(m => m.c2));
    const lastC = Math.max(1, Math.min(fullC + 8, 200));
    const lastR = Math.max(1, Math.min(fullR + 30, Math.max(130, Math.floor(150000 / lastC))));
    sh.note = lastR < fullR || lastC < fullC ? `first ${lastR} rows / ${lastC} columns shown` : '';
    const colW = c => sh.colW[c] ?? sh.defColW;
    const rowH = r => sh.rows[r] ? (sh.rows[r].hidden ? 0 : sh.rows[r].h) : sh.defRowH;
    const spans = new Map(), covered = new Set();
    for (const m of sh.merges) {
        if (m.r1 > lastR || m.c1 > lastC) continue;
        spans.set(m.r1 * KEY + m.c1, m);
        for (let r = m.r1; r <= Math.min(m.r2, lastR); r++)
            for (let c = m.c1; c <= Math.min(m.c2, lastC); c++) if (r !== m.r1 || c !== m.c1) covered.add(r * KEY + c);
    }
    const headW = Math.max(32, String(lastR).length * 8 + 12), HEAD_H = 20;
    const leftOf = {}, tops = new Map();
    let width = headW, left = headW, top = HEAD_H;
    for (let c = 1; c <= lastC; c++) {
        if (!colW(c)) continue;
        width += colW(c);
        if (c <= sh.freezeC) { leftOf[c] = left; left += colW(c); }
    }
    for (let r = 1; r <= Math.min(sh.freezeR, lastR); r++) if (rowH(r)) { tops.set(r, top); top += rowH(r); }
    const yOf = new Float64Array(lastR + 2);  // y of each row below the frozen ones
    let y = 0;
    for (let r = 1; r <= lastR + 1; r++) { yOf[r] = y; if (r > sh.freezeR && r <= lastR) y += rowH(r); }
    sh.width = width;
    sh.stale = false;
    return (sh.layout = {lastR, lastC, colW, rowH, spans, covered, leftOf, tops, headW, width, yOf, bodyH: y,
                         cols: [...Array(lastC).keys()].filter(i => colW(i + 1)).length});
}

// Only the rows from a to b (and the frozen ones) are drawn, the others are two empty rows of their height: a sheet
// of thousands of rows would otherwise cost Edge thousands of graphics layers (sticky row headings) and turn the page
// black. drawSheet() picks the rows around the view, the sheet's track() draws again while scrolling.
const ROW_MARGIN = 800;

function rowAt(sh, y) {
    const L = sh.layout;
    let lo = sh.freezeR + 1, hi = L.lastR;
    if (lo > hi) return L.lastR + 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (L.yOf[mid] <= y) lo = mid; else hi = mid - 1;
    }
    return lo;
}

function drawSheet(w, rt, top) {
    const sh = sheetOf(rt);
    if (!sh.layout || sh.stale) sheetLayout(sh);
    const L = sh.layout, viewH = rt.body.clientHeight / w.zoom || 1000;
    let a = rowAt(sh, top - ROW_MARGIN), b = Math.min(L.lastR, rowAt(sh, top + viewH + ROW_MARGIN));
    for (const m of sh.merges) {              // a merged cell is drawn whole, from its first row
        if (m.r1 < a && m.r2 >= a && m.r1 > sh.freezeR) a = m.r1;
        if (m.r1 <= b && m.r2 > b) b = Math.min(m.r2, L.lastR);
    }
    rt.range = {a, b};
    rt.body.innerHTML = `<div class="dd-sheetbox" style="zoom:${w.zoom}">${sheetHtml(sh, rt.book, a, b)}</div>`;
    if (rt.sel) cellTd(rt, rt.sel.k)?.classList.add('sel');
    markSheet(w, rt);
}

function sheetHtml(sh, book, a, b) {
    const L = sh.layout;
    const font = book.fonts[0];
    const tableCss = [`width:${L.width}px`].concat(font ? [font.size && `font-size:${(font.size * PT).toFixed(2)}px`,
        font.name && `font-family:"${font.name.replace(/"/g, '')}",Calibri,Carlito,Arial,sans-serif`,
        font.color && `color:${font.color}`].filter(Boolean) : []).join(';');      // a fixed layout needs a fixed width
    const out = [`<table class="dd-sheet${sh.grid ? '' : ' nogrid'}" style="${tableCss}"><colgroup><col style="width:${L.headW}px">`];
    for (let c = 1; c <= L.lastC; c++) if (L.colW(c)) out.push(`<col style="width:${L.colW(c)}px">`);
    out.push('</colgroup><thead><tr><th class="dd-corner"></th>');
    for (let c = 1; c <= L.lastC; c++) {
        if (!L.colW(c)) continue;
        out.push(c in L.leftOf ? `<th class="fzc" style="left:${L.leftOf[c]}px">${colName(c)}</th>` : `<th>${colName(c)}</th>`);
    }
    out.push('</tr></thead><tbody>');
    const pad = h => h > 0 ? `<tr class="dd-pad" style="height:${h}px"><td colspan="${L.cols + 1}"></td></tr>` : '';
    for (let r = 1; r <= Math.min(sh.freezeR, L.lastR); r++) out.push(rowHtml(sh, book, r, sh.freezeR));
    out.push(pad(L.yOf[Math.min(a, L.lastR + 1)]));
    for (let r = a; r <= b; r++) out.push(rowHtml(sh, book, r, b));
    out.push(pad(L.bodyH - L.yOf[Math.min(b + 1, L.lastR + 1)]));
    out.push('</tbody></table>');
    return out.join('');
}

function rowHtml(sh, book, r, upto) {
    const L = sh.layout, h = L.rowH(r);
    if (!h) return '';
    const top = L.tops.get(r), frozenRow = top !== undefined;
    const hasValue = k => { const cell = sh.cells.get(k); return !!cell && (cell.v !== null || !!cell.f); };
    const out = [`<tr data-r="${r}" style="height:${h}px"><th${frozenRow ? ` style="top:${top}px;z-index:4"` : ''}>${r}</th>`];
    for (let c = 1; c <= L.lastC; c++) {
        const w = L.colW(c), k = r * KEY + c;
        if (!w || L.covered.has(k)) continue;
        const cell = sh.cells.get(k), m = L.spans.get(k);
        const st = cell ? cellStyle(book, cell.s) : {css: '', h: '', wrap: false};
        let [text, align, color] = cell ? cellText(cell, st, book) : ['', 'left'];
        const css = [st.css], cls = [];
        if (cell && cell.v === null && cell.f) { text = '=' + cell.f; align = 'left'; cls.push('fx'); }   // calculated by Excel
        let attrs = ` data-k="${k}"`;
        const hAlign = st.h && st.h !== 'general' ? ({centerContinuous: 'center', fill: 'left', distributed: 'center'}[st.h] || st.h) : align;
        if (hAlign !== 'left') css.push(`text-align:${hAlign}`);
        if (color) css.push(`color:${color}`);
        if (m) {
            let rows = 0, cols = 0;
            for (let rr = m.r1; rr <= Math.min(m.r2, upto); rr++) if (L.rowH(rr)) rows++;
            for (let cc = m.c1; cc <= Math.min(m.c2, L.lastC); cc++) if (L.colW(cc)) cols++;
            if (rows > 1) attrs += ` rowspan="${rows}"`;
            if (cols > 1) attrs += ` colspan="${cols}"`;
        }
        if (frozenRow || c <= sh.freezeC) {
            cls.push('fz');
            if (frozenRow) css.push(`top:${top}px`);
            if (c <= sh.freezeC) css.push(`left:${L.leftOf[c]}px`);
            if (frozenRow && c <= sh.freezeC) css.push('z-index:2');
        }
        let inner = esc(text);
        if (text && st.wrap) {
            cls.push('wrap');
        } else if (text && !m && hAlign === 'left' && !(c <= sh.freezeC)) {
            // text runs on over the empty cells to its right, as in Excel
            let room = w;
            for (let cc = c + 1; cc <= L.lastC && room < 3000; cc++) {
                const kk = r * KEY + cc;
                if (hasValue(kk) || L.covered.has(kk) || L.spans.has(kk)) break;
                room += L.colW(cc);
            }
            if (room > w) { cls.push('ov'); inner = `<span style="width:${room - 4}px">${inner}</span>`; }
        }
        const style = css.filter(Boolean).join(';');
        out.push(`<td${cls.length ? ` class="${cls.join(' ')}"` : ''}${attrs}${style ? ` style="${style}"` : ''}>${inner}</td>`);
    }
    out.push('</tr>');
    return out.join('');
}

// ---------------------------------------------------------------- dropping files

let dragDepth = 0;
const hasFiles = e => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

function showDrop() {
    const drop = $('dd-drop');
    drop.innerHTML = '<div class="dd-drop-add" data-add="1">Drop here: add as new window(s)</div>' + desk.windows.map(w =>
        `<div class="dd-target" data-replace="${w.id}" style="left:${w.x * 100}%;top:${w.y * 100}%;width:${w.w * 100}%;height:${w.h * 100}%">`
        + `Drop here: replace “${esc(w.name)}”<br>(keeps place${w.locked ? ', lock' : ''} and zoom)</div>`).join('');
    drop.hidden = false;
}
function hideDrop() { dragDepth = 0; $('dd-drop').hidden = true; $('dd-drop').innerHTML = ''; }
// a drag that ended outside the page leaves no dragleave behind: the next mouse move clears the targets
document.addEventListener('mousemove', () => { if (!$('dd-drop').hidden) hideDrop(); });

document.addEventListener('dragenter', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (dragDepth++ === 0) showDrop();
});
document.addEventListener('dragleave', e => {
    if (!hasFiles(e)) return;
    if (--dragDepth <= 0) hideDrop();
});
document.addEventListener('dragover', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const target = e.target.closest && e.target.closest('[data-replace], [data-add]');
    $('dd-drop').querySelectorAll('.over').forEach(el => { if (el !== target) el.classList.remove('over'); });
    if (target) target.classList.add('over');
});
document.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    const target = e.target.closest && e.target.closest('[data-replace]');
    const list = Array.from(e.dataTransfer.files);
    // the files' handles (Edge / Chrome), taken while the drop event lasts: Save can then write into the dropped file
    const jobs = Array.from(e.dataTransfer.items || []).filter(i => i.kind === 'file')
        .map(i => i.getAsFileSystemHandle ? i.getAsFileSystemHandle().catch(() => null) : null);
    hideDrop();
    Promise.all(jobs).then(handles => addFiles(list, target ? +target.dataset.replace : null,
                                               handles.filter(h => h && h.kind === 'file')));
});

// Keys for the active window: Ctrl + / Ctrl − / Ctrl 0 zoom it (instead of the browser page), Ctrl+S saves a sheet;
// copy / paste go to the selected cell of an active sheet
const activeWindow = () => desk.windows.find(o => o.id === activeId);
document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const w = activeWindow();
    if (!w || (e.target.closest && e.target.closest('input, textarea, select'))) return;
    if (e.key === '+' || e.key === '=') { e.preventDefault(); stepZoom(w, 1); }
    else if (e.key === '-') { e.preventDefault(); stepZoom(w, -1); }
    else if (e.key === '0') { e.preventDefault(); setZoom(w, 1); }
    else if (e.key.toLowerCase() === 's' && EDITABLE[w.kind]) { e.preventDefault(); saveFile(w); }
});
const sheetTarget = () => {
    const w = activeWindow(), rt = w && live.get(w.id);
    return rt && rt.book && rt.sel && !rt.editor && rt.body.contains(document.activeElement) ? rt : null;
};
document.addEventListener('copy', e => { const rt = sheetTarget(); if (rt && rt.onCopy) rt.onCopy(e); });
document.addEventListener('paste', e => { const rt = sheetTarget(); if (rt && rt.onPaste) rt.onPaste(e); });

// ---------------------------------------------------------------- search (SFM-267)
// One search over every window on the desk: the text of every PDF page (pdf.js text content, read once per document
// and kept while it is open) and the shown text of every sheet / CSV cell; images have no text. Case does not matter.
// * = any characters within one line of a PDF or one cell -- at the start or the end of the search: the rest of the
// word --, ? = one character, ~* ~? ~~ = the character itself. Matches are marked (PDF: in the text layer of the drawn
// pages, sheets: the cell, one match per cell as in Excel), the current one stronger; Enter / › / F3 goes to the next
// one: its window comes to the front and scrolls there. Everything stays in this browser.

const find = {q: '', re: null, hits: [], cur: -1, gen: 0, timer: 0, byPlace: new Map(), scrollTo: null};

// The search as a regular expression; null when there is nothing to look for (empty, or only * and ?)
function findPattern(q, flags = 'gi') {
    q = q.trim();
    if (!/[^*?\s]/.test(q.replace(/~[*?~]/g, 'x'))) return null;
    let src = '';
    for (let i = 0; i < q.length; i++) {
        const ch = q[i];
        if (ch === '~' && '*?~'.includes(q[i + 1] || '-')) { src += '\\' + q[++i]; continue; }
        if (ch === '*') {
            while (q[i + 1] === '*') i++;
            src += src === '' || i === q.length - 1 ? '\\S*' : '[^\\n]*?';
        } else if (ch === '?') src += '[^\\n]';
        else if (/\s/.test(ch)) { while (/\s/.test(q[i + 1] || '')) i++; src += '\\s+'; }
        else src += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(src, flags);
}

const upperBound = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= x) lo = m + 1; else hi = m; } return lo; };
const placeKey = h => h.page != null ? `${h.wid}:p${h.page}` : `${h.wid}:s${h.sheet}`;
const readingOrder = () => [...desk.windows].sort((a, b) => Math.round(a.y * 20) - Math.round(b.y * 20) || a.x - b.x);

// The text of every page: the items' strings in text-layer order (item i = the text layer's span i), \n after an item
// that ends a line; per item its start in the page text and its place on the page (fractions, for scrolling there)
async function pdfText(rt, progress) {
    if (!rt.textCache) rt.textCache = {pdf: rt.pdf, pages: []};
    const cache = rt.textCache, pdf = cache.pdf, n = pdf.numPages;
    for (let i = 1; i <= n; i++) {
        if (cache.pages[i]) continue;
        if (progress(i, n) === false) return null;
        const page = await pdf.getPage(i);
        const vp = page.getViewport({scale: 1}), tc = await page.getTextContent();
        if (rt.textCache !== cache) return null;          // closed or replaced meanwhile
        let text = '';
        const starts = [], xs = [], ys = [];
        for (const it of tc.items) {
            if (it.str === undefined) continue;
            const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
            starts.push(text.length);
            xs.push(x / vp.width);
            ys.push(y / vp.height);
            text += it.str + (it.hasEOL ? '\n' : '');
        }
        cache.pages[i] = {text, starts, xs, ys};
    }
    return cache.pages;
}

function shownText(cell, book) {
    if (cell.v === null) return cell.f ? '=' + cell.f : '';
    return cellText(cell, cellStyle(book, cell.s), book)[0];
}

function scheduleFind(delay = 250, jump = true) {
    clearTimeout(find.timer);
    find.timer = setTimeout(() => runFind(jump), delay);
}
// a document opened, closed or edited: the matches again, without jumping
function findDocsChanged() { if (find.re) scheduleFind(400, false); }

async function runFind(jump = true) {
    clearTimeout(find.timer);
    find.timer = 0;
    const gen = ++find.gen, q = $('dd-find').value, before = find.hits[find.cur];
    let re = null;
    try { re = findPattern(q); } catch { re = null; }
    Object.assign(find, {q, re, hits: [], cur: -1, byPlace: new Map(), scrollTo: null});
    markAll();
    if (!re) { findInfo(q.trim() ? 'Type more than * and ?' : '', !!q.trim()); return; }
    const hits = [];
    for (const w of readingOrder()) {
        const rt = live.get(w.id);
        if (!rt) continue;
        if (w.kind === 'pdf' && rt.pdf) {
            let pages = null;
            try {
                pages = await pdfText(rt, (i, n) => {
                    if (gen !== find.gen) return false;
                    if (i % 10 === 1) findInfo(`Searching ${w.name} … p. ${i} / ${n}`);
                });
            } catch (e) { console.warn('Document Desk search', w.name, e); }
            if (gen !== find.gen) return;
            (pages || []).forEach((pg, page) => {
                if (pg) for (const m of pg.text.matchAll(re)) if (m[0]) hits.push({wid: w.id, page, start: m.index, end: m.index + m[0].length});
            });
        } else if (rt.book) {
            rt.book.sheets.forEach((sh, sheet) => {
                const L = sh.layout && !sh.stale ? sh.layout : sheetLayout(sh);
                for (const k of [...sh.cells.keys()].sort((a, b) => a - b)) {
                    const r = Math.floor(k / KEY), c = k % KEY;
                    if (r > L.lastR || c > L.lastC || !L.rowH(r) || !L.colW(c) || L.covered.has(k)) continue;
                    re.lastIndex = 0;
                    const m = re.exec(shownText(sh.cells.get(k), rt.book));
                    if (m && m[0]) hits.push({wid: w.id, sheet, k});
                }
            });
        }
    }
    if (gen !== find.gen) return;
    find.hits = hits;
    hits.forEach((h, i) => { const key = placeKey(h); if (!find.byPlace.has(key)) find.byPlace.set(key, []); find.byPlace.get(key).push(i); });
    if (!hits.length) { markAll(); findInfo('No match', true); return; }
    if (jump) { goFind(0); return; }
    find.cur = before ? hits.findIndex(h => h.wid === before.wid && h.page === before.page && h.start === before.start
                                             && h.sheet === before.sheet && h.k === before.k) : -1;
    markAll();
    findInfo();
}

function findStep(dir) {
    if (find.timer || $('dd-find').value !== find.q) { runFind(true); return; }
    if (find.hits.length) goFind(find.cur < 0 ? (dir > 0 ? 0 : -1) : find.cur + dir);
}

function goFind(i) {
    const n = find.hits.length;
    if (!n) return;
    find.cur = ((i % n) + n) % n;
    const h = find.hits[find.cur], w = byId(h.wid), rt = w && live.get(w.id);
    if (!rt) { scheduleFind(0, false); return; }
    activate(w);
    if (h.page != null) {
        find.scrollTo = {wid: w.id, page: h.page};
        markAll();                                     // a drawn page: marked and scrolled to the match at once
        const p = rt.pages && rt.pages[h.page], pg = rt.textCache && rt.textCache.pages[h.page];
        if (find.scrollTo && p && pg) {                // not drawn yet: scroll near it, marked when the page is drawn
            const item = Math.max(0, upperBound(pg.starts, h.start) - 1);
            rt.body.scrollTop = p.div.offsetTop + (pg.ys[item] || 0) * p.div.offsetHeight - rt.body.clientHeight / 2;
            const x = p.div.offsetLeft + (pg.xs[item] || 0) * p.div.offsetWidth;
            if (x < rt.body.scrollLeft || x > rt.body.scrollLeft + rt.body.clientWidth - 40) rt.body.scrollLeft = x - rt.body.clientWidth / 3;
        }
    } else if (rt.book) {
        if (rt.editor) commitEdit(w, rt);
        if (rt.sheet !== h.sheet) { w.view = {sheet: h.sheet, top: 0, left: 0}; rt.sel = null; sheetViewer.show(w, rt); }
        selectCell(w, rt, h.k, 'center', false);
        markAll();
    }
    findInfo();
}

function findInfo(msg = null, warn = false) {
    if (msg === null) {
        const n = find.hits.length, h = find.hits[find.cur], w = h && byId(h.wid), rt = w && live.get(w.id);
        let where = '';
        if (h && h.page != null) where = ` p. ${h.page}`;
        else if (h && rt && rt.book) {
            const sh = rt.book.sheets[h.sheet];
            where = ` ${rt.book.sheets.length > 1 ? sh.name + '!' : ''}${colName(h.k % KEY)}${Math.floor(h.k / KEY)}`;
        }
        msg = !n ? '' : h ? `${find.cur + 1} / ${n} · ${w.name}${where}` : `${n} match${n === 1 ? '' : 'es'}`;
    }
    const el = $('dd-find-info');
    el.textContent = msg;
    el.title = msg;
    el.classList.toggle('warn', warn);
}

function markAll() {
    for (const w of desk.windows) {
        const rt = live.get(w.id);
        if (!rt) continue;
        if (w.kind === 'pdf' && rt.pages) rt.pages.forEach((p, n) => { if (p) markPdfPage(w, rt, n); });
        else if (rt.book && rt.body.querySelector('.dd-sheet')) markSheet(w, rt);
    }
}

// The matches on one drawn page: <mark>s inside the text layer's spans (the text stays transparent over the canvas)
function markPdfPage(w, rt, n) {
    const p = rt.pages && rt.pages[n];
    if (!p || !p.layer) return;
    const divs = p.layer.textDivs, strs = p.layer.textContentItemsStr;
    for (const i of p.marked || []) if (divs[i]) divs[i].textContent = strs[i];
    p.marked = [];
    const list = find.byPlace.get(`${w.id}:p${n}`), pg = rt.textCache && rt.textCache.pages[n];
    if (!list || !pg) return;
    const parts = new Map();                           // item -> [[from, to, current]]
    for (const hi of list) {
        const h = find.hits[hi];
        for (let i = Math.max(0, upperBound(pg.starts, h.start) - 1); i < pg.starts.length && pg.starts[i] < h.end; i++) {
            const s = pg.starts[i], a = Math.max(h.start - s, 0), b = Math.min(h.end - s, (strs[i] || '').length);
            if (b > a) { if (!parts.has(i)) parts.set(i, []); parts.get(i).push([a, b, hi === find.cur]); }
        }
    }
    for (const [i, segs] of parts) {
        const div = divs[i], str = strs[i];
        if (!div) continue;
        const frag = document.createDocumentFragment();
        let at = 0;
        for (const [a, b, cur] of segs.sort((x, y) => x[0] - y[0])) {
            if (a < at) continue;
            if (a > at) frag.append(str.slice(at, a));
            const m = document.createElement('mark');
            m.className = cur ? 'dd-hit cur' : 'dd-hit';
            m.textContent = str.slice(a, b);
            frag.append(m);
            at = b;
        }
        if (at < str.length) frag.append(str.slice(at));
        div.replaceChildren(frag);
        p.marked.push(i);
    }
    const s = find.scrollTo;
    if (s && s.wid === w.id && s.page === n) {
        const m = p.div.querySelector('mark.cur');
        if (m) { find.scrollTo = null; bringIntoView(rt, m); }
    }
}

function markSheet(w, rt) {
    const list = find.byPlace.get(`${w.id}:s${rt.sheet}`) || [];
    const keys = new Map(list.map(hi => [find.hits[hi].k, hi === find.cur]));
    rt.body.querySelectorAll('td.dd-hit').forEach(td => td.classList.remove('dd-hit', 'cur'));
    if (!keys.size) return;
    rt.body.querySelectorAll('td[data-k]').forEach(td => {
        const k = +td.dataset.k;
        if (keys.has(k)) td.classList.add('dd-hit', ...(keys.get(k) ? ['cur'] : []));
    });
}

// Scrolls the window's body (never the desk or the page) so that el sits about in the middle
function bringIntoView(rt, el) {
    const box = rt.body.getBoundingClientRect(), r = el.getBoundingClientRect();
    if (r.top < box.top + 30 || r.bottom > box.bottom - 10) rt.body.scrollTop += r.top - box.top - rt.body.clientHeight / 2 + r.height / 2;
    if (r.left < box.left || r.right > box.right) rt.body.scrollLeft += r.left - box.left - rt.body.clientWidth / 2 + r.width / 2;
}

$('dd-find').addEventListener('input', () => scheduleFind());
$('dd-find').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); $('dd-find').value = ''; runFind(); }
});
$('dd-find-prev').addEventListener('click', () => findStep(-1));
$('dd-find-next').addEventListener('click', () => findStep(1));
document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') { e.preventDefault(); $('dd-find').focus(); $('dd-find').select(); }
    else if (e.key === 'F3') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
});

// ---------------------------------------------------------------- toolbar

function refreshEmpty() { $('dd-empty').hidden = desk.windows.length > 0; }

function setSlim(on) { desk.slim = on; stage.classList.toggle('slim', on); $('dd-slim').classList.toggle('on', on); }
function setClean(on) { desk.clean = on; document.body.classList.toggle('dd-clean', on); $('dd-clean').classList.toggle('on', on); }

$('dd-add').addEventListener('click', async () => {
    if (!window.showOpenFilePicker) { $('dd-file').click(); return; }
    let handles;                              // with handles, Save writes the changes into the chosen files
    try { handles = await window.showOpenFilePicker({multiple: true}); }
    catch (e) { if (e.name !== 'AbortError') $('dd-file').click(); return; }
    addFiles(await Promise.all(handles.map(h => h.getFile())), null, handles);
});
$('dd-file').addEventListener('change', e => { addFiles(Array.from(e.target.files)); e.target.value = ''; });
document.querySelectorAll('[data-arrange]').forEach(b => b.addEventListener('click', () => arrange(b.dataset.arrange)));
$('dd-layouts').addEventListener('change', e => { if (e.target.value) applyLayout(e.target.value); });
$('dd-save-layout').addEventListener('click', saveLayout);
$('dd-delete-layout').addEventListener('click', () => {
    const name = $('dd-layouts').value;
    if (!name) { status('Choose the saved layout to delete first.', true); return; }
    if (!confirm(`Delete the saved layout "${name}"?`)) return;
    delete desk.layouts[name];
    fillLayouts();
    saveSoon();
});
$('dd-slim').addEventListener('click', () => { setSlim(!desk.slim); saveSoon(); });
$('dd-clean').addEventListener('click', () => { setClean(!desk.clean); saveSoon(); });
$('dd-present').addEventListener('click', () => {
    if (!stage.requestFullscreen) { status('This browser has no full screen for a page part.', true); return; }
    stage.requestFullscreen().catch(e => status('Full screen refused: ' + e.message, true));
});
$('dd-clear').addEventListener('click', () => {
    if (!desk.windows.length || !confirm('Close all windows and forget their files? Saved layouts stay.')) return;
    [...desk.windows].forEach(w => closeWindow(w, true));
    desk.arrange = '';
    markArrange();
    saveSoon();
});

// ---------------------------------------------------------------- from the Library (SFM-259)
// The Library plugin's documents (its own folder on this PC / the server) offered in a dialog; a chosen one is fetched
// from the app (/library/file/<id>) and added like a dropped file -- a copy on the desk, so Save of an edited workbook
// asks where to write it (the Library's file isn't changed from here).

// With a window (its 📚 button, SFM-261) the dialog picks one document that replaces the window's document: place,
// size, lock and -- for the same kind of document -- zoom stay, as when a file is dropped onto the window.
const lib = {docs: null, chosen: new Set(), replace: null};

async function openLibrary(w = null) {
    const dlg = $('dd-lib');
    lib.chosen.clear();
    lib.replace = w ? w.id : null;
    $('dd-lib-title').textContent = w ? `Replace “${w.name}” with a Library document` : 'Documents from the Library';
    $('dd-lib-q').value = '';
    libNote('');
    dlg.showModal();
    $('dd-lib-q').focus();
    try {
        const r = await fetch('/api/library', {cache: 'no-store'});
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (!data.settings || !data.settings.folder) throw new Error('no Library folder set on this PC -- choose it on the Library page');
        if (data.error) throw new Error(data.error);
        lib.docs = (data.documents || []).filter(d => d.name && !d.missing && !d.bib_only)
            .map(d => ({...d, kind: kindOf({name: d.name, type: ''})})).filter(d => d.kind)
            .sort((a, b) => (a.title || a.name).localeCompare(b.title || b.name, undefined, {numeric: true}));
    } catch (e) {
        lib.docs = [];
        libNote(`Library not read: ${e.message}.`, true);
    }
    renderLibrary();
}

function libNote(msg, warn = false) {
    $('dd-lib-note').textContent = msg;
    $('dd-lib-note').classList.toggle('warn', warn);
}

function renderLibrary() {
    // every word must occur; * and ? as in the desk's search (SFM-267)
    const words = $('dd-lib-q').value.split(/\s+/).filter(Boolean).map(w => { try { return findPattern(w, 'i'); } catch { return null; } });
    const hay = d => [d.id, d.title, d.name, d.path, d.folder, ...(d.aliases || [])].join(' ');
    const shown = (lib.docs || []).filter(d => words.every(re => !re || re.test(hay(d))));
    $('dd-lib-list').innerHTML = shown.length ? shown.map(d => `
        <label class="dd-lib-item${lib.chosen.has(d.id) ? ' on' : ''}" data-id="${esc(d.id)}" data-kind="${d.kind}" title="${esc(d.path || d.name)}">
            <input type="checkbox" value="${esc(d.id)}"${lib.chosen.has(d.id) ? ' checked' : ''}>
            <span class="dd-kind">${KIND_LABEL[d.kind]}</span>
            <span class="dd-lib-text"><div class="dd-lib-title">${esc(d.title || d.name)}</div>
                <div class="dd-lib-path">${esc(d.path || d.name)}</div></span>
            <span class="dd-lib-id">${esc(d.id)}</span>
        </label>`).join('')
        : `<div class="dd-msg">${lib.docs && lib.docs.length ? 'No document matches.' : 'No PDF, Excel, CSV or image in the Library.'}</div>`;
    lib.shown = shown.length;
    libFooter();
}

function libFooter() {
    if (!$('dd-lib-note').classList.contains('warn'))
        libNote(lib.docs ? `${lib.shown} of ${lib.docs.length} documents` + (lib.chosen.size ? ` -- ${lib.chosen.size} chosen` : '') : '');
    $('dd-lib-add').disabled = !lib.chosen.size;
    $('dd-lib-add').textContent = lib.replace != null ? 'Replace' : lib.chosen.size > 1 ? `Open ${lib.chosen.size}` : 'Open';
}

async function addFromLibrary(ids) {
    $('dd-lib').close();
    const replaceId = lib.replace != null && desk.windows.some(w => w.id === lib.replace) ? lib.replace : null;
    if (replaceId != null) ids = ids.slice(-1);
    const picked = ids.map(id => lib.docs.find(d => d.id === id)).filter(Boolean);
    if (!picked.length) return;
    status(`Loading ${picked.length === 1 ? picked[0].name : picked.length + ' documents'} from the Library…`);
    const got = [], failed = [];
    for (const d of picked) {
        try {
            const r = await fetch(`/library/file/${encodeURIComponent(d.id)}`, {cache: 'no-store'});
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const blob = await r.blob();
            got.push(new File([blob], d.name, {type: blob.type}));
        } catch (e) { failed.push(`${d.name} (${e.message})`); }
    }
    const done = got.length ? await addFiles(got, replaceId) : true;
    if (failed.length) status(`Not loaded from the Library: ${failed.join(', ')}.`, true);
    else if (!done) status('');
    else status(`${got.length === 1 ? got[0].name : got.length + ' documents'} from the Library.`);
}

if ($('dd-lib')) {
    $('dd-lib-open').addEventListener('click', () => openLibrary());
    $('dd-lib-q').addEventListener('input', renderLibrary);
    $('dd-lib-q').addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const only = $('dd-lib-list').querySelectorAll('.dd-lib-item');
        if (lib.chosen.size) addFromLibrary([...lib.chosen]);
        else if (only.length === 1) addFromLibrary([only[0].dataset.id]);
    });
    $('dd-lib-list').addEventListener('change', e => {
        const box = e.target.closest('input[type=checkbox]');
        if (!box) return;
        if (lib.replace != null && box.checked) {     // replacing: one document only
            lib.chosen.clear();
            $('dd-lib-list').querySelectorAll('.dd-lib-item input:checked').forEach(o => {
                if (o !== box) { o.checked = false; o.closest('.dd-lib-item').classList.remove('on'); }
            });
        }
        if (box.checked) lib.chosen.add(box.value); else lib.chosen.delete(box.value);
        box.closest('.dd-lib-item').classList.toggle('on', box.checked);
        libFooter();
    });
    $('dd-lib-list').addEventListener('dblclick', e => {
        const item = e.target.closest('.dd-lib-item');
        if (item) addFromLibrary(lib.replace != null ? [item.dataset.id] : [...new Set([...lib.chosen, item.dataset.id])]);
    });
    $('dd-lib-add').addEventListener('click', () => addFromLibrary([...lib.chosen]));
    $('dd-lib-cancel').addEventListener('click', () => $('dd-lib').close());
}

async function init() {
    let saved = null;
    try { saved = await db.getState(); } catch (e) { storageFailed(e); }
    if (saved && Array.isArray(saved.windows)) Object.assign(desk, saved);
    desk.windows.forEach(mount);
    const top = [...desk.windows].sort((a, b) => b.z - a.z)[0];
    if (top) { activeId = top.id; desk.windows.forEach(paint); }
    setSlim(!!desk.slim);
    setClean(!!desk.clean);
    fillLayouts();
    markArrange();
    refreshEmpty();
}

const byId = id => desk.windows.find(w => w.id === id);
window.documentDesk = {ready: init(), desk, addFiles, arrange, applyLayout, formatNumber, readXlsx,
    saveFile: id => saveFile(byId(id)),
    exportWindow: id => { const w = byId(id); return exportBook(live.get(w.id).book, w.name); },
    attachHandle: (id, handle) => { files.get(byId(id).fileId).handle = handle; }};
