// Drawing tab (SFM-218) -- also the whole of the standalone "Drawing PRO max" (scripts/build_standalone_drawing.py).
// A small Visio: rectangles, ellipses, lines, text boxes and connectors glued to shapes (they follow when a
// shape moves), connection points, text formatting and shape styles from a ribbon, several pages, undo,
// copy / paste, PNG / SVG / XML export. In the workbench a shape can be linked to a model object.
//
// The page holds the document in memory, draws it as SVG and saves it whole as XML through a store:
//   workbench  -> PUT /api/drawings (model/drawings.xml of the open project)
//   standalone -> window.DRAWING_STORE from standalone/drawing_local.js (localStorage)
// Units: CSS px (96 per inch); font size and line width in pt.
(function () {
'use strict';

const FORMAT = 'safety-model-drawings';
const ID_RE = /^[A-Za-z0-9_.:\-]{1,60}$/;
const SVGNS = 'http://www.w3.org/2000/svg';
const PT = 96 / 72;
const GRID = 10;
const UNDO_LIMIT = 150;
const KEY_PAGE = 'drawingPage';
const ONE_D = new Set(['line', 'connector']);
const PAGE_SIZES = { 'A4 landscape': [1123, 794], 'A4 portrait': [794, 1123], 'A3 landscape': [1587, 1123], 'A3 portrait': [1123, 1587] };
const FONTS = ['Calibri', 'Cambria', 'Arial', 'Segoe UI', 'Times New Roman', 'Verdana', 'Tahoma', 'Georgia', 'Courier New', 'Consolas'];
const SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 60, 72];
const COLORS = ['#000000', '#ffffff', '#404040', '#7f7f7f', '#bfbfbf', '#d9d9d9',
                '#1f4e79', '#2e75b6', '#9dc3e6', '#deebf7', '#385723', '#70ad47', '#c5e0b4', '#e2f0d9',
                '#c00000', '#ff0000', '#f4b183', '#fbe5d6', '#7f6000', '#ffc000', '#ffe699', '#fff2cc',
                '#7030a0', '#b4a7d6'];
const WEIGHTS = [0.25, 0.5, 0.75, 1, 1.5, 2.25, 3, 4.5, 6];
const DASHES = { solid: '', dash: '6 4', dot: '1.5 3', dashdot: '8 3 1.5 3' };
const STYLE_KEYS = ['font', 'size', 'bold', 'italic', 'underline', 'strike', 'case', 'color', 'align', 'valign',
                    'bullets', 'indent', 'textRotate', 'fill', 'line', 'lineWidth', 'dash', 'arrowStart', 'arrowEnd',
                    'radius', 'shadow', 'glow'];
const BASE_STYLE = { font: 'Calibri', size: 11, bold: false, italic: false, underline: false, strike: false, case: '',
                     color: '#000000', align: 'center', valign: 'middle', bullets: false, indent: 0, textRotate: 0,
                     fill: '#ffffff', line: '#000000', lineWidth: 1, dash: 'solid', arrowStart: false, arrowEnd: false,
                     radius: 0, shadow: false, glow: false };
const DEFAULTS = {
    rect: {}, ellipse: {},
    text: { fill: 'none', line: 'none' },
    line: { fill: 'none' },
    connector: { fill: 'none', arrowEnd: true },
};

// ---- document <-> XML ------------------------------------------------------------------------

function emptyDoc() { return { pages: [{ id: 'P1', name: 'Page 1', width: 1123, height: 794, shapes: [] }] }; }

function styleOf(shape) { return { ...BASE_STYLE, ...DEFAULTS[shape.type], ...shape.style }; }

function parseXml(text) {
    const xml = new DOMParser().parseFromString(text, 'application/xml');
    if (xml.getElementsByTagName('parsererror').length) throw new Error('Not valid XML.');
    const root = xml.documentElement;
    if (root.tagName !== 'drawings' || root.getAttribute('format') !== FORMAT)
        throw new Error(`Not a drawing file (expected <drawings format="${FORMAT}">).`);
    const doc = { pages: [] };
    const num = (el, a) => (el.hasAttribute(a) ? Number(el.getAttribute(a)) : undefined);
    for (const p of root.children) {
        if (p.tagName !== 'drawing') continue;
        const page = { id: p.getAttribute('id') || '', name: p.getAttribute('name') || '',
                       width: num(p, 'width'), height: num(p, 'height'), shapes: [] };
        for (const el of p.children) {
            if (el.tagName !== 'shape') continue;
            const s = { id: el.getAttribute('id') || '', type: el.getAttribute('type') || '', style: {}, cps: [] };
            for (const a of ['x', 'y', 'w', 'h', 'x1', 'y1', 'x2', 'y2', 'fromPt', 'toPt']) if (el.hasAttribute(a)) s[a] = num(el, a);
            for (const a of ['from', 'to', 'route', 'link']) if (el.getAttribute(a)) s[a] = el.getAttribute(a);
            for (const c of el.children) {
                if (c.tagName === 'text') s.text = c.textContent;
                else if (c.tagName === 'cp') s.cps.push([num(c, 'x'), num(c, 'y')]);
                else if (c.tagName === 'style') {
                    for (const k of STYLE_KEYS) if (c.hasAttribute(k)) {
                        const v = c.getAttribute(k), base = BASE_STYLE[k];
                        s.style[k] = typeof base === 'boolean' ? v === '1' : typeof base === 'number' ? Number(v) : v;
                    }
                }
            }
            if (!s.cps.length) delete s.cps;
            page.shapes.push(s);
        }
        doc.pages.push(page);
    }
    checkDoc(doc);
    return doc;
}

const xmlEsc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const r1 = v => Math.round(v * 100) / 100;

function toXml(doc) {
    const out = ['<?xml version="1.0" encoding="UTF-8"?>', `<drawings format="${FORMAT}" version="1">`];
    for (const p of doc.pages) {
        const head = `  <drawing id="${xmlEsc(p.id)}" name="${xmlEsc(p.name)}" width="${r1(p.width)}" height="${r1(p.height)}"`;
        if (!p.shapes.length) { out.push(head + '/>'); continue; }
        out.push(head + '>');
        for (const s of p.shapes) {
            let attrs = `id="${xmlEsc(s.id)}" type="${s.type}"`;
            for (const a of ['x', 'y', 'w', 'h', 'x1', 'y1', 'x2', 'y2']) if (s[a] !== undefined) attrs += ` ${a}="${r1(s[a])}"`;
            for (const a of ['from', 'fromPt', 'to', 'toPt', 'route', 'link']) if (s[a] !== undefined && s[a] !== '' && s[a] !== null) attrs += ` ${a}="${xmlEsc(s[a])}"`;
            const parts = [];
            if (s.text) parts.push(`<text>${xmlEsc(s.text)}</text>`);
            const st = Object.entries(s.style || {}).filter(([k]) => STYLE_KEYS.includes(k))
                .map(([k, v]) => `${k}="${xmlEsc(typeof v === 'boolean' ? (v ? '1' : '0') : v)}"`);
            if (st.length) parts.push(`<style ${st.join(' ')}/>`);
            for (const [x, y] of s.cps || []) parts.push(`<cp x="${r1(x)}" y="${r1(y)}"/>`);
            out.push(parts.length ? `    <shape ${attrs}>${parts.join('')}</shape>` : `    <shape ${attrs}/>`);
        }
        out.push('  </drawing>');
    }
    out.push('</drawings>', '');
    return out.join('\n');
}

// The same rules as app/services/drawings.py :: check().
function checkDoc(doc) {
    if (!doc.pages.length) throw new Error('The file has no drawing page.');
    const pageIds = new Set();
    for (const p of doc.pages) {
        if (!ID_RE.test(p.id) || pageIds.has(p.id)) throw new Error(`Page id "${p.id}" is missing, invalid or used twice.`);
        pageIds.add(p.id);
        if (!p.name.trim()) throw new Error(`Page ${p.id} has no name.`);
        for (const v of [p.width, p.height]) if (!Number.isFinite(v) || v < 50 || v > 20000) throw new Error(`Page "${p.name}": the size must be 50 to 20000.`);
        const byId = new Map();
        for (const s of p.shapes) {
            if (!ID_RE.test(s.id) || byId.has(s.id)) throw new Error(`Page "${p.name}": shape id "${s.id}" is invalid or used twice.`);
            if (!['rect', 'ellipse', 'line', 'text', 'connector'].includes(s.type)) throw new Error(`Page "${p.name}": ${s.id} has an unknown type "${s.type}".`);
            for (const a of ['x', 'y', 'w', 'h', 'x1', 'y1', 'x2', 'y2', 'fromPt', 'toPt'])
                if (s[a] !== undefined && !Number.isFinite(s[a])) throw new Error(`Page "${p.name}": ${s.id} ${a} is not a number.`);
            const needed = ONE_D.has(s.type) ? ['x1', 'y1', 'x2', 'y2'] : ['x', 'y', 'w', 'h'];
            const missing = needed.filter(a => s[a] === undefined);
            if (missing.length) throw new Error(`Page "${p.name}": ${s.id} has no ${missing.join(', ')}.`);
            byId.set(s.id, s);
        }
        for (const s of p.shapes) for (const end of ['from', 'to']) {
            const g = s[end];
            if (g && (!byId.has(g) || g === s.id || ONE_D.has(byId.get(g).type)))
                throw new Error(`Page "${p.name}": ${s.id} is glued to ${g}, which is not a shape on this page.`);
        }
    }
}

// ---- geometry --------------------------------------------------------------------------------

// Connection points: the four side middles (0 top, 1 right, 2 bottom, 3 left), then the shape's own ones (4..).
function connectionPoints(s) {
    const pts = [[0.5, 0, 0, -1], [1, 0.5, 1, 0], [0.5, 1, 0, 1], [0, 0.5, -1, 0]];
    for (const [fx, fy] of s.cps || []) {
        const d = Math.min(fx, 1 - fx, fy, 1 - fy);
        const dir = d === fy ? [0, -1] : d === 1 - fy ? [0, 1] : d === fx ? [-1, 0] : [1, 0];
        pts.push([fx, fy, ...dir]);
    }
    return pts.map(([fx, fy, dx, dy]) => ({ x: s.x + fx * s.w, y: s.y + fy * s.h, dx, dy }));
}

// Where a connector end glued to shape `s` sits: a chosen point, or (pt -1, "dynamic glue") the side middle
// that is nearest to the other end, like Visio's dynamic connector.
function gluePoint(s, pt, toward) {
    const pts = connectionPoints(s);
    if (pt >= 0 && pt < pts.length) return pts[pt];
    let best = pts[0], bestD = Infinity;
    for (const p of pts.slice(0, 4)) {
        const d = Math.hypot(p.x - toward.x, p.y - toward.y);
        if (d < bestD) { bestD = d; best = p; }
    }
    return best;
}

// Updates a connector's / line's glued ends from the shapes they are glued to.
function resolveEnds(page, c) {
    const byId = id => page.shapes.find(x => x.id === id);
    const a = c.from && byId(c.from), b = c.to && byId(c.to);
    const centre = s => ({ x: s.x + s.w / 2, y: s.y + s.h / 2 });
    let p1 = { x: c.x1, y: c.y1, dx: 0, dy: 0 }, p2 = { x: c.x2, y: c.y2, dx: 0, dy: 0 };
    if (a) p1 = gluePoint(a, c.fromPt ?? -1, b ? centre(b) : p2);
    if (b) p2 = gluePoint(b, c.toPt ?? -1, a ? centre(a) : p1);
    if (a && (c.fromPt ?? -1) < 0) p1 = gluePoint(a, -1, p2);
    c.x1 = p1.x; c.y1 = p1.y; c.x2 = p2.x; c.y2 = p2.y;
    return [p1, p2];
}

function freeDir(p, other) {
    const dx = other.x - p.x, dy = other.y - p.y;
    return Math.abs(dx) >= Math.abs(dy) ? [Math.sign(dx) || 1, 0] : [0, Math.sign(dy) || 1];
}

// The connector's path: right angles (Visio's default) or straight.
function connectorPoints(page, c) {
    const [p1, p2] = resolveEnds(page, c);
    if (c.type === 'line' || c.route === 'straight') return [p1, p2];
    const [d1x, d1y] = p1.dx || p1.dy ? [p1.dx, p1.dy] : freeDir(p1, p2);
    const [d2x, d2y] = p2.dx || p2.dy ? [p2.dx, p2.dy] : freeDir(p2, p1);
    const stub = 15;
    const a = { x: p1.x + d1x * stub, y: p1.y + d1y * stub }, b = { x: p2.x + d2x * stub, y: p2.y + d2y * stub };
    const pts = [p1, a];
    const h1 = d1x !== 0, h2 = d2x !== 0;
    if (h1 && h2) { const mx = (a.x + b.x) / 2; pts.push({ x: mx, y: a.y }, { x: mx, y: b.y }); }
    else if (!h1 && !h2) { const my = (a.y + b.y) / 2; pts.push({ x: a.x, y: my }, { x: b.x, y: my }); }
    else if (h1) pts.push({ x: b.x, y: a.y });
    else pts.push({ x: a.x, y: b.y });
    pts.push(b, p2);
    // drop zero-length and straight-through points
    const clean = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
        const prev = clean[clean.length - 1], p = pts[i];
        if (Math.abs(p.x - prev.x) < 0.01 && Math.abs(p.y - prev.y) < 0.01) continue;
        if (clean.length >= 2) {
            const pp = clean[clean.length - 2];
            if ((Math.abs(pp.x - prev.x) < 0.01 && Math.abs(prev.x - p.x) < 0.01) || (Math.abs(pp.y - prev.y) < 0.01 && Math.abs(prev.y - p.y) < 0.01)) clean.pop();
        }
        clean.push(p);
    }
    return clean;
}

function bbox(page, s) {
    if (ONE_D.has(s.type)) {
        const pts = connectorPoints(page, s);
        const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
        return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }
    return { x: s.x, y: s.y, w: s.w, h: s.h };
}

// ---- drawing (SVG) ---------------------------------------------------------------------------

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function textHtml(s, st) {
    const lines = (s.text || '').split('\n');
    const deco = [st.underline ? 'underline' : '', st.strike ? 'line-through' : ''].filter(Boolean).join(' ') || 'none';
    const transform = { upper: 'uppercase', lower: 'lowercase', title: 'capitalize' }[st.case] || 'none';
    const css = `font-family:'${esc(st.font)}',sans-serif;font-size:${st.size * PT}px;font-weight:${st.bold ? 700 : 400};`
        + `font-style:${st.italic ? 'italic' : 'normal'};text-decoration:${deco};text-transform:${transform};color:${esc(st.color)};`
        + `text-align:${st.align};line-height:1.2;padding-left:${st.indent * 18}px;`;
    const body = st.bullets
        ? `<ul style="margin:0;padding-left:1.2em;text-align:${st.align};">${lines.map(l => `<li>${esc(l) || '&#8203;'}</li>`).join('')}</ul>`
        : lines.map(l => `<div>${esc(l) || '&#8203;'}</div>`).join('');
    return { css, body };
}

function markerDefs() {
    return `<defs>
      <marker id="dw-arrow-end" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" markerUnits="strokeWidth" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/></marker>
      <marker id="dw-arrow-start" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="7" markerHeight="7" markerUnits="strokeWidth" orient="auto"><path d="M10,0 L0,5 L10,10 z" fill="context-stroke"/></marker>
      <filter id="dw-shadow" x="-20%" y="-20%" width="150%" height="150%"><feDropShadow dx="3" dy="3" stdDeviation="2" flood-color="#000" flood-opacity="0.35"/></filter>
      <filter id="dw-glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur in="SourceAlpha" stdDeviation="4" result="b"/><feFlood flood-color="#60a5fa" flood-opacity="0.9"/><feComposite in2="b" operator="in" result="g"/><feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>`;
}

// One shape as SVG markup (also used for the PNG / SVG export, so no editor-only parts here).
function shapeSvg(page, s) {
    const st = styleOf(s);
    const stroke = st.line === 'none' ? 'none' : st.line;
    const sw = st.lineWidth * PT;
    const dash = DASHES[st.dash] ? ` stroke-dasharray="${DASHES[st.dash].split(' ').map(v => v * Math.max(1, sw)).join(' ')}"` : '';
    const filter = st.shadow ? ' filter="url(#dw-shadow)"' : st.glow ? ' filter="url(#dw-glow)"' : '';
    const common = `fill="${st.fill === 'none' ? 'none' : esc(st.fill)}" stroke="${esc(stroke)}" stroke-width="${sw}"${dash}`;
    let geo = '';
    if (s.type === 'rect' || s.type === 'text') {
        geo = `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="${st.radius}" ${common}/>`;
    } else if (s.type === 'ellipse') {
        geo = `<ellipse cx="${s.x + s.w / 2}" cy="${s.y + s.h / 2}" rx="${s.w / 2}" ry="${s.h / 2}" ${common}/>`;
    } else {
        const pts = connectorPoints(page, s);
        const d = pts.map((p, i) => `${i ? 'L' : 'M'}${r1(p.x)},${r1(p.y)}`).join(' ');
        const markers = (st.arrowEnd ? ' marker-end="url(#dw-arrow-end)"' : '') + (st.arrowStart ? ' marker-start="url(#dw-arrow-start)"' : '');
        geo = `<path d="${d}" fill="none" stroke="${esc(stroke === 'none' ? '#000000' : stroke)}" stroke-width="${sw}"${dash}${markers} stroke-linejoin="round"/>`;
    }
    let text = '';
    if (s.text && !ONE_D.has(s.type)) {
        const { css, body } = textHtml(s, st);
        const jc = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }[st.valign] || 'center';
        const rot = st.textRotate ? `transform:rotate(${-st.textRotate}deg);` : '';
        const vertical = st.textRotate === 90 || st.textRotate === 270;
        const boxW = vertical ? s.h : s.w, boxH = vertical ? s.w : s.h;
        text = `<foreignObject x="${s.x + (s.w - boxW) / 2}" y="${s.y + (s.h - boxH) / 2}" width="${boxW}" height="${boxH}" style="overflow:visible;${rot}transform-origin:${s.x + s.w / 2}px ${s.y + s.h / 2}px;transform-box:view-box;">`
            + `<div xmlns="http://www.w3.org/1999/xhtml" style="box-sizing:border-box;width:${boxW}px;height:${boxH}px;display:flex;flex-direction:column;justify-content:${jc};padding:4px;overflow:visible;${css}">${body}</div></foreignObject>`;
    } else if (s.text) {
        const pts = connectorPoints(page, s);
        const mid = pts[Math.floor((pts.length - 1) / 2)], next = pts[Math.floor((pts.length - 1) / 2) + 1] || mid;
        const { css, body } = textHtml(s, st);
        text = `<foreignObject x="${(mid.x + next.x) / 2 - 80}" y="${(mid.y + next.y) / 2 - 12}" width="160" height="24" style="overflow:visible;">`
            + `<div xmlns="http://www.w3.org/1999/xhtml" style="${css}text-align:center;background:#fff;display:inline-block;width:160px;">${body}</div></foreignObject>`;
    }
    return `<g class="dw-shape" data-id="${esc(s.id)}"${filter}>${geo}${text}</g>`;
}

// ---- the page --------------------------------------------------------------------------------

const S = { store: null, doc: null, pageId: null, sel: [], tool: 'pointer', shapeKind: 'rect', zoom: 1, pan: { x: 40, y: 40 },
            undo: [], redo: [], clipboard: null, drag: null, editing: null, saveTimer: null, saving: Promise.resolve(),
            objects: null, snap: true };

const page = () => S.doc.pages.find(p => p.id === S.pageId) || S.doc.pages[0];
const shape = id => page().shapes.find(s => s.id === id);
const selected = () => S.sel.map(shape).filter(Boolean);

function status(text, isError) {
    const el = $('dw-status');
    el.textContent = text;
    el.classList.toggle('error', !!isError);
}

function scheduleSave() {
    status('Saving…');
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(() => {
        const xml = toXml(S.doc);
        S.saving = S.saving.then(() => S.store.save(xml)).then(() => status('Saved'))
            .catch(e => { status(e.message, true); alert(e.message); });
    }, 300);
}

function snapshot() { return { doc: JSON.stringify(S.doc), pageId: S.pageId }; }

function pushUndo(snap) {
    S.undo.push(snap);
    if (S.undo.length > UNDO_LIMIT) S.undo.shift();
    S.redo = [];
}

function change(fn) {
    const before = snapshot();
    if (fn() === false) return false;
    pushUndo(before);
    scheduleSave();
    render();
    return true;
}

function undoRedo(from, to) {
    const step = from.pop();
    if (!step) return;
    to.push(snapshot());
    S.doc = JSON.parse(step.doc);
    S.pageId = S.doc.pages.some(p => p.id === step.pageId) ? step.pageId : S.doc.pages[0].id;
    S.sel = S.sel.filter(id => shape(id));
    scheduleSave();
    render();
}

function nextShapeId(p = page()) {
    let n = 0;
    for (const s of p.shapes) { const m = /^S(\d+)$/.exec(s.id); if (m) n = Math.max(n, +m[1]); }
    return 'S' + (n + 1);
}

function render() {
    const p = page();
    const svg = $('dw-svg');
    const view = `translate(${S.pan.x},${S.pan.y}) scale(${S.zoom})`;
    for (const s of p.shapes) if (ONE_D.has(s.type)) resolveEnds(p, s);
    const shapes = p.shapes.map(s => shapeSvg(p, s)).join('');
    svg.innerHTML = markerDefs()
        + `<pattern id="dw-grid" width="${GRID}" height="${GRID}" patternUnits="userSpaceOnUse"><path d="M ${GRID} 0 L 0 0 0 ${GRID}" fill="none" stroke="#eef0f3" stroke-width="0.5"/></pattern>`
        + `<g id="dw-view" transform="${view}">`
        + `<rect class="dw-page" x="0" y="0" width="${p.width}" height="${p.height}" fill="#fff" stroke="#c7cdd6" filter="url(#dw-shadow)"/>`
        + `<rect x="0" y="0" width="${p.width}" height="${p.height}" fill="url(#dw-grid)" pointer-events="none"/>`
        + `<g id="dw-shapes">${shapes}</g><g id="dw-overlay">${overlaySvg(p)}</g></g>`;
    renderTabs();
    updateRibbon();
    $('dw-zoom').textContent = Math.round(S.zoom * 100) + '%';
}

function linkBadge(s) {
    if (!s.link) return '';
    const known = !S.objects || S.objects.has(s.link);
    const b = bbox(page(), s);
    const title = known ? `${s.link}${S.objects ? ' — ' + S.objects.get(s.link) : ''} (Ctrl+click opens it)` : `${s.link} is not in the model any more`;
    return `<g class="dw-link${known ? '' : ' broken'}" data-link="${esc(s.link)}" data-id="${esc(s.id)}" transform="translate(${b.x + b.w - 7},${b.y - 7})"><title>${esc(title)}</title>`
        + `<circle r="${8 / S.zoom}" fill="${known ? '#1d4ed8' : '#dc2626'}"/><text text-anchor="middle" dy="${3.5 / S.zoom}" font-size="${10 / S.zoom}" fill="#fff" font-family="Arial">${known ? '&#x1F517;' : '!'}</text></g>`;
}

function overlaySvg(p) {
    const z = S.zoom, out = [];
    for (const s of p.shapes) out.push(linkBadge(s));
    const showPoints = S.tool === 'connector' || S.tool === 'cpoint' || (S.drag && S.drag.mode === 'end');
    if (showPoints) for (const s of p.shapes) if (!ONE_D.has(s.type))
        for (const [i, c] of connectionPoints(s).entries())
            out.push(`<g class="dw-cp${i >= 4 ? ' own' : ''}" data-id="${esc(s.id)}" data-pt="${i}"><path d="M${c.x - 4 / z},${c.y - 4 / z} L${c.x + 4 / z},${c.y + 4 / z} M${c.x - 4 / z},${c.y + 4 / z} L${c.x + 4 / z},${c.y - 4 / z}" stroke="#2563eb" stroke-width="${1.5 / z}"/><circle cx="${c.x}" cy="${c.y}" r="${6 / z}" fill="transparent"/></g>`);
    for (const s of selected()) {
        if (ONE_D.has(s.type)) {
            const glued = [s.from, s.to];
            [[s.x1, s.y1], [s.x2, s.y2]].forEach(([x, y], i) => out.push(
                `<rect class="dw-handle end" data-end="${i}" x="${x - 5 / z}" y="${y - 5 / z}" width="${10 / z}" height="${10 / z}" fill="${glued[i] ? '#16a34a' : '#fff'}" stroke="#1d4ed8" stroke-width="${1 / z}"/>`));
        } else {
            out.push(`<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="none" stroke="#1d4ed8" stroke-width="${1 / z}" stroke-dasharray="${4 / z} ${3 / z}" pointer-events="none"/>`);
            if (S.sel.length === 1) for (const [h, fx, fy] of HANDLES)
                out.push(`<rect class="dw-handle" data-handle="${h}" x="${s.x + fx * s.w - 4 / z}" y="${s.y + fy * s.h - 4 / z}" width="${8 / z}" height="${8 / z}" fill="#fff" stroke="#1d4ed8" stroke-width="${1 / z}" style="cursor:${h}-resize"/>`);
        }
    }
    if (S.drag && S.drag.mode === 'marquee') {
        const m = S.drag.rect;
        out.push(`<rect x="${m.x}" y="${m.y}" width="${m.w}" height="${m.h}" fill="rgba(37,99,235,.08)" stroke="#2563eb" stroke-width="${1 / z}" stroke-dasharray="${3 / z}"/>`);
    }
    return out.join('');
}

const HANDLES = [['nw', 0, 0], ['n', 0.5, 0], ['ne', 1, 0], ['e', 1, 0.5], ['se', 1, 1], ['s', 0.5, 1], ['sw', 0, 1], ['w', 0, 0.5]];

function renderOverlay() { $('dw-overlay').innerHTML = overlaySvg(page()); }

function renderTabs() {
    $('dw-tabs').innerHTML = S.doc.pages.map(p => `<button type="button" class="dw-tab${p.id === page().id ? ' active' : ''}" data-page="${esc(p.id)}" title="Double-click to rename">${esc(p.name)}</button>`).join('')
        + '<button type="button" class="dw-tab add" id="dw-page-add" title="New page">+</button>';
}

// ---- ribbon state ----------------------------------------------------------------------------

function common(key) {
    const sel = selected();
    if (!sel.length) return undefined;
    const values = sel.map(s => styleOf(s)[key]);
    return values.every(v => v === values[0]) ? values[0] : undefined;
}

function updateRibbon() {
    const has = S.sel.length > 0;
    document.querySelectorAll('.dw-needs-sel').forEach(el => { el.disabled = !has; });
    $('dw-font').value = common('font') ?? '';
    $('dw-size').value = common('size') ?? '';
    for (const k of ['bold', 'italic', 'underline', 'strike', 'bullets', 'shadow', 'glow'])
        $('dw-' + k)?.classList.toggle('on', common(k) === true);
    for (const a of ['left', 'center', 'right', 'justify']) $('dw-align-' + a).classList.toggle('on', common('align') === a);
    for (const v of ['top', 'middle', 'bottom']) $('dw-valign-' + v).classList.toggle('on', common('valign') === v);
    $('dw-color-bar').style.background = common('color') || '#000000';
    $('dw-fill-bar').style.background = common('fill') === 'none' ? 'transparent' : (common('fill') || '#ffffff');
    $('dw-line-bar').style.background = common('line') === 'none' ? 'transparent' : (common('line') || '#000000');
    document.querySelectorAll('.dw-tool').forEach(b => b.classList.toggle('on', b.dataset.tool === S.tool));
    $('dw-shape-tool').classList.toggle('on', ['rect', 'ellipse', 'line'].includes(S.tool));
    $('dw-shape-icon').innerHTML = { rect: ICON_RECT, ellipse: ICON_ELLIPSE, line: ICON_LINE }[S.shapeKind];
    $('dw-undo').disabled = !S.undo.length;
    $('dw-redo').disabled = !S.redo.length;
    const link = S.sel.length === 1 && selected()[0].link;
    if ($('dw-link')) {
        $('dw-link').disabled = S.sel.length !== 1;
        $('dw-unlink').disabled = !link;
        $('dw-open-link').disabled = !link;
    }
    $('dw-svg').dataset.tool = S.tool;
}

const ICON_RECT = '<svg viewBox="0 0 20 20"><rect x="3" y="5" width="14" height="10" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
const ICON_ELLIPSE = '<svg viewBox="0 0 20 20"><ellipse cx="10" cy="10" rx="7" ry="5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
const ICON_LINE = '<svg viewBox="0 0 20 20"><path d="M3 16 L17 4" stroke="currentColor" stroke-width="1.4"/></svg>';

// ---- editing ---------------------------------------------------------------------------------

function setStyle(key, value) {
    if (!S.sel.length) return;
    change(() => { for (const s of selected()) s.style = { ...s.style, [key]: value }; });
}

function toggleStyle(key) {
    if (!S.sel.length) return;
    setStyle(key, common(key) !== true);
}

function fontSize(step) {
    if (!S.sel.length) return;
    change(() => {
        for (const s of selected()) {
            const now = styleOf(s).size;
            const next = step > 0 ? SIZES.find(v => v > now) ?? now + 8 : [...SIZES].reverse().find(v => v < now) ?? Math.max(1, now - 1);
            s.style = { ...s.style, size: next };
        }
    });
}

function indent(step) {
    if (!S.sel.length) return;
    change(() => { for (const s of selected()) s.style = { ...s.style, indent: Math.max(0, Math.min(10, styleOf(s).indent + step)) }; });
}

function snap(v) { return S.snap ? Math.round(v / GRID) * GRID : v; }

function toModel(evt) {
    const r = $('dw-svg').getBoundingClientRect();
    return { x: (evt.clientX - r.left - S.pan.x) / S.zoom, y: (evt.clientY - r.top - S.pan.y) / S.zoom };
}

function hitShape(target) {
    const g = target.closest && target.closest('.dw-shape');
    return g ? g.dataset.id : null;
}

// The connection point / shape under a model point (for gluing a connector end).
function glueTarget(pt, exclude) {
    const p = page(), tol = 10 / S.zoom;
    for (const s of [...p.shapes].reverse()) {
        if (ONE_D.has(s.type) || s.id === exclude) continue;
        const pts = connectionPoints(s);
        for (let i = 0; i < pts.length; i++) if (Math.hypot(pts[i].x - pt.x, pts[i].y - pt.y) <= tol) return { id: s.id, pt: i, x: pts[i].x, y: pts[i].y };
    }
    for (const s of [...p.shapes].reverse()) {
        if (ONE_D.has(s.type) || s.id === exclude) continue;
        if (pt.x >= s.x && pt.x <= s.x + s.w && pt.y >= s.y && pt.y <= s.y + s.h) return { id: s.id, pt: -1 };
    }
    return null;
}

function select(ids) {
    S.sel = ids;
    renderOverlay();
    updateRibbon();
}

function onPointerDown(evt) {
    if (S.editing) finishText();
    if (evt.button === 1 || (evt.button === 0 && S.spaceDown)) {          // middle button or Space + drag: move the view
        S.drag = { mode: 'pan', start: { x: evt.clientX, y: evt.clientY }, pan: { ...S.pan } };
        return;
    }
    if (evt.button !== 0) return;
    const m = toModel(evt);
    const p = page();
    const target = evt.target;
    const linkEl = target.closest('.dw-link');
    if (linkEl && (evt.ctrlKey || evt.metaKey)) { openLink(linkEl.dataset.link); return; }
    const handle = target.closest('.dw-handle');
    if (handle && S.sel.length) {
        const s = selected()[0];
        S.drag = handle.dataset.end !== undefined
            ? { mode: 'end', id: s.id, end: +handle.dataset.end, before: snapshot() }
            : { mode: 'resize', id: s.id, handle: handle.dataset.handle, orig: { x: s.x, y: s.y, w: s.w, h: s.h }, start: m, before: snapshot() };
        $('dw-svg').setPointerCapture(evt.pointerId);
        return;
    }
    if (S.tool === 'cpoint') {
        const id = hitShape(target) || (target.closest('.dw-cp') && target.closest('.dw-cp').dataset.id);
        const s = id && shape(id);
        if (s && !ONE_D.has(s.type)) {
            const cp = target.closest('.dw-cp');
            if (cp && +cp.dataset.pt >= 4) {
                change(() => { s.cps.splice(+cp.dataset.pt - 4, 1); if (!s.cps.length) delete s.cps; });
                status('Connection point removed');
            } else {
                const fx = Math.max(0, Math.min(1, (m.x - s.x) / s.w)), fy = Math.max(0, Math.min(1, (m.y - s.y) / s.h));
                change(() => { s.cps = [...(s.cps || []), [Math.round(fx * 1000) / 1000, Math.round(fy * 1000) / 1000]]; });
            }
        }
        return;
    }
    if (S.tool === 'connector' || S.tool === 'line') {
        const glue = S.tool === 'connector' ? glueTarget(m) : null;
        const start = glue && glue.pt >= 0 ? { x: glue.x, y: glue.y } : { x: snap(m.x), y: snap(m.y) };
        const s = { id: nextShapeId(), type: S.tool, x1: start.x, y1: start.y, x2: start.x, y2: start.y, style: {} };
        if (glue) { s.from = glue.id; s.fromPt = glue.pt; }
        if (S.tool === 'connector') s.route = 'orthogonal';
        const before = snapshot();
        p.shapes.push(s);
        S.sel = [s.id];
        S.drag = { mode: 'end', id: s.id, end: 1, before, created: true };
        $('dw-svg').setPointerCapture(evt.pointerId);
        render();
        return;
    }
    if (S.tool === 'rect' || S.tool === 'ellipse' || S.tool === 'text') {
        const start = { x: snap(m.x), y: snap(m.y) };
        const s = { id: nextShapeId(), type: S.tool, x: start.x, y: start.y, w: 0, h: 0, style: {} };
        const before = snapshot();
        p.shapes.push(s);
        S.sel = [s.id];
        S.drag = { mode: 'create', id: s.id, start, before };
        $('dw-svg').setPointerCapture(evt.pointerId);
        render();
        return;
    }
    // pointer tool
    const id = hitShape(target) || (linkEl && linkEl.dataset.id);
    // a double-click edits the text -- detected here: each click redraws the shapes, so the browser's own
    // dblclick (which needs the same element under both clicks) never comes
    const now = performance.now();
    if (id && S.lastDown && S.lastDown.id === id && now - S.lastDown.t < 450 && !evt.shiftKey && !evt.ctrlKey) {
        S.lastDown = null;
        setTimeout(() => startText(id), 0);    // after the browser's own focus change of this press
        return;
    }
    S.lastDown = null;
    if (id) {
        if (evt.shiftKey || evt.ctrlKey || evt.metaKey) {
            S.sel = S.sel.includes(id) ? S.sel.filter(x => x !== id) : [...S.sel, id];
            select(S.sel);
            return;
        }
        if (!S.sel.includes(id)) S.sel = [id];
        const s = shape(id);
        if (ONE_D.has(s.type) && S.sel.length === 1 && (s.from || s.to)) {     // a glued line moves with its shapes only
            select(S.sel);
            return;
        }
        S.drag = { mode: 'move', start: m, orig: selected().map(x => ({ id: x.id, x: x.x, y: x.y, x1: x.x1, y1: x.y1, x2: x.x2, y2: x.y2 })), before: snapshot(), moved: false };
        $('dw-svg').setPointerCapture(evt.pointerId);
        select(S.sel);
        return;
    }
    S.drag = { mode: 'marquee', start: m, rect: { x: m.x, y: m.y, w: 0, h: 0 }, add: evt.shiftKey || evt.ctrlKey };
    if (!S.drag.add) S.sel = [];
    $('dw-svg').setPointerCapture(evt.pointerId);
    select(S.sel);
}

function onPointerMove(evt) {
    const d = S.drag;
    if (!d) return;
    if (d.mode === 'pan') {
        S.pan = { x: d.pan.x + evt.clientX - d.start.x, y: d.pan.y + evt.clientY - d.start.y };
        $('dw-view').setAttribute('transform', `translate(${S.pan.x},${S.pan.y}) scale(${S.zoom})`);
        return;
    }
    const m = toModel(evt), p = page();
    if (d.mode === 'move') {
        let dx = m.x - d.start.x, dy = m.y - d.start.y;
        if (evt.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        if (Math.abs(dx) + Math.abs(dy) > 1) d.moved = true;
        const first = d.orig[0], ref = first.x !== undefined ? first.x : first.x1, refY = first.y !== undefined ? first.y : first.y1;
        dx = snap(ref + dx) - ref; dy = snap(refY + dy) - refY;
        for (const o of d.orig) {
            const s = shape(o.id);
            if (ONE_D.has(s.type)) { s.x1 = o.x1 + dx; s.y1 = o.y1 + dy; s.x2 = o.x2 + dx; s.y2 = o.y2 + dy; }
            else { s.x = o.x + dx; s.y = o.y + dy; }
        }
        render();
    } else if (d.mode === 'create') {
        const s = shape(d.id);
        let x2 = snap(m.x), y2 = snap(m.y);
        if (evt.shiftKey) { const side = Math.max(Math.abs(x2 - d.start.x), Math.abs(y2 - d.start.y)); x2 = d.start.x + Math.sign(x2 - d.start.x || 1) * side; y2 = d.start.y + Math.sign(y2 - d.start.y || 1) * side; }
        s.x = Math.min(d.start.x, x2); s.y = Math.min(d.start.y, y2); s.w = Math.abs(x2 - d.start.x); s.h = Math.abs(y2 - d.start.y);
        render();
    } else if (d.mode === 'resize') {
        const s = shape(d.id), o = d.orig, h = d.handle;
        let { x, y, w, h: hh } = o;
        const mx = snap(m.x), my = snap(m.y);
        if (h.includes('w')) { x = Math.min(mx, o.x + o.w - 5); w = o.x + o.w - x; }
        if (h.includes('e')) { w = Math.max(5, mx - o.x); }
        if (h.includes('n')) { y = Math.min(my, o.y + o.h - 5); hh = o.y + o.h - y; }
        if (h.includes('s')) { hh = Math.max(5, my - o.y); }
        if (evt.shiftKey && h.length === 2) { const ratio = o.w / o.h; if (w / hh > ratio) w = hh * ratio; else hh = w / ratio; if (h.includes('w')) x = o.x + o.w - w; if (h.includes('n')) y = o.y + o.h - hh; }
        Object.assign(s, { x, y, w, h: hh });
        render();
    } else if (d.mode === 'end') {
        const s = shape(d.id);
        const key = d.end === 0 ? 'from' : 'to', ptKey = d.end === 0 ? 'fromPt' : 'toPt';
        const glue = s.type === 'connector' ? glueTarget(m, d.end === 0 ? s.to : s.from) : null;
        if (glue) { s[key] = glue.id; s[ptKey] = glue.pt; }
        else {
            delete s[key]; delete s[ptKey];
            let x = snap(m.x), y = snap(m.y);
            if (evt.shiftKey && s.type === 'line') { const ox = d.end === 0 ? s.x2 : s.x1, oy = d.end === 0 ? s.y2 : s.y1; if (Math.abs(x - ox) > Math.abs(y - oy)) y = oy; else x = ox; }
            if (d.end === 0) { s.x1 = x; s.y1 = y; } else { s.x2 = x; s.y2 = y; }
        }
        render();
    } else if (d.mode === 'marquee') {
        d.rect = { x: Math.min(d.start.x, m.x), y: Math.min(d.start.y, m.y), w: Math.abs(m.x - d.start.x), h: Math.abs(m.y - d.start.y) };
        renderOverlay();
    }
}

function onPointerUp(evt) {
    if (evt && $('dw-svg').hasPointerCapture(evt.pointerId)) $('dw-svg').releasePointerCapture(evt.pointerId);
    const d = S.drag;
    S.drag = null;
    if (!d) return;
    const p = page();
    if (d.mode === 'marquee') {
        const r = d.rect;
        const inside = p.shapes.filter(s => { const b = bbox(p, s); return b.x >= r.x && b.y >= r.y && b.x + b.w <= r.x + r.w && b.y + b.h <= r.y + r.h; }).map(s => s.id);
        select(d.add ? [...new Set([...S.sel, ...inside])] : inside);
        return;
    }
    if (d.mode === 'pan') return;
    if (d.mode === 'create') {
        const s = shape(d.id);
        if (s.w < 4 && s.h < 4) {                      // a click: the default size
            const size = s.type === 'text' ? [120, 30] : [120, 60];
            s.w = size[0]; s.h = size[1];
        }
        commitDrag(d);
        if (s.type === 'text') { setTool('pointer'); startText(s.id); }
        return;
    }
    if (d.mode === 'end' && d.created) {
        const s = shape(d.id);
        if (Math.hypot(s.x2 - s.x1, s.y2 - s.y1) < 4 && !(s.from && s.to)) {   // a click without dragging: nothing
            S.doc = JSON.parse(d.before.doc);
            S.sel = [];
            render();
            return;
        }
    }
    if (d.mode === 'move' && !d.moved) {                 // a click (no drag): the first half of a double-click
        S.lastDown = S.sel.length === 1 ? { id: S.sel[0], t: performance.now() } : null;
        render();
        return;
    }
    commitDrag(d);
}

function commitDrag(d) {
    pushUndo(d.before);
    scheduleSave();
    render();
}

function startText(id) {
    const s = shape(id);
    if (!s) return;
    S.sel = [id];
    render();
    const st = styleOf(s);
    const b = bbox(page(), s);
    const ta = $('dw-text');
    const r = $('dw-svg').getBoundingClientRect(), host = $('dw-canvas').getBoundingClientRect();
    const left = r.left - host.left + S.pan.x + b.x * S.zoom, top = r.top - host.top + S.pan.y + b.y * S.zoom;
    Object.assign(ta.style, {
        left: left + 'px', top: top + 'px', width: Math.max(80, b.w * S.zoom) + 'px', height: Math.max(28, b.h * S.zoom) + 'px',
        fontFamily: `'${st.font}', sans-serif`, fontSize: st.size * PT * S.zoom + 'px', fontWeight: st.bold ? 700 : 400,
        fontStyle: st.italic ? 'italic' : 'normal', textAlign: st.align === 'justify' ? 'left' : st.align, color: st.color,
    });
    ta.value = s.text || '';
    ta.hidden = false;
    S.editing = { id, before: snapshot(), text: s.text || '' };
    ta.focus();
    ta.select();
}

function finishText(cancel) {
    const e = S.editing;
    if (!e) return;
    S.editing = null;
    const ta = $('dw-text');
    ta.hidden = true;
    const s = shape(e.id);
    if (!s || cancel || ta.value === e.text) { render(); return; }
    s.text = ta.value;
    pushUndo(e.before);
    scheduleSave();
    render();
}

function deleteSelected() {
    if (!S.sel.length) return;
    const ids = new Set(S.sel);
    change(() => {
        const p = page();
        p.shapes = p.shapes.filter(s => !ids.has(s.id));
        for (const s of p.shapes) {                    // a connector glued to a deleted shape keeps its place, unglued
            if (ids.has(s.from)) { delete s.from; delete s.fromPt; }
            if (ids.has(s.to)) { delete s.to; delete s.toPt; }
        }
        S.sel = [];
    });
}

function copySelected(cut) {
    if (!S.sel.length) return;
    S.clipboard = JSON.parse(JSON.stringify(selected()));
    if (cut) deleteSelected();
}

function paste(offset = 20) {
    if (!S.clipboard || !S.clipboard.length) return;
    change(() => {
        const p = page(), map = new Map();
        const copies = S.clipboard.map(s => { const c = JSON.parse(JSON.stringify(s)); c.id = nextShapeId(p); map.set(s.id, c.id); p.shapes.push(c); return c; });
        for (const c of copies) {
            if (ONE_D.has(c.type)) { c.x1 += offset; c.y1 += offset; c.x2 += offset; c.y2 += offset; } else { c.x += offset; c.y += offset; }
            for (const end of ['from', 'to']) if (c[end]) { if (map.has(c[end])) c[end] = map.get(c[end]); else { delete c[end]; delete c[end + 'Pt']; } }
        }
        S.clipboard = JSON.parse(JSON.stringify(copies));
        S.sel = copies.map(c => c.id);
    });
}

function nudge(dx, dy) {
    if (!S.sel.length) return;
    change(() => { for (const s of selected()) { if (ONE_D.has(s.type)) { if (!s.from) { s.x1 += dx; s.y1 += dy; } if (!s.to) { s.x2 += dx; s.y2 += dy; } } else { s.x += dx; s.y += dy; } } });
}

function order(front) {
    if (!S.sel.length) return;
    change(() => {
        const p = page(), ids = new Set(S.sel);
        const sel = p.shapes.filter(s => ids.has(s.id)), rest = p.shapes.filter(s => !ids.has(s.id));
        p.shapes = front ? [...rest, ...sel] : [...sel, ...rest];
    });
}

function setTool(tool) {
    S.tool = tool;
    if (['rect', 'ellipse', 'line'].includes(tool)) S.shapeKind = tool;
    render();
    $('dw-hint').textContent = {
        pointer: '', rect: 'Drag on the page to draw a rectangle (Shift: square).', ellipse: 'Drag to draw an ellipse (Shift: circle).',
        line: 'Drag to draw a line (Shift: horizontal / vertical).', text: 'Click or drag on the page for a text box, then type.',
        connector: 'Drag from a shape (or one of its × points) to another shape: the connector stays glued when they move.',
        cpoint: 'Click on a shape to add a connection point there; click an own point (×) again to remove it.',
    }[tool];
}

// ---- dropdowns (colours, line, effects) -------------------------------------------------------

function palette(onPick, noneLabel) {
    return (noneLabel ? `<button type="button" class="dw-dd-item" data-color="none">${noneLabel}</button>` : '')
        + `<div class="dw-swatches">${COLORS.map(c => `<button type="button" class="dw-swatch" data-color="${c}" title="${c}" style="background:${c}"></button>`).join('')}</div>`
        + '<label class="dw-dd-item">More colours… <input type="color" class="dw-more-color"></label>';
}

function openDropdown(button, html, onClick) {
    closeDropdowns();
    const dd = $('dw-dropdown');
    dd.innerHTML = html;
    const r = button.getBoundingClientRect();
    dd.style.left = r.left + window.scrollX + 'px';
    dd.style.top = r.bottom + window.scrollY + 2 + 'px';
    dd.hidden = false;
    dd.onclick = e => {
        const el = e.target.closest('[data-color],[data-value]');
        if (!el) return;
        onClick(el.dataset.color ?? el.dataset.value, el);
        closeDropdowns();
    };
    const more = dd.querySelector('.dw-more-color');
    if (more) more.addEventListener('change', () => { onClick(more.value); closeDropdowns(); });
}

function closeDropdowns() { $('dw-dropdown').hidden = true; }

function lineMenu() {
    const w = WEIGHTS.map(v => `<button type="button" class="dw-dd-item" data-value="w:${v}"><svg width="60" height="10"><path d="M2 5 H58" stroke="#000" stroke-width="${v * PT}"/></svg> ${v} pt</button>`).join('');
    const dashes = Object.entries(DASHES).map(([k, v]) => `<button type="button" class="dw-dd-item" data-value="d:${k}"><svg width="60" height="10"><path d="M2 5 H58" stroke="#000" stroke-width="1.5" stroke-dasharray="${v.split(' ').map(x => x * 1.5).join(' ')}"/></svg> ${k}</button>`).join('');
    return palette(null, 'No line') + '<hr><div class="dw-dd-title">Weight</div>' + w + '<hr><div class="dw-dd-title">Dashes</div>' + dashes
        + '<hr><div class="dw-dd-title">Arrows</div>'
        + '<button type="button" class="dw-dd-item" data-value="a:end">Arrow at the end</button><button type="button" class="dw-dd-item" data-value="a:start">Arrow at the start</button><button type="button" class="dw-dd-item" data-value="a:none">No arrows</button>'
        + '<hr><div class="dw-dd-title">Corners / routing</div>'
        + '<button type="button" class="dw-dd-item" data-value="r:0">Square corners</button><button type="button" class="dw-dd-item" data-value="r:8">Rounded corners</button>'
        + '<button type="button" class="dw-dd-item" data-value="route:orthogonal">Connector: right angles</button><button type="button" class="dw-dd-item" data-value="route:straight">Connector: straight</button>';
}

function applyLine(value) {
    if (value === undefined) return;
    if (value === 'none' || value.startsWith('#')) return setStyle('line', value);
    const [k, v] = value.split(':');
    if (k === 'w') setStyle('lineWidth', Number(v));
    else if (k === 'd') setStyle('dash', v);
    else if (k === 'r') setStyle('radius', Number(v));
    else if (k === 'a') change(() => { for (const s of selected()) s.style = { ...s.style, arrowEnd: v === 'end' ? true : v === 'none' ? false : styleOf(s).arrowEnd, arrowStart: v === 'start' ? true : v === 'none' ? false : styleOf(s).arrowStart }; });
    else if (k === 'route') change(() => { for (const s of selected()) if (s.type === 'connector') s.route = v; });
}

// ---- model link (workbench only) ----------------------------------------------------------------

async function loadObjects() {
    if (!S.store.models) return;
    try {
        const r = await fetch('/api/objects', { cache: 'no-store' });
        const list = await r.json();
        S.objects = new Map(list.map(o => [o.id, o.title]));
        S.objectList = list;
    } catch (e) { S.objects = null; }
}

function openLink(id) { window.open('/objects/' + encodeURIComponent(id), '_blank', 'noopener'); }

function linkDialog() {
    const s = selected()[0];
    if (!s || !S.objectList) return;
    const dlg = $('dw-link-dialog');
    const input = $('dw-link-search'), list = $('dw-link-list');
    const show = () => {
        const q = input.value.trim().toLowerCase();
        const hits = S.objectList.filter(o => !q || `${o.id} ${o.title} ${o.object_type}`.toLowerCase().includes(q)).slice(0, 200);
        list.innerHTML = hits.map(o => `<button type="button" class="dw-dd-item" data-id="${esc(o.id)}"><code>${esc(o.id)}</code> ${esc(o.title)} <span class="dw-muted">${esc(o.object_type)}</span></button>`).join('')
            || '<div class="dw-muted" style="padding:6px;">Nothing matches.</div>';
    };
    input.value = s.link || '';
    show();
    input.oninput = show;
    list.onclick = e => {
        const b = e.target.closest('[data-id]');
        if (!b) return;
        const id = b.dataset.id;
        change(() => { s.link = id; if (!s.text && !ONE_D.has(s.type)) s.text = `${id}\n${S.objects.get(id) || ''}`.trim(); });
        dlg.close();
    };
    dlg.showModal();
    input.focus();
}

// ---- pages, files, menus ----------------------------------------------------------------------

async function askText(title, value) {
    const dlg = $('dw-text-dialog');
    $('dw-text-dialog-title').textContent = title;
    $('dw-text-dialog-input').value = value || '';
    dlg.returnValue = '';
    dlg.showModal();
    $('dw-text-dialog-input').select();
    return new Promise(resolve => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? $('dw-text-dialog-input').value.trim() : null), { once: true }));
}

function nextPageId() {
    let n = 0;
    for (const p of S.doc.pages) { const m = /^P(\d+)$/.exec(p.id); if (m) n = Math.max(n, +m[1]); }
    return 'P' + (n + 1);
}

function uniquePageName(name) {
    const names = new Set(S.doc.pages.map(p => p.name));
    if (!names.has(name)) return name;
    for (let i = 2; ; i++) if (!names.has(`${name} (${i})`)) return `${name} (${i})`;
}

function openPage(id) {
    if (S.editing) finishText();
    S.pageId = id;
    S.sel = [];
    try { localStorage.setItem(KEY_PAGE, id); } catch (e) { /* private window */ }
    render();
    fit();
}

function fit() {
    const p = page(), box = $('dw-svg').getBoundingClientRect();
    if (!box.width) return;
    S.zoom = Math.max(0.1, Math.min(4, Math.min((box.width - 40) / p.width, (box.height - 40) / p.height)));
    S.pan = { x: (box.width - p.width * S.zoom) / 2, y: (box.height - p.height * S.zoom) / 2 };
    render();
}

function zoomAt(factor, cx, cy) {
    const z = Math.max(0.1, Math.min(8, S.zoom * factor));
    S.pan = { x: cx - (cx - S.pan.x) * z / S.zoom, y: cy - (cy - S.pan.y) * z / S.zoom };
    S.zoom = z;
    render();
}

function fileBase() { return (page().name || 'drawing').replace(/[^A-Za-z0-9 _.\-]+/g, '_').trim().replace(/\s+/g, '_') || 'drawing'; }

function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// The page as a standalone SVG: the page area only, without grid, selection or link badges.
function pageSvg() {
    const p = page();
    for (const s of p.shapes) if (ONE_D.has(s.type)) resolveEnds(p, s);
    return `<svg xmlns="${SVGNS}" width="${p.width}" height="${p.height}" viewBox="0 0 ${p.width} ${p.height}">${markerDefs()}`
        + `<rect width="${p.width}" height="${p.height}" fill="#ffffff"/>${p.shapes.map(s => shapeSvg(p, s)).join('')}</svg>`;
}

function exportPng() {
    const p = page(), scale = Math.max(1, Math.min(4, 8000 / Math.max(p.width, p.height)));
    const img = new Image();
    img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(p.width * scale); canvas.height = Math.round(p.height * scale);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(blob => download(blob, fileBase() + '.png'), 'image/png');
    };
    img.onerror = () => alert('The PNG export failed in this browser -- use Export SVG.');
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(pageSvg());
}

async function importXml(file) {
    let imported;
    try { imported = parseXml(await file.text()); } catch (e) { alert(`${file.name}: ${e.message}`); return; }
    const added = [];
    change(() => {
        for (const p of imported.pages) {
            const copy = { ...p, id: nextPageId(), name: uniquePageName(p.name) };
            S.doc.pages.push(copy);
            added.push(copy);
        }
    });
    if (added.length) { openPage(added[0].id); status(`Imported ${added.length} page(s) from ${file.name}`); }
}

const ACTIONS = {
    'dw-page-new': async () => {
        const name = await askText('New page', uniquePageName('Page ' + (S.doc.pages.length + 1)));
        if (!name) return;
        const p = { id: nextPageId(), name: uniquePageName(name), width: page().width, height: page().height, shapes: [] };
        change(() => { S.doc.pages.push(p); });
        openPage(p.id);
    },
    'dw-page-rename': async () => {
        const p = page();
        const name = await askText('Rename page', p.name);
        if (name && name !== p.name) change(() => { p.name = name; });
    },
    'dw-page-copy': () => {
        const p = page();
        const copy = { ...JSON.parse(JSON.stringify(p)), id: nextPageId(), name: uniquePageName(p.name + ' (copy)') };
        change(() => { S.doc.pages.push(copy); });
        openPage(copy.id);
    },
    'dw-page-delete': () => {
        const p = page();
        if (!confirm(`Delete the page "${p.name}" with its ${p.shapes.length} shape(s)?`)) return;
        change(() => {
            S.doc.pages = S.doc.pages.filter(x => x !== p);
            if (!S.doc.pages.length) S.doc.pages.push({ id: 'P1', name: 'Page 1', width: 1123, height: 794, shapes: [] });
            S.pageId = S.doc.pages[0].id;
        });
        openPage(S.pageId);
    },
    'dw-export-png': exportPng,
    'dw-export-svg': () => download(new Blob([pageSvg()], { type: 'image/svg+xml' }), fileBase() + '.svg'),
    'dw-export-xml': () => download(new Blob([toXml(S.doc)], { type: 'application/xml' }), 'drawings.xml'),
    'dw-import-xml': () => $('dw-import-file').click(),
    'dw-help': () => $('dw-help-dialog').showModal(),
    'dw-undo': () => undoRedo(S.undo, S.redo),
    'dw-redo': () => undoRedo(S.redo, S.undo),
    'dw-cut': () => copySelected(true),
    'dw-copy': () => copySelected(false),
    'dw-paste': () => paste(),
    'dw-delete': deleteSelected,
    'dw-select-all': () => select(page().shapes.map(s => s.id)),
    'dw-front': () => order(true),
    'dw-back': () => order(false),
    'dw-fit': fit,
    'dw-bold': () => toggleStyle('bold'), 'dw-italic': () => toggleStyle('italic'),
    'dw-underline': () => toggleStyle('underline'), 'dw-strike': () => toggleStyle('strike'),
    'dw-bullets': () => toggleStyle('bullets'),
    'dw-grow': () => fontSize(1), 'dw-shrink': () => fontSize(-1),
    'dw-indent-more': () => indent(1), 'dw-indent-less': () => indent(-1),
    'dw-rotate-text': () => { if (S.sel.length) change(() => { for (const s of selected()) s.style = { ...s.style, textRotate: (styleOf(s).textRotate + 90) % 360 }; }); },
    'dw-align-left': () => setStyle('align', 'left'), 'dw-align-center': () => setStyle('align', 'center'),
    'dw-align-right': () => setStyle('align', 'right'), 'dw-align-justify': () => setStyle('align', 'justify'),
    'dw-valign-top': () => setStyle('valign', 'top'), 'dw-valign-middle': () => setStyle('valign', 'middle'),
    'dw-valign-bottom': () => setStyle('valign', 'bottom'),
    'dw-shadow': () => toggleStyle('shadow'), 'dw-glow': () => toggleStyle('glow'),
    'dw-link': linkDialog,
    'dw-unlink': () => { const s = selected()[0]; if (s && s.link) change(() => { delete s.link; }); },
    'dw-open-link': () => { const s = selected()[0]; if (s && s.link) openLink(s.link); },
};

function wire() {
    for (const [id, action] of Object.entries(ACTIONS)) { const el = $(id); if (el) el.addEventListener('click', () => { closeMenus(); action(); }); }
    // menus
    const bar = $('dw-menubar');
    const closeMenus = () => { bar.classList.remove('open'); bar.querySelectorAll('.menu-list').forEach(l => { l.hidden = true; }); };
    window.closeDrawingMenus = closeMenus;
    bar.querySelectorAll('.menu-title').forEach(t => t.addEventListener('click', e => {
        const list = t.nextElementSibling, wasOpen = !list.hidden;
        closeMenus();
        if (!wasOpen) { list.hidden = false; bar.classList.add('open'); }
        e.stopPropagation();
    }));
    document.addEventListener('click', e => {
        if (!bar.contains(e.target)) closeMenus();
        if (!$('dw-dropdown').contains(e.target) && !e.target.closest('.dw-dd-btn')) closeDropdowns();
    });

    // ribbon
    $('dw-font').innerHTML = '<option value=""></option>' + FONTS.map(f => `<option style="font-family:'${f}'">${f}</option>`).join('');
    $('dw-size').innerHTML = '<option value=""></option>' + SIZES.map(v => `<option value="${v}">${v} pt</option>`).join('');
    $('dw-font').addEventListener('change', e => e.target.value && setStyle('font', e.target.value));
    $('dw-size').addEventListener('change', e => e.target.value && setStyle('size', Number(e.target.value)));
    $('dw-case').addEventListener('click', e => openDropdown(e.currentTarget,
        ['', 'upper', 'lower', 'title'].map(c => `<button type="button" class="dw-dd-item" data-value="${c || 'normal'}">${{ '': 'Normal', upper: 'UPPERCASE', lower: 'lowercase', title: 'Title Case' }[c]}</button>`).join(''),
        v => setStyle('case', v === 'normal' ? '' : v)));
    $('dw-color').addEventListener('click', () => { const c = common('color'); if (c || S.sel.length) setStyle('color', $('dw-color').dataset.last || '#c00000'); });
    $('dw-color-dd').addEventListener('click', e => openDropdown(e.currentTarget, palette(), v => { $('dw-color').dataset.last = v; setStyle('color', v); }));
    $('dw-fill').addEventListener('click', e => openDropdown(e.currentTarget, palette(null, 'No fill'), v => setStyle('fill', v)));
    $('dw-line').addEventListener('click', e => openDropdown(e.currentTarget, lineMenu(), applyLine));
    $('dw-effects').addEventListener('click', e => openDropdown(e.currentTarget,
        '<button type="button" class="dw-dd-item" data-value="shadow">Shadow on / off</button><button type="button" class="dw-dd-item" data-value="glow">Glow on / off</button><button type="button" class="dw-dd-item" data-value="none">No effects</button>',
        v => { if (v === 'none') change(() => { for (const s of selected()) s.style = { ...s.style, shadow: false, glow: false }; }); else toggleStyle(v); }));
    document.querySelectorAll('.dw-tool').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
    $('dw-shape-tool').addEventListener('click', () => setTool(S.shapeKind));
    $('dw-shape-dd').addEventListener('click', e => openDropdown(e.currentTarget,
        `<button type="button" class="dw-dd-item" data-value="rect">${ICON_RECT} Rectangle</button><button type="button" class="dw-dd-item" data-value="ellipse">${ICON_ELLIPSE} Ellipse</button><button type="button" class="dw-dd-item" data-value="line">${ICON_LINE} Line</button>`,
        v => setTool(v)));
    $('dw-snap').addEventListener('change', e => { S.snap = e.target.checked; });
    $('dw-page-size').innerHTML = Object.keys(PAGE_SIZES).map(k => `<option>${k}</option>`).join('');
    $('dw-page-size').addEventListener('change', e => { const [w, h] = PAGE_SIZES[e.target.value]; change(() => { page().width = w; page().height = h; }); fit(); });

    // canvas
    const svg = $('dw-svg');
    svg.addEventListener('pointerdown', onPointerDown);
    svg.addEventListener('pointermove', onPointerMove);
    svg.addEventListener('pointerup', onPointerUp);
    svg.addEventListener('contextmenu', e => { e.preventDefault(); contextMenu(e); });
    svg.addEventListener('wheel', e => {
        e.preventDefault();
        const r = svg.getBoundingClientRect();
        if (e.ctrlKey || e.metaKey) zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
        else { S.pan = { x: S.pan.x - (e.shiftKey ? e.deltaY : e.deltaX), y: S.pan.y - (e.shiftKey ? 0 : e.deltaY) }; render(); }
    }, { passive: false });
    $('dw-text').addEventListener('keydown', e => {
        if (e.key === 'Escape') { e.preventDefault(); finishText(); }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finishText(); }
        e.stopPropagation();
    });
    $('dw-text').addEventListener('blur', () => finishText());
    $('dw-tabs').addEventListener('click', e => {
        const t = e.target.closest('.dw-tab');
        if (!t) return;
        if (t.id === 'dw-page-add') ACTIONS['dw-page-new']();
        else if (t.dataset.page !== page().id) openPage(t.dataset.page);
    });
    $('dw-tabs').addEventListener('dblclick', e => { if (e.target.closest('.dw-tab[data-page]')) ACTIONS['dw-page-rename'](); });
    $('dw-import-file').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) importXml(f); });
    $('dw-text-dialog-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('dw-text-dialog').close('ok'); } });

    document.addEventListener('keydown', e => {
        if (e.key === ' ' && !e.target.closest('input, textarea, select')) { S.spaceDown = true; }
        if (document.querySelector('dialog[open]') || e.target.closest('input, textarea, select') || S.editing) return;
        const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
        const map = { z: 'dw-undo', y: 'dw-redo', c: 'dw-copy', x: 'dw-cut', v: 'dw-paste', a: 'dw-select-all', b: 'dw-bold', i: 'dw-italic', u: 'dw-underline' };
        if (ctrl && k === 'd') { e.preventDefault(); copySelected(false); paste(); return; }
        if (ctrl && map[k]) { e.preventDefault(); ACTIONS[map[k]](); return; }
        if (ctrl) return;
        const step = e.shiftKey ? 10 : 1;
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
        else if (e.key === 'Escape') { closeDropdowns(); setTool('pointer'); select([]); }
        else if (e.key === 'F2' && S.sel.length === 1) { e.preventDefault(); startText(S.sel[0]); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); nudge(-step, 0); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); nudge(step, 0); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); nudge(0, -step); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); nudge(0, step); }
        else if (S.sel.length === 1 && e.key.length === 1 && !e.altKey && !ONE_D.has(selected()[0].type)) {   // typing replaces the text, like Visio
            e.preventDefault();
            startText(S.sel[0]);
            $('dw-text').value = e.key;
        }
    });
    document.addEventListener('keyup', e => { if (e.key === ' ') S.spaceDown = false; });
    window.addEventListener('resize', () => render());
}

function contextMenu(evt) {
    const id = hitShape(evt.target);
    if (id && !S.sel.includes(id)) select([id]);
    const items = [];
    if (S.sel.length) {
        items.push(['Edit text', () => startText(S.sel[0]), S.sel.length !== 1], ['Cut', () => copySelected(true)], ['Copy', () => copySelected(false)]);
        if (S.clipboard) items.push(['Paste', () => paste()]);
        items.push(['Bring to front', () => order(true)], ['Send to back', () => order(false)]);
        if (S.store.models && S.sel.length === 1) {
            items.push(['Link to model object…', linkDialog]);
            if (selected()[0].link) items.push([`Open ${selected()[0].link}`, () => openLink(selected()[0].link)], ['Remove link', ACTIONS['dw-unlink']]);
        }
        items.push(['Delete', deleteSelected, false, 'danger']);
    } else {
        if (S.clipboard) items.push(['Paste', () => paste()]);
        items.push(['Select all', ACTIONS['dw-select-all']], ['Fit to window', fit]);
    }
    const menu = $('dw-menu');
    menu.innerHTML = items.map(([label, , disabled, cls], i) => `<button type="button" class="context-menu-item ${cls || ''}" data-i="${i}"${disabled ? ' disabled' : ''}>${esc(label)}</button>`).join('');
    menu.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { menu.hidden = true; items[+b.dataset.i][1](); }));
    const host = $('dw-canvas').getBoundingClientRect();
    menu.style.left = evt.clientX - host.left + 'px';
    menu.style.top = evt.clientY - host.top + 'px';
    menu.hidden = false;
    const hide = e => { if (!menu.contains(e.target)) { menu.hidden = true; document.removeEventListener('pointerdown', hide, true); } };
    document.addEventListener('pointerdown', hide, true);
}

async function init(store) {
    S.store = store || serverStore;
    let text = null;
    try { text = await S.store.load(); } catch (e) { status(e.message, true); }
    try { S.doc = text ? parseXml(text) : emptyDoc(); }
    catch (e) { alert(`The stored drawings can't be read (${e.message}); starting empty -- nothing is overwritten until you change something.`); S.doc = emptyDoc(); }
    let saved = null;
    try { saved = localStorage.getItem(KEY_PAGE); } catch (e) { /* private window */ }
    S.pageId = S.doc.pages.some(p => p.id === saved) ? saved : S.doc.pages[0].id;
    document.querySelectorAll('.dw-model-only').forEach(el => { el.hidden = !S.store.models; });
    wire();
    await loadObjects();
    setTool('pointer');
    requestAnimationFrame(fit);                // after the page layout has settled
    status('');
}

const serverStore = {
    models: true,
    async load() {
        const r = await fetch('/api/drawings', { cache: 'no-store' });
        if (!r.ok) throw new Error(`Loading failed (${r.status})`);
        return r.text();
    },
    async save(xml) {
        const r = await fetch('/api/drawings', { method: 'PUT', headers: { 'Content-Type': 'application/xml' }, body: xml });
        if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.detail || `Saving failed (${r.status})`); }
    },
};

window.Drawing = { init, parseXml, toXml, checkDoc, connectorPoints, pageSvg, state: S, get page() { return page(); },
                   setTool, select, startText, finishText };
})();
