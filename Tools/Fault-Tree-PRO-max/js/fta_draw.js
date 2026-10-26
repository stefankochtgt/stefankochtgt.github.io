// Shared drawing of fault trees (FTA view, fta.html, and Manual FTA, manual_fta.html): one block
// per event in the style of the user's reference FTA tool, and the right-angled connector lines.
// Both pages feed it the node/edge format of graph.py :: build_fta_tree_graph().
// Drawing of the fault tree in the style of the user's reference FTA tool; every number below is
// taken from that tool's own EMF export (logical units / 60, a gate is 40 x 48 units). One event is one
// block: description box, a short stub, the symbol hanging below it (OR gate, AND gate, basic-event
// circle, or nothing for a single cause), and the ID label box across the symbol. Must match
// graph.py's FTA_UNIT / row pitch, which lays the blocks out on the same grid.
const U = 1.5;                        // px per unit (graph.py FTA_UNIT)
const BOX_W = 75.2, BOX_H = 44;       // description box
const SYM_X = (BOX_W - 40) / 2, SYM_TOP = 48, SYM_W = 40, SYM_H = 48;
const LABEL_X = 1.6, LABEL_TOP = 64, LABEL_W = 72, LABEL_H = 16;
const BLOCK_H = SYM_TOP + SYM_H;      // 96
const BUS = BLOCK_H + 8;              // horizontal connector line, 8 units below the gate
const OR_TOP_R = 29.6, OR_SIDE_Y = 28;               // pointed top: two arcs meeting at the tip
const OR_BOTTOM_R = 37.658, OR_BOTTOM_RISE = 5.75;   // concave bottom edge
const FILL = '#ADD8E6', STROKE = '#000';
const ADDED_FILL = '#FDE68A';  // hand-added gates / events in the Semi-manual FTA (SFM-122)
const OUT_FILL = '#d1d5db';   // fill of events and gates outside the system in scope (SFM-119); text and lines stay black
// Criticality box to the right of an event's description box, wide enough for "H3+"/"H4+"/"ANY".
// The node is widened by one box on *both* sides so its centre -- and the connector geometry -- stays on the box.
const TAG_SIZE = 14, TAG_W = 22, TAG_GAP = 2, TAG_X = BOX_W + TAG_GAP;
const EVENT_TAG_Y = BOX_H / 2 - TAG_SIZE / 2;
const NODE_W = BOX_W + 2 * (TAG_GAP + TAG_W);

const TRI_TIP = LABEL_TOP - 7;        // tip of the triangle symbols, 7 units above the ID label
const GATE_PATHS = {
    or: `M20 0 A${OR_TOP_R} ${OR_TOP_R} 0 0 0 0 ${OR_SIDE_Y} V${SYM_H} `
      + `A${OR_BOTTOM_R} ${OR_BOTTOM_R} 0 0 1 ${SYM_W} ${SYM_H} V${OR_SIDE_Y} `
      + `A${OR_TOP_R} ${OR_TOP_R} 0 0 0 20 0 Z`,
    and: `M0 ${SYM_H} V20 A20 20 0 0 1 ${SYM_W} 20 V${SYM_H} Z`,
    // Manual FTA: a gate with nothing below it yet -- a triangle whose tip sits behind the ID label
    // its tip shows above the ID label (user, 2026-10-23), the stub runs down to it
    triangle: `M${SYM_W / 2} ${TRI_TIP - SYM_TOP} L${SYM_W} ${SYM_H} H0 Z`,
    // Manual FTA: the branch continues on another page (SFM-184) -- transfer triangle, page number in it
    transfer: `M${SYM_W / 2} ${TRI_TIP - SYM_TOP} L${SYM_W} ${SYM_H} H0 Z`,
};
const TRANSFER_TEXT_Y = (LABEL_TOP + LABEL_H + BLOCK_H) / 2 + 0.5;
// A gate continued from an earlier page (Manual FTA, on top of its continuation page: data.page_start) gets a small
// transfer-in triangle on the side, joined to the stub by a short line -- as Reliability Workbench draws it
// (user, 2026-10-23, screenshot). fta_tikz.py / standalone/fta_tikz.js draw the same.
const SIDE_Y = SYM_TOP - 2, SIDE_DX = 28, SIDE_TRI_H = 12, SIDE_TRI_HALF = 7;
const SIDE_TEXT_Y = SIDE_Y + SIDE_TRI_H * 0.68;   // "…" in the lower, wider part of the side triangle
const pageStart = d => !!d.page_start;      // not a tree on a page of its own (SFM-192): nothing continues there

// ---- the title always fits its description box (SFM-186) -------------------------------------------
// app/services/text_fit.py :: fit_title(), line for line (a browser test compares them): measured with the
// Helvetica / Arial widths, wrapped at spaces (an over-long word broken), the font made smaller in steps
// of 0.25 units until all lines fit; only at the smallest size the last line ends in "…".
const TITLE_W = BOX_W - 6, TITLE_H = BOX_H - 4, TITLE_SIZE = 6.0, TITLE_MIN = 2.5, TITLE_STEP = 0.25, TITLE_LEAD = 1.18;
const HELV_ASCII = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const HELV = Object.assign(Object.fromEntries(HELV_ASCII.map((w, i) => [String.fromCharCode(32 + i), w])),
    { '…': 1000, 'ß': 611, '–': 556, '—': 1000, '„': 333, '“': 333, '”': 333, '’': 222, '°': 400 });
function charWidth(ch) {
    let w = HELV[ch];
    if (w === undefined) w = HELV[Array.from(ch.normalize('NFD'))[0]];
    return w === undefined ? 556 : w;
}
const textWidth = t => Array.from(t).reduce((sum, ch) => sum + charWidth(ch), 0);
const titleFits = (t, size) => textWidth(t) * size <= TITLE_W * 1000;
function wrapTitle(words, size) {
    const lines = [];
    let current = '';
    for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (titleFits(candidate, size)) { current = candidate; continue; }
        if (current) { lines.push(current); current = ''; }
        if (titleFits(word, size)) { current = word; continue; }
        // a word wider than the box: broken after a "/" (CG/Mass/Inertia), else where it has to be
        let chunk = '';
        for (const piece of word.split(/(?<=\/)/)) {
            if (!piece) continue;
            if (titleFits(chunk + piece, size)) { chunk += piece; continue; }
            if (chunk && titleFits(piece, size)) { lines.push(chunk); chunk = piece; continue; }
            for (const ch of Array.from(piece)) {
                if (titleFits(chunk + ch, size) || !chunk) chunk += ch;
                else { lines.push(chunk); chunk = ch; }
            }
        }
        current = chunk;
    }
    if (current) lines.push(current);
    return lines;
}
function fitTitle(text, maxH = TITLE_H) {      // maxH: compact display, a lower title area (SFM-200)
    const words = (text || '').split(/\s+/).filter(Boolean);
    if (!words.length) return { lines: [], size: TITLE_SIZE };
    let k = 0, size, lines;
    while (true) {
        size = TITLE_SIZE - TITLE_STEP * k;
        lines = wrapTitle(words, size);
        if (lines.length * TITLE_LEAD * size <= maxH || size <= TITLE_MIN) break;
        k += 1;
    }
    if (lines.length * TITLE_LEAD * size > maxH) {
        const keep = Math.max(1, Math.floor(maxH / (TITLE_LEAD * size)));
        lines = lines.slice(0, keep);
        let last = Array.from(lines[lines.length - 1]);
        while (last.length && !titleFits(last.join('') + '…', size)) last = last.slice(0, -1);
        lines[lines.length - 1] = last.join('').trimEnd() + '…';
    }
    return { lines, size };
}
// ---- compact display (SFM-200): the same blocks, closer together; the ASIL / H square (top right) inside the
// description box, the title below it (the label stays outside, framed, SFM-212). fta_tikz.py / .js draw the same.
const C_TAG_H = 9, C_TAG_FONT = 5.6, C_INSET = 1.5, C_TITLE_DROP = 11;
const compactCorner = d => !!d.compact && !!d.tag;
const cTagWidth = tag => Math.max(C_TAG_H, textWidth(tag) * C_TAG_FONT / 1000 + 3);
function compactCornerSvg(d) {
    let s = '', tagW = 0;
    if (d.tag) {
        tagW = cTagWidth(d.tag);
        s += `<rect x="${BOX_W - C_INSET - tagW}" y="${C_INSET}" width="${tagW}" height="${C_TAG_H}" fill="#fff" stroke-width="0.45"/>`
           + `<text x="${BOX_W - C_INSET - tagW / 2}" y="${C_INSET + C_TAG_H / 2}" dominant-baseline="central" text-anchor="middle"`
           + ` font-family="Arial, Helvetica, sans-serif" font-size="${C_TAG_FONT}" font-weight="bold" fill="#000" stroke="none">${escapeXml(d.tag)}</text>`;
    }
    return s;
}
// the node data the views draw the title from: `fit_label` (lines) at `fit_size` px; compact with a square / label in
// the box: a lower title area, moved down (`fit_shift`, FIT_SHIFT_STYLE)
function fitLabel(d) {
    const corner = compactCorner(d);
    const f = fitTitle(d.label || '', corner ? TITLE_H - C_TITLE_DROP : TITLE_H);
    d.fit_label = f.lines.join('\n');
    d.fit_size = f.size * U;
    if (corner) d.fit_shift = 1; else delete d.fit_shift;
    return d;
}
// the cytoscape style of a fitted title (after the node style; nodes without fit_label keep theirs)
const FIT_STYLE = { selector: 'node[fit_label]', style: {
    'label': 'data(fit_label)', 'font-size': 'data(fit_size)', 'line-height': TITLE_LEAD, 'text-max-width': BOX_W * U } };
// compact display: the title below the square / label in the box (SFM-200)
const FIT_SHIFT_STYLE = { selector: 'node[fit_shift]', style: { 'text-margin-y': (BOX_H / 2 - BLOCK_H / 2 + C_TITLE_DROP / 2) * U } };

function escapeXml(s) {
    return String(s).replace(/[<>&"']/g, c => ({'<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;'}[c]));
}

function symbolSvg(symbol) {
    if (symbol === 'basic') return `<circle cx="${BOX_W / 2}" cy="${SYM_TOP + SYM_H / 2}" r="${SYM_H / 2}"/>`;
    if (GATE_PATHS[symbol]) return `<path transform="translate(${SYM_X},${SYM_TOP})" d="${GATE_PATHS[symbol]}"/>`;
    return '';
}

function tagSvg(x, y, value) {
    if (!value) return '';                         // never an empty box (user, 2026-10-21)
    const fit = value.length > 3 ? ` textLength="${TAG_W - 3}" lengthAdjust="spacingAndGlyphs"` : '';   // "ASIL D"
    return `<rect x="${x}" y="${y}" width="${TAG_W}" height="${TAG_SIZE}" fill="#fff"/>`
         + `<text x="${x + TAG_W / 2}" y="${y + TAG_SIZE / 2}" dominant-baseline="central" text-anchor="middle"${fit}`
         + ` font-family="Arial, Helvetica, sans-serif" font-size="7" font-weight="bold"`
         + ` fill="#000" stroke="none">${escapeXml(value)}</text>`;
}

function blockSvg(d) {
    const isGate = d.type === 'or_gate' || d.type === 'and_gate';
    let body = symbolSvg(d.symbol);
    if (!isGate) {
        const stubEnd = d.symbol === 'none' ? LABEL_TOP : d.symbol === 'triangle' || d.symbol === 'transfer' ? TRI_TIP : SYM_TOP;
        body = `<rect x="0" y="0" width="${BOX_W}" height="${BOX_H}"${d.shared ? ' stroke-dasharray="3 2"' : ''}/>`
             + `<line x1="${BOX_W / 2}" y1="${BOX_H}" x2="${BOX_W / 2}" y2="${stubEnd}"/>`
             + (pageStart(d)
                ? `<line x1="${BOX_W / 2}" y1="${SIDE_Y}" x2="${BOX_W / 2 + SIDE_DX}" y2="${SIDE_Y}"/>`
                  + `<path class="page-start" d="M${BOX_W / 2 + SIDE_DX} ${SIDE_Y} L${BOX_W / 2 + SIDE_DX + SIDE_TRI_HALF} ${SIDE_Y + SIDE_TRI_H}`
                  + ` H${BOX_W / 2 + SIDE_DX - SIDE_TRI_HALF} Z"/>`
                  + `<text x="${BOX_W / 2 + SIDE_DX}" y="${SIDE_TEXT_Y}" dominant-baseline="central" text-anchor="middle"`
                  + ` font-family="Arial, Helvetica, sans-serif" font-size="6" font-weight="bold" fill="${d.text_color || '#000'}"`
                  + ` stroke="none">…</text>` : '')       // a click on it goes back to the page it continues from (SFM-193)
             + body
             + `<rect x="${LABEL_X}" y="${LABEL_TOP}" width="${LABEL_W}" height="${LABEL_H}"/>`
             + `<text x="${BOX_W / 2}" y="${LABEL_TOP + LABEL_H / 2}" dominant-baseline="central" text-anchor="middle"`
             + ` font-family="Arial, Helvetica, sans-serif" font-size="7.5" fill="${d.text_color || '#000'}" stroke="none">${escapeXml(d.code)}</text>`
             + (d.symbol === 'transfer' && d.page_number
                ? `<text x="${BOX_W / 2}" y="${TRANSFER_TEXT_Y}" dominant-baseline="central" text-anchor="middle"`
                  + ` font-family="Arial, Helvetica, sans-serif" font-size="9" font-weight="bold" fill="${d.text_color || '#000'}"`
                  + ` stroke="none">…</text>` : '')         // on screen "…": a click on it opens the page (user, 2026-10-23)
             + (d.compact ? compactCornerSvg(d)                          // compact: the square in the box (SFM-200)
                : d.type === 'manual_event' && !d.tag_box ? '' : tagSvg(TAG_X, EVENT_TAG_Y, d.tag));   // hand-added Semi-manual events: none
    }
    const left = (NODE_W - BOX_W) / 2;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${NODE_W * U}" height="${BLOCK_H * U}" `
              + `viewBox="${-left - 0.5} -0.5 ${NODE_W + 1} ${BLOCK_H + 1}">`
              + `<g fill="${d.out_of_scope ? OUT_FILL : d.fill || (d.added ? ADDED_FILL : FILL)}" stroke="${STROKE}" stroke-width="0.6">${body}</g></svg>`;
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

// Where an input line leaves the node above it, relative to that block's top-left corner (units):
// spread along the gate's bottom edge (on the concave curve for OR), from the label box for a
// single cause.
// Where an input line leaves the node above it, relative to that block's top-left corner (units):
// spread along the gate's bottom edge (on the concave curve for OR), from the label box for a
// single cause.
function inputPoint(symbol, index, count) {
    if (symbol !== 'or' && symbol !== 'and') return { x: BOX_W / 2, y: LABEL_TOP + LABEL_H };
    const step = count > 1 ? Math.min(13.33, 34 / (count - 1)) : 0;
    const dx = (index - (count - 1) / 2) * step;
    if (symbol === 'and') return { x: BOX_W / 2 + dx, y: BLOCK_H };
    const centreY = SYM_TOP + SYM_H - OR_BOTTOM_RISE + OR_BOTTOM_R;
    return { x: BOX_W / 2 + dx, y: centreY - Math.sqrt(OR_BOTTOM_R * OR_BOTTOM_R - dx * dx) };
}

// Height (units below the upper block's top) of each input line's horizontal run, so the lines of
// one gate run as separate parallel lines that never overlap or cross (user, 2026-10-01): on each
// side of the gate the outermost input turns closest to the gate, each further one a step lower;
// an input straight below its exit point has no horizontal run. Keyed by edge id.
const BUS_FIRST = BLOCK_H + 4, BUS_STEP = 4, BUS_SPAN = 22;
const COMPACT_BUS_SPAN = 8;                 // compact rows (110 apart): the lines stay between 100 and 108 (SFM-200)
function busLevels(nodes, edges) {
    const byId = Object.fromEntries(nodes.map(n => [n.data.id, n]));
    const groups = {};
    edges.forEach(e => { (groups[e.data.source] = groups[e.data.source] || []).push(e); });
    const level = {};
    for (const [source, list] of Object.entries(groups)) {
        const upper = byId[source];
        if (!upper) continue;
        const upperLeft = upper.position.x - BOX_W * U / 2;
        const items = list.filter(e => byId[e.data.target]).map(e => ({
            id: e.data.id,
            exitX: upperLeft + inputPoint(upper.data.symbol, e.data.input_index, e.data.input_count).x * U,
            childX: byId[e.data.target].position.x,
        }));
        const lefts = items.filter(i => i.childX < i.exitX - 0.5).sort((a, b) => a.childX - b.childX);
        const rights = items.filter(i => i.childX > i.exitX + 0.5).sort((a, b) => b.childX - a.childX);
        const ranks = Math.max(lefts.length, rights.length);
        const span = upper.data.compact ? COMPACT_BUS_SPAN : BUS_SPAN;
        const step = ranks > 1 ? Math.min(BUS_STEP, span / (ranks - 1)) : 0;
        items.forEach(i => { level[i.id] = BUS_FIRST; });
        [lefts, rights].forEach(side => side.forEach((i, k) => { level[i.id] = BUS_FIRST + k * step; }));
    }
    return level;
}

// Right-angled connector lines, drawn as straight edges between invisible junction nodes: down from
// the input point to its own horizontal level (busLevels()), across, and down into the description
// box (or a nested gate's tip).
function connectorElements(nodes, edges) {
    const byId = Object.fromEntries(nodes.map(n => [n.data.id, n]));
    const elements = [];
    const levels = busLevels(nodes, edges);
    edges.forEach(e => {
        const upper = byId[e.data.source], lower = byId[e.data.target];
        if (!upper || !lower) return;
        const upperLeft = upper.position.x - BOX_W * U / 2, upperTop = upper.position.y - BLOCK_H * U / 2;
        const lowerTop = lower.position.y - BLOCK_H * U / 2;
        const p = inputPoint(upper.data.symbol, e.data.input_index, e.data.input_count);
        const entryY = lowerTop + (lower.data.type.endsWith('_gate') ? SYM_TOP * U : 0);
        const pts = [
            [upperLeft + p.x * U, upperTop + p.y * U],
            [upperLeft + p.x * U, upperTop + levels[e.data.id] * U],
            [lower.position.x, upperTop + levels[e.data.id] * U],
            [lower.position.x, entryY],
        ];
        pts.forEach((pt, i) => elements.push({
            data: { id: `${e.data.id}#j${i}` }, classes: 'junction', position: { x: pt[0], y: pt[1] },
        }));
        for (let i = 0; i < 3; i++) {
            elements.push({ data: { id: `${e.data.id}#s${i}`, source: `${e.data.id}#j${i}`, target: `${e.data.id}#j${i + 1}` } });
        }
    });
    return elements;
}
