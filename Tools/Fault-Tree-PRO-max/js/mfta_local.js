// Integrity Workbench - Fault Tree PRO max, standalone (user, 2026-10-21: "a standalone fault tree pro max
// that I can share with my friends"). The page is the app's Manual FTA page (app/templates/manual_fta.html,
// built by scripts/build_standalone_fta.py); this file answers its server calls in the browser instead:
// window.fetch is wrapped, so /api/manual-fta/... and /api/model-identity never leave the browser. The data
// lives in localStorage. The logic is a port of app/services/manual_fta.py (analyses, events, repeated
// events with scopes, move / copy / copy with new IDs, criticality, colour, layout) and of the manual part
// of app/services/fta_export.py (XML export / import, same format as the app; rwb_import.py for Reliability
// Workbench XML) -- keep them in step.
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
        ensureUids(data.tops);
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
        causes: o.causes || [], criticality: o.criticality || '', color: o.color || '', analysis: o.analysis || '',
        new_page: !!o.new_page, uid: o.uid || '' });
    const clone = e => JSON.parse(JSON.stringify(e));
    // the internal ID that never changes (manual_fta._ensure_uids(), SFM-202): kept; new events get one; every
    // occurrence of a repeated event shares one; one used by two different events is replaced for the later one
    const newUid = () => 'u' + Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, '0')).join('');
    function ensureUids(tops) {
        const byId = new Map(), owner = new Map();
        for (const e of walk(tops)) {
            if (byId.has(e.id)) { e.uid = byId.get(e.id); continue; }
            if (!e.uid || (owner.has(e.uid) && owner.get(e.uid) !== e.id)) { do e.uid = newUid(); while (owner.has(e.uid)); }
            byId.set(e.id, e.uid); owner.set(e.uid, e.id);
        }
    }
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
            e.uid = '';                                      // an independent event now: its own internal ID
            return [[e, parent]];
        }
        throw new NeedsScope(id, occ.length);
    }
    const parentPath = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    const signature = e => JSON.stringify([e.id, e.title, e.description, e.label, e.kind, e.gate, e.criticality, e.color, !!e.new_page,
                                          e.causes.map(signature)]);
    function cloneNewIds(e, tops, counters, asTop) {
        const n = ev({ ...e, id: newId(tops, counters, asTop ? 'top' : e.kind), causes: [], analysis: '', new_page: !!e.new_page, uid: '' });
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
            if (b.new_page) {                                    // SFM-184; a top event: its tree on a page of its own (SFM-192)
                if ((b.kind || first.kind) === 'basic') throw new FtaError(`${id} is a basic event -- only a gate's branch can continue on a new page.`);
            }
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
                if (b.new_page !== undefined) e.new_page = !!b.new_page;
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
    // compact display (SFM-200): the same blocks, neighbours 10 and rows 110 units apart (manual_fta.COMPACT_*)
    const COMPACT_H_GAP = 10 * UNIT, COMPACT_ROW_PITCH = 110 * UNIT;
    // compact stage 2 (SFM-201): branches packed row by row -- manual_fta._contour(), the same arithmetic
    const BAND_GAP = 6 * UNIT, EXIT_HALF = 17 * UNIT;
    function contour(e, path, root, gap) {
        const half = LEAF_W / 2, right = reach(e, gap, true);            // its label included (SFM-212)
        if (!e.causes.length || (e.new_page && !root)) return [{ [path]: 0 }, [[-half, right]], []];
        const kids = e.causes.map(c => contour(c, `${path}/${c.id}`, false, gap));
        const offsets = [], rowsU = [], bandsU = [];
        for (const [, rows, bands] of kids) {
            let need = null;
            rows.forEach(([left], d) => { if (d < rowsU.length) { const n = rowsU[d][1] + gap - left; need = need === null ? n : Math.max(need, n); } });
            bands.forEach(([left], d) => { if (d < bandsU.length) { const n = bandsU[d][1] + BAND_GAP - left; need = need === null ? n : Math.max(need, n); } });
            const o = need === null ? 0 : need;
            offsets.push(o);
            for (const [union, own] of [[rowsU, rows], [bandsU, bands]])
                own.forEach(([left, right], d) => {
                    if (d < union.length) union[d] = [Math.min(union[d][0], left + o), Math.max(union[d][1], right + o)];
                    else union.push([left + o, right + o]);
                });
        }
        const mid = (offsets[0] + offsets[offsets.length - 1]) / 2, pos = { [path]: 0 };
        kids.forEach(([childPos], i) => { for (const [key, x] of Object.entries(childPos)) pos[key] = x + offsets[i] - mid; });
        const exitHalf = kids.length > 1 ? EXIT_HALF : 0;
        const band0 = [Math.min(offsets[0] - mid, -exitHalf), Math.max(offsets[offsets.length - 1] - mid, exitHalf)];
        return [pos, [[-half, right]].concat(rowsU.map(([a, b]) => [a - mid, b - mid])),
                [band0].concat(bandsU.map(([a, b]) => [a - mid, b - mid]))];
    }
    // a label (SFM-212): the block reaches right to the label's frame -- manual_fta._reach() / _extent(), the same arithmetic
    const NOTE_MAX_W = LEAF_W, NOTE_TAG_ROOM = (2 + 22) * UNIT, NOTE_MARGIN = 10 * UNIT;
    function reach(e, gap, compact) {
        const half = LEAF_W / 2;
        if (!e.label) return half;
        const end = half + (e.criticality && !compact ? NOTE_TAG_ROOM : 0) + 3 * UNIT + 6 + NOTE_MAX_W;
        return Math.max(half, end - gap + NOTE_MARGIN);
    }
    const span = (ext, gap) => ext.reduce((a, [l, r]) => a + l + r, 0) + gap * (ext.length - 1);
    function extent(e, root = true, gap = H_GAP, compact = false) {     // [left, right] of the branch around the event's middle
        const half = LEAF_W / 2, own = reach(e, gap, compact);
        if (!e.causes.length || (e.new_page && !root)) return [half, own];
        const s = span(e.causes.map(c => extent(c, false, gap, compact)), gap);
        return [Math.max(half, s / 2), Math.max(own, s / 2)];
    }
    // manual_fta.pages(): page 1 = the trees, then one page per event marked new_page (once per ID, tree order)
    // a top event marked new_page: its tree on a page of its own, page 1 only for the other trees (SFM-192)
    function pagesOf(tops) {
        const loose = tops.filter(t => !t.new_page);
        const result = loose.length || !tops.length ? [{ id: '', number: 1, code: '', title: '', at: '', parent: null,
            trees: loose.map(t => ({ id: t.id, title: t.title })) }] : [], seen = new Set();   // page 1's trees (SFM-196)
        // parent: the page the gate's transfer triangle is on (null for page 1 and an own-page tree, SFM-193)
        function visit(e, path, owner) {
            for (const c of e.causes) {
                const here = `${path}/${c.id}`;
                if (c.new_page && !seen.has(c.id)) { seen.add(c.id); result.push({ id: c.id, number: result.length + 1, code: c.id, title: c.title, at: here, parent: owner }); }
                visit(c, here, c.new_page ? c.id : owner);
            }
        }
        for (const t of loose) visit(t, t.id, '');
        for (const t of tops) {
            if (!t.new_page || seen.has(t.id)) continue;
            seen.add(t.id);
            result.push({ id: t.id, number: result.length + 1, code: t.id, title: t.title, at: t.id, parent: null });
            visit(t, t.id, t.id);
        }
        return result;
    }
    // manual_fta.table(): the Grid view's rows, one per event ID (SFM-195) -- keep in step
    function tableOf(data, analysis) {
        const names = Object.fromEntries(data.analyses.map(a => [a.id, a.name]));
        const numbers = Object.fromEntries(data.analyses.map(a => [a.id,
            Object.fromEntries(pagesOf(data.tops.filter(t => t.analysis === a.id)).map(p => [p.id, p.number]))]));
        const rows = new Map();
        function walk(e, parent, path, top, owner) {
            const page = e.new_page ? e.id : owner;
            let row = rows.get(e.id);
            if (!row) {
                const n = e.causes.length;
                row = { id: e.id, uid: e.uid || '', kind: parent ? (e.kind === 'intermediate' ? 'gate' : e.kind) : 'top',
                        title: e.title, description: e.description, label: e.label, criticality: e.criticality, color: e.color,
                        type: e.kind === 'basic' ? '' : n > 1 ? e.gate.toUpperCase() : n === 1 ? 'single input' : 'not developed',
                        inputs: e.causes.map(c => c.id), parents: [], trees: [], occurrences: 0,
                        page, page_number: (numbers[top.analysis] || {})[page] || 0, new_page: !!e.new_page,
                        analysis: top.analysis, analysis_name: names[top.analysis] || '', at: path };
                rows.set(e.id, row);
            }
            row.occurrences += 1;
            if (parent && !row.parents.includes(parent.id)) row.parents.push(parent.id);
            if (!row.trees.includes(top.id)) row.trees.push(top.id);
            for (const c of e.causes) walk(c, e, `${path}/${c.id}`, top, page);
        }
        for (const t of data.tops) if (!analysis || t.analysis === analysis) walk(t, null, t.id, t, t.new_page ? t.id : '');
        const all = [...rows.values()];
        return { gates: all.filter(r => r.kind !== 'basic'), events: all.filter(r => r.kind === 'basic') };
    }
    // ---- version control (manual_fta_versions.py, SFM-197): Save keeps a copy of everything plus its changes and time
    // under STORE + '.versions' -- the change texts are the app's, keep them in step
    const VERSIONS = STORE + '.versions', MAX_CHANGES = 500;
    const VFIELDS = [['title', 'title'], ['description', 'description'], ['label', 'label'], ['criticality', 'H category / ASIL'],
                     ['color', 'colour'], ['type', 'type'], ['inputs', 'inputs'], ['parents', 'below'], ['new_page', 'own page']];
    const loadVersions = () => { try { return JSON.parse(localStorage.getItem(VERSIONS) || '[]'); } catch (e) { return []; } };
    const fmtV = v => Array.isArray(v) ? (v.join(', ') || 'none') : typeof v === 'boolean' ? (v ? 'yes' : 'no') : (v ? `'${v}'` : 'none');
    function changesOf(old, neu) {
        const lines = [], oldNames = Object.fromEntries(old.analyses.map(a => [a.id, a.name]));
        const newNames = Object.fromEntries(neu.analyses.map(a => [a.id, a.name]));
        for (const a of neu.analyses) {
            if (!(a.id in oldNames)) lines.push(`Analysis '${a.name}' added`);
            else if (oldNames[a.id] !== a.name) lines.push(`Analysis '${oldNames[a.id]}' renamed to '${a.name}'`);
        }
        for (const a of old.analyses) if (!(a.id in newNames)) lines.push(`Analysis '${a.name}' deleted`);
        const rows = d => { const t = tableOf(d, ''); return new Map(t.gates.concat(t.events).map(r => [r.id, r])); };
        let before = rows(old);
        const after = rows(neu), kinds = { top: 'Top event', gate: 'Gate', basic: 'Basic event' };
        // an ID changed: by the internal ID (SFM-202), else by the place in the tree (manual_fta_versions._renames())
        const byUid = new Map([...after].filter(([, r]) => r.uid).map(([id, r]) => [r.uid, id]));
        const renamed = new Map();
        for (const [id, r] of before) {
            const to = r.uid ? byUid.get(r.uid) : undefined;
            if (to !== undefined && to !== id && !before.has(to)) renamed.set(id, to);
        }
        const oldIds = new Set([...before.keys()].filter(i => !renamed.has(i)));
        const newIds = new Set([...after.keys()].filter(i => ![...renamed.values()].includes(i)));
        const found = new Map();
        (function pairs(list) {
            for (const [a, b, top] of list) {
                const ka = top ? 'top' : a.kind, kb = top ? 'top' : b.kind;
                if (a.id !== b.id && ka === kb && !newIds.has(a.id) && !oldIds.has(b.id)
                    && !found.has(a.id) && ![...found.values()].includes(b.id)) found.set(a.id, b.id);
                pairs(a.causes.slice(0, Math.min(a.causes.length, b.causes.length)).map((x, i) => [x, b.causes[i], false]));
            }
        })(old.tops.slice(0, Math.min(old.tops.length, neu.tops.length)).map((t, i) => [t, neu.tops[i], true]));
        for (const [a, b] of found) if (!renamed.has(a)) renamed.set(a, b);
        for (const [a, b] of renamed) lines.push(`${a}: ID changed to ${b}`);
        if (renamed.size) {
            const ren = ids => ids.map(i => renamed.get(i) || i);
            before = new Map([...before].map(([id, r]) => {
                const to = renamed.get(id) || id;
                return [to, { ...r, id: to, inputs: ren(r.inputs), parents: ren(r.parents), trees: ren(r.trees) }];
            }));
        }
        for (const [id, r] of after) {
            const o = before.get(id);
            if (!o) { lines.push(`${kinds[r.kind]} ${id} '${r.title}' added`); continue; }
            if (o.kind !== r.kind) lines.push(`${id}: ${kinds[o.kind].toLowerCase()} -> ${kinds[r.kind].toLowerCase()}`);
            for (const [key, name] of VFIELDS)
                if (JSON.stringify(o[key]) !== JSON.stringify(r[key])) lines.push(`${id}: ${name} ${fmtV(o[key])} -> ${fmtV(r[key])}`);
            if (o.analysis !== r.analysis) lines.push(`${id}: moved to analysis '${r.analysis_name}'`);
        }
        for (const [id, o] of before) if (!after.has(id)) lines.push(`${kinds[o.kind]} ${id} '${o.title}' deleted`);
        return lines;
    }
    function summaryOf(lines) {
        const added = lines.filter(x => x.endsWith(' added')).length, deleted = lines.filter(x => x.endsWith(' deleted')).length;
        const changed = lines.length - added - deleted;
        return [added ? `${added} added` : '', changed ? `${changed} changed` : '', deleted ? `${deleted} deleted` : '']
            .filter(Boolean).join(', ') || 'no changes';
    }
    const stateOf = d => JSON.stringify({ analyses: d.analyses, tops: d.tops });
    const hashOf = text => {                      // cyrb53: a short fingerprint of a state, to see "changed?" without a copy
        let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
        for (let i = 0; i < text.length; i++) {
            const c = text.charCodeAt(i);
            h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
    };
    const shownVersion = ({ snapshot, hash, onDisk, ...v }) => v;          // what the page gets (the app's fields)
    const versionHash = v => v.hash || (v.snapshot ? hashOf(stateOf(v.snapshot)) : '');
    function versionStatus(data) {
        const versions = loadVersions(), last = versions[versions.length - 1];
        return { versions: versions.slice().reverse().map(shownVersion), current: last ? last.n : 0,
                 dirty: last ? hashOf(stateOf(data)) !== versionHash(last) : data.tops.length > 0,
                 folder: folderHandle ? folderHandle.name : '' };
    }
    async function snapshotOf(v) {                // a revision's copy: in the browser, or in the linked folder (SFM-199)
        if (v.snapshot) return v.snapshot;
        const dir = await folderAccess(true);
        const text = dir ? await readText(await dir.getDirectoryHandle('versions', { create: true }), revisionFile(v.n)) : null;
        if (!text) throw new FtaError(`Revision ${v.n} is kept in the folder "${folderHandle ? folderHandle.name : '?'}" on this `
                                      + 'computer -- connect it again (File > Keep on this computer).', 409);
        return JSON.parse(text);
    }
    async function saveVersion(data, note = '') {
        const versions = loadVersions(), last = versions[versions.length - 1], hash = hashOf(stateOf(data));
        const dir = await folderAccess(true);
        if (last && hash === versionHash(last)) {     // nothing changed: no revision -- the folder still gets the state
            if (dir) await writeFolder(dir, data);
            return null;
        }
        const lines = changesOf(last ? await snapshotOf(last) : { analyses: [], tops: [] }, data);
        const snapshot = JSON.parse(JSON.stringify({ analyses: data.analyses, tops: data.tops, counters: data.counters }));
        const v = { n: last ? last.n + 1 : 1, saved: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), summary: summaryOf(lines),
                    note, total: lines.length, changes: lines.slice(0, MAX_CHANGES), hash };
        if (dir) {                                    // the copy goes to the folder, not into the browser's storage
            await writeText(await dir.getDirectoryHandle('versions', { create: true }), revisionFile(v.n), JSON.stringify(snapshot));
            v.onDisk = true;
        } else v.snapshot = snapshot;
        try { localStorage.setItem(VERSIONS, JSON.stringify(versions.concat([v]))); }
        catch (e) {
            throw new FtaError('Not enough browser storage for another revision -- keep the fault trees in a folder on this '
                               + 'computer (File > Keep on this computer) or export the XML.', 507);
        }
        if (dir) await writeFolder(dir, data);
        return shownVersion(v);
    }
    async function restoreVersion(data, n) {
        const v = loadVersions().find(x => x.n === n);
        if (!v) throw new FtaError(`There is no revision ${n}.`, 404);
        const snapshot = await snapshotOf(v);
        if (versionStatus(data).dirty) await saveVersion(data, `Saved before restoring revision ${n}`);
        save({ ...load(), ...JSON.parse(JSON.stringify(snapshot)) });
        return (await saveVersion(load(), `Restored revision ${n}`)) || { n };
    }

    // ---- a folder on this computer (SFM-199, user 2026-10-24: "in browser cannot select to make local copy on harddisk?"):
    // with the File System Access API (Chrome, Edge) the fault trees and their revisions are kept in a folder the user
    // picks -- fault-trees.json (everything, to open again), fault-trees.xml (readable, imports into the app),
    // versions/versions.json + versions/rNNNN.json (the revisions; their copies then live only there). The folder is
    // remembered (IndexedDB); after a restart the browser asks once for permission again, on the next Save.
    const HAS_FOLDER_API = typeof window.showDirectoryPicker === 'function';
    let folderHandle = null;
    const revisionFile = n => `r${String(n).padStart(4, '0')}.json`;
    function idbRun(mode, fn) {
        return new Promise((resolve, reject) => {
            const open = indexedDB.open('faultTreeProMax', 1);
            open.onupgradeneeded = () => open.result.createObjectStore('handles');
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
                const tx = open.result.transaction('handles', mode), req = fn(tx.objectStore('handles'));
                tx.oncomplete = () => { resolve(req && req.result); open.result.close(); };
                tx.onerror = () => reject(tx.error);
            };
        });
    }
    const loadFolderHandle = () => idbRun('readonly', s => s.get('folder')).catch(() => null);
    const storeFolderHandle = h => idbRun('readwrite', s => (h ? s.put(h, 'folder') : s.delete('folder'))).catch(() => null);
    async function folderAccess(ask) {
        if (!folderHandle) return null;
        try {
            let p = await folderHandle.queryPermission({ mode: 'readwrite' });
            if (p !== 'granted' && ask) p = await folderHandle.requestPermission({ mode: 'readwrite' });
            return p === 'granted' ? folderHandle : null;
        } catch (e) { return null; }
    }
    async function writeText(dir, name, text) {
        const file = await dir.getFileHandle(name, { create: true }), w = await file.createWritable();
        await w.write(text); await w.close();
    }
    async function readText(dir, name) {
        try { return await (await (await dir.getFileHandle(name)).getFile()).text(); } catch (e) { return null; }
    }
    async function writeFolder(dir, data) {
        const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
        await writeText(dir, 'fault-trees.json', JSON.stringify({ format: 'fault-tree-pro-max', saved: now, analyses: data.analyses,
                                                                  tops: data.tops, counters: data.counters }));
        await writeText(dir, 'fault-trees.xml', exportXml(data, ''));
        const vdir = await dir.getDirectoryHandle('versions', { create: true });
        const versions = loadVersions();
        for (const v of versions) if (v.snapshot) await writeText(vdir, revisionFile(v.n), JSON.stringify(v.snapshot));
        const moved = versions.map(v => { const { snapshot, ...rest } = v; return { ...rest, hash: versionHash(v), onDisk: true }; });
        await writeText(vdir, 'versions.json', JSON.stringify(moved.map(({ onDisk, ...v }) => v), null, 1));
        localStorage.setItem(VERSIONS, JSON.stringify(moved));           // the copies now live in the folder
    }
    async function chooseFolder() {
        if (!HAS_FOLDER_API) {
            alert('Keeping the fault trees in a folder needs Chrome or Edge. Here: Import / Export > Export XML keeps a copy.');
            return;
        }
        let dir;
        try { dir = await window.showDirectoryPicker({ id: 'fault-tree-pro-max', mode: 'readwrite' }); }
        catch (e) {      // SFM-213: only a cancelled dialog stays silent -- a blocked one (e.g. by a company policy) says so
            if (e && e.name === 'AbortError') return;
            alert(`This browser did not open the folder dialog (${(e && e.name) || 'Error'}: ${(e && e.message) || e}).\n\n`
                  + 'On company computers the IT policy often switches off folder access for web pages. '
                  + 'Keep a copy with Import / Export > Export XML instead (open it again with Import XML).');
            return;
        }
        const there = await readText(dir, 'fault-trees.json');
        if (there) {
            let stored = null;
            try { stored = JSON.parse(there); } catch (e) { /* not ours */ }
            if (stored && Array.isArray(stored.analyses) && Array.isArray(stored.tops) && confirm(
                `The folder "${dir.name}" already holds fault trees (saved ${stored.saved || '?'}).\n\nOK: open them here `
                + '(the fault trees in this browser are replaced).\nCancel: keep the fault trees of this browser and save them '
                + 'into the folder.')) {
                const vtext = await readText(await dir.getDirectoryHandle('versions', { create: true }), 'versions.json');
                let versions = [];
                try { versions = (JSON.parse(vtext || '[]') || []).map(v => ({ ...v, onDisk: true })); } catch (e) { /* none */ }
                save({ ...load(), analyses: stored.analyses, tops: stored.tops, counters: stored.counters || {} });
                localStorage.setItem(VERSIONS, JSON.stringify(versions));
                folderHandle = dir; await storeFolderHandle(dir);
                location.reload();
                return;
            }
        }
        folderHandle = dir; await storeFolderHandle(dir);
        try { await writeFolder(dir, load()); } catch (e) { alert(`Could not write into "${dir.name}": ${e.message}`); }
        updateFolderUi();
    }
    async function stopFolder() {
        if (!folderHandle) return;
        if (!confirm(`Stop keeping the fault trees in "${folderHandle.name}"? The files there stay; revisions saved there can `
                     + 'only be restored after linking the folder again.')) return;
        folderHandle = null; await storeFolderHandle(null);
        updateFolderUi();
    }
    function updateFolderUi() {
        const link = document.getElementById('folder-link'), stop = document.getElementById('folder-stop');
        const state = document.getElementById('folder-status');
        if (!link) return;
        link.textContent = folderHandle ? `Folder on this computer: ${folderHandle.name}…` : 'Keep on this computer (folder)…';
        link.title = HAS_FOLDER_API ? 'Keep the fault trees and their revisions in a folder on this computer (written on Save)'
                                    : 'Needs Chrome or Edge -- use Import / Export > Export XML';
        stop.hidden = !folderHandle;
        state.textContent = folderHandle ? `Folder: ${folderHandle.name}` : '';
        state.title = folderHandle ? 'Save writes the fault trees and the revision into this folder on your computer' : '';
    }
    document.addEventListener('DOMContentLoaded', async () => {          // File menu items + status (standalone only)
        const anchor = document.getElementById('menu-save');
        if (!anchor) return;
        const mk = (id, text, run) => {
            const b = document.createElement('button');
            b.type = 'button'; b.setAttribute('role', 'menuitem'); b.id = id; b.textContent = text;
            b.addEventListener('click', run);
            return b;
        };
        anchor.after(mk('folder-link', 'Keep on this computer (folder)…', chooseFolder),
                     mk('folder-stop', 'Stop using the folder', stopFolder));
        const state = document.createElement('span');
        state.id = 'folder-status'; state.className = 'save-status'; state.style.color = '#1e3a8a';
        const saveState = document.getElementById('save-status');
        if (saveState) saveState.after(state);
        folderHandle = await loadFolderHandle() || null;
        updateFolderUi();
    });
    function buildGraph(data, analysis, page = '', compact = 0) {    // compact: 0, 1 (SFM-200), 2 stacked (SFM-201)
        const stage = Number(compact) || 0, tight = {};
        const gap = stage ? COMPACT_H_GAP : H_GAP, pitch = stage ? COMPACT_ROW_PITCH : ROW_PITCH;
        const counts = {};
        for (const e of walk(data.tops)) counts[e.id] = (counts[e.id] || 0) + 1;
        const tops = analysis ? data.tops.filter(t => t.analysis === analysis) : data.tops;
        const nodes = [], edges = [];
        const pageList = pagesOf(tops), pageNo = Object.fromEntries(pageList.map(p => [p.id, p.number]));
        const start = page ? pageList.find(p => p.id === page) : null;
        function place(e, x, row, topId, path) {
            const nodeId = path ? `${path}/${e.id}` : e.id;
            const transfer = e.new_page && row > 0;
            nodes.push({ data: { id: nodeId, type: 'manual_event', symbol: symbol(e), label: e.title, shared: (counts[e.id] || 0) > 1,
                occurrences: counts[e.id] || 0, code: e.id, depth: row, kind: e.kind, gate: e.gate, top: topId,
                description: e.description, note: e.label, tag: e.criticality, tag_box: true, color: e.color,
                fill: e.color ? COLORS[e.color] : '', tikz_fill: e.color ? TIKZ_COLORS[e.color] : '', causes: e.causes.length,
                new_page: !!e.new_page, page_number: e.new_page ? (pageNo[e.id] || 0) : 0 }, position: { x, y: row * pitch } });
            if (stage) { nodes[nodes.length - 1].data.compact = true; if (stage === 2) nodes[nodes.length - 1].data.stacked = true; }
            if (transfer) { nodes[nodes.length - 1].data.symbol = 'transfer'; return; }
            const ext = e.causes.map(c => extent(c, false, gap, !!stage));
            let cursor = x - span(ext, gap) / 2;
            e.causes.forEach((c, i) => {
                const child = `${nodeId}/${c.id}`;
                edges.push({ data: { id: `mfta-${child}`, source: nodeId, target: child, input_index: i, input_count: e.causes.length } });
                place(c, stage === 2 ? tight[child] : cursor + ext[i][0], row + 1, topId, nodeId);
                cursor += ext[i][0] + ext[i][1] + gap;
            });
        }
        if (start) {                                       // a continuation page: the branch alone; or a tree on its own page
            const [e, , path] = resolve(tops, start.code, start.at);
            const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
            if (stage === 2) {
                const [pos, rows] = contour(e, parent ? `${parent}/${e.id}` : e.id, true, gap);
                const base = -Math.min(...rows.map(r => r[0]));
                for (const [key, x] of Object.entries(pos)) tight[key] = base + x;
                place(e, base, 0, path.split('/')[0], parent);
            } else place(e, extent(e, true, gap, !!stage)[0], 0, path.split('/')[0], parent);
            if (parent) {                                  // continued from an earlier page: the side triangle, "…" (SFM-193)
                const back = start.parent || '';
                Object.assign(nodes[0].data, { page_start: true, from_page_id: back, from_page: pageNo[back] || 0 });
            }
            return { nodes, edges };
        }
        let cursor = 0;
        const placedRows = [];
        for (const t of tops.filter(x => !x.new_page)) {
            if (stage === 2) {                             // trees side by side, also packed row by row
                const [pos, rows] = contour(t, t.id, true, gap);
                let base = -Math.min(...rows.map(r => r[0]));
                if (placedRows.length) {
                    base = -Infinity;
                    for (let d = 0; d < Math.min(rows.length, placedRows.length); d++) base = Math.max(base, placedRows[d][1] + gap * 3 - rows[d][0]);
                }
                for (const [key, x] of Object.entries(pos)) tight[key] = base + x;
                place(t, base, 0, t.id, '');
                rows.forEach(([a, b], d) => {
                    if (d < placedRows.length) placedRows[d] = [Math.min(placedRows[d][0], a + base), Math.max(placedRows[d][1], b + base)];
                    else placedRows.push([a + base, b + base]);
                });
                continue;
            }
            const [l, r] = extent(t, true, gap, !!stage); place(t, cursor + l, 0, t.id, ''); cursor += l + r + gap * 3;
        }
        return { nodes, edges };
    }

    // ---- XML export / import (fta_export.py, source "manual") -----------------------------------
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    function eventXml(e, indent) {
        const pad = '  '.repeat(indent);
        let a = ` id="${esc(e.id)}" kind="${e.kind}" gate="${e.gate}"`;
        if (e.uid) a += ` uid="${esc(e.uid)}"`;
        if (e.label) a += ` label="${esc(e.label)}"`;
        if (e.criticality) a += ` criticality="${esc(e.criticality)}"`;
        if (e.color) a += ` color="${esc(e.color)}"`;
        if (e.new_page) a += ` newPage="true"`;
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
    // the trees as Reliability Workbench XML -- rwb_import.py :: to_rwb_xml() (SFM-190), the same text
    const RWB_COLUMNS = {
        GateInputs: [['Gate', 'string'], ['ObjectIndex', 'int'], ['ObjectType', 'string'], ['SubIndex', 'int']],
        Gates: [['Id', 'string'], ['Description', 'string'], ['LabelText', 'string'], ['Page', 'boolean'], ['Type', 'string']],
        PrimaryEvents: [['Id', 'string'], ['AsilEnabled', 'boolean'], ['AsilRequirement', 'string'], ['Description', 'string'],
                        ['EventType', 'string'], ['Notes1', 'string']],
    };
    const RWB_NOT_EXPORTED = "description texts, colours, the label of a basic event, and a gate's label when it also has a "
                           + "criticality (RWB's LabelText holds one of the two)";
    function exportRwbXml(data, analysis) {
        const tops = data.tops.filter(t => !analysis || t.analysis === analysis);
        const x = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const gates = [], events = [], index = new Map();
        const collect = (e, isTop) => {
            if (index.has(e.id)) return;
            if (e.kind === 'basic' && !isTop) { index.set(e.id, ['event', events.length]); events.push(e); return; }
            index.set(e.id, ['gate', gates.length]); gates.push(e);
            e.causes.forEach(c => collect(c, false));
        };
        tops.forEach(t => collect(t, true));
        const topIds = new Set(tops.map(t => t.id));
        const row = (table, values) => [`  <${table}>`, ...RWB_COLUMNS[table].map(([name]) => {
            const v = values[name] || '';
            return v !== '' ? `    <${name}>${x(v)}</${name}>` : `    <${name} />`;
        }), `  </${table}>`];
        const schema = ['  <xs:schema id="XMLExport" xmlns="" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:msdata="urn:schemas-microsoft-com:xml-msdata">',
            '    <xs:element name="XMLExport" msdata:IsDataSet="true" msdata:UseCurrentLocale="true">',
            '      <xs:complexType>', '        <xs:choice minOccurs="0" maxOccurs="unbounded">'];
        for (const [table, cols] of Object.entries(RWB_COLUMNS)) {
            schema.push(`          <xs:element name="${table}">`, '            <xs:complexType>', '              <xs:sequence>');
            for (const [name, kind] of cols) schema.push(`                <xs:element name="${name}" type="xs:${kind}"${name === 'Id' ? '' : ' minOccurs="0"'} />`);
            schema.push('              </xs:sequence>', '            </xs:complexType>', '          </xs:element>');
        }
        schema.push('        </xs:choice>', '      </xs:complexType>',
            '      <xs:unique name="Constraint1" msdata:PrimaryKey="true">',
            '        <xs:selector xpath=".//Gates" />', '        <xs:field xpath="Id" />', '      </xs:unique>',
            '      <xs:unique name="PrimaryEvents_Constraint1" msdata:ConstraintName="Constraint1" msdata:PrimaryKey="true">',
            '        <xs:selector xpath=".//PrimaryEvents" />', '        <xs:field xpath="Id" />', '      </xs:unique>',
            '    </xs:element>', '  </xs:schema>');
        const inputs = [], rows = [];
        for (const g of gates) g.causes.forEach((c, order) => {
            const [table, r] = index.get(c.id);
            inputs.push(...row('GateInputs', { Gate: g.id, ObjectIndex: String(r), ObjectType: table === 'gate' ? 'Gate' : 'Primary event', SubIndex: String(order) }));
        });
        for (const g of gates) {
            const n = g.causes.length, type = n > 1 ? g.gate.toUpperCase() : n === 1 ? 'NULL' : 'TRANSFER';
            rows.push(...row('Gates', { Id: g.id, Description: g.title, LabelText: g.criticality || g.label,
                                        Page: g.new_page && !topIds.has(g.id) ? 'true' : 'false', Type: type }));
        }
        for (const e of events) rows.push(...row('PrimaryEvents', { Id: e.id, AsilEnabled: 'false', AsilRequirement: 'QM',
                                                                    Description: e.title, EventType: 'Basic', Notes1: e.criticality }));
        const head = ['<?xml version="1.0" standalone="yes"?>',
            `<!-- Fault trees exported by ${x(TOOL)} for Isograph Reliability Workbench (import with the template IntegrityWorkbench_FTA.rwb-impx). Not carried over: ${RWB_NOT_EXPORTED}. -->`,
            '<XMLExport>'];
        return head.concat(schema, inputs, rows, ['</XMLExport>']).join('\n') + '\n';
    }
    function parseEvent(el) {
        return ev({ id: el.getAttribute('id') || '', title: (el.querySelector(':scope > title') || {}).textContent || '',
            description: (el.querySelector(':scope > description') || {}).textContent || '', label: el.getAttribute('label') || '',
            kind: el.getAttribute('kind'), gate: el.getAttribute('gate'),
            criticality: CRITICALITY_LEVELS.includes(el.getAttribute('criticality')) ? el.getAttribute('criticality') : '',
            color: (el.getAttribute('color') || '') in COLORS ? el.getAttribute('color') : '',
            new_page: el.getAttribute('newPage') === 'true', uid: el.getAttribute('uid') || '',
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
    // Isograph Reliability Workbench XML export -> the manual export format (rwb_import.py, SFM-189) -- keep in step
    function rwbToManual(root) {
        const rows = tag => [...root.children].filter(c => c.tagName === tag);
        const text = (el, name) => { const c = [...el.children].find(x => x.tagName === name); return c ? c.textContent.trim() : ''; };
        const oneLine = s => s.split(/\s+/).filter(Boolean).join(' ');
        const crit = v => { v = v.trim(); return CRITICALITY_LEVELS.includes(v) ? v : CRITICALITY_LEVELS.includes('ASIL ' + v) ? 'ASIL ' + v : ''; };
        const gates = rows('Gates'), events = rows('PrimaryEvents');
        const notes = ['Isograph Reliability Workbench XML export -- read: Gates, PrimaryEvents, GateInputs (everything else in the file is not used).'];
        const errors = [], used = new Set(), renamed = [];
        const transfers = new Set(), inhibits = new Set(), otherEvents = new Map();   // insertion-ordered, once per ID
        const listed = (ids, limit = 10) => ids.slice(0, limit).join(', ') + (ids.length > limit ? ` ... and ${ids.length - limit} more` : '');
        const cleanId = (raw, row) => {
            let neu = raw.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[_.-]+|[_.-]+$/g, '') || row;
            const base = neu; let n = 2;
            while (used.has(neu)) neu = `${base}_${n++}`;
            used.add(neu);
            if (neu !== raw) renamed.push(`'${raw}' -> ${neu}`);
            return neu;
        };
        const gateIds = gates.map((g, i) => cleanId(text(g, 'Id'), `GATE${i}`));
        const eventIds = events.map((e, i) => cleanId(text(e, 'Id'), `EVENT${i}`));
        const gateRow = new Map(gates.map((g, i) => [text(g, 'Id'), i]));
        const inputs = new Map();
        for (const el of rows('GateInputs')) {
            const gate = text(el, 'Gate'), kind = text(el, 'ObjectType');
            const index = Number(text(el, 'ObjectIndex')), order = Number(text(el, 'SubIndex') || 0);
            if (text(el, 'ObjectIndex') === '' || !Number.isInteger(index) || !Number.isInteger(order)) { errors.push(`GateInputs of ${gate}: ObjectIndex / SubIndex is not a number.`); continue; }
            if (!gateRow.has(gate)) { errors.push(`GateInputs: there is no gate ${gate}.`); continue; }
            const table = kind === 'Gate' ? 'gate' : kind === 'Primary event' ? 'event' : '';
            if (!table) { errors.push(`GateInputs of ${gate}: unknown ObjectType '${kind}'.`); continue; }
            if (!(index >= 0 && index < (table === 'gate' ? gates.length : events.length))) {
                errors.push(`GateInputs of ${gate}: there is no ${table === 'gate' ? 'gate' : 'primary event'} in row ${index} (ObjectIndex is the row position, 0-based).`);
                continue;
            }
            if (!inputs.has(gate)) inputs.set(gate, []);
            inputs.get(gate).push([order, table, index]);
        }
        for (const ins of inputs.values()) ins.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) || a[2] - b[2]);
        const all = [...inputs.values()].flat();
        const usedGates = new Set(all.filter(x => x[1] === 'gate').map(x => x[2]));
        const usedEvents = new Set(all.filter(x => x[1] === 'event').map(x => x[2]));
        const eventXmlOf = (i, pad) => {
            const e = events[i], kind = text(e, 'EventType') || 'Basic';
            if (kind === 'House' || kind === 'Conditional') errors.push(`${eventIds[i]}: a ${kind.toLowerCase()} event changes the logic -- the Manual FTA has no such event.`);
            else if (kind !== 'Basic') { if (!otherEvents.has(kind)) otherEvents.set(kind, new Set()); otherEvents.get(kind).add(eventIds[i]); }
            let c = crit(text(e, 'Notes1'));
            if (!c && text(e, 'AsilEnabled') === 'true') c = crit(text(e, 'AsilRequirement'));
            return `${pad}<event id="${esc(eventIds[i])}" kind="basic" gate="or"${c ? ` criticality="${esc(c)}"` : ''}><title>${esc(oneLine(text(e, 'Description')))}</title></event>\n`;
        };
        const gateXmlOf = (i, stack, isTop, pad) => {
            const g = gates[i], gid = gateIds[i], kind = text(g, 'Type').toUpperCase(), ins = inputs.get(text(g, 'Id')) || [];
            let gate = 'or', label = oneLine(text(g, 'LabelText'));
            if (kind === 'AND') gate = 'and';
            else if (kind === 'INHIBIT') {                       // RWB evaluates it as AND of its inputs
                gate = 'and'; inhibits.add(gid);
                if (!crit(label)) label = label ? `INHIBIT: ${label}` : 'INHIBIT';
            }
            else if (kind === 'NULL') { if (ins.length > 1) errors.push(`${gid}: a NULL gate with ${ins.length} inputs (it passes on exactly one).`); }
            else if (kind === 'TRANSFER') {
                if (!ins.length) transfers.add(gid);
                else if (ins.length > 1) errors.push(`${gid}: a transfer gate with ${ins.length} inputs.`);
            } else if (kind !== 'OR') errors.push(`${gid}: ${kind || 'no'} gate -- the Manual FTA has only AND / OR gates (INHIBIT is imported as AND, NULL and TRANSFER as a single-input OR).`);
            let a = ` id="${esc(gid)}" kind="intermediate" gate="${gate}"`;
            if (label) a += crit(label) ? ` criticality="${esc(crit(label))}"` : ` label="${esc(label)}"`;
            if (isTop || text(g, 'Page') === 'true') a += ' newPage="true"';   // every top event a page of its own (SFM-192)
            let s = `${pad}<event${a}><title>${esc(oneLine(text(g, 'Description')))}</title>\n`;
            for (const [, table, index] of ins) {
                if (table === 'event') s += eventXmlOf(index, pad + '  ');
                else if (stack.includes(index)) errors.push(`${gid}: input ${gateIds[index]} loops back to a gate above it.`);
                else s += gateXmlOf(index, stack.concat([index]), false, pad + '  ');
            }
            return s + `${pad}</event>\n`;
        };
        let s = `<faultTreeExport format="${FORMAT}" version="${VERSION}" source="manual">\n  <model source="Isograph Reliability Workbench XML export"/>\n`;
        gates.forEach((g, i) => { if (!usedGates.has(i)) s += `  <tree top="${esc(gateIds[i])}">\n${gateXmlOf(i, [i], true, '    ')}  </tree>\n`; });
        if (gates.length && gates.every((g, i) => usedGates.has(i))) errors.push('Every gate is another gate\'s input -- no top event (the gates loop).');
        const nTops = gates.filter((g, i) => !usedGates.has(i)).length;
        if (nTops) notes.push(`${nTops} top event(s), each a fault tree page of its own.`);
        if (renamed.length) notes.push(`${renamed.length} ID(s) made valid (letters, digits, - _ . only, one ID per event): ${listed(renamed, 5)}.`);
        if (inhibits.size) notes.push(`${inhibits.size} INHIBIT gate(s) imported as AND gates labelled INHIBIT (RWB evaluates an INHIBIT gate as AND of its inputs): ${listed([...inhibits])}.`);
        if (transfers.size) notes.push(`${transfers.size} transfer gate(s) without inputs here, imported as gates with nothing below them (drawn as a triangle): ${listed([...transfers])}.`);
        for (const [kind, ids] of otherEvents) notes.push(`${ids.size} ${kind} event(s) imported as basic events: ${listed([...ids])}.`);
        const loose = eventIds.filter((id, i) => !usedEvents.has(i));
        if (loose.length) notes.push(`${loose.length} event(s) below no gate, left out: ${listed(loose)}.`);
        if (gates.concat(events).some(x => text(x, 'Description').includes('\n'))) notes.push('Line breaks in descriptions became spaces (the box wraps the title itself).');
        if (!gates.length) errors.push('The Reliability Workbench file contains no gates.');
        return { root: new DOMParser().parseFromString(s + '</faultTreeExport>\n', 'application/xml').documentElement, notes, errors: [...new Set(errors)] };
    }
    function previewImport(data, text, analysis) {
        const doc = new DOMParser().parseFromString(text, 'application/xml');
        if (doc.querySelector('parsererror')) throw new FtaError('Not a readable XML file.');
        let root = doc.documentElement, notes = [], conversionErrors = [];
        if (root.tagName === 'XMLExport') ({ root, notes, errors: conversionErrors } = rwbToManual(root));
        if (root.tagName !== 'faultTreeExport' || root.getAttribute('format') !== FORMAT)
            throw new FtaError('Not an Integrity Workbench fault tree export (<faultTreeExport format="safety-model-fta">) or a Reliability Workbench XML export (<XMLExport>).');
        if (root.getAttribute('version') !== VERSION) throw new FtaError(`Export format version ${root.getAttribute('version')} is not supported (this tool reads ${VERSION}).`);
        const modelEl = root.querySelector(':scope > model');
        const model = modelEl ? Object.fromEntries([...modelEl.attributes].map(a => [a.name, a.value])) : {};
        const preview = { model, trees: [], errors: [...conversionErrors], notes, tops: [] };
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
        if (p === '/api/manual-fta/table') return tableOf(data, q.get('analysis') || '');   // SFM-195
        if (p === '/api/manual-fta/versions' && method === 'GET') return versionStatus(data);   // SFM-197
        if (p === '/api/manual-fta/versions' && method === 'POST') { const saved = await saveVersion(data); return { saved, ...versionStatus(load()) }; }
        if ((m = /^\/api\/manual-fta\/versions\/(\d+)\/restore$/.exec(p))) {
            const saved = await restoreVersion(data, +m[1]);
            return { restored: +m[1], saved, ...versionStatus(load()) };
        }
        if (p === '/api/manual-fta/explorer') {             // manual_fta.explorer() (SFM-194)
            return { analyses: data.analyses.map(a => {
                const tops = data.tops.filter(t => t.analysis === a.id);
                return { id: a.id, name: a.name, trees: tops.length, pages: pagesOf(tops) };
            }) };
        }
        if (p === '/api/manual-fta/analyses' && method === 'POST') {
            return body.copy_of ? ops.duplicateAnalysis(data, body.copy_of, body.name) : ops.createAnalysis(data, body.name);
        }
        if ((m = /^\/api\/manual-fta\/analyses\/([^/]+)$/.exec(p))) {
            const id = decodeURIComponent(m[1]);
            if (method === 'PUT') return ops.renameAnalysis(data, id, body.name);
            if (method === 'DELETE') return { deleted: ops.deleteAnalysis(data, id) };
        }
        if (p === '/api/manual-fta/graph') {                // one page of the analysis + its pages (SFM-184)
            const analysis = q.get('analysis') || '', tops = analysis ? data.tops.filter(t => t.analysis === analysis) : data.tops;
            const pageList = pagesOf(tops);
            let page = q.get('page') || '';
            if (!pageList.some(x => x.id === page)) page = pageList.length ? pageList[0].id : '';   // SFM-192
            return { ...buildGraph(data, analysis, page, q.get('compact') === 'true' ? 1 : Number(q.get('compact')) || 0), pages: pageList, page };
        }
        if (p === '/api/manual-fta/example-graph') return buildGraph({ tops: exampleTops() }, '');
        if (p === '/api/manual-fta/trees') return ops.newTree(data, body || {});
        if (p === '/api/manual-fta/events/bulk') return { updated: ops.updateEvents(data, body || {}) };
        if (p === '/api/manual-fta/events/bulk-delete') return { deleted: ops.deleteEvents(data, body || {}) };
        if (p === '/api/manual-fta/import') {
            const preview = previewImport(data, body, q.get('analysis') || '');
            const apply = q.get('apply') === 'true';
            if (apply && !preview.errors.length) applyImport(data, preview);
            const out = { model: preview.model, trees: preview.trees, errors: preview.errors, notes: preview.notes,
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
    function exportTex(data, analysis, compact = 0) {
        const a = data.analyses.find(x => x.id === analysis);
        const sheets = [];                                     // one picture per page (SFM-184)
        for (const id of analysis ? [analysis] : data.analyses.map(x => x.id))
            for (const p of pagesOf(data.tops.filter(t => t.analysis === id))) sheets.push({ number: p.number, graph: buildGraph(data, id, p.id, compact) });
        return window.FtaTikz.document(sheets, {
            name: a ? a.name : 'all analyses', revision: revisionId(data), changed: data.changed || '',
            exported: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), tool: TOOL });
    }
    document.addEventListener('click', e => {
        const link = e.target.closest && e.target.closest('a#export-xml, a#export-tex, a#export-rwb');
        if (!link) return;
        e.preventDefault();
        const params = new URL(link.href, location.href).searchParams, analysis = params.get('analysis') || '';
        const data = load(), base = `fault_trees_${analysis || 'all'}_${revisionId(data)}`;
        if (link.id === 'export-xml') download(exportXml(data, analysis), 'application/xml', base + '.xml');
        else if (link.id === 'export-rwb') download(exportRwbXml(data, analysis), 'application/xml', base + '_rwb.xml');
        else download(exportTex(data, analysis, Number(params.get('compact')) || 0), 'application/x-tex', base + '.tex');   // SFM-200/201
    }, true);

    window.FaultTreeProMax = { load, STORE, exportXml: a => exportXml(load(), a), exportRwbXml: a => exportRwbXml(load(), a), exportTex: a => exportTex(load(), a),
                               graph: a => buildGraph(load(), a) };   // for tests and the curious
})();
