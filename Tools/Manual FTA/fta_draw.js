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

const GATE_PATHS = {
    or: `M20 0 A${OR_TOP_R} ${OR_TOP_R} 0 0 0 0 ${OR_SIDE_Y} V${SYM_H} `
      + `A${OR_BOTTOM_R} ${OR_BOTTOM_R} 0 0 1 ${SYM_W} ${SYM_H} V${OR_SIDE_Y} `
      + `A${OR_TOP_R} ${OR_TOP_R} 0 0 0 20 0 Z`,
    and: `M0 ${SYM_H} V20 A20 20 0 0 1 ${SYM_W} 20 V${SYM_H} Z`,
    // Manual FTA: a gate with nothing below it yet -- a triangle whose tip sits behind the ID label
    triangle: `M${SYM_W / 2} ${LABEL_TOP - SYM_TOP} L${SYM_W} ${SYM_H} H0 Z`,
};

function escapeXml(s) {
    return String(s).replace(/[<>&"']/g, c => ({'<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;'}[c]));
}

function symbolSvg(symbol) {
    if (symbol === 'basic') return `<circle cx="${BOX_W / 2}" cy="${SYM_TOP + SYM_H / 2}" r="${SYM_H / 2}"/>`;
    if (GATE_PATHS[symbol]) return `<path transform="translate(${SYM_X},${SYM_TOP})" d="${GATE_PATHS[symbol]}"/>`;
    return '';
}

function tagSvg(x, y, value) {
    return `<rect x="${x}" y="${y}" width="${TAG_W}" height="${TAG_SIZE}" fill="#fff"/>`
         + (value ? `<text x="${x + TAG_W / 2}" y="${y + TAG_SIZE / 2}" dominant-baseline="central" text-anchor="middle"`
                  + ` font-family="Arial, Helvetica, sans-serif" font-size="7" font-weight="bold"`
                  + ` fill="#000" stroke="none">${escapeXml(value)}</text>` : '');
}

function blockSvg(d) {
    const isGate = d.type === 'or_gate' || d.type === 'and_gate';
    let body = symbolSvg(d.symbol);
    if (!isGate) {
        const stubEnd = d.symbol === 'none' || d.symbol === 'triangle' ? LABEL_TOP : SYM_TOP;
        body = `<rect x="0" y="0" width="${BOX_W}" height="${BOX_H}"${d.shared ? ' stroke-dasharray="3 2"' : ''}/>`
             + `<line x1="${BOX_W / 2}" y1="${BOX_H}" x2="${BOX_W / 2}" y2="${stubEnd}"/>`
             + body
             + `<rect x="${LABEL_X}" y="${LABEL_TOP}" width="${LABEL_W}" height="${LABEL_H}"/>`
             + `<text x="${BOX_W / 2}" y="${LABEL_TOP + LABEL_H / 2}" dominant-baseline="central" text-anchor="middle"`
             + ` font-family="Arial, Helvetica, sans-serif" font-size="7.5" fill="#000" stroke="none">${escapeXml(d.code)}</text>`
             + (d.type === 'manual_event' ? '' : tagSvg(TAG_X, EVENT_TAG_Y, d.tag));   // no criticality in Manual FTA
    }
    const left = (NODE_W - BOX_W) / 2;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${NODE_W * U}" height="${BLOCK_H * U}" `
              + `viewBox="${-left - 0.5} -0.5 ${NODE_W + 1} ${BLOCK_H + 1}">`
              + `<g fill="${d.out_of_scope ? OUT_FILL : d.added ? ADDED_FILL : FILL}" stroke="${STROKE}" stroke-width="0.6">${body}</g></svg>`;
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
        const step = ranks > 1 ? Math.min(BUS_STEP, BUS_SPAN / (ranks - 1)) : 0;
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
