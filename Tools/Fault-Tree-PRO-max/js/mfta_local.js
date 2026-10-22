// Integrity Workbench - Fault Tree PRO max, standalone (user, 2026-10-21: "a standalone fault tree pro max
// that I can share with my friends"). The page is the app's Manual FTA page (app/templates/manual_fta.html,
// built by scripts/build_standalone_fta.py); this file answers its server calls in the browser instead:
// window.fetch is wrapped, so /api/manual-fta/... and /api/model-identity never leave the browser. The data
// lives in localStorage. The logic is a port of app/services/manual_fta.py (analyses, events, repeated
// events with scopes, move / copy / copy with new IDs, criticality, colour, layout) and of the manual part
// of app/services/fta_export.py (XML export / import, same format as the app) -- keep them in step.
(function () {
    'use strict';
    const STORE = 'faultTreeProMax.v1';
    const KINDS = ['intermediate', 'basic'];
    const GATES = ['or', 'and'];
    const ID_PREFIX = { top: 'TP', intermediate: 'GT', basic: 'EV' };
    const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
    const CRITICALITY_LEVELS = ['H1', 'H2', 'H3', 'H3+', 'H4', 'H4+', 'ANY', 'QM', 'ASIL A', 'ASIL B', 'ASIL C', 'ASIL D'];
    const COLORS = { yellow: '#FDE68A', green: '#BBF7D0', red: '#FECACA', orange: '#FED7AA', grey: '#E5E7EB', purple: '#E9D5FF' };
    const TIKZ_COLORS = { yellow: 'yellow!35', green: 'green!25', red: 'red!25', orange: 'orange!30', grey: 'gray!20', purple: 'violet!20' };
    const MOVE_MODES = ['move', 'copy', 'copy_new'];
    const UNIT = 1.5, LEAF_W = 75.2 * UNIT, H_GAP = (18.4 + 16) * UNIT, ROW_PITCH = 128 * UNIT;   // graph.py
    const TOOL = 'Integrity Workbench Fault Tree PRO max (standalone)';
    const FORMAT = 'safety-model-fta', VERSION = '1';

    class FtaError extends Error {
        constructor(message, status = 400, detail = null) { super(message); this.status = status; this.detail = detail; }
    }
    class NeedsScope extends FtaError {
        constructor(eventId, count) {
            const msg = `${eventId} appears ${count} times (a repeated event): change all ${count} occurrences, `
                      + 'or only this one -- it then gets a new ID and is independent.';
            super(msg, 409, { message: msg, needs_scope: true, event: eventId, occurrences: count });
        }
    }

    // ---- storage ---------------------------------------------------------------------------------
    function load() {
        let data = null;
        try { data = JSON.parse(localStorage.getItem(STORE)); } catch (e) { /* private window / broken */ }
        if (!data || !Array.isArray(data.analyses) || !data.analyses.length) {
            data = { analyses: [{ id: 'A1', name: 'Fault trees' }], tops: [], counters: {}, revision: 0, tag: '' };
        }
        data.tops = data.tops || []; data.counters = data.counters || {};
        return data;
    }
    function save(data) {
        const known = new Set(data.analyses.map(a => a.id));
        data.tops.forEach(t => { if (!known.has(t.analysis)) t.analysis = data.analyses[0].id; });
        data.revision = (data.revision || 0) + 1;                       // one revision per change
        data.tag = Math.random().toString(16).slice(2, 10).padEnd(8, '0');
        data.changed = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
        localStorage.setItem(STORE, JSON.stringify(data));
    }
    const revisionId = data => data.revision ? `R${data.revision}-${data.tag}` : 'R0';

    const ev = (o = {}) => ({ id: o.id, title: o.title || '', description: o.description || '', label: o.label || '',
        kind: KINDS.includes(o.kind) ? o.kind : 'intermediate', gate: GATES.includes(o.gate) ? o.gate : 'or',
        causes: o.causes || [], criticality: o.criticality || '', color: o.color || '', analysis: o.analysis || '' });
    const clone = e => JSON.parse(JSON.stringify(e));
    function* walk(events) { for (const e of events) { yield e; yield* walk(e.causes); } }
    const clean = t => (t || '').trim();

    function newId(tops, counters, kind) {
        const prefix = ID_PREFIX[kind];
        const taken = new Set([...walk(tops)].map(e => e.id));
        let n = counters[prefix] || 1;
        while (taken.has(`${prefix}-${n}`)) n++;
        counters[prefix] = n + 1;
        return `${prefix}-${n}`;
    }

    // ---- occurrences of repeated events (manual_fta.py) ------------------------------------------
    function occurrences(tops, id) {
        const found = [];
        (function search(events, parent, path) {
            for (const e of events) {
                const here = path ? `${path}/${e.id}` : e.id;
                if (e.id === id) found.push([e, parent, here]);
                search(e.causes, e, here);
            }
        })(tops, null, '');
        return found;
    }
    function resolve(tops, id, at) {
        const occ = occurrences(tops, id);
        if (!occ.length) throw new FtaError(`There is no event ${id}.`);
        if (at) {
            const m = occ.find(o => o[2] === at);
            if (!m) throw new FtaError(`${id} is no longer at ${at} -- reload the page.`);
            return m;
        }
        return occ[0];
    }
    function targets(tops, counters, id, at, scope) {
        const occ = occurrences(tops, id);
        if (!occ.length) throw new FtaError(`There is no event ${id}.`);
        if (occ.length === 1) return [[occ[0][0], occ[0][1]]];
        if (scope === 'all') return occ.map(o => [o[0], o[1]]);
        if (scope === 'this') {
            const [e, parent] = resolve(tops, id, at);
            e.id = newId(tops, counters, parent ? e.kind : 'top');
            return [[e, parent]];
        }
        throw new NeedsScope(id, occ.length);
    }
    const parentPath = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    const signature = e => JSON.stringify([e.id, e.title, e.description, e.label, e.kind, e.gate, e.criticality, e.color,
                                          e.causes.map(signature)]);
    function cloneNewIds(e, tops, counters, asTop) {
        const n = ev({ ...e, id: newId(tops, counters, asTop ? 'top' : e.kind), causes: [], analysis: '' });
        const holder = [n];
        for (const c of e.causes) n.causes.push(cloneNewIds(c, tops.concat(holder), counters, false));
        return n;
    }
    const checkCrit = v => { v = clean(v); if (v && !CRITICALITY_LEVELS.includes(v)) throw new FtaError(`Unknown criticality '${v}' -- one of ${CRITICALITY_LEVELS.join(', ')}.`); return v; };
    const checkColor = v => { v = clean(v).toLowerCase(); if (v && !(v in COLORS)) throw new FtaError(`Unknown colour '${v}' -- one of ${Object.keys(COLORS).join(', ')}.`); return v; };

    // ---- operations ------------------------------------------------------------------------------
    function analysisOf(data, id) {
        const a = data.analyses.find(x => x.id === id);
        if (!a) throw new FtaError(`There is no analysis ${id}.`, 404);
        return a;
    }
    function nextAnalysisId(data) {
        let n = Math.max(data.counters.A || 1, ...data.analyses.map(a => /^A\d+$/.test(a.id) ? +a.id.slice(1) + 1 : 1));
        data.counters.A = n + 1;
        return `A${n}`;
    }
    const cleanName = n => { n = (n || '').split(/\s+/).filter(Boolean).join(' '); if (!n) throw new FtaError('Give the analysis a name.'); return n.slice(0, 80); };

    const ops = {
        listAnalyses(data) { return data.analyses.map(a => ({ ...a, trees: data.tops.filter(t => t.analysis === a.id).length })); },
        createAnalysis(data, name) { const a = { id: nextAnalysisId(data), name: cleanName(name) }; data.analyses.push(a); save(data); return a; },
        renameAnalysis(data, id, name) { const a = analysisOf(data, id); a.name = cleanName(name); save(data); return a; },
        deleteAnalysis(data, id) {
            analysisOf(data, id);
            if (data.analyses.length === 1) throw new FtaError('The last analysis cannot be deleted -- delete its trees instead.');
            const removed = [...walk(data.tops.filter(t => t.analysis === id))].map(e => e.id);
            data.tops = data.tops.filter(t => t.analysis !== id); data.analyses = data.analyses.filter(a => a.id !== id);
            save(data); return removed;
        },
        duplicateAnalysis(data, id, name) {
            const src = analysisOf(data, id);
            const dup = { id: nextAnalysisId(data), name: cleanName(name || `${src.name} (copy)`) };
            data.analyses.push(dup);
            const copies = [];
            for (const t of data.tops.filter(x => x.analysis === id)) {
                const c = cloneNewIds(t, data.tops.concat(copies), data.counters, true); c.analysis = dup.id; copies.push(c);
            }
            data.tops.push(...copies); save(data); return dup;
        },
        newTree(data, b) {
            if (b.analysis && !data.analyses.some(a => a.id === b.analysis)) throw new FtaError(`There is no analysis ${b.analysis}.`);
            const t = ev({ id: newId(data.tops, data.counters, 'top'), title: clean(b.title), description: clean(b.description),
                           label: clean(b.label), analysis: b.analysis || data.analyses[0].id });
            data.tops.push(t); save(data); return t;
        },
        addCause(data, parentId, b) {
            const kind = b.kind || 'basic';
            if (!KINDS.includes(kind)) throw new FtaError(`Unknown event kind '${kind}'.`);
            resolve(data.tops, parentId, b.at);
            const tg = targets(data.tops, data.counters, parentId, b.at, b.scope);
            if (tg[0][0].kind === 'basic') throw new FtaError(`${parentId} is a basic event and cannot have anything below it -- add it below a gate.`);
            const cause = ev({ id: newId(data.tops, data.counters, kind), title: clean(b.title), description: clean(b.description), label: clean(b.label), kind });
            tg.forEach(([p], i) => p.causes.push(i === 0 ? cause : clone(cause)));
            save(data); return cause;
        },
        updateEvent(data, id, b) {
            resolve(data.tops, id, b.at);
            const tg = targets(data.tops, data.counters, id, b.at, b.scope);
            let newIdV = b.id !== undefined ? clean(b.id) : null;
            if (b.scope === 'this' && newIdV === id) newIdV = null;
            const first = tg[0][0];
            if (newIdV !== null && newIdV !== first.id) {
                if (!ID_PATTERN.test(newIdV)) throw new FtaError(`'${newIdV}' is not a valid ID -- use letters, digits, '-', '_' and '.' only (no spaces).`);
                if ([...walk(data.tops)].some(e => e.id === newIdV)) throw new FtaError(`The ID ${newIdV} is already used by another event.`);
            } else newIdV = null;
            if (b.kind !== undefined) {
                if (!KINDS.includes(b.kind)) throw new FtaError(`Unknown event kind '${b.kind}'.`);
                if (b.kind === 'basic' && first.causes.length) throw new FtaError(`${id} has causes, so it cannot be a basic event.`);
            }
            if (b.gate !== undefined && !GATES.includes(b.gate)) throw new FtaError(`Unknown gate '${b.gate}'.`);
            const crit = b.criticality !== undefined ? checkCrit(b.criticality) : null;
            const col = b.color !== undefined ? checkColor(b.color) : null;
            const kindId = b.kind !== undefined && b.kind !== first.kind && tg[0][1] ? newId(data.tops, data.counters, b.kind) : null;
            for (const [e] of tg) {
                if (newIdV) e.id = newIdV;
                if (b.title !== undefined) e.title = clean(b.title);
                if (b.description !== undefined) e.description = (b.description || '').trim();
                if (b.label !== undefined) e.label = clean(b.label);
                if (b.kind !== undefined) { if (kindId) e.id = kindId; e.kind = b.kind; }
                if (b.gate !== undefined) e.gate = b.gate;
                if (crit !== null) e.criticality = crit;
                if (col !== null) e.color = col;
            }
            save(data); return first;
        },
        updateEvents(data, b) {
            const crit = b.criticality !== undefined ? checkCrit(b.criticality) : null;
            const col = b.color !== undefined ? checkColor(b.color) : null;
            if (b.gate !== undefined && !GATES.includes(b.gate)) throw new FtaError(`Unknown gate '${b.gate}'.`);
            const items = (b.ids || []).map(x => typeof x === 'string' ? [x, null] : [x.id, x.at]);
            items.forEach(([i, at]) => resolve(data.tops, i, at));
            if (b.scope !== 'all' && b.scope !== 'this') {
                const rep = items.map(([i]) => [i, occurrences(data.tops, i).length]).find(x => x[1] > 1);
                if (rep) throw new NeedsScope(rep[0], rep[1]);
            }
            const changed = [];
            for (const [i, at] of items) {
                for (const [e] of targets(data.tops, data.counters, i, at, b.scope)) {
                    if (crit !== null) e.criticality = crit;
                    if (col !== null) e.color = col;
                    if (b.gate !== undefined && e.kind !== 'basic') e.gate = b.gate;
                    changed.push(e.id);
                }
            }
            save(data); return [...new Set(changed)];
        },
        removeOccurrence(data, id, at, scope) {
            const [e, parent, path] = resolve(data.tops, id, at);
            const removed = [...walk([e])].map(x => x.id);
            if (!parent) { data.tops.splice(data.tops.indexOf(e), 1); return removed; }
            for (const [t] of targets(data.tops, data.counters, parent.id, parentPath(path), scope)) {
                const i = t.causes.findIndex(c => c.id === id);
                if (i >= 0) t.causes.splice(i, 1);
            }
            return removed;
        },
        deleteEvent(data, id, at, scope) { const r = ops.removeOccurrence(data, id, at, scope); save(data); return r; },
        deleteEvents(data, b) {
            const items = (b.ids || []).map(x => typeof x === 'string' ? [x, null] : [x.id, x.at]);
            const paths = items.map(([i, at]) => at || resolve(data.tops, i)[2]);
            if (b.scope !== 'all' && b.scope !== 'this') {
                for (const [i, at] of items) {
                    const parent = resolve(data.tops, i, at)[1];
                    if (parent && occurrences(data.tops, parent.id).length > 1) throw new NeedsScope(parent.id, occurrences(data.tops, parent.id).length);
                }
            }
            const removed = [];
            const order = items.map((it, k) => [it, paths[k]]).sort((x, y) => x[1].length - y[1].length);
            for (const [[i], path] of order) {
                if (paths.some(o => o !== path && path.startsWith(o + '/'))) continue;
                removed.push(...ops.removeOccurrence(data, i, path, b.scope));
            }
            save(data); return removed;
        },
        moveCause(data, id, b) {
            const step = b.direction === 'left' ? -1 : 1;
            const [, parent, path] = resolve(data.tops, id, b.at);
            const groups = !parent ? [data.tops] : targets(data.tops, data.counters, parent.id, parentPath(path), b.scope).map(([t]) => t.causes);
            let moved = false;
            for (const sib of groups) {
                const i = sib.findIndex(c => c.id === id), j = i + step;
                if (i >= 0 && j >= 0 && j < sib.length) { [sib[i], sib[j]] = [sib[j], sib[i]]; moved = true; }
            }
            if (moved) save(data);
            return { ok: true };
        },
        moveBranch(data, id, b) {
            const mode = b.mode || 'move';
            if (!MOVE_MODES.includes(mode)) throw new FtaError(`Unknown mode '${mode}' -- one of ${MOVE_MODES.join(', ')}.`);
            const [e, parent, path] = resolve(data.tops, id, b.at);
            const [t, , tPath] = resolve(data.tops, b.parent || '', b.target_at);
            const branch = new Set([...walk([e])].map(x => x.id));
            if (t === e || [...walk(e.causes)].includes(t) || branch.has(t.id)) throw new FtaError(`${id} cannot be placed below itself or below an event of its own branch.`);
            if (t.kind === 'basic') throw new FtaError(`${t.id} is a basic event and cannot have anything below it -- drop onto a gate.`);
            if (mode === 'move' && parent && parent.id === t.id) return e;
            if (mode === 'copy' && t.causes.some(c => c.id === e.id)) throw new FtaError(`${id} is already an input of ${t.id}.`);
            if (b.scope !== 'all' && b.scope !== 'this') {
                for (const check of [t.id].concat(mode === 'move' && parent ? [parent.id] : [])) {
                    const c = occurrences(data.tops, check).length;
                    if (c > 1) throw new NeedsScope(check, c);
                }
            }
            const placed = mode === 'copy_new' ? cloneNewIds(e, data.tops, data.counters, false) : clone(e);
            if (mode === 'move') {
                if (!parent) { data.tops.splice(data.tops.indexOf(e), 1); placed.id = newId(data.tops.concat([e]), data.counters, e.kind); }
                else ops.removeOccurrence(data, id, path, b.scope);
            }
            placed.analysis = '';
            const tg = targets(data.tops, data.counters, t.id, tPath, b.scope);
            tg.forEach(([x], i) => x.causes.push(i === 0 ? placed : clone(placed)));
            save(data); return placed;
        },
    };

    // ---- layout (manual_fta.build_graph) -------------------------------------------------------
    function symbol(e) { if (e.causes.length > 1) return e.gate; if (!e.causes.length) return e.kind === 'basic' ? 'basic' : 'triangle'; return 'none'; }
    function width(e) { if (!e.causes.length) return LEAF_W; const w = e.causes.map(width); return Math.max(LEAF_W, w.reduce((a, b) => a + b, 0) + H_GAP * (w.length - 1)); }
    function buildGraph(data, analysis) {
        const counts = {};
        for (const e of walk(data.tops)) counts[e.id] = (counts[e.id] || 0) + 1;
        const tops = analysis ? data.tops.filter(t => t.analysis === analysis) : data.tops;
        const nodes = [], edges = [];
        function place(e, x, row, topId, path) {
            const nodeId = path ? `${path}/${e.id}` : e.id;
            nodes.push({ data: { id: nodeId, type: 'manual_event', symbol: symbol(e), label: e.title, shared: (counts[e.id] || 0) > 1,
                occurrences: counts[e.id] || 0, code: e.id, depth: row, kind: e.kind, gate: e.gate, top: topId,
                description: e.description, note: e.label, tag: e.criticality, tag_box: true, color: e.color,
                fill: e.color ? COLORS[e.color] : '', tikz_fill: e.color ? TIKZ_COLORS[e.color] : '', causes: e.causes.length }, position: { x, y: row * ROW_PITCH } });
            const w = e.causes.map(width);
            let cursor = x - (w.reduce((a, b) => a + b, 0) + H_GAP * (w.length - 1)) / 2;
            e.causes.forEach((c, i) => {
                const child = `${nodeId}/${c.id}`;
                edges.push({ data: { id: `mfta-${child}`, source: nodeId, target: child, input_index: i, input_count: e.causes.length } });
                place(c, cursor + w[i] / 2, row + 1, topId, nodeId);
                cursor += w[i] + H_GAP;
            });
        }
        let cursor = 0;
        for (const t of tops) { const w = width(t); place(t, cursor + w / 2, 0, t.id, ''); cursor += w + H_GAP * 3; }
        return { nodes, edges };
    }

    // ---- XML export / import (fta_export.py, source "manual") -----------------------------------
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    function eventXml(e, indent) {
        const pad = '  '.repeat(indent);
        let a = ` id="${esc(e.id)}" kind="${e.kind}" gate="${e.gate}"`;
        if (e.label) a += ` label="${esc(e.label)}"`;
        if (e.criticality) a += ` criticality="${esc(e.criticality)}"`;
        if (e.color) a += ` color="${esc(e.color)}"`;
        let s = `${pad}<event${a}>\n${pad}  <title>${esc(e.title)}</title>\n`;
        if (e.description) s += `${pad}  <description>${esc(e.description)}</description>\n`;
        for (const c of e.causes) s += eventXml(c, indent + 1);
        return s + `${pad}</event>\n`;
    }
    function exportXml(data, analysis) {
        const a = data.analyses.find(x => x.id === analysis);
        const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
        let s = `<?xml version='1.0' encoding='UTF-8'?>\n<faultTreeExport format="${FORMAT}" version="${VERSION}" source="manual"`
              + (a ? ` analysis="${esc(a.id)}" analysisName="${esc(a.name)}"` : '') + '>\n';
        s += `  <!-- Fault trees exported by ${TOOL}. Same format as the Integrity Workbench app: import it there or here. -->\n`;
        s += `  <model project="standalone" revision="${revisionId(data)}" revisionChanged="${data.changed || ''}" fingerprint="" gitCommit="" gitState="not under version control" exported="${now}" tool="${esc(TOOL)}"/>\n`;
        for (const t of data.tops.filter(x => !analysis || x.analysis === analysis)) s += `  <tree top="${esc(t.id)}">\n${eventXml(t, 2)}  </tree>\n`;
        return s + '</faultTreeExport>\n';
    }
    function parseEvent(el) {
        return ev({ id: el.getAttribute('id') || '', title: (el.querySelector(':scope > title') || {}).textContent || '',
            description: (el.querySelector(':scope > description') || {}).textContent || '', label: el.getAttribute('label') || '',
            kind: el.getAttribute('kind'), gate: el.getAttribute('gate'),
            criticality: CRITICALITY_LEVELS.includes(el.getAttribute('criticality')) ? el.getAttribute('criticality') : '',
            color: (el.getAttribute('color') || '') in COLORS ? el.getAttribute('color') : '',
            causes: [...el.children].filter(c => c.tagName === 'event').map(parseEvent) });
    }
    function checkEvents(el, path, errors) {
        const id = el.getAttribute('id') || '', where = `${path}/${id || '?'}`;
        if (!ID_PATTERN.test(id)) errors.push(`${where}: '${id}' is not a valid ID (letters, digits, - _ . only).`);
        if (!KINDS.includes(el.getAttribute('kind') || 'intermediate')) errors.push(`${where}: unknown kind '${el.getAttribute('kind')}'.`);
        if (!GATES.includes(el.getAttribute('gate') || 'or')) errors.push(`${where}: unknown gate '${el.getAttribute('gate')}'.`);
        if (el.getAttribute('criticality') && !CRITICALITY_LEVELS.includes(el.getAttribute('criticality'))) errors.push(`${where}: unknown criticality '${el.getAttribute('criticality')}'.`);
        if (el.getAttribute('color') && !(el.getAttribute('color') in COLORS)) errors.push(`${where}: unknown colour '${el.getAttribute('color')}'.`);
        const kids = [...el.children].filter(c => c.tagName === 'event');
        if (el.getAttribute('kind') === 'basic' && kids.length) errors.push(`${where}: a basic event cannot have events below it.`);
        kids.forEach(k => checkEvents(k, where, errors));
    }
    function previewImport(data, text, analysis) {
        const doc = new DOMParser().parseFromString(text, 'application/xml');
        if (doc.querySelector('parsererror')) throw new FtaError('Not a readable XML file.');
        const root = doc.documentElement;
        if (root.tagName !== 'faultTreeExport' || root.getAttribute('format') !== FORMAT)
            throw new FtaError('Not an Integrity Workbench fault tree export (<faultTreeExport format="safety-model-fta">).');
        if (root.getAttribute('version') !== VERSION) throw new FtaError(`Export format version ${root.getAttribute('version')} is not supported (this tool reads ${VERSION}).`);
        const modelEl = root.querySelector(':scope > model');
        const model = modelEl ? Object.fromEntries([...modelEl.attributes].map(a => [a.name, a.value])) : {};
        const preview = { model, trees: [], errors: [], tops: [] };
        if (root.getAttribute('source') !== 'manual') {
            preview.errors.push(`This file holds ${(root.getAttribute('source') || '?').replace('_', '-')} fault trees -- only Manual FTA trees can be imported.`);
            return preview;
        }
        const existing = new Set(data.tops.map(t => t.id));
        for (const tree of root.querySelectorAll(':scope > tree')) {
            const el = tree.querySelector(':scope > event');
            if (!el) { preview.errors.push(`Tree ${tree.getAttribute('top') || '?'} has no event.`); continue; }
            if (el.getAttribute('kind') === 'basic') preview.errors.push(`Tree ${el.getAttribute('id')}: a top event cannot be a basic event.`);
            checkEvents(el, '', preview.errors);
            const top = parseEvent(el);
            preview.tops.push(top);
            preview.trees.push({ top: top.id, title: top.title, events: [...walk([top])].length,
                                 action: existing.has(top.id) ? 'replaces the existing tree' : 'new tree' });
        }
        const sigs = {};
        for (const e of walk(preview.tops)) (sigs[e.id] = sigs[e.id] || new Set()).add(signature(e));
        const differ = Object.keys(sigs).filter(i => sigs[i].size > 1).sort();
        if (differ.length) preview.errors.push('These IDs appear more than once with different content (a repeated event must be the same everywhere): ' + differ.join(', '));
        const replaced = new Set(preview.tops.map(t => t.id));
        const clash = [...new Set([...walk(data.tops.filter(t => !replaced.has(t.id)))]
            .filter(e => sigs[e.id] && !sigs[e.id].has(signature(e))).map(e => e.id))].sort();
        if (clash.length) preview.errors.push('These IDs are already used in other trees for a different event: ' + clash.join(', '));
        if (analysis && !data.analyses.some(a => a.id === analysis)) preview.errors.push(`There is no analysis ${analysis}.`);
        preview.tops.forEach(t => { t.analysis = analysis || data.analyses[0].id; });
        if (!preview.tops.length && !preview.errors.length) preview.errors.push('The file contains no fault tree.');
        return preview;
    }
    function applyImport(data, preview) {
        for (const t of preview.tops) {
            const i = data.tops.findIndex(x => x.id === t.id);
            if (i >= 0) data.tops[i] = t; else data.tops.push(t);
        }
        for (const e of walk(data.tops)) {
            const m = /^(TP|GT|EV)-(\d+)$/.exec(e.id);
            if (m) data.counters[m[1]] = Math.max(data.counters[m[1]] || 1, +m[2] + 1);
        }
        save(data);
    }

    // the guided tour's example tree (SFM-182) -- manual_fta.example_tops(); only drawn, never saved
    function exampleTops() {
        const fuse = () => ev({ id: 'EV-3', title: 'Shared fuse blown', description: 'One fuse supplies both headlamps.',
                                kind: 'basic', criticality: 'ASIL B', color: 'red' });
        return [ev({ id: 'TP-1', title: 'Both headlamps dark at night', description: 'The driver cannot see the road ahead.',
            label: 'Hazard', gate: 'and', criticality: 'ASIL B', analysis: 'tour', causes: [
                ev({ id: 'GT-1', title: 'Left headlamp dark', causes: [ev({ id: 'EV-1', title: 'Left bulb burnt out', kind: 'basic' }), fuse()] }),
                ev({ id: 'GT-2', title: 'Right headlamp dark', causes: [
                    ev({ id: 'EV-2', title: 'Right bulb burnt out', kind: 'basic', criticality: 'QM', color: 'yellow' }), fuse()] }),
            ] })];
    }

    // ---- the routes the page calls ----------------------------------------------------------------
    async function route(method, url, body) {
        const u = new URL(url, API_BASE), p = u.pathname, q = u.searchParams;
        const data = load();
        let m;
        if (p === '/api/model-identity') {
            return { revision: revisionId(data), revision_changed: data.changed || '', project: 'standalone', tool: TOOL,
                     line: `${TOOL} | revision ${revisionId(data)}` };
        }
        if (p === '/api/manual-fta/analyses' && method === 'GET') return ops.listAnalyses(data);
        if (p === '/api/manual-fta/analyses' && method === 'POST') {
            return body.copy_of ? ops.duplicateAnalysis(data, body.copy_of, body.name) : ops.createAnalysis(data, body.name);
        }
        if ((m = /^\/api\/manual-fta\/analyses\/([^/]+)$/.exec(p))) {
            const id = decodeURIComponent(m[1]);
            if (method === 'PUT') return ops.renameAnalysis(data, id, body.name);
            if (method === 'DELETE') return { deleted: ops.deleteAnalysis(data, id) };
        }
        if (p === '/api/manual-fta/graph') return buildGraph(data, q.get('analysis') || '');
        if (p === '/api/manual-fta/example-graph') return buildGraph({ tops: exampleTops() }, '');
        if (p === '/api/manual-fta/trees') return ops.newTree(data, body || {});
        if (p === '/api/manual-fta/events/bulk') return { updated: ops.updateEvents(data, body || {}) };
        if (p === '/api/manual-fta/events/bulk-delete') return { deleted: ops.deleteEvents(data, body || {}) };
        if (p === '/api/manual-fta/import') {
            const preview = previewImport(data, body, q.get('analysis') || '');
            const apply = q.get('apply') === 'true';
            if (apply && !preview.errors.length) applyImport(data, preview);
            const out = { model: preview.model, trees: preview.trees, errors: preview.errors,
                          applied: apply && !preview.errors.length, current_revision: revisionId(load()) };
            if (preview.errors.length) throw Object.assign(new FtaError(preview.errors[0]), { body: out });
            return out;
        }
        if ((m = /^\/api\/manual-fta\/events\/([^/]+)(\/causes|\/move|\/move-to)?$/.exec(p))) {
            const id = decodeURIComponent(m[1]);
            if (m[2] === '/causes') return ops.addCause(data, id, body || {});
            if (m[2] === '/move') return ops.moveCause(data, id, body || {});
            if (m[2] === '/move-to') return ops.moveBranch(data, id, body || {});
            if (method === 'PUT') return ops.updateEvent(data, id, body || {});
            if (method === 'DELETE') return { deleted: ops.deleteEvent(data, id, q.get('at') || null, q.get('scope') || null) };
        }
        throw new FtaError(`Not available in the standalone version: ${method} ${p}`, 404);
    }

    // The page asks for "/api/..." (root-relative). Those are answered here whatever the page's own address
    // is -- a website sub-folder, an installed app, or a file opened by double-click (file:///C:/... would
    // otherwise turn them into file:///C:/api/...).
    const API_BASE = 'http://fault-tree.local';
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
        const url = typeof input === 'string' ? input : input.url;
        if (typeof url !== 'string' || !url.startsWith('/api/')) return realFetch(input, init);
        const path = new URL(url, API_BASE).pathname;
        const method = (init.method || 'GET').toUpperCase();
        let body = init.body;
        if (body instanceof ArrayBuffer) body = new TextDecoder().decode(body);
        else if (typeof body === 'string' && path !== '/api/manual-fta/import') { try { body = JSON.parse(body); } catch (e) { /* plain */ } }
        try {
            const result = await route(method, url, body);
            return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
        } catch (e) {
            if (!(e instanceof FtaError)) console.error(e);
            const payload = e.body || { detail: e.detail || e.message, errors: [e.message] };
            return new Response(JSON.stringify(payload), { status: e.status || 500, headers: { 'Content-Type': 'application/json' } });
        }
    };

    // Export XML / LaTeX: generated here and saved as a file (the app serves them from /fta-export/manual.*)
    function download(text, type, name) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([text], { type }));
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
    function exportTex(data, analysis) {
        const a = data.analyses.find(x => x.id === analysis);
        return window.FtaTikz.document(buildGraph(data, analysis), {
            name: a ? a.name : 'all analyses', revision: revisionId(data), changed: data.changed || '',
            exported: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), tool: TOOL });
    }
    document.addEventListener('click', e => {
        const link = e.target.closest && e.target.closest('a#export-xml, a#export-tex');
        if (!link) return;
        e.preventDefault();
        const analysis = new URL(link.href, location.href).searchParams.get('analysis') || '';
        const data = load(), base = `fault_trees_${analysis || 'all'}_${revisionId(data)}`;
        if (link.id === 'export-xml') download(exportXml(data, analysis), 'application/xml', base + '.xml');
        else download(exportTex(data, analysis), 'application/x-tex', base + '.tex');
    }, true);

    window.FaultTreeProMax = { load, STORE, exportXml: a => exportXml(load(), a), exportTex: a => exportTex(load(), a),
                               graph: a => buildGraph(load(), a) };   // for tests and the curious
})();
