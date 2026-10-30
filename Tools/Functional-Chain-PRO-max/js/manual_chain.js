// Manual Functional Chain (SFM-217) -- also the whole of the standalone "Functional Chain PRO max"
// (scripts/build_standalone_chain.py): every function, sub-function, system and flow is drawn by hand.
// The drawing is the workbench's Functional Chain view (IDEF0 boxes, flow arrows, red dashed system
// borders): the same Cytoscape styles, and the automatic layout is a port of
// app/services/graph.py :: build_functional_chain_graph() -- keep them in step.
//
// The page holds the document in memory and saves it whole as XML through a store:
//   workbench  -> PUT /api/manual-chain (model/manual_chain.xml of the open project)
//   standalone -> window.CHAIN_STORE from standalone/chain_local.js (localStorage)
// The XML is also the Export / Import XML format.
(function () {
'use strict';

const FORMAT = 'safety-model-manual-chain';
// = graph.py _CHAIN_LEAF_WIDTH, _CHAIN_H_GAP, _CHAIN_DEPTH_GAP, _CHAIN_BORDER_MARGIN
const LEAF_WIDTH = 160, H_GAP = 40, DEPTH_GAP = 90, BORDER_MARGIN = 24;
const ID_RE = /^[A-Za-z0-9_.:\-]{1,60}$/;
const UNDO_LIMIT = 100;
const KEY_DIAGRAM = 'manualChainDiagram';

// ---- the document and its XML ----------------------------------------------------------------

function emptyDoc() {
    return { diagrams: [{ id: 'D1', name: 'Functional chain 1', functions: [], flows: [] }] };
}

function parseXml(text) {
    const xml = new DOMParser().parseFromString(text, 'application/xml');
    if (xml.getElementsByTagName('parsererror').length) throw new Error('Not valid XML.');
    const root = xml.documentElement;
    if (root.tagName !== 'manualFunctionalChain' || root.getAttribute('format') !== FORMAT)
        throw new Error(`Not a functional chain file (expected <manualFunctionalChain format="${FORMAT}">).`);
    const num = v => (v === null || v === '' ? null : Number(v));
    const doc = { diagrams: [] };
    for (const d of root.children) {
        if (d.tagName !== 'diagram') continue;
        const diagram = { id: d.getAttribute('id') || '', name: d.getAttribute('name') || '', functions: [], flows: [] };
        for (const el of d.children) {
            if (el.tagName === 'function') {
                const title = el.getElementsByTagName('title')[0];
                diagram.functions.push({
                    id: el.getAttribute('id') || '', title: title ? title.textContent : '',
                    parent: el.getAttribute('parent') || '', system: el.getAttribute('system') || '',
                    x: num(el.getAttribute('x')), y: num(el.getAttribute('y')),
                });
            } else if (el.tagName === 'flow') {
                diagram.flows.push({ source: el.getAttribute('source') || '', target: el.getAttribute('target') || '' });
            }
        }
        doc.diagrams.push(diagram);
    }
    checkDoc(doc);
    return doc;
}

const xmlEsc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const round = v => Math.round(v * 10) / 10;

function toXml(doc) {
    const out = ['<?xml version="1.0" encoding="UTF-8"?>', `<manualFunctionalChain format="${FORMAT}" version="1">`];
    for (const d of doc.diagrams) {
        if (!d.functions.length && !d.flows.length) { out.push(`  <diagram id="${xmlEsc(d.id)}" name="${xmlEsc(d.name)}"/>`); continue; }
        out.push(`  <diagram id="${xmlEsc(d.id)}" name="${xmlEsc(d.name)}">`);
        for (const f of d.functions) {
            const pos = f.x !== null && f.x !== undefined && f.y !== null && f.y !== undefined
                ? ` x="${round(f.x)}" y="${round(f.y)}"` : '';
            out.push(`    <function id="${xmlEsc(f.id)}" parent="${xmlEsc(f.parent || '')}" system="${xmlEsc(f.system || '')}"${pos}>`
                     + `<title>${xmlEsc(f.title || '')}</title></function>`);
        }
        for (const fl of d.flows) out.push(`    <flow source="${xmlEsc(fl.source)}" target="${xmlEsc(fl.target)}"/>`);
        out.push('  </diagram>');
    }
    out.push('</manualFunctionalChain>', '');
    return out.join('\n');
}

// The same rules as app/services/manual_chain.py :: check().
function checkDoc(doc) {
    if (!doc.diagrams.length) throw new Error('The file has no diagram.');
    const diagramIds = new Set();
    for (const d of doc.diagrams) {
        if (!ID_RE.test(d.id) || diagramIds.has(d.id)) throw new Error(`Diagram id "${d.id}" is missing, invalid or used twice.`);
        diagramIds.add(d.id);
        if (!d.name.trim()) throw new Error(`Diagram ${d.id} has no name.`);
        const parents = new Map();
        for (const f of d.functions) {
            if (!ID_RE.test(f.id)) throw new Error(`Diagram "${d.name}": function ID "${f.id}" is invalid (letters, digits, _ . : - only).`);
            if (parents.has(f.id)) throw new Error(`Diagram "${d.name}": function ID ${f.id} is used twice.`);
            for (const v of [f.x, f.y]) if (v !== null && v !== undefined && !Number.isFinite(v))
                throw new Error(`Diagram "${d.name}": ${f.id} has an invalid position.`);
            parents.set(f.id, f.parent || '');
        }
        for (const [id, parent] of parents) {
            if (parent && !parents.has(parent)) throw new Error(`Diagram "${d.name}": ${id} is inside ${parent}, which doesn't exist.`);
            const chain = new Set([id]);
            for (let cur = parent; cur; cur = parents.get(cur) || '') {
                if (chain.has(cur)) throw new Error(`Diagram "${d.name}": ${id} is (indirectly) inside itself.`);
                chain.add(cur);
            }
        }
        const flows = new Set();
        for (const fl of d.flows) {
            if (!parents.has(fl.source) || !parents.has(fl.target))
                throw new Error(`Diagram "${d.name}": a flow ${fl.source} -> ${fl.target} names a function that doesn't exist.`);
            if (fl.source === fl.target) throw new Error(`Diagram "${d.name}": a flow from ${fl.source} to itself.`);
            const key = fl.source + '\u0000' + fl.target;
            if (flows.has(key)) throw new Error(`Diagram "${d.name}": the flow ${fl.source} -> ${fl.target} is there twice.`);
            flows.add(key);
        }
    }
}

// ---- layout: port of graph.py :: build_functional_chain_graph() ------------------------------
// One difference: a manual function has one parent, so nothing is drawn twice ("shared"), and a function
// gets a system border when a system is entered for it (in the model: system-level functions).

function autoLayout(diagram) {
    const byId = new Map(diagram.functions.map(f => [f.id, f]));
    const childrenOf = new Map();
    for (const f of diagram.functions) if (f.parent && byId.has(f.parent)) {
        if (!childrenOf.has(f.parent)) childrenOf.set(f.parent, []);
        childrenOf.get(f.parent).push(f.id);
    }
    const flowsTo = new Map();
    for (const fl of diagram.flows) {
        if (!flowsTo.has(fl.source)) flowsTo.set(fl.source, []);
        flowsTo.get(fl.source).push(fl.target);
    }
    const topoOrder = ids => {
        const idSet = new Set(ids);
        const incoming = new Map(ids.map(id => [id, 0]));
        for (const id of ids) for (const t of flowsTo.get(id) || []) if (idSet.has(t)) incoming.set(t, incoming.get(t) + 1);
        const ordered = [], remaining = [...ids].sort();
        while (remaining.length) {
            const ready = remaining.filter(id => incoming.get(id) === 0);
            const next = ready.length ? ready[0] : remaining[0];
            ordered.push(next);
            remaining.splice(remaining.indexOf(next), 1);
            for (const t of flowsTo.get(next) || []) if (incoming.has(t)) incoming.set(t, Math.max(0, incoming.get(t) - 1));
        }
        return ordered;
    };
    const hasBorder = id => !!(byId.get(id) && byId.get(id).system);
    const innerWidth = (id, ancestors) => {
        if (ancestors.has(id)) return LEAF_WIDTH;
        const kids = childrenOf.get(id) || [];
        if (!kids.length) return LEAF_WIDTH;
        const next = new Set(ancestors).add(id);
        const widths = topoOrder(kids).map(k => subtreeWidth(k, next));
        return widths.reduce((a, b) => a + b, 0) + H_GAP * (widths.length - 1);
    };
    const subtreeWidth = (id, ancestors) => innerWidth(id, ancestors) + (hasBorder(id) ? 2 * BORDER_MARGIN : 0);
    const positions = new Map();
    const place = (id, x, depth, ancestors) => {
        const kids = ancestors.has(id) ? [] : topoOrder(childrenOf.get(id) || []);
        if (!kids.length) { positions.set(id, { x, y: depth * DEPTH_GAP }); return; }
        const next = new Set(ancestors).add(id);
        let cursor = x - innerWidth(id, ancestors) / 2;
        for (const kid of kids) {
            const w = subtreeWidth(kid, next);
            place(kid, cursor + w / 2, depth + 1, next);
            cursor += w + H_GAP;
        }
    };
    const roots = topoOrder(diagram.functions.filter(f => !f.parent || !byId.has(f.parent)).map(f => f.id));
    let cursor = 0;
    for (const r of roots) {
        const w = subtreeWidth(r, new Set());
        place(r, cursor + w / 2, 0, new Set());
        cursor += w + H_GAP * 3;
    }
    return { positions, childrenOf, topoOrder };
}

// Cytoscape elements: the Functional Chain view's node types (function_ref, function_group,
// system_border) and flowsTo edges; stored positions win over the automatic ones.
function buildElements(diagram) {
    const { positions, childrenOf, topoOrder } = autoLayout(diagram);
    const byId = new Map(diagram.functions.map(f => [f.id, f]));
    const nodes = [];
    const borderKey = id => (byId.get(id) && byId.get(id).system) || null;
    const borders = (ids, container) => {
        const framed = new Map();
        let i = 0;
        while (i < ids.length) {
            const key = borderKey(ids[i]);
            if (key === null) { i++; continue; }
            let j = i + 1;
            while (j < ids.length && borderKey(ids[j]) === key) j++;
            const members = ids.slice(i, j);
            const data = { id: `${members[0]}::border`, type: 'system_border', label: key, function_id: members[0], system: key };
            if (members.length > 1) data.function_ids = members;
            if (container) data.parent = container;
            nodes.push({ data });
            for (const m of members) framed.set(m, data.id);
            i = j;
        }
        return framed;
    };
    const place = (id, container, border, ancestors) => {
        const f = byId.get(id);
        const data = { id, real_id: id, label: `${f.id}\n${f.title}`, shared: false };
        if (border || container) data.parent = border || container;
        const kids = ancestors.has(id) ? [] : topoOrder(childrenOf.get(id) || []);
        if (kids.length) {
            data.type = 'function_group';
            nodes.push({ data });
            const framed = borders(kids, id);
            const next = new Set(ancestors).add(id);
            for (const kid of kids) place(kid, id, framed.get(kid) || '', next);
        } else {
            data.type = 'function_ref';
            const stored = f.x !== null && f.x !== undefined && f.y !== null && f.y !== undefined;
            nodes.push({ data, position: stored ? { x: f.x, y: f.y } : { ...positions.get(id) } });
        }
    };
    const roots = topoOrder(diagram.functions.filter(f => !f.parent || !byId.has(f.parent)).map(f => f.id));
    const framed = borders(roots, '');
    for (const r of roots) place(r, '', framed.get(r) || '', new Set());
    const edges = diagram.flows.map(fl => ({ data: { id: `${fl.source}->${fl.target}`, type: 'flowsTo', label: '', source: fl.source, target: fl.target } }));
    return { nodes, edges };
}

// The Functional Chain view's styles (functional_chain.html), plus the selection.
const STYLE = [
    { selector: 'node', style: {
        'label': 'data(label)', 'font-size': 10, 'text-wrap': 'wrap', 'text-max-width': 110,
        'background-color': '#fff', 'border-width': 2.5, 'border-color': '#16a34a',
        'color': '#000', 'text-valign': 'center', 'text-halign': 'center',
        'width': 120, 'height': 48, 'shape': 'round-rectangle',
    }},
    { selector: 'node[type = "function_group"]', style: {
        'background-color': '#f0fdf4', 'background-opacity': 0.6,
        'border-color': '#0f766e', 'border-width': 2,
        'text-valign': 'top', 'text-halign': 'center', 'font-size': 11,
        'padding': 24, 'shape': 'round-rectangle',
    }},
    { selector: 'node[type = "system_border"]', style: {
        'background-opacity': 0, 'border-style': 'dashed', 'border-color': '#dc2626',
        'border-width': 1.5, 'padding': 12, 'shape': 'rectangle',
        'text-valign': 'top', 'text-halign': 'center', 'font-size': 8, 'color': '#dc2626',
        'text-margin-y': -2,
    }},
    { selector: 'edge', style: {
        'curve-style': 'bezier', 'target-arrow-shape': 'triangle', 'width': 2,
        'line-color': '#2563eb', 'target-arrow-color': '#2563eb', 'label': '',
    }},
    { selector: 'node:selected', style: { 'overlay-color': '#2563eb', 'overlay-opacity': 0.12, 'overlay-padding': 4 } },
    { selector: 'edge:selected', style: { 'line-color': '#dc2626', 'target-arrow-color': '#dc2626', 'width': 3 } },
    { selector: '.eh-source, .eh-target', style: { 'border-width': 3, 'border-color': '#f59e0b' } },
    { selector: '.eh-preview, .eh-ghost-edge', style: {
        'line-color': '#f59e0b', 'target-arrow-color': '#f59e0b', 'source-arrow-color': '#f59e0b',
    }},
    { selector: '.dimmed', style: { 'opacity': 0.2 } },
];

// ---- the page --------------------------------------------------------------------------------

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private window */ } };
const recall = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };

const serverStore = {
    async load() {
        const r = await fetch('/api/manual-chain', { cache: 'no-store' });
        if (!r.ok) throw new Error(`Loading failed (${r.status})`);
        return r.text();
    },
    async save(xml) {
        const r = await fetch('/api/manual-chain', { method: 'PUT', headers: { 'Content-Type': 'application/xml' }, body: xml });
        if (!r.ok) {
            const data = await r.json().catch(() => ({}));
            throw new Error(data.detail || `Saving failed (${r.status})`);
        }
    },
};

const S = { store: null, doc: null, diagramId: null, cy: null, eh: null, undo: [], redo: [], linkMode: false,
            shift: false, hovered: null, saveTimer: null, saving: Promise.resolve() };

const diagram = () => S.doc.diagrams.find(d => d.id === S.diagramId) || S.doc.diagrams[0];
const fn = id => diagram().functions.find(f => f.id === id);

function status(text, isError) {
    const el = $('chain-status');
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
    }, 250);
}

// Every change: a snapshot for Undo, the change, a save and a redraw.
function change(fnChange, { redraw = true } = {}) {
    const before = JSON.stringify(S.doc);
    const result = fnChange();
    if (result === false) return false;
    S.undo.push({ doc: before, diagramId: S.diagramId });
    if (S.undo.length > UNDO_LIMIT) S.undo.shift();
    S.redo = [];
    scheduleSave();
    if (redraw) render();
    updateMenus();
    return true;
}

function undoRedo(from, to) {
    const step = from.pop();
    if (!step) return;
    to.push({ doc: JSON.stringify(S.doc), diagramId: S.diagramId });
    S.doc = JSON.parse(step.doc);
    S.diagramId = S.doc.diagrams.some(d => d.id === step.diagramId) ? step.diagramId : S.doc.diagrams[0].id;
    scheduleSave();
    fillDiagramSelect();
    render();
    updateMenus();
}

function nextFunctionId(d) {
    let n = 0;
    for (const f of d.functions) { const m = /^F-(\d+)$/.exec(f.id); if (m) n = Math.max(n, +m[1]); }
    return 'F-' + String(n + 1).padStart(3, '0');
}

function descendants(d, id) {
    const out = new Set();
    const walk = p => { for (const f of d.functions) if (f.parent === p && !out.has(f.id)) { out.add(f.id); walk(f.id); } };
    walk(id);
    return out;
}

// The positions the automatic layout would give functions without one are written into the
// document (unsaved until the next change), so a later drag never makes the others jump.
function fillMissingPositions(d) {
    if (!d.functions.some(f => f.x === null || f.x === undefined)) return;
    const { positions } = autoLayout(d);
    for (const f of d.functions) if ((f.x === null || f.x === undefined) && positions.has(f.id)) {
        f.x = positions.get(f.id).x; f.y = positions.get(f.id).y;
    }
}

function render(keepView = true) {
    const d = diagram();
    fillMissingPositions(d);
    const { nodes, edges } = buildElements(d);
    $('chain-empty').hidden = d.functions.length > 0;
    if (!S.cy) {
        S.cy = cytoscape({
            container: $('chain-graph'), elements: [...nodes, ...edges], style: STYLE,
            layout: { name: 'preset', padding: 40 },
        });
        window.cy = S.cy;          // like the other graph pages (console, tests)
        S.cy.fit(undefined, 40);
        wireGraph();
        return;
    }
    // one Cytoscape instance for the page: the elements are replaced (a change may come from one of its
    // own events, e.g. a double-click -- destroying the instance there breaks the rest of that event)
    const selected = S.cy.$(':selected').map(e => e.id());
    S.cy.batch(() => {
        S.cy.elements().remove();
        S.cy.add([...nodes, ...edges]);
        for (const id of selected) S.cy.$id(id).select();
    });
    if (!keepView) S.cy.fit(undefined, 40);
}

function wireGraph() {
    const cy = S.cy;
    S.eh = cy.edgehandles({
        canConnect: (s, t) => s.id() !== t.id() && s.data('type') !== 'system_border' && t.data('type') !== 'system_border',
        edgeParams: () => ({}), hoverDelay: 150, snap: true, snapThreshold: 30,
    });
    if (S.linkMode) S.eh.enableDrawMode();
    cy.on('ehcomplete', (event, source, target, added) => {
        added.remove();
        addFlow(source.data('real_id') || source.id(), target.data('real_id') || target.id());
    });
    cy.on('mouseover', 'node', evt => { S.hovered = evt.target.id(); focusMode(); });
    cy.on('mouseout', 'node', () => { S.hovered = null; focusMode(); });
    cy.on('dragfree', 'node', evt => movedNodes(evt.target));
    cy.on('dbltap', 'node', evt => { if (evt.target.data('real_id')) editFunction(evt.target.data('real_id')); });
    cy.on('cxttap', evt => contextMenu(evt));
    cy.on('tap', evt => { if (evt.target === cy) hideMenu(); });
    cy.on('select unselect', updateMenus);
}

// A dragged box (and everything in it) keeps the place it was dropped at.
function movedNodes(node) {
    const leaves = node.isParent() ? node.descendants().filter(n => n.data('type') === 'function_ref') : node.collection();
    const moves = [];
    leaves.forEach(n => {
        const f = fn(n.id());
        if (!f) return;
        const p = n.position();
        if (Math.abs((f.x ?? NaN) - p.x) > 0.5 || Math.abs((f.y ?? NaN) - p.y) > 0.5 || f.x === null || f.x === undefined)
            moves.push([f.id, p.x, p.y]);
    });
    if (!moves.length) return;
    change(() => { for (const [id, x, y] of moves) { const f = fn(id); f.x = x; f.y = y; } }, { redraw: false });
}

function focusMode() {
    const cy = S.cy;
    if (!cy) return;
    if (S.shift && S.hovered) {
        const node = cy.$id(S.hovered);
        const keep = node.union(node.connectedEdges());
        cy.elements().difference(keep).addClass('dimmed');
        keep.removeClass('dimmed');
    } else cy.elements().removeClass('dimmed');
}

function setLinkMode(on) {
    if (on === S.linkMode) return;
    S.linkMode = on;
    $('link-mode-badge').textContent = on ? 'Link mode: ON — drag to connect' : 'Link mode: hold Ctrl';
    if (S.eh) on ? S.eh.enableDrawMode() : S.eh.disableDrawMode();
}

// ---- editing ---------------------------------------------------------------------------------

function addFlow(source, target) {
    const d = diagram();
    if (d.flows.some(f => f.source === source && f.target === target)) {
        status(`The flow ${source} → ${target} is already there.`, true);
        return;
    }
    change(() => { d.flows.push({ source, target }); });
}

function viewCentre() {
    const cy = S.cy, box = $('chain-graph');
    const pan = cy.pan(), zoom = cy.zoom();
    return { x: (box.clientWidth / 2 - pan.x) / zoom, y: (box.clientHeight / 2 - pan.y) / zoom };
}

function newFunction({ parent = '', at = null, after = null } = {}) {
    const d = diagram();
    const id = nextFunctionId(d);
    let pos = at;
    if (!pos && after) {
        const n = S.cy.$id(after);
        const bb = n.boundingBox({ includeLabels: false });
        pos = { x: bb.x2 + H_GAP + LEAF_WIDTH / 2 - 20, y: n.isParent() ? (bb.y1 + bb.y2) / 2 : n.position('y') };
    }
    if (!pos && parent) {
        const kids = S.cy.$id(parent).children();
        if (kids.length) {
            const bb = kids.boundingBox({ includeLabels: false });
            const right = kids.max(k => k.boundingBox({ includeLabels: false }).x2).ele;
            pos = { x: bb.x2 + H_GAP + LEAF_WIDTH / 2 - 20, y: right.isParent() ? (bb.y1 + bb.y2) / 2 : right.position('y') };
        } else {
            const p = S.cy.$id(parent).position();
            pos = { x: p.x, y: p.y + DEPTH_GAP / 2 };
        }
    }
    pos = pos || viewCentre();
    const f = { id, title: '', parent: parent || '', system: '', x: pos.x, y: pos.y };
    openDialog(f, true, () => {
        change(() => {
            d.functions.push(f);
            if (after) d.flows.push({ source: after, target: f.id });
        });
        S.cy.$(':selected').unselect();
        S.cy.$id(f.id).select();
    });
}

function editFunction(id) {
    const f = fn(id);
    if (f) openDialog({ ...f }, false, edited => change(() => applyEdit(id, edited)));
}

function applyEdit(oldId, edited) {
    const d = diagram();
    const f = d.functions.find(x => x.id === oldId);
    if (edited.id !== oldId) {
        for (const x of d.functions) if (x.parent === oldId) x.parent = edited.id;
        for (const fl of d.flows) { if (fl.source === oldId) fl.source = edited.id; if (fl.target === oldId) fl.target = edited.id; }
    }
    Object.assign(f, { id: edited.id, title: edited.title, parent: edited.parent, system: edited.system });
}

function openDialog(f, isNew, done) {
    const d = diagram();
    const dlg = $('fn-dialog');
    $('fn-dialog-title').textContent = isNew ? 'New function' : `Function ${f.id}`;
    $('fn-id').value = f.id;
    $('fn-title').value = f.title;
    $('fn-system').value = f.system;
    const blocked = isNew ? new Set() : new Set([f.id, ...descendants(d, f.id)]);
    $('fn-parent').innerHTML = '<option value="">— top level (not inside a function) —</option>'
        + d.functions.filter(x => !blocked.has(x.id)).map(x => `<option value="${esc(x.id)}">${esc(x.id)} ${esc(x.title)}</option>`).join('');
    $('fn-parent').value = f.parent || '';
    $('fn-systems').innerHTML = [...new Set(d.functions.map(x => x.system).filter(Boolean))].sort()
        .map(s => `<option value="${esc(s)}">`).join('');
    $('fn-error').textContent = '';
    dlg.onsubmitted = () => {
        const edited = { id: $('fn-id').value.trim(), title: $('fn-title').value.trim(),
                         parent: $('fn-parent').value, system: $('fn-system').value.trim() };
        if (!ID_RE.test(edited.id)) return 'The ID may use letters, digits and _ . : - (no spaces).';
        if (edited.id !== f.id || isNew) {
            if (d.functions.some(x => x.id === edited.id && (isNew || x.id !== f.id))) return `${edited.id} is already used in this diagram.`;
        }
        if (isNew) { Object.assign(f, edited); done(f); } else done(edited);
        return '';
    };
    dlg.showModal();
    $('fn-title').focus();
}

function deleteFunctions(ids) {
    const d = diagram();
    const all = new Set();
    for (const id of ids) { all.add(id); for (const x of descendants(d, id)) all.add(x); }
    const inner = [...all].filter(x => !ids.includes(x));
    const what = ids.length === 1 ? ids[0] : `${ids.length} functions`;
    if (!confirm(`Delete ${what}${inner.length ? ` and the ${inner.length} function(s) inside` : ''}, with their flows?`)) return;
    change(() => {
        d.functions = d.functions.filter(f => !all.has(f.id));
        d.flows = d.flows.filter(fl => !all.has(fl.source) && !all.has(fl.target));
    });
}

function deleteFlows(keys) {
    const d = diagram();
    change(() => { d.flows = d.flows.filter(fl => !keys.includes(`${fl.source}->${fl.target}`)); });
}

function deleteSelected() {
    const sel = S.cy.$(':selected');
    const functions = sel.nodes().filter(n => n.data('real_id')).map(n => n.id());
    const flows = sel.edges().map(e => e.id());
    if (functions.length) deleteFunctions(functions);
    else if (flows.length) deleteFlows(flows);
}

function relayout() {
    const d = diagram();
    change(() => {
        for (const f of d.functions) { f.x = null; f.y = null; }
        fillMissingPositions(d);
    });
    S.cy.fit(undefined, 40);
}

// ---- right-click menu ------------------------------------------------------------------------

function hideMenu() { $('chain-menu').hidden = true; }

function contextMenu(evt) {
    const cy = S.cy, target = evt.target;
    const items = [];
    if (target === cy) {
        items.push(['New function here', () => newFunction({ at: { ...evt.position } })]);
        items.push(['Automatic layout', relayout], ['Fit to window', () => cy.fit(undefined, 40)]);
    } else if (target.isEdge()) {
        items.push([`Delete flow ${target.data('source')} → ${target.data('target')}`, () => deleteFlows([target.id()]), 'danger']);
    } else if (target.data('type') === 'system_border') {
        const ids = target.data('function_ids') || [target.data('function_id')];
        items.push([`Remove system "${target.data('system')}"`, () => change(() => { for (const id of ids) fn(id).system = ''; })]);
    } else {
        const id = target.id(), f = fn(id);
        items.push(['Edit…', () => editFunction(id)],
                   ['Add sub-function', () => newFunction({ parent: id })],
                   ['Add next function (with flow)', () => newFunction({ parent: f.parent, after: id })]);
        if (f.parent) items.push([`Move out of ${f.parent}`, () => change(() => { f.parent = fn(f.parent) ? (fn(f.parent).parent || '') : ''; })]);
        items.push(['Delete…', () => deleteFunctions([id]), 'danger']);
    }
    const menu = $('chain-menu');
    const header = target === cy ? '' : `<div class="context-menu-header">${esc(target.isEdge() ? 'Flow' : (target.data('real_id') || target.data('label')))}</div>`;
    menu.innerHTML = header + items.map(([label, , cls], i) =>
        `<button type="button" class="context-menu-item ${cls || ''}" data-i="${i}">${esc(label)}</button>`).join('');
    menu.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { hideMenu(); items[+b.dataset.i][1](); }));
    const p = evt.renderedPosition;
    menu.style.left = Math.min(p.x, $('chain-graph').clientWidth - 200) + 'px';
    menu.style.top = p.y + 'px';
    menu.hidden = false;
}

// ---- diagrams, files, menus --------------------------------------------------------------------

function fillDiagramSelect() {
    $('diagram-select').innerHTML = S.doc.diagrams.map(d => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('');
    $('diagram-select').value = S.diagramId;
}

function openDiagram(id) {
    S.diagramId = id;
    store(KEY_DIAGRAM, id);
    fillDiagramSelect();
    render(false);
    updateMenus();
}

function nextDiagramId() {
    let n = 0;
    for (const d of S.doc.diagrams) { const m = /^D(\d+)$/.exec(d.id); if (m) n = Math.max(n, +m[1]); }
    return 'D' + (n + 1);
}

function uniqueName(name) {
    const names = new Set(S.doc.diagrams.map(d => d.name));
    if (!names.has(name)) return name;
    for (let i = 2; ; i++) if (!names.has(`${name} (${i})`)) return `${name} (${i})`;
}

async function askText(title, value) {
    const dlg = $('text-dialog');
    $('text-dialog-title').textContent = title;
    $('text-dialog-input').value = value || '';
    dlg.returnValue = '';
    dlg.showModal();
    $('text-dialog-input').select();
    return new Promise(resolve => dlg.addEventListener('close', () => {
        resolve(dlg.returnValue === 'ok' ? $('text-dialog-input').value.trim() : null);
    }, { once: true }));
}

const MENU_ACTIONS = {
    'diagram-new': async () => {
        const name = await askText('New diagram', uniqueName('Functional chain'));
        if (!name) return;
        const d = { id: nextDiagramId(), name: uniqueName(name), functions: [], flows: [] };
        change(() => { S.doc.diagrams.push(d); S.diagramId = d.id; }, { redraw: false });
        openDiagram(d.id);
    },
    'diagram-rename': async () => {
        const d = diagram();
        const name = await askText('Rename diagram', d.name);
        if (!name || name === d.name) return;
        change(() => { d.name = name; }, { redraw: false });
        fillDiagramSelect();
    },
    'diagram-copy': () => {
        const d = diagram();
        const copy = { ...JSON.parse(JSON.stringify(d)), id: nextDiagramId(), name: uniqueName(d.name + ' (copy)') };
        change(() => { S.doc.diagrams.push(copy); }, { redraw: false });
        openDiagram(copy.id);
    },
    'diagram-delete': () => {
        const d = diagram();
        if (!confirm(`Delete the diagram "${d.name}" with its ${d.functions.length} function(s)?`)) return;
        change(() => {
            S.doc.diagrams = S.doc.diagrams.filter(x => x !== d);
            if (!S.doc.diagrams.length) S.doc.diagrams.push({ id: 'D1', name: 'Functional chain 1', functions: [], flows: [] });
            S.diagramId = S.doc.diagrams[0].id;
        }, { redraw: false });
        openDiagram(S.diagramId);
    },
    'edit-undo': () => undoRedo(S.undo, S.redo),
    'edit-redo': () => undoRedo(S.redo, S.undo),
    'edit-new': () => newFunction(),
    'edit-delete': deleteSelected,
    'edit-layout': relayout,
    'export-xml': () => withControl('All functional chain diagrams, XML', c => download(new Blob(
        [c ? exportControl.xmlWithComment(toXml(S.doc), c.xml_comment) : toXml(S.doc)], { type: 'application/xml' }), 'functional-chain.xml')),
    'import-xml': () => $('import-xml-file').click(),
    'export-jpg': () => withControl(`Functional chain diagram "${diagram().name}", JPG`, c => exportGraphJpg(S.cy, fileBase(), '', null, c && c.line)),
    'export-png': () => {
        if (!S.cy.nodes().length) { alert('There is nothing to export yet.'); return; }
        if (window.exportControl) {                    // with the document control in the footer (SFM-225)
            withControl(`Functional chain diagram "${diagram().name}", PNG`, c => exportGraphJpg(S.cy, fileBase(), '', null, c.line, 'image/png'));
            return;
        }
        const bb = S.cy.elements().boundingBox();
        const scale = Math.max(1, Math.min(4, 12000 / Math.max(bb.w + 80, bb.h + 80)));
        download(S.cy.png({ full: true, scale, bg: '#ffffff', output: 'blob' }), fileBase() + '.png');
    },
    'help-tricks': () => $('help-dialog').showModal(),
};

// In the workbench: asks which work product the export is for and hands its document control to
// `fn` (export_control.js, SFM-225); nothing when cancelled. In the standalone `fn(null)`.
async function withControl(content, fn) {
    if (!window.exportControl) return fn(null);
    const c = await exportControl.ask(content);
    if (c) fn(c);
}

function fileBase() {
    return (diagram().name || 'functional-chain').replace(/[^A-Za-z0-9 _.\-]+/g, '_').trim().replace(/\s+/g, '_') || 'functional-chain';
}

function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

async function importXml(file) {
    let imported;
    try { imported = parseXml(await file.text()); } catch (e) { alert(`${file.name}: ${e.message}`); return; }
    const added = [];
    change(() => {
        for (const d of imported.diagrams) {
            const copy = { ...d, id: nextDiagramId(), name: uniqueName(d.name) };
            S.doc.diagrams.push(copy);
            added.push(copy);
        }
    }, { redraw: false });
    if (added.length) {
        openDiagram(added[0].id);
        status(`Imported ${added.length} diagram(s) from ${file.name}`);
    }
}

function updateMenus() {
    if (!S.cy) return;
    $('edit-undo').disabled = !S.undo.length;
    $('edit-redo').disabled = !S.redo.length;
    $('edit-delete').disabled = !S.cy.$(':selected').length;
    $('diagram-delete').disabled = false;
}

function wireMenus() {
    const bar = $('chain-menubar');
    const close = () => { bar.classList.remove('open'); bar.querySelectorAll('.menu-list').forEach(l => { l.hidden = true; }); };
    bar.querySelectorAll('.menu-title').forEach(t => t.addEventListener('click', e => {
        const list = t.nextElementSibling, wasOpen = !list.hidden;
        close();
        if (!wasOpen) { list.hidden = false; bar.classList.add('open'); }
        e.stopPropagation();
    }));
    bar.querySelectorAll('.menu-title').forEach(t => t.addEventListener('mouseenter', () => {
        if (bar.classList.contains('open') && t.nextElementSibling.hidden) { close(); t.nextElementSibling.hidden = false; bar.classList.add('open'); }
    }));
    document.addEventListener('click', e => { if (!bar.contains(e.target)) close(); if (!$('chain-menu').contains(e.target)) hideMenu(); });
    for (const [id, action] of Object.entries(MENU_ACTIONS)) {
        const el = $(id);
        if (el) el.addEventListener('click', () => { close(); action(); });
    }
    $('chain-graph').parentElement.addEventListener('contextmenu', e => e.preventDefault());   // the page's own menu, not the browser's
    $('import-xml-file').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) importXml(f); });
    $('diagram-select').addEventListener('change', e => openDiagram(e.target.value));
    $('add-function').addEventListener('click', () => newFunction());
    $('auto-layout').addEventListener('click', relayout);
    $('fit-window').addEventListener('click', () => S.cy && S.cy.fit(undefined, 40));
    $('undo-btn').addEventListener('click', MENU_ACTIONS['edit-undo']);
    $('redo-btn').addEventListener('click', MENU_ACTIONS['edit-redo']);

    const fnForm = $('fn-form');
    fnForm.addEventListener('submit', e => {
        if (e.submitter && e.submitter.value === 'cancel') return;
        const error = $('fn-dialog').onsubmitted();
        if (error) { e.preventDefault(); $('fn-error').textContent = error; }
    });
    fnForm.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'BUTTON') { e.preventDefault(); fnForm.requestSubmit($('fn-save')); }
    });
    $('text-dialog-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); $('text-dialog').close('ok'); }
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Control') setLinkMode(true);
        if (e.key === 'Shift') { S.shift = true; focusMode(); }
        if (document.querySelector('dialog[open]') || e.target.closest('input, textarea, select')) return;
        const k = e.key.toLowerCase();
        if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) { e.preventDefault(); MENU_ACTIONS['edit-undo'](); }
        else if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); MENU_ACTIONS['edit-redo'](); }
        else if (e.key === 'Delete' || e.key === 'Backspace') { if (S.cy.$(':selected').length) { e.preventDefault(); deleteSelected(); } }
        else if (e.key === 'F2' || e.key === 'Enter') {
            const n = S.cy.$('node:selected').filter(x => x.data('real_id'));
            if (n.length === 1) { e.preventDefault(); editFunction(n.id()); }
        } else if (e.key === 'Escape') { hideMenu(); S.cy.$(':selected').unselect(); }
        else if (k === 'n' && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); newFunction(); }
    });
    document.addEventListener('keyup', e => {
        if (e.key === 'Control') setLinkMode(false);
        if (e.key === 'Shift') { S.shift = false; focusMode(); }
    });
    window.addEventListener('blur', () => { setLinkMode(false); S.shift = false; S.hovered = null; focusMode(); });
}

async function init(chainStore) {
    S.store = chainStore || serverStore;
    let text = null;
    try { text = await S.store.load(); } catch (e) { status(e.message, true); }
    try { S.doc = text ? parseXml(text) : emptyDoc(); }
    catch (e) { alert(`The stored functional chain can't be read (${e.message}); starting empty -- nothing is overwritten until you change something.`); S.doc = emptyDoc(); }
    const saved = recall(KEY_DIAGRAM);
    S.diagramId = S.doc.diagrams.some(d => d.id === saved) ? saved : S.doc.diagrams[0].id;
    wireMenus();
    fillDiagramSelect();
    render(false);
    updateMenus();
    status('');
}

window.ManualChain = { init, parseXml, toXml, checkDoc, autoLayout, buildElements, serverStore, state: S,
                       get diagram() { return diagram(); } };
})();
