// Drawing tab (SFM-218) -- also the whole of the standalone "Drawing" (scripts/build_standalone_drawing.py).
// A small Visio: rectangles, ellipses, lines, text boxes and connectors glued to shapes (they follow when a
// shape moves), connection points, text formatting and shape styles from a ribbon, several pages, undo,
// copy / paste, PNG / SVG / XML export. In the workbench a shape can be linked to a model object.
// Since SFM-306..313 (from the Manual FTA): Alt+drag moves a shape with its branch, *Arrange as tree*, notes attached to a
// shape (`attach`), a Grid view, search across all pages, revisions (store.versions / saveVersion / version), pages in a
// tree (`parent`), and in the standalone a folder on this computer (store.chooseFolder, standalone/drawing_local.js).
// Pictures (SFM-291): pasted from the clipboard (Ctrl+V) or, in the workbench, a fault tree page of the app
// (Insert > Fault tree...); each picture is kept once in the document (doc.images, <images> in the XML) and the
// picture shapes point to it -- so undo snapshots, copies and duplicated pages don't copy the picture data.
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
const SHAPE_TYPES = ['rect', 'ellipse', 'line', 'text', 'connector', 'image', 'person'];
const DRAW_KINDS = ['rect', 'ellipse', 'line', 'person'];       // the shape button's choices (person: SFM-336)
// a picture as stored: PNG, JPEG, GIF or WebP as a base64 data URI -- nothing that can run code (no SVG)
const IMG_RE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const IMG_KEEP = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const IMG_MAX_SIDE = 4000, IMG_MAX_BYTES = 8000000;      // larger pictures are redrawn smaller
const COPY_MARK = 'safety-model-drawing-shapes';           // on the clipboard when shapes were copied (Ctrl+C / X)
// A connector end glued onto a shape's outline sits on a raster: twelfths of the side (halves, thirds, quarters,
// sixths -- equal distances for 1, 2, 3, 4 or 6 connectors). Stored as fromAt / toAt = "<side t|r|b|l>:<fraction>".
const RASTER = 12;
const AT_RE = /^[trbl]:(0|1|0?\.\d+|1\.0+)$/;
const SIDE_DIR = { t: [0, -1], r: [1, 0], b: [0, 1], l: [-1, 0] };
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
    image: { fill: 'none', line: 'none' },
};

// ---- document <-> XML ------------------------------------------------------------------------

function emptyDoc() { return { pages: [{ id: 'P1', name: 'Page 1', width: 1123, height: 794, shapes: [] }], images: {} }; }

function styleOf(shape) { return { ...BASE_STYLE, ...DEFAULTS[shape.type], ...shape.style }; }

function parseXml(text) {
    const xml = new DOMParser().parseFromString(text, 'application/xml');
    if (xml.getElementsByTagName('parsererror').length) throw new Error('Not valid XML.');
    const root = xml.documentElement;
    if (root.tagName !== 'drawings' || root.getAttribute('format') !== FORMAT)
        throw new Error(`Not a drawing file (expected <drawings format="${FORMAT}">).`);
    const doc = { pages: [], images: {} };
    const num = (el, a) => (el.hasAttribute(a) ? Number(el.getAttribute(a)) : undefined);
    for (const p of root.children) {
        if (p.tagName === 'images') {
            for (const im of p.children) if (im.tagName === 'image')
                doc.images[im.getAttribute('id') || ''] = { src: im.textContent.trim(), name: im.getAttribute('name') || '' };
            continue;
        }
        if (p.tagName !== 'drawing') continue;
        const page = { id: p.getAttribute('id') || '', name: p.getAttribute('name') || '',
                       width: num(p, 'width'), height: num(p, 'height'), shapes: [] };
        if (p.getAttribute('parent')) page.parent = p.getAttribute('parent');          // SFM-313
        for (const el of p.children) {
            if (el.tagName !== 'shape') continue;
            const s = { id: el.getAttribute('id') || '', type: el.getAttribute('type') || '', style: {}, cps: [] };
            for (const a of ['x', 'y', 'w', 'h', 'x1', 'y1', 'x2', 'y2', 'fromPt', 'toPt', 'midX', 'midY']) if (el.hasAttribute(a)) s[a] = num(el, a);
            for (const a of ['from', 'to', 'fromAt', 'toAt', 'route', 'link', 'img', 'attach']) if (el.getAttribute(a)) s[a] = el.getAttribute(a);
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
        const head = `  <drawing id="${xmlEsc(p.id)}" name="${xmlEsc(p.name)}" width="${r1(p.width)}" height="${r1(p.height)}"`
            + (p.parent ? ` parent="${xmlEsc(p.parent)}"` : '');
        if (!p.shapes.length) { out.push(head + '/>'); continue; }
        out.push(head + '>');
        for (const s of p.shapes) {
            let attrs = `id="${xmlEsc(s.id)}" type="${s.type}"`;
            for (const a of ['x', 'y', 'w', 'h', 'x1', 'y1', 'x2', 'y2', 'midX', 'midY']) if (s[a] !== undefined) attrs += ` ${a}="${r1(s[a])}"`;
            for (const a of ['from', 'fromPt', 'fromAt', 'to', 'toPt', 'toAt', 'route', 'link', 'img', 'attach']) if (s[a] !== undefined && s[a] !== '' && s[a] !== null) attrs += ` ${a}="${xmlEsc(s[a])}"`;
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
    // the pictures the shapes show -- only those still used (undo may have dropped a shape, its picture stays in memory)
    const used = new Set(doc.pages.flatMap(p => p.shapes.filter(s => s.type === 'image').map(s => s.img)));
    const images = Object.entries(doc.images || {}).filter(([id]) => used.has(id));
    if (images.length) {
        out.push('  <images>');
        for (const [id, im] of images) out.push(`    <image id="${xmlEsc(id)}"${im.name ? ` name="${xmlEsc(im.name)}"` : ''}>${im.src}</image>`);
        out.push('  </images>');
    }
    out.push('</drawings>', '');
    return out.join('\n');
}

// The same rules as app/services/drawings.py :: check().
function checkDoc(doc) {
    if (!doc.pages.length) throw new Error('The file has no drawing page.');
    const images = doc.images || {};
    for (const [id, im] of Object.entries(images)) {
        if (!ID_RE.test(id)) throw new Error(`Picture id "${id}" is invalid.`);
        if (!IMG_RE.test(im.src)) throw new Error(`Picture ${id} is not a PNG, JPEG, GIF or WebP picture.`);
    }
    const pageIds = new Set();
    for (const p of doc.pages) {
        if (!ID_RE.test(p.id) || pageIds.has(p.id)) throw new Error(`Page id "${p.id}" is missing, invalid or used twice.`);
        pageIds.add(p.id);
        if (!p.name.trim()) throw new Error(`Page ${p.id} has no name.`);
        for (const v of [p.width, p.height]) if (!Number.isFinite(v) || v < 50 || v > 20000) throw new Error(`Page "${p.name}": the size must be 50 to 20000.`);
        const byId = new Map();
        for (const s of p.shapes) {
            if (!ID_RE.test(s.id) || byId.has(s.id)) throw new Error(`Page "${p.name}": shape id "${s.id}" is invalid or used twice.`);
            if (!SHAPE_TYPES.includes(s.type)) throw new Error(`Page "${p.name}": ${s.id} has an unknown type "${s.type}".`);
            for (const a of ['x', 'y', 'w', 'h', 'x1', 'y1', 'x2', 'y2', 'fromPt', 'toPt', 'midX', 'midY'])
                if (s[a] !== undefined && !Number.isFinite(s[a])) throw new Error(`Page "${p.name}": ${s.id} ${a} is not a number.`);
            const needed = ONE_D.has(s.type) ? ['x1', 'y1', 'x2', 'y2'] : ['x', 'y', 'w', 'h'];
            const missing = needed.filter(a => s[a] === undefined);
            if (missing.length) throw new Error(`Page "${p.name}": ${s.id} has no ${missing.join(', ')}.`);
            if (s.type === 'image' && !Object.prototype.hasOwnProperty.call(images, s.img || ''))
                throw new Error(`Page "${p.name}": ${s.id} shows picture "${s.img || ''}", which is not in the file.`);
            byId.set(s.id, s);
        }
        for (const s of p.shapes) for (const end of ['from', 'to']) {
            if (s[end + 'At'] !== undefined && !AT_RE.test(s[end + 'At'])) throw new Error(`Page "${p.name}": ${s.id} ${end}At "${s[end + 'At']}" is not a place on a shape's side.`);
            const g = s[end];
            if (g && (!byId.has(g) || g === s.id || ONE_D.has(byId.get(g).type)))
                throw new Error(`Page "${p.name}": ${s.id} is glued to ${g}, which is not a shape on this page.`);
        }
        for (const s of p.shapes) if (s.attach) {          // a note (SFM-311): on a shape of this page that is no note itself
            const a = byId.get(s.attach);
            if (ONE_D.has(s.type) || !a || a.id === s.id || ONE_D.has(a.type) || a.attach)
                throw new Error(`Page "${p.name}": ${s.id} is a note of ${s.attach}, which is not a shape on this page.`);
        }
    }
    // pages in a tree (SFM-313): the parent is another page, and no page lies below itself
    const parentOf = new Map(doc.pages.map(p => [p.id, p.parent || '']));
    for (const p of doc.pages) {
        if (!p.parent) continue;
        if (!pageIds.has(p.parent) || p.parent === p.id) throw new Error(`Page "${p.name}" lies below page "${p.parent}", which is not in the file.`);
        for (let at = p.parent, n = 0; at; at = parentOf.get(at), n++)
            if (at === p.id || n > doc.pages.length) throw new Error(`Page "${p.name}" lies below itself.`);
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

// The point at `at` ("r:0.25") on the shape's outline: on the rectangle's side; for an ellipse the point of the
// ellipse in the direction of that side point (seen from the centre), so the raster follows the outline.
function outlinePoint(s, at) {
    const [side, frac] = at.split(':');
    let f = Number(frac);
    const k = Math.round(f * RASTER);
    if (Math.abs(f * RASTER - k) < 0.01) f = k / RASTER;      // "0.3333" is exactly 4/12: equal distances stay exact
    let x = side === 'l' ? s.x : side === 'r' ? s.x + s.w : s.x + f * s.w;
    let y = side === 't' ? s.y : side === 'b' ? s.y + s.h : s.y + f * s.h;
    if (s.type === 'ellipse') {
        const cx = s.x + s.w / 2, cy = s.y + s.h / 2, a = s.w / 2 || 1, b = s.h / 2 || 1;
        const nx = (x - cx) / a, ny = (y - cy) / b, r = Math.hypot(nx, ny) || 1;
        x = cx + a * nx / r; y = cy + b * ny / r;
    }
    const [dx, dy] = SIDE_DIR[side] || [0, 0];
    return { x, y, dx, dy };
}

// The raster place on the shape's outline nearest to `pt`, if `pt` is within `band` of the outline.
function outlineHit(s, pt, band) {
    let side, f;
    if (s.type === 'ellipse') {
        const cx = s.x + s.w / 2, cy = s.y + s.h / 2, a = s.w / 2 || 1, b = s.h / 2 || 1;
        const nx = (pt.x - cx) / a, ny = (pt.y - cy) / b, r = Math.hypot(nx, ny);
        if (!r || Math.hypot(pt.x - (cx + a * nx / r), pt.y - (cy + b * ny / r)) > band) return null;
        if (Math.abs(nx) >= Math.abs(ny)) { side = nx > 0 ? 'r' : 'l'; f = (1 + ny / Math.abs(nx)) / 2; }
        else { side = ny > 0 ? 'b' : 't'; f = (1 + nx / Math.abs(ny)) / 2; }
    } else {
        const inX = pt.x >= s.x - band && pt.x <= s.x + s.w + band, inY = pt.y >= s.y - band && pt.y <= s.y + s.h + band;
        const cands = [];
        if (inX) cands.push(['t', Math.abs(pt.y - s.y), (pt.x - s.x) / s.w], ['b', Math.abs(pt.y - s.y - s.h), (pt.x - s.x) / s.w]);
        if (inY) cands.push(['l', Math.abs(pt.x - s.x), (pt.y - s.y) / s.h], ['r', Math.abs(pt.x - s.x - s.w), (pt.y - s.y) / s.h]);
        const best = cands.filter(c => c[1] <= band).sort((p, q) => p[1] - q[1])[0];
        if (!best) return null;
        [side, , f] = best;
    }
    const k = Math.max(1, Math.min(RASTER - 1, Math.round(f * RASTER)));
    const at = `${side}:${(k / RASTER).toFixed(4)}`;
    return { at, ...outlinePoint(s, at) };
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
    const end = (s, at, pt, toward) => (at && AT_RE.test(at) ? outlinePoint(s, at) : gluePoint(s, pt ?? -1, toward));
    let p1 = { x: c.x1, y: c.y1, dx: 0, dy: 0 }, p2 = { x: c.x2, y: c.y2, dx: 0, dy: 0 };
    if (a) p1 = end(a, c.fromAt, c.fromPt, b ? centre(b) : p2);
    if (b) p2 = end(b, c.toAt, c.toPt, a ? centre(a) : p1);
    if (a && !c.fromAt && (c.fromPt ?? -1) < 0) p1 = gluePoint(a, -1, p2);
    c.x1 = p1.x; c.y1 = p1.y; c.x2 = p2.x; c.y2 = p2.y;
    return [p1, p2];
}

function freeDir(p, other) {
    const dx = other.x - p.x, dy = other.y - p.y;
    return Math.abs(dx) >= Math.abs(dy) ? [Math.sign(dx) || 1, 0] : [0, Math.sign(dy) || 1];
}

// The connector's path: right angles (Visio's default) or straight.
// Right angles (SFM-337, user 2026-11-17: "when using right angles for arrows make sure multiple arrows dont overlap,
// let me move the right angles manually if required"): a connector with `midX` / `midY` runs its middle line there
// (moved by hand: drag a line of the selected arrow); without, the route is chosen automatically and the middle
// lines of automatic arrows that would lie on each other (same direction, within SPREAD_TOL, overlapping) are put
// SPREAD_GAP apart, centred on where they were (spreadOf(), worked out once per drawing of the page).
const SPREAD_TOL = 6, SPREAD_GAP = 12;
let routeVersion = 0;                        // render() counts up: the spread is worked out again
const spreadMemo = new Map();                // page id -> {ver, at: Map(connector id -> coordinate)}

function connectorPoints(page, c) {
    if (c.type === 'line' || c.route === 'straight') return resolveEnds(page, c);
    const r = orthoRoute(page, c);
    if (c.midX === undefined && c.midY === undefined && r.mid) {
        const at = spreadOf(page).get(c.id);
        if (at !== undefined && Math.abs(at - r.mid.at) > 0.01) return cleanPath(zRoute(r, r.mid.axis, at));
    }
    return cleanPath(r.pts);
}

// The route of an orthogonal connector before the spread: {pts, mid: {axis 'x' | 'y', at, lo, hi} | null (the
// middle line of a Z shape), p1, p2, a, b}
function orthoRoute(page, c) {
    const [p1, p2] = resolveEnds(page, c);
    const [d1x, d1y] = p1.dx || p1.dy ? [p1.dx, p1.dy] : freeDir(p1, p2);
    const [d2x, d2y] = p2.dx || p2.dy ? [p2.dx, p2.dy] : freeDir(p2, p1);
    const stub = 15;
    const a = { x: p1.x + d1x * stub, y: p1.y + d1y * stub }, b = { x: p2.x + d2x * stub, y: p2.y + d2y * stub };
    // the L and Z shapes between the two stubs; the one that doesn't cut through the connected shapes, doesn't
    // turn back against an end's direction, and is the shortest with the fewest bends wins
    const boxes = [c.from, c.to].map(id => id && page.shapes.find(x => x.id === id)).filter(Boolean)
        .map(x => ({ x1: x.x + 1, y1: x.y + 1, x2: x.x + x.w - 1, y2: x.y + x.h - 1 }));
    const cuts = (u, v) => boxes.some(bx => (Math.abs(u.y - v.y) < 0.01
        ? u.y > bx.y1 && u.y < bx.y2 && Math.max(u.x, v.x) > bx.x1 && Math.min(u.x, v.x) < bx.x2
        : u.x > bx.x1 && u.x < bx.x2 && Math.max(u.y, v.y) > bx.y1 && Math.min(u.y, v.y) < bx.y2));
    const r = { p1, p2, a, b };
    if (c.midX !== undefined) return { ...r, pts: zRoute(r, 'x', c.midX), mid: null };
    if (c.midY !== undefined) return { ...r, pts: zRoute(r, 'y', c.midY), mid: null };
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    let best = null, bestScore = Infinity;
    for (const mid of [[{ x: b.x, y: a.y }], [{ x: a.x, y: b.y }], [{ x: mx, y: a.y }, { x: mx, y: b.y }], [{ x: a.x, y: my }, { x: b.x, y: my }]]) {
        const path = [a, ...mid, b];
        let score = mid.length * 20;
        for (let i = 1; i < path.length; i++) {
            score += Math.abs(path[i].x - path[i - 1].x) + Math.abs(path[i].y - path[i - 1].y);
            if (cuts(path[i - 1], path[i])) score += 10000;
        }
        if ((path[1].x - a.x) * d1x + (path[1].y - a.y) * d1y < -0.01) score += 5000;           // back into its shape
        const last = path[path.length - 2];
        if ((b.x - last.x) * d2x + (b.y - last.y) * d2y > 0.01) score += 5000;                  // arrives from inside
        if (score < bestScore) { bestScore = score; best = path; }
    }
    let mid = null;
    if (best.length === 4) {
        const [m1, m2] = [best[1], best[2]];
        mid = Math.abs(m1.x - m2.x) < 0.01 ? { axis: 'x', at: m1.x, lo: Math.min(m1.y, m2.y), hi: Math.max(m1.y, m2.y) }
                                           : { axis: 'y', at: m1.y, lo: Math.min(m1.x, m2.x), hi: Math.max(m1.x, m2.x) };
        if (mid.hi - mid.lo < 0.01) mid = null;
    } else if (best.length === 3) {          // an L: its vertical line (at a.x or b.x) is the one that can move
        const c1 = best[1];
        mid = { axis: 'x', at: c1.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) };
        if (mid.hi - mid.lo < 0.01) mid = null;
    }
    return { ...r, pts: [p1, ...best, p2], mid };
}

function zRoute(r, axis, at) {
    const { p1, p2, a, b } = r;
    return axis === 'x' ? [p1, a, { x: at, y: a.y }, { x: at, y: b.y }, b, p2] : [p1, a, { x: a.x, y: at }, { x: b.x, y: at }, b, p2];
}

// drop zero-length and straight-through points
function cleanPath(pts) {
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

// Middle lines of automatic arrows that lie on each other, spread apart (see connectorPoints)
function spreadOf(page) {
    const memo = spreadMemo.get(page.id);
    if (memo && memo.ver === routeVersion) return memo.at;
    const segs = [];
    for (const c of page.shapes) {
        if (c.type !== 'connector' || c.route === 'straight' || c.midX !== undefined || c.midY !== undefined) continue;
        const r = orthoRoute(page, c);
        if (r.mid) segs.push({ id: c.id, ...r.mid });
    }
    const groups = [];
    for (const g of segs.sort((u, v) => u.at - v.at || u.lo - v.lo || (u.id < v.id ? -1 : 1))) {
        const near = groups.find(gr => gr.some(o => o.axis === g.axis && Math.abs(o.at - g.at) < SPREAD_TOL && o.lo < g.hi - 0.5 && g.lo < o.hi - 0.5));
        if (near) near.push(g); else groups.push([g]);
    }
    const at = new Map();
    for (const gr of groups) {
        if (gr.length < 2) continue;
        const centre = gr.reduce((t, g) => t + g.at, 0) / gr.length;
        gr.sort((u, v) => u.lo - v.lo || u.hi - v.hi || (u.id < v.id ? -1 : 1));
        gr.forEach((g, i) => at.set(g.id, centre + (i - (gr.length - 1) / 2) * SPREAD_GAP));
    }
    spreadMemo.set(page.id, { ver: routeVersion, at });
    return at;
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

// A picture's address: the data URI itself in an export (`embed`); in the editor a blob: URL made from it once --
// a data URI of megabytes in every redraw would make dragging slow.
const IMG_URLS = new Map();
const HIT_PX = 16;           // screen px: width of the invisible grab band along lines and outlines (SFM-293)
const HANDLE_HIT_PX = 20;    // screen px: grab area of a resize / end handle
function imageHref(id, embed) {
    const im = S.doc.images[id];
    if (!im) return '';
    if (embed) return im.src;
    let u = IMG_URLS.get(id);
    if (!u || u.src !== im.src) {
        const comma = im.src.indexOf(','), bin = atob(im.src.slice(comma + 1)), bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        if (u) URL.revokeObjectURL(u.url);
        u = { src: im.src, url: URL.createObjectURL(new Blob([bytes], { type: im.src.slice(5, im.src.indexOf(';')) })) };
        IMG_URLS.set(id, u);
    }
    return u.url;
}

// One shape as SVG markup (also used for the PNG / SVG export -- `embed`: pictures as data URIs --, so no
// editor-only parts here).
// A person (SFM-336, user 2026-11-17: "a user shape (just little person made out of lines)"): a stick figure in the
// shape's box -- head (filled with the fill colour), body, arms, legs in the line colour and width.
function personSvg(s, stroke, fill, sw, dash) {
    const r = Math.max(2, Math.min(s.w * 0.3, s.h * 0.13));
    const cx = s.x + s.w / 2, neck = s.y + 2 * r, hip = s.y + s.h * 0.62, arms = neck + (hip - neck) * 0.3;
    const line = `stroke="${esc(stroke)}" stroke-width="${Math.max(sw, 1)}"${dash} stroke-linecap="round" fill="none"`;
    return `<circle cx="${r1(cx)}" cy="${r1(s.y + r)}" r="${r1(r)}" fill="${fill === 'none' ? 'none' : esc(fill)}" stroke="${esc(stroke)}" stroke-width="${Math.max(sw, 1)}"${dash}/>`
        + `<path d="M${r1(cx)},${r1(neck)} L${r1(cx)},${r1(hip)} M${r1(s.x)},${r1(arms)} L${r1(s.x + s.w)},${r1(arms)}`
        + ` M${r1(cx)},${r1(hip)} L${r1(s.x + s.w * 0.1)},${r1(s.y + s.h)} M${r1(cx)},${r1(hip)} L${r1(s.x + s.w * 0.9)},${r1(s.y + s.h)}" ${line}/>`;
}

function shapeSvg(page, s, embed) {
    const st = styleOf(s);
    const stroke = st.line === 'none' ? 'none' : st.line;
    const sw = st.lineWidth * PT;
    const dash = DASHES[st.dash] ? ` stroke-dasharray="${DASHES[st.dash].split(' ').map(v => v * Math.max(1, sw)).join(' ')}"` : '';
    const filter = st.shadow ? ' filter="url(#dw-shadow)"' : st.glow ? ' filter="url(#dw-glow)"' : '';
    const common = `fill="${st.fill === 'none' ? 'none' : esc(st.fill)}" stroke="${esc(stroke)}" stroke-width="${sw}"${dash}`;
    let geo = '';
    if (s.type === 'rect' || s.type === 'text') {
        geo = `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="${st.radius}" ${common}/>`;
    } else if (s.type === 'image') {
        const href = imageHref(s.img, embed);
        geo = href ? `<image href="${esc(href)}" x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" preserveAspectRatio="none"/>`
                   : `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="#f3f4f6" stroke="#dc2626"/>`;
        if (st.line !== 'none') geo += `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="none" stroke="${esc(stroke)}" stroke-width="${sw}"${dash}/>`;
        const name = !embed && S.doc.images[s.img] && S.doc.images[s.img].name;
        if (name) geo += `<title>${esc(name)}</title>`;
    } else if (s.type === 'ellipse') {
        geo = `<ellipse cx="${s.x + s.w / 2}" cy="${s.y + s.h / 2}" rx="${s.w / 2}" ry="${s.h / 2}" ${common}/>`;
    } else if (s.type === 'person') {
        geo = personSvg(s, stroke === 'none' ? '#000000' : stroke, st.fill, sw, dash);
    } else {
        const pts = connectorPoints(page, s);
        const d = pts.map((p, i) => `${i ? 'L' : 'M'}${r1(p.x)},${r1(p.y)}`).join(' ');
        const markers = (st.arrowEnd ? ' marker-end="url(#dw-arrow-end)"' : '') + (st.arrowStart ? ' marker-start="url(#dw-arrow-start)"' : '');
        geo = `<path d="${d}" fill="none" stroke="${esc(stroke === 'none' ? '#000000' : stroke)}" stroke-width="${sw}"${dash}${markers} stroke-linejoin="round"/>`;
    }
    // in the editor only: an invisible band of HIT_PX screen pixels along the line / outline, so a thin arrow or
    // border need not be hit exactly to select, drag or resize the shape (SFM-293)
    if (!embed) {
        const hw = Math.max(sw, HIT_PX / S.zoom);
        const band = `fill="none" stroke="transparent" stroke-width="${hw}" pointer-events="stroke"`;
        if (ONE_D.has(s.type)) geo += `<path class="dw-hit" d="${geo.match(/ d="([^"]*)"/)[1]}" ${band} stroke-linejoin="round" stroke-linecap="round"/>`;
        else if (s.type === 'ellipse') geo += `<ellipse class="dw-hit" cx="${s.x + s.w / 2}" cy="${s.y + s.h / 2}" rx="${s.w / 2}" ry="${s.h / 2}" ${band}/>`;
        else geo += `<rect class="dw-hit" x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" ${band}/>`;
    }
    let text = '';
    if (s.text && s.type === 'person') {           // SFM-336: the name below the figure
        const { css, body } = textHtml(s, st);
        const bw = Math.max(s.w, 160);
        text = `<foreignObject x="${s.x + (s.w - bw) / 2}" y="${s.y + s.h}" width="${bw}" height="40" style="overflow:visible;">`
            + `<div xmlns="http://www.w3.org/1999/xhtml" style="box-sizing:border-box;width:${bw}px;padding:2px 4px;text-align:center;overflow:visible;${css}">${body}</div></foreignObject>`;
    } else if (s.text && !ONE_D.has(s.type)) {
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
            objects: null, snap: true, grid: false, search: null, collapsed: new Set(), pagesPanel: true, dragPage: null };

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
    S.saveTimer = setTimeout(saveNow, 300);
}

function saveNow() {
    clearTimeout(S.saveTimer);
    S.saveTimer = null;
    const xml = toXml(S.doc);
    S.saving = S.saving.then(() => S.store.save(xml)).then(() => { status('Saved'); updateFolderUi(); schedulePictures(); })
        .catch(e => { status(e.message, true); alert(e.message); });
    return S.saving;
}

// SFM-335: after a save the server says which pages have no current picture (GET /api/drawings/pictures/stale);
// each is drawn here as PNG (the same drawing as Export PNG) and stored for the LaTeX documents' Drawing block.
// Only with a store that keeps pictures (the workbench); a second save meanwhile starts it again.
function pagePng(p, scale = Math.max(1, Math.min(2, 4000 / Math.max(p.width, p.height)))) {
    const svg = pageSvg(null, p);
    return new Promise((ok, fail) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(p.width * scale); canvas.height = Math.round(p.height * scale);
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            canvas.toBlob(b => b ? ok(b) : fail(new Error('no PNG')), 'image/png');
        };
        img.onerror = () => fail(new Error('the page could not be drawn'));
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
}

let pictureRun = Promise.resolve(), pictureTimer = null;
function schedulePictures() {
    if (!S.store.pictures) return;
    clearTimeout(pictureTimer);
    pictureTimer = setTimeout(() => { pictureRun = pictureRun.then(updatePictures).catch(() => {}); }, 1500);
}
async function updatePictures() {
    const stale = await S.store.stalePictures();
    for (const id of stale) {
        const p = S.doc.pages.find(x => x.id === id);
        if (!p) continue;
        try { await S.store.savePicture(id, await pagePng(p)); }
        catch (e) { status(`The picture of page "${p.name}" for the documents was not stored: ${e.message}`, true); }
    }
}

async function flushSave() {                // a change still waiting for its save is written now
    if (S.saveTimer) saveNow();
    await S.saving;
}

// The pictures are not in the snapshot: they never change, and the shapes only point to them (doc.images).
function snapshot() { return { doc: JSON.stringify({ pages: S.doc.pages }), pageId: S.pageId }; }
function restoreDoc(json) { S.doc = { ...JSON.parse(json), images: S.doc.images }; }

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
    restoreDoc(step.doc);
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
    routeVersion += 1;                       // the arrows' spread is worked out again (SFM-337)
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
    renderPages();
    if (S.grid && !$('dw-gridview').contains(document.activeElement)) renderGrid();
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
    const showPoints = S.tool === 'connector' || S.tool === 'cpoint' || (S.drag && S.drag.mode === 'end');
    // the raster on the outline of the shape under the mouse, the place the end would glue to highlighted
    const hover = S.drag && S.drag.mode === 'end' ? S.drag.hover : (S.tool === 'connector' ? S.hover : null);
    const hs = hover && shape(hover.id);
    if (hs && !ONE_D.has(hs.type)) {
        for (const side of 'trbl') for (let k = 1; k < RASTER; k++) {
            const q = outlinePoint(hs, `${side}:${(k / RASTER).toFixed(4)}`);
            out.push(`<circle class="dw-raster" cx="${q.x}" cy="${q.y}" r="${(k % 6 === 0 ? 3.6 : k % 3 === 0 ? 3 : 2.3) / z}" fill="#2563eb" stroke="#fff" stroke-width="${0.8 / z}" opacity="0.9" pointer-events="none"/>`);
        }
        if (hover.x !== undefined) out.push(`<circle class="dw-raster-hit" cx="${hover.x}" cy="${hover.y}" r="${5 / z}" fill="none" stroke="#16a34a" stroke-width="${2 / z}" pointer-events="none"/>`);
    }
    if (showPoints) for (const s of p.shapes) if (!ONE_D.has(s.type))
        for (const [i, c] of connectionPoints(s).entries()) if (i >= 4 || S.tool === 'cpoint')
            out.push(`<g class="dw-cp${i >= 4 ? ' own' : ''}" data-id="${esc(s.id)}" data-pt="${i}"><path d="M${c.x - 4 / z},${c.y - 4 / z} L${c.x + 4 / z},${c.y + 4 / z} M${c.x - 4 / z},${c.y + 4 / z} L${c.x + 4 / z},${c.y - 4 / z}" stroke="#2563eb" stroke-width="${1.5 / z}"/><circle cx="${c.x}" cy="${c.y}" r="${6 / z}" fill="transparent"/></g>`);
    for (const s of selected()) {
        if (ONE_D.has(s.type)) {
            const glued = [s.from, s.to];
            [[s.x1, s.y1], [s.x2, s.y2]].forEach(([x, y], i) => out.push(
                `<g class="dw-handle end" data-end="${i}"><rect x="${x - 5 / z}" y="${y - 5 / z}" width="${10 / z}" height="${10 / z}" fill="${glued[i] ? '#16a34a' : '#fff'}" stroke="#1d4ed8" stroke-width="${1 / z}"/>${handleHit(x, y, z)}</g>`));
            // SFM-337: a right-angle arrow's lines (not those at its ends) can be dragged sideways
            if (S.sel.length === 1 && s.type === 'connector' && s.route !== 'straight') {
                const pts = connectorPoints(p, s);
                for (let i = 1; i < pts.length - 2; i++) {
                    const u = pts[i], v = pts[i + 1], vertical = Math.abs(u.x - v.x) < 0.01;
                    if (Math.hypot(v.x - u.x, v.y - u.y) < 16 / z) continue;
                    const cx = (u.x + v.x) / 2, cy = (u.y + v.y) / 2;
                    out.push(`<g class="dw-handle bend" data-bend="${vertical ? 'x' : 'y'}" style="cursor:${vertical ? 'ew' : 'ns'}-resize"><title>Drag to move this line of the arrow (right-click: automatic right angles)</title>`
                        + `<rect x="${cx - (vertical ? 3 : 7) / z}" y="${cy - (vertical ? 7 : 3) / z}" width="${(vertical ? 6 : 14) / z}" height="${(vertical ? 14 : 6) / z}" rx="${2 / z}" fill="#fde68a" stroke="#b45309" stroke-width="${1 / z}"/>${handleHit(cx, cy, z)}</g>`);
                }
            }
        } else {
            out.push(`<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="none" stroke="#1d4ed8" stroke-width="${1 / z}" stroke-dasharray="${4 / z} ${3 / z}" pointer-events="none"/>`);
            if (S.sel.length === 1) for (const [h, fx, fy] of HANDLES)
                out.push(`<g class="dw-handle" data-handle="${h}" style="cursor:${h}-resize"><rect x="${s.x + fx * s.w - 4.5 / z}" y="${s.y + fy * s.h - 4.5 / z}" width="${9 / z}" height="${9 / z}" fill="#fff" stroke="#1d4ed8" stroke-width="${1 / z}"/>${handleHit(s.x + fx * s.w, s.y + fy * s.h, z)}</g>`);
        }
    }
    // a selected note: a dashed line to its shape (SFM-311)
    for (const s of selected()) {
        const a = s.attach && shape(s.attach);
        if (a) out.push(`<path class="dw-note-leader" d="M${s.x + s.w / 2},${s.y + s.h / 2} L${a.x + a.w / 2},${a.y + a.h / 2}" stroke="#d4b106" stroke-width="${1.2 / z}" stroke-dasharray="${4 / z} ${3 / z}" fill="none" pointer-events="none"/>`);
    }
    // search matches on this page (SFM-309): framed in amber, the current one thicker
    if (S.search) S.search.hits.forEach((h, i) => {
        if (h.page !== p.id) return;
        const t = shape(h.id);
        if (!t) return;
        const b = bbox(p, t), pad = 4 / z;
        out.push(`<rect class="dw-search-hit${i === S.search.i ? ' current' : ''}" x="${b.x - pad}" y="${b.y - pad}" width="${b.w + 2 * pad}" height="${b.h + 2 * pad}" fill="none" stroke="#f59e0b" stroke-width="${(i === S.search.i ? 3 : 1.5) / z}" pointer-events="none"/>`);
    });
    // link badges over the handles: the top-right handle's grab area must not cover the badge (SFM-293)
    for (const s of p.shapes) out.push(linkBadge(s));
    if (S.drag && S.drag.mode === 'marquee') {
        const m = S.drag.rect;
        out.push(`<rect x="${m.x}" y="${m.y}" width="${m.w}" height="${m.h}" fill="rgba(37,99,235,.08)" stroke="#2563eb" stroke-width="${1 / z}" stroke-dasharray="${3 / z}"/>`);
    }
    return out.join('');
}

// a handle's grab area: HANDLE_HIT_PX screen pixels square around it, larger than the drawn square (SFM-293)
function handleHit(x, y, z) {
    const r = HANDLE_HIT_PX / 2 / z;
    return `<rect class="dw-hit" x="${x - r}" y="${y - r}" width="${2 * r}" height="${2 * r}" fill="transparent"/>`;
}

const HANDLES = [['nw', 0, 0], ['n', 0.5, 0], ['ne', 1, 0], ['e', 1, 0.5], ['se', 1, 1], ['s', 0.5, 1], ['sw', 0, 1], ['w', 0, 0.5]];

function renderOverlay() { $('dw-overlay').innerHTML = overlaySvg(page()); }

// ---- pages in a tree (SFM-313) -----------------------------------------------------------------

const KEY_COLLAPSED = 'drawingPagesCollapsed', KEY_PANEL = 'drawingPagesPanel';
const pageById = id => S.doc.pages.find(p => p.id === id);
const pageChildren = parentId => S.doc.pages.filter(p => (p.parent || '') === (parentId || ''));

// every page in tree order (a page, then its subpages), with its depth
function pageOrder() {
    const out = [], seen = new Set();
    const walk = (pid, depth) => { for (const p of pageChildren(pid)) { if (seen.has(p.id)) continue; seen.add(p.id); out.push({ p, depth }); walk(p.id, depth + 1); } };
    walk('', 0);
    for (const p of S.doc.pages) if (!seen.has(p.id)) out.push({ p, depth: 0 });       // never: checkDoc refuses it
    return out;
}

function isBelow(id, ancestor) {
    for (let at = pageById(id) && pageById(id).parent, n = 0; at && n <= S.doc.pages.length; at = pageById(at) && pageById(at).parent, n++)
        if (at === ancestor) return true;
    return false;
}

function rememberCollapsed() { try { localStorage.setItem(KEY_COLLAPSED, JSON.stringify([...S.collapsed])); } catch (e) { /* private window */ } }

function renderPages() {
    const tree = $('dw-pages-tree');
    if (!tree) return;
    const cur = page().id;
    for (let at = page().parent; at; at = pageById(at) && pageById(at).parent) if (S.collapsed.delete(at)) rememberCollapsed();
    const rows = [];
    const walk = (pid, depth) => {
        for (const p of pageChildren(pid)) {
            const kids = pageChildren(p.id).length, closed = S.collapsed.has(p.id);
            rows.push(`<div class="dw-pg${p.id === cur ? ' active' : ''}" data-page="${esc(p.id)}" draggable="true" style="padding-left:${4 + depth * 14}px" title="${esc(p.name)} -- double-click renames, right-click for more, drag onto another page to put it below that one">`
                + `<span class="dw-pg-tw"${kids ? ` data-toggle="${esc(p.id)}" title="${closed ? 'Show' : 'Hide'} the subpages"` : ''}>${kids ? (closed ? '&#9656;' : '&#9662;') : ''}</span>`
                + `<span class="dw-pg-name">${esc(p.name)}</span>${p.shapes.length ? '' : '<span class="dw-pg-empty" title="no shapes">&#8709;</span>'}</div>`);
            if (!closed) walk(p.id, depth + 1);
        }
    };
    walk('', 0);
    tree.innerHTML = rows.join('');
}

function newPage(parent) {
    return async () => {
        const name = await askText(parent ? `New page below "${pageById(parent).name}"` : 'New page', uniquePageName('Page ' + (S.doc.pages.length + 1)));
        if (!name) return;
        const p = { id: nextPageId(), name: uniquePageName(name), width: page().width, height: page().height, shapes: [] };
        if (parent) p.parent = parent;
        change(() => { S.doc.pages.push(p); });
        openPage(p.id);
    };
}

// `id` goes below `parent` ('' = top level), as its last subpage; refused below itself
function movePage(id, parent) {
    const p = pageById(id);
    if (!p || (parent || '') === (p.parent || '')) return false;
    if (parent && (parent === id || isBelow(parent, id))) { status('A page can not go below itself or one of its subpages.', true); return false; }
    return change(() => {
        if (parent) p.parent = parent; else delete p.parent;
        S.doc.pages = [...S.doc.pages.filter(x => x !== p), p];         // the last one of its new siblings
    });
}

function shiftPage(id, step) {           // up / down among its siblings
    const p = pageById(id), sibs = pageChildren(p.parent || ''), i = sibs.indexOf(p), other = sibs[i + step];
    if (!other) return;
    change(() => {
        const a = S.doc.pages.indexOf(p), b = S.doc.pages.indexOf(other);
        [S.doc.pages[a], S.doc.pages[b]] = [S.doc.pages[b], S.doc.pages[a]];
    });
}

function deletePage(id) {
    const p = pageById(id), kids = pageChildren(id);
    if (!confirm(`Delete the page "${p.name}" with its ${p.shapes.length} shape(s)?` + (kids.length ? `\n\nIts ${kids.length} subpage(s) move up one level.` : ''))) return;
    change(() => {
        for (const k of kids) { if (p.parent) k.parent = p.parent; else delete k.parent; }
        S.doc.pages = S.doc.pages.filter(x => x !== p);
        if (!S.doc.pages.length) S.doc.pages.push({ id: 'P1', name: 'Page 1', width: 1123, height: 794, shapes: [] });
        if (S.pageId === id) S.pageId = (kids[0] || pageById(p.parent) || pageOrder()[0].p).id;
    });
    openPage(S.pageId);
}

function pageMenu(evt, id) {
    const p = pageById(id), sibs = pageChildren(p.parent || ''), i = sibs.indexOf(p);
    if (id !== page().id) openPage(id);
    showMenu([
        ['New page below this one…', newPage(id)],
        ['Rename…', ACTIONS['dw-page-rename']],
        ['Duplicate', ACTIONS['dw-page-copy']],
        ['Move up', () => shiftPage(id, -1), i <= 0],
        ['Move down', () => shiftPage(id, 1), i >= sibs.length - 1],
        ['Move to the top level', () => movePage(id, ''), !p.parent],
        ['Delete…', () => deletePage(id), false, 'danger'],
    ], evt.clientX, evt.clientY);
}

function setPagesPanel(open) {
    S.pagesPanel = open;
    $('dw-pages').classList.toggle('closed', !open);
    $('dw-pages-toggle').classList.toggle('on', open);
    try { localStorage.setItem(KEY_PANEL, open ? '1' : '0'); } catch (e) { /* private window */ }
}

function wirePages() {
    const tree = $('dw-pages-tree');
    tree.addEventListener('click', e => {
        const tw = e.target.closest('[data-toggle]');
        if (tw) {
            const id = tw.dataset.toggle;
            if (!S.collapsed.delete(id)) S.collapsed.add(id);
            rememberCollapsed();
            renderPages();
            return;
        }
        const row = e.target.closest('.dw-pg');
        if (row && row.dataset.page !== page().id) openPage(row.dataset.page);
    });
    tree.addEventListener('dblclick', e => { if (e.target.closest('.dw-pg') && !e.target.closest('[data-toggle]')) ACTIONS['dw-page-rename'](); });
    tree.addEventListener('contextmenu', e => { const row = e.target.closest('.dw-pg'); if (row) { e.preventDefault(); pageMenu(e, row.dataset.page); } });
    tree.addEventListener('dragstart', e => { const row = e.target.closest('.dw-pg'); if (!row) return; S.dragPage = row.dataset.page; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', row.dataset.page); });
    tree.addEventListener('dragend', () => { S.dragPage = null; tree.querySelectorAll('.drop').forEach(x => x.classList.remove('drop')); });
    const target = e => { const row = e.target.closest('.dw-pg'); return row ? row.dataset.page : ''; };
    tree.addEventListener('dragover', e => {
        if (!S.dragPage) return;
        e.preventDefault();
        tree.querySelectorAll('.drop').forEach(x => x.classList.remove('drop'));
        const row = e.target.closest('.dw-pg');
        (row || tree).classList.add('drop');
    });
    tree.addEventListener('drop', e => {
        if (!S.dragPage) return;
        e.preventDefault();
        const id = S.dragPage, to = target(e);
        S.dragPage = null;
        tree.querySelectorAll('.drop').forEach(x => x.classList.remove('drop'));
        if (to !== id) movePage(id, to);
    });
    $('dw-pages-add').addEventListener('click', () => newPage('')());
    $('dw-pages-toggle').addEventListener('click', () => { setPagesPanel(!S.pagesPanel); render(); });
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
    $('dw-shape-tool').classList.toggle('on', DRAW_KINDS.includes(S.tool));
    $('dw-shape-icon').innerHTML = { rect: ICON_RECT, ellipse: ICON_ELLIPSE, line: ICON_LINE, person: ICON_PERSON }[S.shapeKind];
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
const ICON_PERSON = '<svg viewBox="0 0 20 20"><circle cx="10" cy="4.2" r="2.4" fill="none" stroke="currentColor" stroke-width="1.3"/>'
    + '<path d="M10 6.6 V12.5 M5 8.6 H15 M10 12.5 L6 18 M10 12.5 L14 18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

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

// What a connector end at model point `pt` glues to: an own connection point (×), else the raster place on a
// shape's outline (within a band around it), else -- inside a shape -- the shape itself (dynamic glue).
function glueTarget(pt, exclude) {
    const p = page(), tol = 10 / S.zoom, band = 12 / S.zoom;
    const shapes = [...p.shapes].reverse().filter(s => !ONE_D.has(s.type) && s.id !== exclude);
    for (const s of shapes) {
        const pts = connectionPoints(s);
        for (let i = 4; i < pts.length; i++) if (Math.hypot(pts[i].x - pt.x, pts[i].y - pt.y) <= tol) return { id: s.id, pt: i, x: pts[i].x, y: pts[i].y };
    }
    for (const s of shapes) {
        const hit = outlineHit(s, pt, band);
        if (hit) return { id: s.id, at: hit.at, x: hit.x, y: hit.y };
    }
    for (const s of shapes)
        if (pt.x >= s.x && pt.x <= s.x + s.w && pt.y >= s.y && pt.y <= s.y + s.h) return { id: s.id, pt: -1 };
    return null;
}

// Glues end `end` (0 start, 1 end) of connector `s` as `glue` says, or unglues it.
function setGlue(s, end, glue) {
    const key = end === 0 ? 'from' : 'to';
    delete s[key + 'Pt']; delete s[key + 'At'];
    if (!glue) { delete s[key]; return; }
    s[key] = glue.id;
    if (glue.at) s[key + 'At'] = glue.at; else s[key + 'Pt'] = glue.pt;
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
        S.drag = handle.dataset.bend ? { mode: 'bend', id: s.id, axis: handle.dataset.bend, before: snapshot() }
            : handle.dataset.end !== undefined
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
        const start = glue && glue.x !== undefined ? { x: glue.x, y: glue.y } : { x: snap(m.x), y: snap(m.y) };
        const s = { id: nextShapeId(), type: S.tool, x1: start.x, y1: start.y, x2: start.x, y2: start.y, style: {} };
        if (glue) setGlue(s, 0, glue);
        if (S.tool === 'connector') s.route = 'orthogonal';
        const before = snapshot();
        p.shapes.push(s);
        S.sel = [s.id];
        S.drag = { mode: 'end', id: s.id, end: 1, before, created: true };
        $('dw-svg').setPointerCapture(evt.pointerId);
        render();
        return;
    }
    if (S.tool === 'rect' || S.tool === 'ellipse' || S.tool === 'text' || S.tool === 'person') {
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
        if (evt.ctrlKey || evt.metaKey) {          // Ctrl+click toggles it, Ctrl+drag copies the selection (SFM-230)
            S.drag = { mode: 'ctrl', id, start: m, before: snapshot() };
            $('dw-svg').setPointerCapture(evt.pointerId);
            return;
        }
        if (evt.shiftKey) {
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
        let moving = selected();
        if (evt.altKey && !ONE_D.has(s.type)) {               // Alt+drag: the shape with its branch (SFM-306)
            const ids = branchOf(p, id);
            S.sel = [id];
            moving = p.shapes.filter(x => ids.has(x.id));
            status(`Moving ${moving.length} shape(s): ${s.id} and what its connectors lead to`);
        }
        S.drag = { mode: 'move', start: m, orig: moveOrig(withNotes(p, moving)), before: snapshot(), moved: false };
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
    if (!d) {
        if (S.tool === 'connector') {                 // show the raster of the shape under the mouse
            const g = glueTarget(toModel(evt));
            const key = g ? `${g.id}|${g.x}|${g.y}` : '';
            if (key !== S.hoverKey) { S.hoverKey = key; S.hover = g; renderOverlay(); }
        }
        return;
    }
    if (d.mode === 'pan') {
        S.pan = { x: d.pan.x + evt.clientX - d.start.x, y: d.pan.y + evt.clientY - d.start.y };
        $('dw-view').setAttribute('transform', `translate(${S.pan.x},${S.pan.y}) scale(${S.zoom})`);
        return;
    }
    const m = toModel(evt), p = page();
    if (d.mode === 'ctrl') {                        // dragged: copies of the selection (with the shape) follow the mouse
        if (Math.abs(m.x - d.start.x) + Math.abs(m.y - d.start.y) <= 3 / S.zoom) return;
        if (!S.sel.includes(d.id)) S.sel = [...S.sel, d.id];
        const copies = duplicate(withNotes(p, selected()), 0);
        S.sel = copies.filter(c => !c.attach || !copies.some(x => x.id === c.attach)).map(c => c.id);
        S.drag = { mode: 'move', start: d.start, orig: moveOrig(copies), before: d.before, moved: true };
        select(S.sel);
        onPointerMove(evt);
        return;
    }
    if (d.mode === 'move') {
        let dx = m.x - d.start.x, dy = m.y - d.start.y;
        if (evt.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        if (Math.abs(dx) + Math.abs(dy) > 1) d.moved = true;
        const first = d.orig[0], ref = first.x !== undefined ? first.x : first.x1, refY = first.y !== undefined ? first.y : first.y1;
        dx = snap(ref + dx) - ref; dy = snap(refY + dy) - refY;
        for (const o of d.orig) {
            const s = shape(o.id);
            if (ONE_D.has(s.type)) {
                s.x1 = o.x1 + dx; s.y1 = o.y1 + dy; s.x2 = o.x2 + dx; s.y2 = o.y2 + dy;
                if (o.midX !== undefined) s.midX = o.midX + dx;
                if (o.midY !== undefined) s.midY = o.midY + dy;
            } else { s.x = o.x + dx; s.y = o.y + dy; }
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
        // a corner handle with Shift keeps the proportions -- a picture the other way round: always, Shift = free (SFM-291)
        if ((s.type === 'image' ? !evt.shiftKey : evt.shiftKey) && h.length === 2) { const ratio = o.w / o.h; if (w / hh > ratio) w = hh * ratio; else hh = w / ratio; if (h.includes('w')) x = o.x + o.w - w; if (h.includes('n')) y = o.y + o.h - hh; }
        Object.assign(s, { x, y, w, h: hh });
        render();
    } else if (d.mode === 'bend') {                 // SFM-337: the line moved by hand stays there
        const s = shape(d.id);
        if (d.axis === 'x') { s.midX = snap(m.x); delete s.midY; } else { s.midY = snap(m.y); delete s.midX; }
        render();
    } else if (d.mode === 'end') {
        const s = shape(d.id);
        const glue = s.type === 'connector' ? glueTarget(m, d.end === 0 ? s.to : s.from) : null;
        d.hover = glue;
        setGlue(s, d.end, glue);
        if (!glue) {
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
    if (d.mode === 'ctrl') {                        // Ctrl+click without moving: in / out of the selection
        S.sel = S.sel.includes(d.id) ? S.sel.filter(x => x !== d.id) : [...S.sel, d.id];
        select(S.sel);
        return;
    }
    if (d.mode === 'create') {
        const s = shape(d.id);
        if (s.w < 4 && s.h < 4) {                      // a click: the default size
            const size = s.type === 'text' ? [120, 30] : s.type === 'person' ? [40, 80] : [120, 60];
            s.w = size[0]; s.h = size[1];
        }
        commitDrag(d);
        if (s.type === 'text') { setTool('pointer'); startText(s.id); }
        return;
    }
    if (d.mode === 'end' && d.created) {
        const s = shape(d.id);
        if (Math.hypot(s.x2 - s.x1, s.y2 - s.y1) < 4 && !(s.from && s.to)) {   // a click without dragging: nothing
            restoreDoc(d.before.doc);
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
    if (!s || s.type === 'image') return;             // pictures have no text
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
    for (const n of notesOf(page(), ids)) ids.add(n.id);         // a shape's notes go with it (SFM-311)
    change(() => {
        const p = page();
        p.shapes = p.shapes.filter(s => !ids.has(s.id));
        for (const s of p.shapes) {                    // a connector glued to a deleted shape keeps its place, unglued
            if (ids.has(s.from)) setGlue(s, 0, null);
            if (ids.has(s.to)) setGlue(s, 1, null);
        }
        S.sel = [];
    });
}

function copySelected(cut) {
    if (!S.sel.length) return;
    S.clipboard = JSON.parse(JSON.stringify(withNotes(page(), selected())));
    if (cut) deleteSelected();
}

// Copies of `shapes` on the page, `offset` away: a line glued to a copied shape is glued to its copy,
// one glued to a shape left behind comes loose. Paste and Ctrl+drag (SFM-230).
function duplicate(shapes, offset) {
    const p = page(), map = new Map();
    const copies = shapes.map(s => { const c = JSON.parse(JSON.stringify(s)); c.id = nextShapeId(p); map.set(s.id, c.id); p.shapes.push(c); return c; });
    for (const c of copies) {
        if (ONE_D.has(c.type)) {
            c.x1 += offset; c.y1 += offset; c.x2 += offset; c.y2 += offset;
            if (c.midX !== undefined) c.midX += offset;
            if (c.midY !== undefined) c.midY += offset;
        } else { c.x += offset; c.y += offset; }
        for (const [i, end] of ['from', 'to'].entries()) if (c[end]) { if (map.has(c[end])) c[end] = map.get(c[end]); else setGlue(c, i, null); }
        if (c.attach) { if (map.has(c.attach)) c.attach = map.get(c.attach); else delete c.attach; }     // a note without its shape: a text
    }
    return copies;
}

function paste(offset = 20) {
    if (!S.clipboard || !S.clipboard.length) return;
    change(() => {
        const copies = duplicate(S.clipboard, offset);
        S.clipboard = JSON.parse(JSON.stringify(copies));
        S.sel = copies.map(c => c.id);
    });
}

// Right-click > Add connected shape (SFM-305, like the Manual FTA's "add below"): a shape of the same kind, size and
// style (no text, no model link) `CONNECT_GAP` away on that side, glued with an arrow connector from the middle of the
// side to the middle of the facing side. When that place is taken it moves on sideways (right of / below the shapes
// already there, like siblings in a tree). Its text opens for typing.
const CONNECT_GAP = 60;
const CONNECT_DIRS = { right: ['r', 'l', 1, 0], below: ['b', 't', 0, 1], left: ['l', 'r', -1, 0], above: ['t', 'b', 0, -1] };

function connectedPlace(p, s, dir) {
    const [, , ux, uy] = CONNECT_DIRS[dir];
    let x = snap(s.x + ux * (s.w + CONNECT_GAP)), y = snap(s.y + uy * (s.h + CONNECT_GAP));
    const free = (x, y) => !p.shapes.some(o => !ONE_D.has(o.type) && o.id !== s.id
        && x < o.x + o.w + GRID && x + s.w + GRID > o.x && y < o.y + o.h + GRID && y + s.h + GRID > o.y);
    for (let i = 0; i < 200 && !free(x, y); i++) {
        if (ux) y = snap(y + s.h / 2 + GRID); else x = snap(x + s.w / 2 + GRID);     // sideways: below / right of it
    }
    return { x, y };
}

function addConnected(dir) {
    const s = selected()[0];
    if (!s || ONE_D.has(s.type) || !CONNECT_DIRS[dir]) return;
    const [fromSide, toSide] = CONNECT_DIRS[dir];
    let made = null;
    change(() => {
        const p = page();
        const at = connectedPlace(p, s, dir);
        const n = { id: nextShapeId(p), type: s.type, x: at.x, y: at.y, w: s.w, h: s.h, style: JSON.parse(JSON.stringify(s.style || {})) };
        if (s.type === 'image') n.img = s.img;
        p.shapes.push(n);
        const c = { id: nextShapeId(p), type: 'connector', route: 'orthogonal', x1: 0, y1: 0, x2: 0, y2: 0, style: { arrowEnd: true },
                    from: s.id, fromAt: `${fromSide}:0.5000`, to: n.id, toAt: `${toSide}:0.5000` };
        p.shapes.push(c);
        resolveEnds(p, c);
        S.sel = [n.id];
        made = n;
    });
    if (made && made.type !== 'image') startText(made.id);
}

// ---- branches, trees and notes (SFM-306, SFM-307, SFM-311) -------------------------------------

function moveOrig(list) { return list.map(x => ({ id: x.id, x: x.x, y: x.y, x1: x.x1, y1: x.y1, x2: x.x2, y2: x.y2, midX: x.midX, midY: x.midY })); }

// The notes attached to the shapes `ids` (SFM-311) that are not among them: they move, copy and go with their shape.
function notesOf(p, ids) {
    const set = ids instanceof Set ? ids : new Set(ids);
    return p.shapes.filter(s => s.attach && set.has(s.attach) && !set.has(s.id));
}
function withNotes(p, shapes) { return [...shapes, ...notesOf(p, shapes.map(s => s.id))]; }

// The shapes a connector or line leads to from `id` (its `from` end there, its `to` end on the other shape) -- the
// children in a branch, like the inputs of a gate in a fault tree. Notes are no children (they go with their shape).
function treeChildren(p, id) {
    const byId = new Map(p.shapes.map(x => [x.id, x]));
    return p.shapes.filter(c => ONE_D.has(c.type) && c.from === id && c.to && c.to !== id && byId.has(c.to) && !byId.get(c.to).attach)
        .map(c => ({ c, s: byId.get(c.to) }));
}

// SFM-306: the shape and everything its connectors lead to, and on (each shape once, loops stop)
function branchOf(p, id) {
    const seen = new Set([id]), queue = [id];
    while (queue.length) for (const { s } of treeChildren(p, queue.shift())) if (!seen.has(s.id)) { seen.add(s.id); queue.push(s.id); }
    return seen;
}

const KEY_TREE = 'drawingTree';
const TREE_DEFAULTS = { dir: 'down', level: 60, sibling: 20, reglue: true };
function treeSettings() {
    try { return { ...TREE_DEFAULTS, ...JSON.parse(localStorage.getItem(KEY_TREE) || '{}') }; } catch (e) { return { ...TREE_DEFAULTS }; }
}

// SFM-307 (the Manual FTA's layout): the branch below `rootId` laid out as a tree -- down (children below, side by side)
// or right (children to the right, one under the other). The root stays where it is; each level is as deep as its
// deepest shape plus `level`, siblings `sibling` apart, a parent centred over its children; the order of the
// children is their order on the page now. A shape reached twice is placed once (under the first parent). With
// `reglue` the connectors of the tree run from the middle of the parent's side to the middle of the child's facing
// side. Notes move with their shapes. One change (one Undo). Returns the number of shapes placed.
function arrangeTree(rootId, opt = treeSettings()) {
    const p = page(), root = shape(rootId);
    if (!root || ONE_D.has(root.type)) return 0;
    const down = opt.dir !== 'right', sib = Math.max(0, Number(opt.sibling) || 0), lvl = Math.max(0, Number(opt.level) || 0);
    const along = x => (down ? x.w : x.h), deep = x => (down ? x.h : x.w);
    const placed = new Set([rootId]), kids = new Map(), edges = [], levels = [];
    const build = (id, depth) => {
        const node = shape(id);
        levels[depth] = Math.max(levels[depth] || 0, deep(node));
        const list = treeChildren(p, id).filter(k => !placed.has(k.s.id))
            .sort((a, b) => (down ? a.s.x - b.s.x || a.s.y - b.s.y : a.s.y - b.s.y || a.s.x - b.s.x));
        const own = [];
        for (const k of list) if (!placed.has(k.s.id)) { placed.add(k.s.id); own.push(k); edges.push(k.c); }
        kids.set(id, own.map(k => k.s.id));
        for (const k of own) build(k.s.id, depth + 1);
    };
    build(rootId, 0);
    const breadth = new Map();
    const measure = id => {
        const ks = kids.get(id) || [];
        const sum = ks.reduce((t, k) => t + measure(k), 0) + sib * Math.max(0, ks.length - 1);
        const b = Math.max(along(shape(id)), sum);
        breadth.set(id, b);
        return b;
    };
    measure(rootId);
    const start = [0];
    for (let i = 1; i < levels.length; i++) start[i] = start[i - 1] + levels[i - 1] + lvl;
    const moves = new Map();
    const base = down ? root.y : root.x;
    const place = (id, depth, from) => {
        const x = shape(id), B = breadth.get(id);
        const b = from + (B - along(x)) / 2, d = base + start[depth] + (levels[depth] - deep(x)) / 2;
        moves.set(id, [Math.round(down ? b : d) - x.x, Math.round(down ? d : b) - x.y]);
        const ks = kids.get(id) || [];
        const total = ks.reduce((t, k) => t + breadth.get(k), 0) + sib * Math.max(0, ks.length - 1);
        let at = from + (B - total) / 2;
        for (const k of ks) { place(k, depth + 1, at); at += breadth.get(k) + sib; }
    };
    place(rootId, 0, (down ? root.x + root.w / 2 : root.y + root.h / 2) - breadth.get(rootId) / 2);
    moves.set(rootId, [0, 0]);
    change(() => {
        for (const [id, [dx, dy]] of moves) {
            if (!dx && !dy) continue;
            for (const x of [shape(id), ...notesOf(p, [id])]) { x.x += dx; x.y += dy; }
        }
        if (opt.reglue) for (const c of edges) {
            delete c.fromPt; delete c.toPt;
            c.fromAt = down ? 'b:0.5000' : 'r:0.5000';
            c.toAt = down ? 't:0.5000' : 'l:0.5000';
        }
    });
    status(`Arranged ${moves.size} shape(s) as a tree`);
    return moves.size;
}

function treeDialog(id) {
    const dlg = $('dw-tree-dialog'), o = treeSettings();
    $('dw-tree-dir').value = o.dir; $('dw-tree-level').value = o.level; $('dw-tree-sibling').value = o.sibling; $('dw-tree-reglue').checked = !!o.reglue;
    dlg.returnValue = '';
    dlg.showModal();
    dlg.addEventListener('close', () => {
        if (dlg.returnValue !== 'ok') return;
        const opt = { dir: $('dw-tree-dir').value, level: Number($('dw-tree-level').value) || 0,
                      sibling: Number($('dw-tree-sibling').value) || 0, reglue: $('dw-tree-reglue').checked };
        try { localStorage.setItem(KEY_TREE, JSON.stringify(opt)); } catch (e) { /* private window */ }
        arrangeTree(id, opt);
    }, { once: true });
}

// SFM-311: a note (a text box in a light frame) attached to the shape: it moves, copies and goes with it
function addNote() {
    const s = selected()[0];
    if (!s || ONE_D.has(s.type) || s.attach) return;
    let made = null;
    change(() => {
        const p = page();
        const n = { id: nextShapeId(p), type: 'text', x: snap(s.x + s.w + 2 * GRID), y: snap(s.y), w: 140, h: 40, attach: s.id,
                    style: { fill: '#fffbe6', line: '#d4b106', size: 9, align: 'left', valign: 'top' } };
        p.shapes.push(n);
        S.sel = [n.id];
        made = n;
    });
    if (made) startText(made.id);
}

// ---- Grid view (SFM-308) ------------------------------------------------------------------------

const KIND_NAMES = { rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', text: 'Text', connector: 'Connector', image: 'Picture', person: 'Person' };
const kindName = s => (s.attach ? 'Note' : KIND_NAMES[s.type] || s.type);

function gridRows() {
    const all = $('dw-grid-all').checked, words = searchWords($('dw-grid-filter').value);
    const rows = [];
    for (const { p } of pageOrder()) {
        if (!all && p.id !== page().id) continue;
        for (const s of p.shapes) {
            const hay = [p.name, s.id, kindName(s), s.text || '', s.link || '', s.attach || ''].join(' ');
            if (words.every(re => re.test(hay))) rows.push({ p, s });
        }
    }
    return rows;
}

function connectionsText(p, s) {
    if (ONE_D.has(s.type)) return `${s.from || '·'} → ${s.to || '·'}`;
    const out = p.shapes.filter(c => ONE_D.has(c.type) && c.from === s.id && c.to).map(c => c.to);
    const inc = p.shapes.filter(c => ONE_D.has(c.type) && c.to === s.id && c.from).map(c => c.from);
    return [inc.length ? `← ${inc.join(', ')}` : '', out.length ? `→ ${out.join(', ')}` : ''].filter(Boolean).join('; ');
}

function renderGrid() {
    const rows = gridRows(), models = S.store.models;
    $('dw-grid-count').textContent = `${rows.length} shape(s)`;
    $('dw-grid-body').innerHTML = rows.map(({ p, s }) => {
        const editable = s.type !== 'image';
        return `<tr data-page="${esc(p.id)}" data-id="${esc(s.id)}"><td>${esc(p.name)}</td><td><code>${esc(s.id)}</code></td><td>${esc(kindName(s))}</td>`
            + `<td class="dw-grid-text">${editable ? `<textarea rows="1" spellcheck="false" aria-label="Text of ${esc(s.id)}">${esc(s.text || '')}</textarea>` : ''}</td>`
            + `<td>${esc(connectionsText(p, s))}</td><td>${s.attach ? `<code>${esc(s.attach)}</code>` : ''}</td>`
            + (models ? `<td>${s.link ? `<code>${esc(s.link)}</code>` : ''}</td>` : '')
            + `<td><button type="button" class="secondary dw-grid-show" title="Show it on its page">Show</button></td></tr>`;
    }).join('') || `<tr><td colspan="8" class="dw-muted">No shapes${$('dw-grid-filter').value ? ' match' : ''}.</td></tr>`;
}

function setGrid(open) {
    S.grid = open;
    $('dw-gridview').hidden = !open;
    $('dw-canvas').hidden = open;
    $('dw-grid-toggle').classList.toggle('on', open);
    if (S.editing) finishText();
    if (open) { renderGrid(); $('dw-grid-filter').focus(); } else render();
}

function wireGrid() {
    $('dw-grid-filter').addEventListener('input', renderGrid);
    $('dw-grid-all').addEventListener('change', renderGrid);
    $('dw-grid-close').addEventListener('click', () => setGrid(false));
    $('dw-grid-body').addEventListener('change', e => {
        const ta = e.target.closest('textarea'), tr = e.target.closest('tr');
        if (!ta || !tr) return;
        const p = pageById(tr.dataset.page), s = p && p.shapes.find(x => x.id === tr.dataset.id);
        if (s && (s.text || '') !== ta.value) change(() => { s.text = ta.value; });
    });
    $('dw-grid-body').addEventListener('click', e => {
        if (!e.target.closest('.dw-grid-show')) return;
        const tr = e.target.closest('tr');
        setGrid(false);
        goToShape(tr.dataset.page, tr.dataset.id);
    });
}

// ---- search across all pages (SFM-309) ---------------------------------------------------------

// every word must match (case ignored); * = any characters, ? = one character
function searchWords(q) {
    return String(q || '').trim().split(/\s+/).filter(Boolean)
        .map(w => new RegExp(w.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.'), 'i'));
}

function goToShape(pageId, id) {
    if (S.editing) finishText();
    if (pageId !== page().id) {
        S.pageId = pageId;
        try { localStorage.setItem(KEY_PAGE, pageId); } catch (e) { /* private window */ }
    }
    const p = page(), s = shape(id);
    S.sel = s ? [id] : [];
    if (s) {
        const box = $('dw-svg').getBoundingClientRect(), b = bbox(p, s);
        if (box.width) S.pan = { x: box.width / 2 - (b.x + b.w / 2) * S.zoom, y: box.height / 2 - (b.y + b.h / 2) * S.zoom };
    }
    render();
}

function runSearch() {
    const q = $('dw-search').value, words = searchWords(q);
    if (!words.length) { S.search = null; $('dw-search-count').textContent = ''; render(); return; }
    const hits = [];
    for (const { p } of pageOrder()) for (const s of p.shapes)
        if (words.every(re => re.test([s.id, s.text || '', s.link || ''].join(' ')))) hits.push({ page: p.id, id: s.id });
    S.search = { q, hits, i: -1 };
    $('dw-search-count').textContent = hits.length ? `${hits.length} found` : 'nothing found';
    render();
}

function searchStep(step) {
    if (!S.search || S.search.q !== $('dw-search').value) runSearch();
    const r = S.search;
    if (!r || !r.hits.length) return;
    r.i = (r.i + step + r.hits.length) % r.hits.length;
    const h = r.hits[r.i];
    $('dw-search-count').textContent = `${r.i + 1} of ${r.hits.length}`;
    goToShape(h.page, h.id);
}

function wireSearch() {
    $('dw-search').addEventListener('input', runSearch);
    $('dw-search').addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); searchStep(e.shiftKey ? -1 : 1); }
        else if (e.key === 'Escape') { e.preventDefault(); $('dw-search').value = ''; runSearch(); $('dw-search').blur(); }
        e.stopPropagation();
    });
    $('dw-search-prev').addEventListener('click', () => searchStep(-1));
    $('dw-search-next').addEventListener('click', () => searchStep(1));
}

// ---- revisions (SFM-310, like the Manual FTA's version control) ----------------------------------

const MAX_CHANGES = 500;
const short = t => { const v = String(t || '').replace(/\s+/g, ' ').trim(); return v.length > 40 ? v.slice(0, 39) + '…' : v; };
const shapeName = s => `${kindName(s).toLowerCase()} ${s.id}${short(s.text) ? ` '${short(s.text)}'` : ''}`;

// What changed from document `a` (null: nothing before) to `b`, page by page and shape by shape: [{kind, text}]
// with kind added / removed / changed. A connector glued at both ends counts as changed only when it is glued
// elsewhere (its points follow its shapes).
function diffDocs(a, b) {
    const out = [], add = (kind, text) => out.push({ kind, text });
    const before = new Map((a ? a.pages : []).map(p => [p.id, p])), after = new Map(b.pages.map(p => [p.id, p]));
    const nameOf = id => (after.get(id) || before.get(id) || { name: id }).name;
    for (const p of b.pages) {
        const o = before.get(p.id);
        if (!o) { add('added', `Page '${p.name}' added (${p.shapes.length} shape(s))`); continue; }
        if (o.name !== p.name) add('changed', `Page '${o.name}' renamed to '${p.name}'`);
        if ((o.parent || '') !== (p.parent || '')) add('changed', `Page '${p.name}' moved ${p.parent ? `below '${nameOf(p.parent)}'` : 'to the top level'}`);
        if (o.width !== p.width || o.height !== p.height) add('changed', `Page '${p.name}': size ${o.width} x ${o.height} -> ${p.width} x ${p.height}`);
        const old = new Map(o.shapes.map(s => [s.id, s])), now = new Set(p.shapes.map(s => s.id));
        for (const s of p.shapes) {
            const x = old.get(s.id);
            if (!x) { add('added', `Page '${p.name}': ${shapeName(s)} added`); continue; }
            const what = [];
            if ((x.text || '') !== (s.text || '')) what.push(`text '${short(x.text)}' -> '${short(s.text)}'`);
            if (ONE_D.has(s.type)) {
                if (['from', 'to', 'fromAt', 'toAt', 'fromPt', 'toPt'].some(k => (x[k] ?? '') !== (s[k] ?? ''))) what.push('connected differently');
                if ((!s.from && (x.x1 !== s.x1 || x.y1 !== s.y1)) || (!s.to && (x.x2 !== s.x2 || x.y2 !== s.y2))) what.push('moved');
                if ((x.route || '') !== (s.route || '')) what.push('routing');
            } else {
                if (x.x !== s.x || x.y !== s.y) what.push('moved');
                if (x.w !== s.w || x.h !== s.h) what.push('resized');
                if (JSON.stringify(x.cps || []) !== JSON.stringify(s.cps || [])) what.push('connection points');
            }
            if (JSON.stringify(styleOf(x)) !== JSON.stringify(styleOf(s))) what.push('style');
            if ((x.link || '') !== (s.link || '')) what.push(`model link ${x.link || 'none'} -> ${s.link || 'none'}`);
            if ((x.attach || '') !== (s.attach || '')) what.push(s.attach ? `note of ${s.attach}` : 'no note any more');
            if (x.img !== s.img) what.push('picture');
            if (what.length) add('changed', `Page '${p.name}': ${shapeName(s)} ${what.join(', ')}`);
        }
        for (const s of o.shapes) if (!now.has(s.id)) add('removed', `Page '${p.name}': ${shapeName(s)} removed`);
    }
    for (const o of (a ? a.pages : [])) if (!after.has(o.id)) add('removed', `Page '${o.name}' removed (${o.shapes.length} shape(s))`);
    return out;
}

function changeSummary(changes) {
    const n = k => changes.filter(c => c.kind === k).length;
    return [['added', n('added')], ['removed', n('removed')], ['changed', n('changed')]].filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ') || 'no change';
}

async function lastRevision() {
    const list = await S.store.versions();
    if (!list.length) return { list, last: null, doc: null };
    let doc = null;
    try { doc = parseXml(await S.store.version(list[0].n)); } catch (e) { doc = null; }
    return { list, last: list[0], doc };
}

// Saves the drawing as a new revision with what changed since the last one; none when nothing changed.
async function saveRevision(note) {
    if (!S.store.versions) return null;
    if (S.editing) finishText();
    await flushSave();
    const { last, doc } = await lastRevision();
    const changes = diffDocs(doc, S.doc);
    if (last && !changes.length) { status(`No change since revision ${last.n} -- no new revision`); return null; }
    const v = await S.store.saveVersion(toXml(S.doc), { note: note || '', summary: changeSummary(changes),
                                                        changes: changes.slice(0, MAX_CHANGES).map(c => c.text) });
    status(`Saved revision ${v.n}`);
    updateFolderUi();
    return v;
}

async function restoreRevision(n) {
    if (!confirm(`Restore revision ${n}? The drawing becomes as it was then (all pages). Changes since the last revision are saved as a revision first, so nothing is lost.`)) return;
    try {
        await flushSave();
        const { last, doc } = await lastRevision();
        if (!last || diffDocs(doc, S.doc).length) await saveRevision(`Saved before restoring revision ${n}`);
        const old = parseXml(await S.store.version(n));
        const before = snapshot();
        S.doc = { pages: old.pages, images: { ...S.doc.images, ...old.images } };
        pushUndo(before);
        S.pageId = S.doc.pages.some(p => p.id === S.pageId) ? S.pageId : S.doc.pages[0].id;
        S.sel = [];
        render();
        fit();
        saveNow();
        await saveRevision(`Restored revision ${n}`);
        await revisionsDialog(true);
    } catch (e) { status(e.message, true); alert(e.message); }
}

async function revisionsDialog(refresh) {
    const dlg = $('dw-rev-dialog');
    let list = [];
    try { list = await S.store.versions(); } catch (e) { status(e.message, true); }
    $('dw-rev-list').innerHTML = list.length ? list.map(v => `<details class="dw-rev" data-n="${v.n}"><summary><b>Revision ${v.n}</b> `
        + `<span class="dw-muted">${esc(String(v.saved || '').replace('T', ' ').replace(/(\.\d+)?Z$/, ' UTC'))}</span> -- ${esc(v.summary || '')}`
        + `${v.note ? ` <i>${esc(v.note)}</i>` : ''} <button type="button" class="secondary dw-rev-restore" data-n="${v.n}">Restore</button></summary>`
        + `<ul>${(v.changes || []).map(c => `<li>${esc(c)}</li>`).join('') || '<li class="dw-muted">no change lines</li>'}</ul></details>`).join('')
        : '<p class="dw-muted">No revision yet -- <b>Save revision</b> keeps the drawing as it is now, with the time and what changed.</p>';
    if (!refresh && !dlg.open) { $('dw-rev-note').value = ''; dlg.showModal(); }
}

function wireRevisions() {
    $('dw-rev-save').addEventListener('click', async () => {
        try { if (await saveRevision($('dw-rev-note').value.trim())) $('dw-rev-note').value = ''; await revisionsDialog(true); }
        catch (e) { status(e.message, true); alert(e.message); }
    });
    $('dw-rev-note').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('dw-rev-save').click(); } });
    $('dw-rev-list').addEventListener('click', e => {
        const b = e.target.closest('.dw-rev-restore');
        if (b) { e.preventDefault(); restoreRevision(Number(b.dataset.n)); }
    });
}

// ---- a folder on this computer (SFM-312, standalone only: the store has it) ----------------------------

async function updateFolderUi() {
    const st = S.store && S.store.folderState ? await S.store.folderState().catch(() => null) : null;
    const item = $('dw-folder'), stop = $('dw-folder-stop'), label = $('dw-folder-status');
    if (!item) return;
    item.hidden = !st;
    stop.hidden = !st || !st.name;
    label.hidden = !st || !st.name;
    if (!st) return;
    item.disabled = !st.api;
    item.title = st.api ? 'Keep the drawing and its revisions in a folder on this computer (written on every change)'
                        : 'Needs Chrome or Edge -- use Import / Export > Export XML';
    item.textContent = st.name ? (st.granted ? `Folder on this computer: ${st.name}…` : `Reconnect the folder ${st.name}…`) : 'Keep on this computer (folder)…';
    label.textContent = st.name ? (st.granted ? `Folder: ${st.name}` : `Folder ${st.name}: not connected -- File > Reconnect`) : '';
    label.classList.toggle('error', !!st.name && !st.granted);
}

function nudge(dx, dy) {
    if (!S.sel.length) return;
    change(() => { for (const s of withNotes(page(), selected())) { if (ONE_D.has(s.type)) {
        if (!s.from) { s.x1 += dx; s.y1 += dy; } if (!s.to) { s.x2 += dx; s.y2 += dy; }
        if (!s.from && !s.to) { if (s.midX !== undefined) s.midX += dx; if (s.midY !== undefined) s.midY += dy; }   // SFM-337
    } else { s.x += dx; s.y += dy; } } });
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
    if (DRAW_KINDS.includes(tool)) S.shapeKind = tool;
    render();
    $('dw-hint').textContent = {
        pointer: '', rect: 'Drag on the page to draw a rectangle (Shift: square).', ellipse: 'Drag to draw an ellipse (Shift: circle).',
        line: 'Drag to draw a line (Shift: horizontal / vertical).', person: 'Click for a person, or drag its size; double-click it to write its name below it.', text: 'Click or drag on the page for a text box, then type.',
        connector: 'Drag from a shape to another: on a shape\'s line the end snaps to the raster dots (twelfths of a side), inside a shape it takes the nearest side; it stays glued when the shapes move.',
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
        + '<button type="button" class="dw-dd-item" data-value="a:end">Arrow at the end</button><button type="button" class="dw-dd-item" data-value="a:start">Arrow at the start</button><button type="button" class="dw-dd-item" data-value="a:both">Arrows at both ends</button><button type="button" class="dw-dd-item" data-value="a:none">No arrows</button>'
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
    else if (k === 'a') change(() => { for (const s of selected()) s.style = { ...s.style, arrowEnd: v === 'end' || v === 'both' ? true : v === 'none' ? false : styleOf(s).arrowEnd, arrowStart: v === 'start' || v === 'both' ? true : v === 'none' ? false : styleOf(s).arrowStart }; });
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

// ---- pictures (SFM-291) ----------------------------------------------------------------------------

const clipboardHere = e => !(document.querySelector('dialog[open]') || S.editing
                             || (e.target && e.target.closest && e.target.closest('input, textarea, select')));

// Ctrl+C / X (and the menu): the shapes into the drawing's own clipboard, a mark onto the system clipboard -- so a
// later Ctrl+V knows the shapes are newer than a picture copied before.
function onCopy(e, cut) {
    if (!clipboardHere(e) || !S.sel.length) return;
    copySelected(cut);
    if (e.clipboardData) e.clipboardData.setData('text/plain', `${COPY_MARK} ${S.clipboard.length}`);
    e.preventDefault();
}

// Ctrl+V: copied shapes (the mark), else a picture on the clipboard, else the drawing's own clipboard.
function onPaste(e) {
    if (!clipboardHere(e)) return;
    e.preventDefault();
    const data = e.clipboardData;
    if (data && data.getData('text/plain').startsWith(COPY_MARK)) { paste(); return; }
    const files = data ? [...data.items].filter(i => i.kind === 'file' && i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean) : [];
    if (files.length) { insertPictureFile(files[0], 'Picture from the clipboard'); return; }
    paste();
}

// The menu's Paste / Insert > Picture from the clipboard: reads the clipboard where the browser allows it
// (it may ask first). True when it pasted something.
async function pasteFromClipboard(picturesOnly) {
    if (!navigator.clipboard || !navigator.clipboard.read) return false;
    let items;
    try { items = await navigator.clipboard.read(); } catch (e) { return false; }
    for (const item of items) {
        const type = item.types.find(t => t.startsWith('image/'));
        if (type) { await insertPictureFile(await item.getType(type), 'Picture from the clipboard'); return true; }
        if (!picturesOnly && item.types.includes('text/plain')) {
            const text = await (await item.getType('text/plain')).text();
            if (text.startsWith(COPY_MARK) && S.clipboard) { paste(); return true; }
        }
    }
    return false;
}

const blobToDataUrl = blob => new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(r.result);
    r.onerror = () => fail(r.error);
    r.readAsDataURL(blob);
});

// A picture (file / clipboard item) -> {src: data URI, w, h (its own size in px)}. PNG, JPEG, GIF and WebP stay as
// they are; other kinds (BMP, SVG, ...) and very large pictures are redrawn as PNG (photos: JPEG), at most
// IMG_MAX_SIDE px wide or high.
async function readPicture(blob) {
    const url = URL.createObjectURL(blob);
    try {
        const img = await new Promise((ok, fail) => {
            const i = new Image();
            i.onload = () => ok(i);
            i.onerror = () => fail(new Error('This is not a picture the browser can read.'));
            i.src = url;
        });
        const w = img.naturalWidth || 300, h = img.naturalHeight || 150;
        if (IMG_KEEP.has(blob.type) && Math.max(w, h) <= IMG_MAX_SIDE && blob.size <= IMG_MAX_BYTES) {
            const src = await blobToDataUrl(blob);
            if (IMG_RE.test(src)) return { src, w, h };
        }
        const k = Math.min(1, IMG_MAX_SIDE / Math.max(w, h)), jpeg = blob.type === 'image/jpeg';
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w * k)); canvas.height = Math.max(1, Math.round(h * k));
        const ctx = canvas.getContext('2d');
        if (jpeg) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        return { src: canvas.toDataURL(jpeg ? 'image/jpeg' : 'image/png', 0.92), w, h };
    } finally {
        URL.revokeObjectURL(url);
    }
}

async function insertPictureFile(blob, name) {
    try { const pic = await readPicture(blob); insertPicture(pic.src, pic.w, pic.h, name); }
    catch (e) { alert(e.message); }
}

function nextImageId() {
    let n = 0;
    for (const id of Object.keys(S.doc.images)) { const m = /^IMG-(\d+)$/.exec(id); if (m) n = Math.max(n, +m[1]); }
    return 'IMG-' + (n + 1);
}

// The middle of what is in view, on the page.
function viewCentre() {
    const r = $('dw-svg').getBoundingClientRect(), p = page();
    return { x: Math.max(0, Math.min(p.width, (r.width / 2 - S.pan.x) / S.zoom)),
             y: Math.max(0, Math.min(p.height, (r.height / 2 - S.pan.y) / S.zoom)) };
}

// A picture shape in the middle of the view, at its own size or smaller -- at most 90 % of the page -- and selected.
// `name` (where it came from) is kept with the picture and shown when the mouse rests on it.
function insertPicture(src, w, h, name) {
    if (!IMG_RE.test(src)) { alert('This picture cannot be inserted (only PNG, JPEG, GIF and WebP pictures).'); return; }
    const p = page(), k = Math.min(1, p.width * 0.9 / w, p.height * 0.9 / h);
    w = Math.max(5, Math.round(w * k)); h = Math.max(5, Math.round(h * k));
    const c = viewCentre();
    const same = Object.entries(S.doc.images).find(([, x]) => x.src === src);    // pasted twice: kept once
    const img = same ? same[0] : nextImageId();
    if (!same) S.doc.images[img] = { src, name: name || '' };
    if (S.editing) finishText();
    change(() => {
        const s = { id: nextShapeId(), type: 'image', img, style: {}, w, h,
                    x: Math.round(Math.max(0, Math.min(p.width - w, c.x - w / 2))), y: Math.round(Math.max(0, Math.min(p.height - h, c.y - h / 2))) };
        p.shapes.push(s);
        S.sel = [s.id];
    });
    if (S.tool !== 'pointer') setTool('pointer');
}

// ---- Insert > Fault tree (workbench): a page of the Manual FTA, the FTA tab or the Semi-manual FTA as a picture ----------------------
// The page itself draws it: opened in a hidden frame with ?picture=1, it answers with the PNG of its diagram
// (graph_export.js :: sendPicture) -- exactly what the tab shows (compact display, system in scope as chosen there),
// with the model revision above each top event.

function ftaPicture(url) {
    return new Promise((resolve, reject) => {
        const frame = document.createElement('iframe');
        frame.className = 'dw-picture-frame';
        frame.setAttribute('aria-hidden', 'true');
        frame.tabIndex = -1;
        const finish = (fn, value) => { clearTimeout(timer); window.removeEventListener('message', onMessage); frame.remove(); fn(value); };
        const onMessage = e => {
            if (e.source !== frame.contentWindow || e.origin !== location.origin || !e.data || e.data.type !== 'fta-picture') return;
            if (e.data.empty) finish(reject, new Error('That page has no fault tree.'));
            else if (e.data.error) finish(reject, new Error(e.data.error));
            else finish(resolve, e.data);
        };
        const timer = setTimeout(() => finish(reject, new Error('The fault tree page did not answer within a minute.')), 60000);
        window.addEventListener('message', onMessage);
        frame.src = url + (url.includes('?') ? '&' : '?') + 'picture=1';
        document.body.appendChild(frame);
    });
}

function pageLabel(p) {
    const tree = p.code ? `${p.code} ${p.title || ''}` : (p.trees || []).length === 1 ? `${p.trees[0].id} ${p.trees[0].title || ''}` : '';
    return `Page ${p.number}` + (tree.trim() ? ` — ${tree.trim()}` : (p.trees || []).length > 1 ? ` (${p.trees.length} trees)` : '');
}

async function ftaDialog() {
    const dlg = $('dw-fta-dialog'), list = $('dw-fta-list'), info = $('dw-fta-status');
    if (!dlg) return;
    list.innerHTML = '<div class="dw-muted" style="padding:6px;">Loading…</div>';
    info.textContent = '';
    dlg.showModal();
    const enc = encodeURIComponent, out = [];
    const item = (src, name, text) => `<button type="button" class="dw-dd-item" data-src="${esc(src)}" data-name="${esc(name)}">${esc(text)}</button>`;
    try {
        const r = await fetch('/api/manual-fta/explorer', { cache: 'no-store' });      // 404 while the plugin is off
        if (r.ok) for (const a of (await r.json()).analyses) {
            out.push(`<div class="dw-dd-title">Manual FTA — ${esc(a.name)}</div>`);
            for (const p of a.pages)
                out.push(item(`/manual-fta?analysis=${enc(a.id)}${p.id ? '&page=' + enc(p.id) : ''}`, `Manual FTA "${a.name}", ${pageLabel(p)}`, pageLabel(p)));
            if (!a.pages.length) out.push('<div class="dw-muted" style="padding:2px 8px;">no fault tree yet</div>');
        }
    } catch (e) { /* none */ }
    try {
        const r = await fetch('/api/graph/fta-tree/page', { cache: 'no-store' });
        const pages = r.ok ? (await r.json()).pages || [] : [];
        if (pages.length) {
            out.push('<div class="dw-dd-title">FTA (derived from the model)</div>');
            for (const p of pages) out.push(item(`/fta?page=${enc(p.id)}`, `FTA, ${pageLabel(p)}`, pageLabel(p)));
        }
    } catch (e) { /* none */ }
    try {
        const r = await fetch('/api/semi-manual-fta/graph', { cache: 'no-store' });     // 404 while the plugin is off
        const pages = r.ok ? (await r.json()).pages || [] : [];
        if (pages.length) {
            out.push('<div class="dw-dd-title">Semi-manual FTA</div>');
            for (const p of pages) out.push(item(`/semi-manual-fta?page=${enc(p.id)}`, `Semi-manual FTA, ${pageLabel(p)}`, pageLabel(p)));
        }
    } catch (e) { /* none */ }
    list.innerHTML = out.join('') || '<div class="dw-muted" style="padding:6px;">This project has no fault trees.</div>';
    list.onclick = async e => {
        const b = e.target.closest('[data-src]');
        if (!b || list.dataset.busy) return;
        list.dataset.busy = '1';
        list.querySelectorAll('button').forEach(x => { x.disabled = true; });
        info.textContent = 'Drawing the fault tree…';
        try {
            const pic = await ftaPicture(b.dataset.src);
            dlg.close();
            insertPicture(pic.src, pic.width, pic.height, b.dataset.name + (pic.revision ? `, model revision ${pic.revision}` : ''));
        } catch (err) {
            info.textContent = err.message;
        } finally {
            delete list.dataset.busy;
            list.querySelectorAll('button').forEach(x => { x.disabled = false; });
        }
    };
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

// In the workbench: asks which work product the export is for and hands its document control to
// `fn` (export_control.js, SFM-225); nothing when cancelled. In the standalone `fn(null)`.
async function withControl(content, fn) {
    if (!window.exportControl) return fn(null);
    const c = await exportControl.ask(content);
    if (c) fn(c);
}

const FOOTER_SIZE = 9, FOOTER_GREY = '#9ca3af';

// The page as a standalone SVG: the page area only, without grid, selection or link badges. `footer`
// (optional): the document control (SFM-225), in light grey below the page, split to fit its width.
function pageSvg(footer, p = page()) {
    for (const s of p.shapes) if (ONE_D.has(s.type)) resolveEnds(p, s);
    const lines = footer ? exportControl.wrap(footer, Math.max(60, Math.floor(p.width / (FOOTER_SIZE * 0.52)))) : [];
    const h = p.height + (lines.length ? lines.length * (FOOTER_SIZE + 3) + 8 : 0);
    const text = lines.map((t, i) => `<text x="8" y="${p.height + 4 + (i + 1) * (FOOTER_SIZE + 3)}" font-family="Arial, Helvetica, sans-serif" `
        + `font-size="${FOOTER_SIZE}" fill="${FOOTER_GREY}">${xmlEsc(t)}</text>`).join('');
    return `<svg xmlns="${SVGNS}" width="${p.width}" height="${h}" viewBox="0 0 ${p.width} ${h}">${markerDefs()}`
        + `<rect width="${p.width}" height="${h}" fill="#ffffff"/>${p.shapes.map(s => shapeSvg(p, s, true)).join('')}${text}</svg>`;
}

function exportPng(footer) {
    const p = page(), scale = Math.max(1, Math.min(4, 8000 / Math.max(p.width, p.height)));
    const svg = pageSvg(footer);
    const height = Number(/height="([0-9.]+)"/.exec(svg)[1]);
    const img = new Image();
    img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(p.width * scale); canvas.height = Math.round(height * scale);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(blob => download(blob, fileBase() + '.png'), 'image/png');
    };
    img.onerror = () => alert('The PNG export failed in this browser -- use Export SVG.');
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

async function importXml(file) {
    let imported;
    try { imported = parseXml(await file.text()); } catch (e) { alert(`${file.name}: ${e.message}`); return; }
    const added = [], remap = {};
    for (const [id, im] of Object.entries(imported.images)) {      // the same picture is kept once
        const same = Object.entries(S.doc.images).find(([, x]) => x.src === im.src);
        remap[id] = same ? same[0] : nextImageId();
        if (!same) S.doc.images[remap[id]] = im;
    }
    for (const p of imported.pages) for (const s of p.shapes) if (s.type === 'image') s.img = remap[s.img];
    const ids = {};
    change(() => {
        for (const p of imported.pages) {
            const copy = { ...p, id: nextPageId(), name: uniquePageName(p.name) };
            ids[p.id] = copy.id;
            S.doc.pages.push(copy);
            added.push(copy);
        }
        for (const p of added) { if (p.parent && ids[p.parent]) p.parent = ids[p.parent]; else delete p.parent; }   // SFM-313
    });
    if (added.length) { openPage(added[0].id); status(`Imported ${added.length} page(s) from ${file.name}`); }
}

const ACTIONS = {
    'dw-page-new': () => newPage(page().parent || '')(),
    'dw-page-sub': () => newPage(page().id)(),
    'dw-page-rename': async () => {
        const p = page();
        const name = await askText('Rename page', p.name);
        if (name && name !== p.name) change(() => { p.name = name; });
    },
    'dw-page-copy': () => {
        const p = page();
        const copy = { ...JSON.parse(JSON.stringify(p)), id: nextPageId(), name: uniquePageName(p.name + ' (copy)') };
        change(() => { S.doc.pages.splice(S.doc.pages.indexOf(p) + 1, 0, copy); });     // next to it, same parent
        openPage(copy.id);
    },
    'dw-page-delete': () => deletePage(page().id),
    'dw-rev-save-now': () => saveRevision('').catch(e => { status(e.message, true); alert(e.message); }),
    'dw-revisions': () => revisionsDialog(false),
    'dw-grid-toggle': () => setGrid(!S.grid),
    'dw-folder': async () => { try { await S.store.chooseFolder(); } catch (e) { alert(e.message); } updateFolderUi(); },
    'dw-folder-stop': async () => { await S.store.stopFolder(); updateFolderUi(); },
    'dw-export-png': () => withControl(`Drawing page "${page().name}", PNG`, c => exportPng(c && c.line)),
    'dw-export-svg': () => withControl(`Drawing page "${page().name}", SVG`, c => download(
        new Blob([pageSvg(c && c.line)], { type: 'image/svg+xml' }), fileBase() + '.svg')),
    'dw-export-xml': () => withControl('All drawing pages, XML', c => download(new Blob(
        [c ? exportControl.xmlWithComment(toXml(S.doc), c.xml_comment) : toXml(S.doc)], { type: 'application/xml' }), 'drawings.xml')),
    'dw-import-xml': () => $('dw-import-file').click(),
    'dw-help': () => $('dw-help-dialog').showModal(),
    'dw-undo': () => undoRedo(S.undo, S.redo),
    'dw-redo': () => undoRedo(S.redo, S.undo),
    // through the browser's copy / cut event, so the clipboard says "shapes" (see onCopy); without it, only here
    'dw-cut': () => { if (!document.execCommand('cut')) copySelected(true); },
    'dw-copy': () => { if (!document.execCommand('copy')) copySelected(false); },
    'dw-paste': async () => { if (!(await pasteFromClipboard(false))) paste(); },
    'dw-insert-clip': async () => {
        if (!(await pasteFromClipboard(true)))
            alert('No picture found -- copy one (e.g. a screenshot), then press Ctrl+V on the drawing. '
                  + '(The menu can only read the clipboard where the browser allows it; Ctrl+V always works.)');
    },
    'dw-insert-fta': () => ftaDialog(),
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
        `<button type="button" class="dw-dd-item" data-value="rect">${ICON_RECT} Rectangle</button><button type="button" class="dw-dd-item" data-value="ellipse">${ICON_ELLIPSE} Ellipse</button><button type="button" class="dw-dd-item" data-value="line">${ICON_LINE} Line</button><button type="button" class="dw-dd-item" data-value="person">${ICON_PERSON} Person</button>`,
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
    wirePages();
    wireGrid();
    wireSearch();
    wireRevisions();
    $('dw-import-file').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) importXml(f); });
    $('dw-text-dialog-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('dw-text-dialog').close('ok'); } });

    document.addEventListener('keydown', e => {
        if (e.key === ' ' && !e.target.closest('input, textarea, select')) { S.spaceDown = true; }
        const ctrlKey = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
        if (ctrlKey && key === 'f' && !S.editing && !document.querySelector('dialog[open]')) {      // SFM-309
            e.preventDefault(); $('dw-search').focus(); $('dw-search').select(); return;
        }
        if (ctrlKey && key === 's' && !document.querySelector('dialog[open]')) { e.preventDefault(); if (S.editing) finishText(); ACTIONS['dw-rev-save-now'](); return; }   // SFM-310
        if (document.querySelector('dialog[open]') || e.target.closest('input, textarea, select') || S.editing) return;
        const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
        const map = { z: 'dw-undo', y: 'dw-redo', a: 'dw-select-all', b: 'dw-bold', i: 'dw-italic', u: 'dw-underline' };
        if (ctrl && k === 'd') { e.preventDefault(); copySelected(false); paste(); return; }
        if (ctrl && 'cxv'.includes(k)) return;          // the browser's copy / cut / paste events do it (SFM-291)
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
        else if (S.sel.length === 1 && e.key.length === 1 && !e.altKey && !ONE_D.has(selected()[0].type) && selected()[0].type !== 'image') {   // typing replaces the text, like Visio
            e.preventDefault();
            startText(S.sel[0]);
            $('dw-text').value = e.key;
        }
    });
    document.addEventListener('keyup', e => { if (e.key === ' ') S.spaceDown = false; });
    document.addEventListener('copy', e => onCopy(e, false));
    document.addEventListener('cut', e => onCopy(e, true));
    document.addEventListener('paste', onPaste);
    window.addEventListener('resize', () => render());
}

function contextMenu(evt) {
    const id = hitShape(evt.target);
    if (id && !S.sel.includes(id)) select([id]);
    const items = [];
    if (S.sel.length) {
        items.push(['Edit text', () => startText(S.sel[0]), S.sel.length !== 1 || selected()[0].type === 'image'], ['Cut', () => copySelected(true)], ['Copy', () => copySelected(false)]);
        if (S.clipboard) items.push(['Paste', () => paste()]);
        const one = S.sel.length === 1 ? selected()[0] : null;
        if (one && !ONE_D.has(one.type)) {                                // SFM-305
            for (const dir of Object.keys(CONNECT_DIRS)) items.push([`Add connected shape ${dir}`, () => addConnected(dir), false, 'dw-add-connected']);
            if (treeChildren(page(), one.id).length) items.push(['Arrange as tree…', () => treeDialog(one.id)]);       // SFM-307
            if (one.attach) items.push(['Detach note', () => change(() => { delete one.attach; })], [`Select ${one.attach}`, () => select([one.attach])]);
            else items.push(['Add note', addNote]);                                                                       // SFM-311
        }
        if (selected().every(s => ONE_D.has(s.type))) items.push(...lineItems(selected()));       // SFM-323
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
    showMenu(items, evt.clientX, evt.clientY);
}

// SFM-323: right-click on lines / connectors -- routing (connectors), which ends carry an arrow, reverse the direction.
// The current choice carries a tick (when all selected lines agree).
const ARROW_CHOICES = [['Arrow at the end', false, true], ['Arrow at the start', true, false], ['Arrows at both ends', true, true], ['No arrows', false, false]];

function lineItems(lines) {
    const tick = (on, label) => (on ? '✓ ' : '') + label;
    const items = [];
    const conns = lines.filter(s => s.type === 'connector');
    if (conns.length) {
        const route = s => (s.route === 'straight' ? 'straight' : 'orthogonal');
        for (const [r, label] of [['straight', 'Straight arrow'], ['orthogonal', 'Right-angle arrow']])
            items.push([tick(conns.every(s => route(s) === r), label), () => change(() => { for (const s of conns) { s.route = r; delete s.midX; delete s.midY; } }), false, 'dw-line-item']);
    }
    for (const [label, start, end] of ARROW_CHOICES) {
        const on = lines.every(s => !!styleOf(s).arrowStart === start && !!styleOf(s).arrowEnd === end);
        items.push([tick(on, label), () => change(() => { for (const s of lines) s.style = { ...s.style, arrowStart: start, arrowEnd: end }; }), false, 'dw-line-item']);
    }
    items.push(['Reverse direction', () => change(() => lines.forEach(reverseLine)), false, 'dw-line-item']);
    const bent = conns.filter(s => s.midX !== undefined || s.midY !== undefined);
    if (bent.length) items.push(['Automatic right angles', () => change(() => bent.forEach(s => { delete s.midX; delete s.midY; })), false, 'dw-line-item']);
    return items;
}

// Swaps a line's / connector's two ends (points and glue): the arrow then points the other way and the tree
// direction (from -> to, SFM-307) follows it.
function reverseLine(s) {
    [s.x1, s.y1, s.x2, s.y2] = [s.x2, s.y2, s.x1, s.y1];
    for (const [a, b] of [['from', 'to'], ['fromAt', 'toAt'], ['fromPt', 'toPt']]) {
        const va = s[a], vb = s[b];
        if (vb === undefined) delete s[a]; else s[a] = vb;
        if (va === undefined) delete s[b]; else s[b] = va;
    }
}

// The right-click menu at a screen point (fixed position: also for the pages panel); items [label, fn, disabled, class]
function showMenu(items, x, y) {
    const menu = $('dw-menu');
    menu.innerHTML = items.map(([label, , disabled, cls], i) => `<button type="button" class="context-menu-item ${cls || ''}" data-i="${i}"${disabled ? ' disabled' : ''}>${esc(label)}</button>`).join('');
    menu.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { menu.hidden = true; items[+b.dataset.i][1](); }));
    menu.style.position = 'fixed';
    menu.hidden = false;
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.max(0, Math.min(x, window.innerWidth - w - 4)) + 'px';
    menu.style.top = Math.max(0, Math.min(y, window.innerHeight - h - 4)) + 'px';
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
    try { S.collapsed = new Set(JSON.parse(localStorage.getItem(KEY_COLLAPSED) || '[]')); } catch (e) { S.collapsed = new Set(); }
    let panel = '1';
    try { panel = localStorage.getItem(KEY_PANEL) ?? '1'; } catch (e) { /* private window */ }
    document.querySelectorAll('.dw-model-only').forEach(el => { el.hidden = !S.store.models; });
    schedulePictures();                       // pictures missing or out of date (SFM-335), e.g. drawn before
    wire();
    setPagesPanel(panel !== '0');
    updateFolderUi();
    await loadObjects();
    setTool('pointer');
    requestAnimationFrame(fit);                // after the page layout has settled
    status('');
}

const serverStore = {
    models: true,
    // revisions (SFM-310): model/drawing_versions of the open project, see app/services/drawing_versions.py
    async versions() {
        const r = await fetch('/api/drawings/versions', { cache: 'no-store' });
        if (!r.ok) throw new Error(`Loading the revisions failed (${r.status})`);
        return (await r.json()).versions;
    },
    async version(n) {
        const r = await fetch(`/api/drawings/versions/${n}`, { cache: 'no-store' });
        if (!r.ok) throw new Error(`Revision ${n} could not be read (${r.status})`);
        return r.text();
    },
    async saveVersion(xml, meta) {
        const r = await fetch('/api/drawings/versions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ xml, ...meta }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.detail || `Saving the revision failed (${r.status})`);
        return d;
    },
    async load() {
        const r = await fetch('/api/drawings', { cache: 'no-store' });
        if (!r.ok) throw new Error(`Loading failed (${r.status})`);
        return r.text();
    },
    async save(xml) {
        const r = await fetch('/api/drawings', { method: 'PUT', headers: { 'Content-Type': 'application/xml' }, body: xml });
        if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.detail || `Saving failed (${r.status})`); }
    },
    // the pages' pictures for the LaTeX documents (SFM-335, app/services/drawing_pictures.py)
    pictures: true,
    async stalePictures() {
        const r = await fetch('/api/drawings/pictures/stale', { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()).stale;
    },
    async savePicture(pageId, blob) {
        const r = await fetch(`/api/drawings/pictures/${encodeURIComponent(pageId)}`, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: blob });
        if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.detail || `HTTP ${r.status}`); }
    },
};

window.Drawing = { init, parseXml, toXml, checkDoc, connectorPoints, pageSvg, state: S, get page() { return page(); },
                   setTool, select, startText, finishText, insertPicture, render, diffDocs, branchOf, arrangeTree, saveRevision,
                   flushSave, pageOrder, goToShape, pagePng, get pictures() { return pictureRun; } };
})();
