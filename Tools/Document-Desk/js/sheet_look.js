// The look of an Excel sheet on the Document Desk (SFM-320, mini_tools plugin) -- what makes a sheet look as in
// Excel beyond the cell's own font: fills (solid, patterns, gradients), borders (each edge decided once for both
// cells, so a dashed or thin border is not lost to the grid line of the neighbour cell; filled cells hide the grid
// lines as in Excel; diagonal lines), table styles (the built-in Light / Medium / Dark families and the workbook's
// own), conditional formatting (cellIs, expression, text, blanks, errors, duplicates, top / bottom, average, dates,
// colour scales, data bars, icon sets -- also the Excel 2010 rules in the sheet's extLst) and the small formula
// reader the expression rules need. A rule whose formula uses something the reader does not know is not applied
// (never guessed). Everything is read in the browser from the workbook's XML; nothing is sent anywhere.

export const KEY = 20000;              // cell key = row * KEY + column (Excel has 16384 columns)

const all = (node, name) => Array.from(node.getElementsByTagNameNS('*', name));
const kids = (node, name) => (node ? Array.from(node.children).filter(c => c.localName === name) : []);
const kid = (node, name) => kids(node, name)[0];
const isOn = v => /^(1|true)$/i.test(v || '');

// ---------------------------------------------------------------- colours

export function tint(hex, t) {
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

const rgb = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
const hex = a => '#' + a.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
// f of colour a over colour b
export const mix = (a, b, f) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v * f + y[i] * (1 - f))); };

// ---------------------------------------------------------------- fills, fonts, borders, dxfs

const GRAY = {gray0625: 0.0625, gray125: 0.125, lightGray: 0.25, mediumGray: 0.5, darkGray: 0.75};
const stripes = (deg, w, c) => `repeating-linear-gradient(${deg}deg, ${c} 0 ${w}px, transparent ${w}px 4px)`;
const PATTERN = {
    darkHorizontal: [[0, 2]], lightHorizontal: [[0, 1]], darkVertical: [[90, 2]], lightVertical: [[90, 1]],
    darkDown: [[45, 2]], lightDown: [[45, 1]], darkUp: [[-45, 2]], lightUp: [[-45, 1]],
    darkGrid: [[0, 2], [90, 2]], lightGrid: [[0, 1], [90, 1]], darkTrellis: [[45, 2], [-45, 2]], lightTrellis: [[45, 1], [-45, 1]],
};

// A <fill> -> {color (the colour it looks like: grid lines, mixing), bg (the CSS background)} or null (no fill).
// In a dxf (conditional format, table style) a solid fill's colour is its bgColor.
export function fillOf(fill, color, dxf = false) {
    if (!fill) return null;
    const g = kid(fill, 'gradientFill');
    if (g) {
        const stops = kids(g, 'stop').map(s => [+(s.getAttribute('position') || 0), color(kid(s, 'color')) || '#ffffff']);
        if (!stops.length) return null;
        const list = stops.map(([p, c]) => `${c} ${(p * 100).toFixed(1)}%`).join(', ');
        const bg = g.getAttribute('type') === 'path' ? `radial-gradient(${list})`
            : `linear-gradient(${90 + (+(g.getAttribute('degree') || 0))}deg, ${list})`;
        return {color: stops[0][1], bg};
    }
    const p = kid(fill, 'patternFill');
    if (!p) return null;
    const type = p.getAttribute('patternType') || (dxf ? 'solid' : 'none');
    if (type === 'none') return null;
    const fg = color(kid(p, 'fgColor')), bgc = color(kid(p, 'bgColor'));
    if (type === 'solid') {
        const c = dxf ? (bgc || fg) : (fg || bgc || '#000000');
        return c ? {color: c, bg: c} : null;
    }
    const f = fg || '#000000', b = bgc || '#ffffff';
    if (type in GRAY) { const c = mix(f, b, GRAY[type]); return {color: c, bg: c}; }
    const layers = PATTERN[type];
    if (!layers) return {color: mix(f, b, 0.5), bg: mix(f, b, 0.5)};
    return {color: mix(f, b, 0.4), bg: layers.map(([deg, w]) => stripes(deg, w, f)).join(', ') + ', ' + b};
}

// A <font> / <rPr> -> {b, i, u, strike, size, name, color, va}; in a dxf, what is not given stays undefined
export function fontOf(f, color, dxf = false) {
    const flag = n => {
        const e = kid(f, n);
        if (!e) return dxf ? undefined : false;
        return !/^(0|false|none)$/.test(e.getAttribute('val') || '');
    };
    const out = {b: flag('b'), i: flag('i'), u: flag('u'), strike: flag('strike'),
                 size: parseFloat(kid(f, 'sz')?.getAttribute('val') || '0'),
                 name: (kid(f, 'name') || kid(f, 'rFont'))?.getAttribute('val') || '',
                 color: kid(f, 'color') ? color(kid(f, 'color')) : (dxf ? undefined : null),
                 va: kid(f, 'vertAlign')?.getAttribute('val') || ''};
    return out;
}

export const BORDER_RANK = {hair: 1, dotted: 2, dashDotDot: 3, dashDot: 4, dashed: 5, thin: 6, mediumDashDotDot: 7,
    slantDashDot: 8, mediumDashDot: 9, mediumDashed: 10, medium: 11, double: 12, thick: 13};
const BORDER_CSS = {thin: '1px solid', hair: '1px dotted', dotted: '1px dotted', dashed: '1px dashed',
    dashDot: '1px dashed', dashDotDot: '1px dashed', medium: '2px solid', mediumDashed: '2px dashed',
    mediumDashDot: '2px dashed', mediumDashDotDot: '2px dashed', slantDashDot: '2px dashed', thick: '3px solid',
    double: '3px double'};
const sideCss = b => `${BORDER_CSS[b.style] || '1px solid'} ${b.color || '#000000'}`;
const side = (style, color) => ({style, color, rank: BORDER_RANK[style] || 6});

// A <border> -> {left, right, top, bottom, insideH, insideV, up, down}: each {style, color, rank} or null
export function borderOf(b, color) {
    const one = name => {
        const e = kid(b, name), st = e && e.getAttribute('style');
        return st && st !== 'none' ? side(st, color(kid(e, 'color')) || '#000000') : null;
    };
    const out = {left: one('left') || one('start'), right: one('right') || one('end'), top: one('top'), bottom: one('bottom'),
                 insideH: one('horizontal'), insideV: one('vertical'), up: null, down: null};
    const d = one('diagonal');
    if (d && isOn(b.getAttribute('diagonalUp'))) out.up = d;
    if (d && isOn(b.getAttribute('diagonalDown'))) out.down = d;
    return out;
}

export function dxfOf(el, color) {
    if (!el) return null;
    return {font: kid(el, 'font') ? fontOf(kid(el, 'font'), color, true) : null,
            fill: fillOf(kid(el, 'fill'), color, true), border: kid(el, 'border') ? borderOf(kid(el, 'border'), color) : null};
}

// ---------------------------------------------------------------- references

export function parseRef(ref) {
    const m = /^\$?([A-Z]{1,3})\$?(\d+)$/i.exec(ref || '');
    if (!m) return null;
    let c = 0;
    for (const ch of m[1].toUpperCase()) c = c * 26 + ch.charCodeAt(0) - 64;
    return [+m[2], c];
}

export function parseSqref(text) {
    const out = [];
    for (const part of (text || '').trim().split(/\s+/)) {
        const [a, b] = part.split(':').map(parseRef);
        if (!a) continue;
        const e = b || a;
        out.push({r1: Math.min(a[0], e[0]), c1: Math.min(a[1], e[1]), r2: Math.max(a[0], e[0]), c2: Math.max(a[1], e[1])});
    }
    return out;
}

// ---------------------------------------------------------------- formulas (conditional formatting only)
// Values: number, string, boolean, null (empty cell), XErr; a reference evaluates to {range}. An error inside a
// formula is a value (ISERROR sees it); something the reader does not know throws Unsupported.

class XErr { constructor(code) { this.code = code; } }
class Unsupported extends Error {}
const VALUE = new XErr('#VALUE!'), DIV0 = new XErr('#DIV/0!'), NA = new XErr('#N/A');

const TOKEN = new RegExp([
    /\s+/.source,
    /("(?:[^"]|"")*")/.source,                                              // 1 string
    /(#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|GETTING_DATA))/.source, // 2 error
    // 3 sheet, 4 cell or range, 5 column range, 6 row range
    /((?:'(?:[^']|'')+'|[A-Za-z_][\w.]*)!)?(?:(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?)(?![\w(])|(\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3})(?![\w(])|(\$?\d+:\$?\d+)(?![\w(]))/.source,
    /(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.source,     // 7 number
    /([A-Za-z_][\w.]*)(\s*\()?/.source,                                     // 8 name, 9 call
    /(<>|<=|>=|[-+*/^&=<>%(),;{}])/.source,                                 // 10 operator
].join('|'), 'y');

function tokenize(src) {
    const out = [];
    TOKEN.lastIndex = 0;
    while (TOKEN.lastIndex < src.length) {
        const at = TOKEN.lastIndex, m = TOKEN.exec(src);
        if (!m || m.index !== at) throw new Unsupported('token');
        if (m[1]) out.push({t: 'str', v: m[1].slice(1, -1).replace(/""/g, '"')});
        else if (m[2]) out.push({t: 'err', v: m[2]});
        else if (m[4] || m[5] || m[6]) out.push({t: 'ref', sheet: m[3] ? m[3].slice(0, -1).replace(/^'|'$/g, '').replace(/''/g, "'") : null,
                                                 v: m[4] || m[5] || m[6], kind: m[4] ? 'cell' : m[5] ? 'cols' : 'rows'});
        else if (m[7]) out.push({t: 'num', v: +m[7]});
        else if (m[8]) out.push(m[9] ? {t: 'fn', v: m[8].toUpperCase()} : {t: 'name', v: m[8].toUpperCase()});
        else if (m[10]) out.push({t: 'op', v: m[10] === ';' ? ',' : m[10]});
    }
    return out;
}

function refPart(text) {
    const m = /^(\$?)([A-Za-z]{1,3})?(\$?)(\d+)?$/.exec(text);
    let c = 0;
    if (m[2]) for (const ch of m[2].toUpperCase()) c = c * 26 + ch.charCodeAt(0) - 64;
    return {c: m[2] ? c : null, ca: !!m[1] || !m[2], r: m[4] ? +m[4] : null, ra: !!m[3] || !m[4]};
}

export function parseFormula(src) {
    const toks = tokenize(src.replace(/^=/, ''));
    let i = 0;
    const peek = () => toks[i], isOp = v => toks[i] && toks[i].t === 'op' && toks[i].v === v;
    const take = v => { if (!isOp(v)) throw new Unsupported('expected ' + v); i++; };
    const cmp = () => {
        let a = cat();
        while (toks[i] && toks[i].t === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(toks[i].v)) { const op = toks[i++].v; a = {k: 'op', op, a, b: cat()}; }
        return a;
    };
    const cat = () => { let a = add(); while (isOp('&')) { i++; a = {k: 'op', op: '&', a, b: add()}; } return a; };
    const add = () => {
        let a = mul();
        while (isOp('+') || isOp('-')) { const op = toks[i++].v; a = {k: 'op', op, a, b: mul()}; }
        return a;
    };
    const mul = () => {
        let a = pow();
        while (isOp('*') || isOp('/')) { const op = toks[i++].v; a = {k: 'op', op, a, b: pow()}; }
        return a;
    };
    const pow = () => { let a = unary(); while (isOp('^')) { i++; a = {k: 'op', op: '^', a, b: unary()}; } return a; };
    const unary = () => {
        if (isOp('-')) { i++; return {k: 'neg', a: unary()}; }
        if (isOp('+')) { i++; return unary(); }
        let a = primary();
        while (isOp('%')) { i++; a = {k: 'pct', a}; }
        return a;
    };
    const primary = () => {
        const t = peek();
        if (!t) throw new Unsupported('end');
        i++;
        if (t.t === 'num') return {k: 'val', v: t.v};
        if (t.t === 'str') return {k: 'val', v: t.v};
        if (t.t === 'err') return {k: 'val', v: new XErr(t.v)};
        if (t.t === 'name') {
            if (t.v === 'TRUE' || t.v === 'FALSE') return {k: 'val', v: t.v === 'TRUE'};
            throw new Unsupported('name ' + t.v);                      // defined names: not read
        }
        if (t.t === 'ref') {
            const [a, b] = t.v.split(':');
            const p = refPart(a), q = b ? refPart(b) : p;
            return {k: 'ref', sheet: t.sheet, a: p, b: q, kind: t.kind};
        }
        if (t.t === 'fn') {
            const args = [];
            if (!isOp(')')) {
                for (;;) {
                    args.push(isOp(',') || isOp(')') ? {k: 'val', v: null} : cmp());
                    if (isOp(',')) { i++; continue; }
                    break;
                }
            }
            take(')');
            if (!(t.v in FN)) throw new Unsupported('function ' + t.v);
            return {k: 'fn', name: t.v, args};
        }
        if (t.t === 'op' && t.v === '(') { const e = cmp(); take(')'); return e; }
        throw new Unsupported('token ' + t.v);
    };
    const e = cmp();
    if (i !== toks.length) throw new Unsupported('rest');
    return e;
}

// ---- evaluation: ctx = {book, sh, r, c, r0, c0} (the cell, the rule's anchor cell)

function sheetByName(ctx, name) {
    if (!name) return ctx.sh;
    const sh = ctx.book.sheets.find(s => s.name.toLowerCase() === name.toLowerCase());
    if (!sh) throw new Unsupported('sheet');
    return sh;
}

function rangeOf(node, ctx) {
    const sh = sheetByName(ctx, node.sheet);
    const pos = (p, isEnd) => {
        let r = p.r, c = p.c;
        if (r == null) r = isEnd ? Math.max(sh.maxR, 1) : 1; else if (!p.ra) r += ctx.r - ctx.r0;
        if (c == null) c = isEnd ? Math.max(sh.maxC, 1) : 1; else if (!p.ca) c += ctx.c - ctx.c0;
        return [r, c];
    };
    const [r1, c1] = pos(node.a, false), [r2, c2] = pos(node.b, true);
    if (r1 < 1 || c1 < 1 || r2 < 1 || c2 < 1) return new XErr('#REF!');
    return {range: true, sh, r1: Math.min(r1, r2), c1: Math.min(c1, c2), r2: Math.max(r1, r2), c2: Math.max(c1, c2)};
}

export function cellValue(sh, r, c) {
    const cell = sh.cells.get(r * KEY + c);
    if (!cell || cell.v === null || cell.v === undefined) return null;
    if (cell.t === 'e') return new XErr(String(cell.v));
    if (cell.t === 'b') return !!cell.v;
    if (typeof cell.v === 'number') return cell.v;
    if (cell.t === 'd') { const d = Date.parse(cell.v); return isNaN(d) ? String(cell.v) : d / 86400000 + 25569; }
    return String(cell.v);
}

function* cellsOf(rg) {
    const r2 = Math.min(rg.r2, rg.sh.maxR), c2 = Math.min(rg.c2, rg.sh.maxC);
    for (let r = rg.r1; r <= r2; r++) for (let c = rg.c1; c <= c2; c++) yield cellValue(rg.sh, r, c);
}

function ev(node, ctx) {
    switch (node.k) {
        case 'val': return node.v;
        case 'ref': return rangeOf(node, ctx);
        case 'neg': { const v = num(scalar(ev(node.a, ctx))); return -v; }
        case 'pct': return num(scalar(ev(node.a, ctx))) / 100;
        case 'fn': return FN[node.name](node.args, ctx);
        case 'op': {
            const a = scalar(ev(node.a, ctx)), b = scalar(ev(node.b, ctx));
            if (a instanceof XErr) return a;
            if (b instanceof XErr) return b;
            switch (node.op) {
                case '&': return text(a) + text(b);
                case '+': return num(a) + num(b);
                case '-': return num(a) - num(b);
                case '*': return num(a) * num(b);
                case '/': { const d = num(b); if (d === 0) return DIV0; return num(a) / d; }
                case '^': return num(a) ** num(b);
                default: {
                    const k = compare(a, b);
                    return {'=': k === 0, '<>': k !== 0, '<': k < 0, '>': k > 0, '<=': k <= 0, '>=': k >= 0}[node.op];
                }
            }
        }
    }
    throw new Unsupported('node');
}

// A value used as one value: a one-cell reference -> its value; a larger range -> the cell in the formula cell's row /
// column (implicit intersection), else #VALUE!
function scalar(v, ctx) {
    if (!v || !v.range) return v;
    if (v.r1 === v.r2 && v.c1 === v.c2) return cellValue(v.sh, v.r1, v.c1);
    return VALUE;
}

class Thrown extends Error { constructor(err) { super(err.code); this.err = err; } }
function num(v) {
    if (v instanceof XErr) throw new Thrown(v);
    if (typeof v === 'number') return v;
    if (v === null) return 0;
    if (typeof v === 'boolean') return v ? 1 : 0;
    const t = String(v).trim();
    if (t !== '' && !isNaN(+t)) return +t;
    throw new Thrown(VALUE);
}
function text(v) {
    if (v instanceof XErr) throw new Thrown(v);
    if (v === null) return '';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (typeof v === 'number') return String(+v.toPrecision(15));
    return String(v);
}
function bool(v) {
    if (v instanceof XErr) throw new Thrown(v);
    if (typeof v === 'boolean') return v;
    if (v === null) return false;
    if (typeof v === 'number') return v !== 0;
    const t = String(v).toUpperCase();
    if (t === 'TRUE') return true;
    if (t === 'FALSE') return false;
    throw new Thrown(VALUE);
}
const rankOf = v => (typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2);
export function compare(a, b) {
    if (a === null) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0;
    if (b === null) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0;
    const ra = rankOf(a), rb = rankOf(b);
    if (ra !== rb) return ra - rb;
    if (ra === 1) { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; }
    const x = +a, y = +b;
    return Math.abs(x - y) < 1e-12 * Math.max(1, Math.abs(x), Math.abs(y)) ? 0 : x < y ? -1 : 1;
}

// the values of the arguments, ranges spread out (for SUM, MIN, AND, ...): {v, fromRange}
function* spread(args, ctx) {
    for (const a of args) {
        const v = ev(a, ctx);
        if (v && v.range) for (const x of cellsOf(v)) yield {v: x, fromRange: true};
        else yield {v, fromRange: false};
    }
}
const numbers = (args, ctx) => {
    const out = [];
    for (const {v, fromRange} of spread(args, ctx)) {
        if (v instanceof XErr) throw new Thrown(v);
        if (fromRange) { if (typeof v === 'number') out.push(v); } else out.push(num(v));
    }
    return out;
};
const arg = (args, i, ctx) => (args[i] ? scalar(ev(args[i], ctx)) : null);
const guard = f => (args, ctx) => {
    try { return f(args, ctx); } catch (e) { if (e instanceof Thrown) return e.err; throw e; }
};

// Excel serial numbers of days (1900 calendar; the workbook's 1904 calendar is handled by the caller)
const serialOf = (y, m, d) => (Date.UTC(y, m, d) - Date.UTC(1899, 11, 30)) / 86400000;
const dateOf = s => new Date(Date.UTC(1899, 11, 30) + Math.floor(s) * 86400000);
export function today(date1904 = false) {
    const n = new Date();
    return serialOf(n.getFullYear(), n.getMonth(), n.getDate()) - (date1904 ? 1462 : 0);
}

// SEARCH-like wildcard text -> RegExp (* ? ~)
function wildcard(t, whole) {
    let src = '';
    for (let i = 0; i < t.length; i++) {
        const ch = t[i];
        if (ch === '~' && i + 1 < t.length) { src += t[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
        src += ch === '*' ? '[\\s\\S]*' : ch === '?' ? '[\\s\\S]' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(whole ? `^${src}$` : src, 'i');
}

function criterion(c) {                     // COUNTIF's criteria: ">5", "<>x", "a*", 7
    if (typeof c !== 'string') return v => v !== null && compare(v, c) === 0;
    const m = /^(<=|>=|<>|=|<|>)?([\s\S]*)$/.exec(c);
    const op = m[1] || '=', raw = m[2];
    const target = raw !== '' && !isNaN(+raw) ? +raw : raw;
    if (typeof target === 'string' && (op === '=' || op === '<>') && /[*?~]/.test(target)) {
        const re = wildcard(target, true);
        return v => (op === '=') === (v !== null && typeof v === 'string' && re.test(v));
    }
    return v => {
        if (op === '=' && target === '') return v === null || v === '';
        if (v === null) return op === '<>' ? target !== '' : false;
        if (typeof target === 'number' && typeof v !== 'number') return op === '<>';
        const k = compare(v, target);
        return {'=': k === 0, '<>': k !== 0, '<': k < 0, '>': k > 0, '<=': k <= 0, '>=': k >= 0}[op];
    };
}

const FN = {
    TRUE: () => true,
    FALSE: () => false,
    IF: guard((a, ctx) => (bool(arg(a, 0, ctx)) ? (a[1] ? scalar(ev(a[1], ctx)) : true) : (a[2] ? scalar(ev(a[2], ctx)) : false))),
    AND: guard((a, ctx) => { let r = true; for (const {v, fromRange} of spread(a, ctx)) { if (fromRange && (v === null || typeof v === 'string')) continue; r = bool(v) && r; } return r; }),
    OR: guard((a, ctx) => { let r = false; for (const {v, fromRange} of spread(a, ctx)) { if (fromRange && (v === null || typeof v === 'string')) continue; r = bool(v) || r; } return r; }),
    XOR: guard((a, ctx) => { let r = false; for (const {v} of spread(a, ctx)) if (v !== null && typeof v !== 'string' && bool(v)) r = !r; return r; }),
    NOT: guard((a, ctx) => !bool(arg(a, 0, ctx))),
    ISBLANK: (a, ctx) => arg(a, 0, ctx) === null,
    ISNUMBER: (a, ctx) => typeof arg(a, 0, ctx) === 'number',
    ISTEXT: (a, ctx) => typeof arg(a, 0, ctx) === 'string',
    ISNONTEXT: (a, ctx) => typeof arg(a, 0, ctx) !== 'string',
    ISLOGICAL: (a, ctx) => typeof arg(a, 0, ctx) === 'boolean',
    ISERROR: (a, ctx) => arg(a, 0, ctx) instanceof XErr,
    ISERR: (a, ctx) => { const v = arg(a, 0, ctx); return v instanceof XErr && v.code !== '#N/A'; },
    ISNA: (a, ctx) => { const v = arg(a, 0, ctx); return v instanceof XErr && v.code === '#N/A'; },
    ISEVEN: guard((a, ctx) => Math.trunc(num(arg(a, 0, ctx))) % 2 === 0),
    ISODD: guard((a, ctx) => Math.abs(Math.trunc(num(arg(a, 0, ctx))) % 2) === 1),
    IFERROR: (a, ctx) => { const v = arg(a, 0, ctx); return v instanceof XErr ? arg(a, 1, ctx) : v; },
    IFNA: (a, ctx) => { const v = arg(a, 0, ctx); return v instanceof XErr && v.code === '#N/A' ? arg(a, 1, ctx) : v; },
    NA: () => NA,
    ROW: (a, ctx) => { const v = a[0] ? ev(a[0], ctx) : null; return v && v.range ? v.r1 : ctx.r; },
    COLUMN: (a, ctx) => { const v = a[0] ? ev(a[0], ctx) : null; return v && v.range ? v.c1 : ctx.c; },
    MOD: guard((a, ctx) => { const x = num(arg(a, 0, ctx)), d = num(arg(a, 1, ctx)); if (d === 0) return DIV0; return x - d * Math.floor(x / d); }),
    INT: guard((a, ctx) => Math.floor(num(arg(a, 0, ctx)))),
    ABS: guard((a, ctx) => Math.abs(num(arg(a, 0, ctx)))),
    SIGN: guard((a, ctx) => Math.sign(num(arg(a, 0, ctx)))),
    ROUND: guard((a, ctx) => { const f = 10 ** num(arg(a, 1, ctx)); const x = num(arg(a, 0, ctx)); return Math.sign(x) * Math.round(Math.abs(x) * f) / f; }),
    ROUNDUP: guard((a, ctx) => { const f = 10 ** num(arg(a, 1, ctx)); const x = num(arg(a, 0, ctx)); return Math.sign(x) * Math.ceil(Math.abs(x) * f - 1e-9) / f; }),
    ROUNDDOWN: guard((a, ctx) => { const f = 10 ** num(arg(a, 1, ctx)); const x = num(arg(a, 0, ctx)); return Math.sign(x) * Math.floor(Math.abs(x) * f + 1e-9) / f; }),
    LEN: guard((a, ctx) => text(arg(a, 0, ctx)).length),
    LEFT: guard((a, ctx) => text(arg(a, 0, ctx)).slice(0, a[1] ? num(arg(a, 1, ctx)) : 1)),
    RIGHT: guard((a, ctx) => { const t = text(arg(a, 0, ctx)), n = a[1] ? num(arg(a, 1, ctx)) : 1; return n <= 0 ? '' : t.slice(-n); }),
    MID: guard((a, ctx) => { const t = text(arg(a, 0, ctx)), s = num(arg(a, 1, ctx)), n = num(arg(a, 2, ctx)); return s < 1 ? VALUE : t.substr(s - 1, n); }),
    UPPER: guard((a, ctx) => text(arg(a, 0, ctx)).toUpperCase()),
    LOWER: guard((a, ctx) => text(arg(a, 0, ctx)).toLowerCase()),
    TRIM: guard((a, ctx) => text(arg(a, 0, ctx)).trim().replace(/ {2,}/g, ' ')),
    EXACT: guard((a, ctx) => text(arg(a, 0, ctx)) === text(arg(a, 1, ctx))),
    CONCATENATE: guard((a, ctx) => a.map((_, i) => text(arg(a, i, ctx))).join('')),
    CONCAT: guard((a, ctx) => [...spread(a, ctx)].map(x => text(x.v)).join('')),
    VALUE: guard((a, ctx) => num(arg(a, 0, ctx))),
    N: (a, ctx) => { const v = arg(a, 0, ctx); return typeof v === 'number' ? v : typeof v === 'boolean' ? +v : 0; },
    SEARCH: guard((a, ctx) => {
        const f = text(arg(a, 0, ctx)), t = text(arg(a, 1, ctx)), s = a[2] ? num(arg(a, 2, ctx)) : 1;
        const m = wildcard(f, false).exec(t.slice(s - 1));
        return m ? m.index + s : VALUE;
    }),
    FIND: guard((a, ctx) => {
        const f = text(arg(a, 0, ctx)), t = text(arg(a, 1, ctx)), s = a[2] ? num(arg(a, 2, ctx)) : 1;
        const k = t.indexOf(f, s - 1);
        return k < 0 ? VALUE : k + 1;
    }),
    TODAY: (a, ctx) => today(ctx.book.date1904),
    NOW: (a, ctx) => { const n = new Date(); return today(ctx.book.date1904) + (n.getHours() * 3600 + n.getMinutes() * 60 + n.getSeconds()) / 86400; },
    DATE: guard((a, ctx) => serialOf(num(arg(a, 0, ctx)), num(arg(a, 1, ctx)) - 1, num(arg(a, 2, ctx)))),
    YEAR: guard((a, ctx) => dateOf(num(arg(a, 0, ctx))).getUTCFullYear()),
    MONTH: guard((a, ctx) => dateOf(num(arg(a, 0, ctx))).getUTCMonth() + 1),
    DAY: guard((a, ctx) => dateOf(num(arg(a, 0, ctx))).getUTCDate()),
    WEEKDAY: guard((a, ctx) => {
        const d = dateOf(num(arg(a, 0, ctx))).getUTCDay(), type = a[1] ? num(arg(a, 1, ctx)) : 1;
        return type === 2 ? (d + 6) % 7 + 1 : type === 3 ? (d + 6) % 7 : d + 1;
    }),
    EOMONTH: guard((a, ctx) => { const d = dateOf(num(arg(a, 0, ctx))), m = num(arg(a, 1, ctx)); return serialOf(d.getUTCFullYear(), d.getUTCMonth() + m + 1, 0); }),
    EDATE: guard((a, ctx) => { const d = dateOf(num(arg(a, 0, ctx))), m = num(arg(a, 1, ctx)); return serialOf(d.getUTCFullYear(), d.getUTCMonth() + m, d.getUTCDate()); }),
    SUM: guard((a, ctx) => numbers(a, ctx).reduce((s, x) => s + x, 0)),
    MIN: guard((a, ctx) => { const l = numbers(a, ctx); return l.length ? Math.min(...l) : 0; }),
    MAX: guard((a, ctx) => { const l = numbers(a, ctx); return l.length ? Math.max(...l) : 0; }),
    AVERAGE: guard((a, ctx) => { const l = numbers(a, ctx); return l.length ? l.reduce((s, x) => s + x, 0) / l.length : DIV0; }),
    COUNT: (a, ctx) => [...spread(a, ctx)].filter(x => typeof x.v === 'number').length,
    COUNTA: (a, ctx) => [...spread(a, ctx)].filter(x => x.v !== null && x.v !== '').length,
    COUNTBLANK: (a, ctx) => [...spread(a, ctx)].filter(x => x.v === null || x.v === '').length,
    COUNTIF: guard((a, ctx) => {
        const rg = ev(a[0], ctx);
        if (!rg || !rg.range) return VALUE;
        const test = criterion(arg(a, 1, ctx));
        let n = 0;
        // the empty cells inside the sheet's used range count too (criteria "" / "<>x")
        for (let r = rg.r1; r <= Math.min(rg.r2, Math.max(rg.sh.maxR, rg.r1)); r++)
            for (let c = rg.c1; c <= Math.min(rg.c2, Math.max(rg.sh.maxC, rg.c1)); c++) if (test(cellValue(rg.sh, r, c))) n++;
        return n;
    }),
};

// A formula's value for cell (r, c), or undefined when it can't be read (the rule is then not applied)
function evalAt(f, ctx) {
    try { return scalar(ev(f, ctx)); } catch (e) { if (e instanceof Thrown) return e.err; return undefined; }
}

// ---------------------------------------------------------------- conditional formatting

const X14 = node => node.parentNode && node.parentNode.localName === 'conditionalFormattings';

// The sheet's rules, by priority: {type, ranges, r0, c0, dxf, stop, f: [parsed formulas], ...}
export function readConditionalFormats(doc, book, color) {
    const rules = [];
    for (const block of all(doc, 'conditionalFormatting')) {
        const x14 = X14(block);
        const ranges = parseSqref(x14 ? (kid(block, 'sqref')?.textContent || '') : block.getAttribute('sqref'));
        if (!ranges.length) continue;
        for (const el of kids(block, 'cfRule')) {
            const type = el.getAttribute('type') || '';
            if (x14 && type === 'dataBar') continue;         // the Excel 2010 part of a data bar: its main rule draws it
            const rule = {type, ranges, r0: ranges[0].r1, c0: ranges[0].c1, priority: +(el.getAttribute('priority') || 1e6),
                          stop: isOn(el.getAttribute('stopIfTrue')), op: el.getAttribute('operator') || '',
                          text: el.getAttribute('text'), stats: null, bad: false,
                          dxf: x14 ? dxfOf(kid(el, 'dxf'), color) : (el.hasAttribute('dxfId') ? book.dxfs[+el.getAttribute('dxfId')] || null : null)};
            try {
                rule.f = kids(el, x14 ? 'f' : 'formula').map(f => parseFormula(f.textContent || ''));
            } catch { rule.f = null; }
            if (type === 'top10') Object.assign(rule, {rank: +(el.getAttribute('rank') || 10), percent: isOn(el.getAttribute('percent')),
                                                       bottom: isOn(el.getAttribute('bottom'))});
            if (type === 'aboveAverage') Object.assign(rule, {above: el.getAttribute('aboveAverage') !== '0',
                equal: isOn(el.getAttribute('equalAverage')), std: +(el.getAttribute('stdDev') || 0)});
            if (type === 'timePeriod') rule.period = el.getAttribute('timePeriod') || '';
            const scale = kid(el, 'colorScale'), bar = kid(el, 'dataBar'), icons = kid(el, 'iconSet');
            const cfvos = node => kids(node, 'cfvo').map(v => {
                const val = v.getAttribute('val') ?? kid(v, 'f')?.textContent;
                let f = null;
                try { f = val != null && isNaN(+val) ? parseFormula(val) : null; } catch { f = null; }
                return {type: v.getAttribute('type') || 'num', val, f, gte: v.getAttribute('gte') !== '0'};
            });
            if (type === 'colorScale' && scale) Object.assign(rule, {cfvo: cfvos(scale), colors: kids(scale, 'color').map(c => color(c) || '#ffffff')});
            if (type === 'dataBar' && bar) Object.assign(rule, {cfvo: cfvos(bar), barColor: color(kid(bar, 'color')) || '#638ec6',
                showValue: bar.getAttribute('showValue') !== '0',
                minLength: +(bar.getAttribute('minLength') ?? 10), maxLength: +(bar.getAttribute('maxLength') ?? 90)});
            if (type === 'iconSet') {
                const node = icons || el;
                Object.assign(rule, {cfvo: icons ? cfvos(icons) : [], iconSet: node.getAttribute('iconSet') || '3TrafficLights1',
                                     reverse: isOn(node.getAttribute('reverse')), showValue: node.getAttribute('showValue') !== '0'});
            }
            rules.push(rule);
        }
    }
    return rules.sort((a, b) => a.priority - b.priority);
}

// rules by row (rows up to `lastR`), built when the sheet is laid out
export function indexRules(sh, lastR) {
    const byRow = new Map();
    for (const rule of sh.cf || []) {
        rule.stats = null;
        for (const g of rule.ranges) {
            for (let r = g.r1; r <= Math.min(g.r2, lastR); r++) {
                let list = byRow.get(r);
                if (!list) byRow.set(r, list = []);
                if (list[list.length - 1] !== rule) list.push(rule);
            }
        }
    }
    for (const list of byRow.values()) list.sort((a, b) => a.priority - b.priority);
    sh.cfByRow = byRow;
}

const inRanges = (rule, r, c) => rule.ranges.some(g => r >= g.r1 && r <= g.r2 && c >= g.c1 && c <= g.c2);

// The values of the rule's cells (statistics: duplicates, top 10, average, scales, bars, icons)
function statsOf(rule, sh) {
    if (rule.stats) return rule.stats;
    const nums = [], count = new Map();
    for (const g of rule.ranges) {
        for (let r = g.r1; r <= Math.min(g.r2, sh.maxR); r++) {
            for (let c = g.c1; c <= Math.min(g.c2, sh.maxC); c++) {
                const v = cellValue(sh, r, c);
                if (v === null || v instanceof XErr) continue;
                if (typeof v === 'number') nums.push(v);
                const key = typeof v === 'string' ? 's' + v.toLowerCase() : typeof v + v;
                count.set(key, (count.get(key) || 0) + 1);
            }
        }
    }
    nums.sort((a, b) => a - b);
    const mean = nums.length ? nums.reduce((s, x) => s + x, 0) / nums.length : 0;
    const sd = nums.length > 1 ? Math.sqrt(nums.reduce((s, x) => s + (x - mean) ** 2, 0) / (nums.length - 1)) : 0;
    return (rule.stats = {nums, count, mean, sd});
}

const keyOf = v => (typeof v === 'string' ? 's' + v.toLowerCase() : typeof v + v);

function percentile(sorted, p) {
    if (!sorted.length) return 0;
    const x = (sorted.length - 1) * p, lo = Math.floor(x), hi = Math.ceil(x);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (x - lo);
}

// A cfvo's number for this rule (colour scales, bars, icons)
function threshold(cfvo, rule, ctx, st) {
    const n = st.nums;
    const val = () => {
        if (cfvo.f) { const v = evalAt(cfvo.f, {...ctx, r0: rule.r0, c0: rule.c0}); return typeof v === 'number' ? v : NaN; }
        return +cfvo.val;
    };
    switch (cfvo.type) {
        case 'min': case 'autoMin': return n.length ? n[0] : 0;
        case 'max': case 'autoMax': return n.length ? n[n.length - 1] : 0;
        case 'percent': return n.length ? n[0] + (n[n.length - 1] - n[0]) * val() / 100 : 0;
        case 'percentile': return percentile(n, val() / 100);
        default: return val();           // num, formula
    }
}

function periodHit(period, v, book) {
    if (typeof v !== 'number') return false;
    const t = today(book.date1904), d = Math.floor(v), td = dateOf(t), dd = dateOf(d);
    const wd = td.getUTCDay(), weekStart = t - wd;
    const ym = x => x.getUTCFullYear() * 12 + x.getUTCMonth();
    switch (period) {
        case 'today': return d === t;
        case 'yesterday': return d === t - 1;
        case 'tomorrow': return d === t + 1;
        case 'last7Days': return d <= t && d > t - 7;
        case 'thisWeek': return d >= weekStart && d < weekStart + 7;
        case 'lastWeek': return d >= weekStart - 7 && d < weekStart;
        case 'nextWeek': return d >= weekStart + 7 && d < weekStart + 14;
        case 'thisMonth': return ym(dd) === ym(td);
        case 'lastMonth': return ym(dd) === ym(td) - 1;
        case 'nextMonth': return ym(dd) === ym(td) + 1;
    }
    return false;
}

// Does the rule apply to the cell (value v)? undefined = can't tell (not applied)
function ruleHits(rule, ctx, v) {
    const f = i => (rule.f && rule.f[i] ? evalAt(rule.f[i], ctx) : undefined);
    const s = () => (v === null ? '' : v instanceof XErr ? '' : text(v)).toLowerCase();
    const want = (rule.text || '').toLowerCase();
    switch (rule.type) {
        case 'cellIs': {
            if (v instanceof XErr) return false;
            const a = f(0);
            if (a === undefined || a instanceof XErr) return false;
            const k = compare(v, a);
            switch (rule.op) {
                case 'equal': return k === 0;
                case 'notEqual': return k !== 0;
                case 'greaterThan': return k > 0;
                case 'greaterThanOrEqual': return k >= 0;
                case 'lessThan': return k < 0;
                case 'lessThanOrEqual': return k <= 0;
                case 'between': case 'notBetween': {
                    const b = f(1);
                    if (b === undefined || b instanceof XErr) return false;
                    const lo = compare(a, b) <= 0 ? a : b, hi = lo === a ? b : a;
                    const inside = compare(v, lo) >= 0 && compare(v, hi) <= 0;
                    return rule.op === 'between' ? inside : !inside;
                }
            }
            return false;
        }
        case 'expression': {
            const r = f(0);
            if (r === undefined || r instanceof XErr) return false;
            if (typeof r === 'string') return false;
            return typeof r === 'boolean' ? r : r !== 0 && r !== null;
        }
        case 'containsText': case 'notContainsText': case 'beginsWith': case 'endsWith': {
            if (rule.text == null) { const r = f(0); return r === true || (typeof r === 'number' && r !== 0); }
            if (v instanceof XErr) return rule.type === 'notContainsText';
            const t = s();
            if (rule.type === 'containsText') return v !== null && t.includes(want);
            if (rule.type === 'notContainsText') return !t.includes(want);
            if (rule.type === 'beginsWith') return v !== null && t.startsWith(want);
            return v !== null && t.endsWith(want);
        }
        case 'containsBlanks': return !(v instanceof XErr) && s().trim() === '';
        case 'notContainsBlanks': return v instanceof XErr || s().trim() !== '';
        case 'containsErrors': return v instanceof XErr;
        case 'notContainsErrors': return !(v instanceof XErr);
        case 'duplicateValues': case 'uniqueValues': {
            if (v === null || v instanceof XErr) return false;
            const n = statsOf(rule, ctx.sh).count.get(keyOf(v)) || 0;
            return rule.type === 'duplicateValues' ? n > 1 : n === 1;
        }
        case 'top10': {
            if (typeof v !== 'number') return false;
            const nums = statsOf(rule, ctx.sh).nums;
            if (!nums.length) return false;
            const k = Math.max(1, Math.min(nums.length, rule.percent ? Math.floor(nums.length * rule.rank / 100) : rule.rank));
            return rule.bottom ? v <= nums[k - 1] : v >= nums[nums.length - k];
        }
        case 'aboveAverage': {
            if (typeof v !== 'number') return false;
            const st = statsOf(rule, ctx.sh), limit = st.mean + (rule.above ? 1 : -1) * rule.std * st.sd;
            if (rule.above) return rule.equal ? v >= limit : v > limit;
            return rule.equal ? v <= limit : v < limit;
        }
        case 'timePeriod': return periodHit(rule.period, v, ctx.book);
    }
    return false;
}

function scaleColor(rule, ctx, v) {
    if (typeof v !== 'number' || !rule.cfvo || rule.cfvo.length < 2 || rule.colors.length < rule.cfvo.length) return null;
    const st = statsOf(rule, ctx.sh), t = rule.cfvo.map(c => threshold(c, rule, ctx, st));
    if (t.some(isNaN)) return null;
    if (v <= t[0]) return rule.colors[0];
    for (let i = 1; i < t.length; i++) {
        if (v <= t[i]) {
            const f = t[i] === t[i - 1] ? 1 : (v - t[i - 1]) / (t[i] - t[i - 1]);
            return mix(rule.colors[i], rule.colors[i - 1], f);
        }
    }
    return rule.colors[rule.colors.length - 1];
}

function barOf(rule, ctx, v) {
    if (typeof v !== 'number' || !rule.cfvo || rule.cfvo.length < 2) return null;
    const st = statsOf(rule, ctx.sh), lo = threshold(rule.cfvo[0], rule, ctx, st), hi = threshold(rule.cfvo[1], rule, ctx, st);
    if (isNaN(lo) || isNaN(hi)) return null;
    const f = hi === lo ? 1 : Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
    return {pct: rule.minLength + f * (rule.maxLength - rule.minLength), color: rule.barColor, hide: !rule.showValue};
}

// icon sets: the icons of each set, lowest first, as [glyph, colour]
const G = '#00a650', Y = '#ffc000', R = '#e41a1c', GR = '#7f7f7f';
const ICONS = {
    Arrows: [['▼', R], ['▶', Y], ['▲', G]], ArrowsGray: [['▼', GR], ['▶', GR], ['▲', GR]],
    Flags: [['⚑', R], ['⚑', Y], ['⚑', G]], TrafficLights1: [['●', R], ['●', Y], ['●', G]], TrafficLights2: [['●', R], ['●', Y], ['●', G]],
    Signs: [['◆', R], ['▲', Y], ['●', G]], Symbols: [['✖', R], ['!', Y], ['✔', G]], Symbols2: [['✖', R], ['!', Y], ['✔', G]],
    Stars: [['☆', Y], ['⯪', Y], ['★', Y]], Triangles: [['▼', R], ['▬', Y], ['▲', G]],
    RedToBlack: [['●', '#000000'], ['●', '#7f7f7f'], ['●', '#ff8080'], ['●', R]],
    Rating: [['▁', '#4472c4'], ['▃', '#4472c4'], ['▅', '#4472c4'], ['▇', '#4472c4'], ['█', '#4472c4']],
    Quarters: [['○', GR], ['◔', GR], ['◑', GR], ['◕', GR], ['●', GR]], Boxes: [['□', GR], ['▤', GR], ['▥', GR], ['▦', GR], ['■', GR]],
};
function iconOf(rule, ctx, v) {
    if (typeof v !== 'number') return null;
    const m = /^(\d)(\w+?)\d?$/.exec(rule.iconSet) || [null, '3', 'TrafficLights'];
    const n = +m[1], base = ICONS[rule.iconSet.slice(1)] || ICONS[m[2]] || ICONS[m[2] + '1'] || ICONS.TrafficLights1;
    let set = base.length === n ? base : n === 4 ? [base[0], base[1], base[1], base[base.length - 1]]
        : n === 5 ? [base[0], base[0], base[1], base[base.length - 1], base[base.length - 1]] : base.slice(0, n);
    if (rule.reverse) set = [...set].reverse();
    const st = statsOf(rule, ctx.sh);
    let k = 0;
    rule.cfvo.forEach((c, i) => {
        if (i === 0) return;
        const t = threshold(c.type === 'percent' || c.type === 'percentile' || c.type === 'num' || c.type === 'formula' ? c : {type: 'percent', val: c.val}, rule, ctx, st);
        if (!isNaN(t) && (c.gte ? v >= t : v > t)) k = i;
    });
    const [glyph, colour] = set[Math.min(k, set.length - 1)];
    return {glyph, color: colour, hide: !rule.showValue};
}

// What the conditional formats make of one cell: {font, fill, bar, icon} (only what a rule sets), or null
export function conditionalLook(book, sh, r, c) {
    const rules = sh.cfByRow && sh.cfByRow.get(r);
    if (!rules) return null;
    let out = null;
    const v = cellValue(sh, r, c);
    for (const rule of rules) {
        if (!inRanges(rule, r, c)) continue;
        const ctx = {book, sh, r, c, r0: rule.r0, c0: rule.c0};
        out ||= {font: {}, fill: null, bar: null, icon: null};
        if (rule.type === 'colorScale') { if (!out.fill) { const col = scaleColor(rule, ctx, v); if (col) out.fill = {color: col, bg: col}; } continue; }
        if (rule.type === 'dataBar') { if (!out.bar) out.bar = barOf(rule, ctx, v); continue; }
        if (rule.type === 'iconSet') { if (!out.icon) out.icon = iconOf(rule, ctx, v); continue; }
        let hit;
        try { hit = ruleHits(rule, ctx, v); } catch { hit = false; }
        if (!hit) continue;
        const d = rule.dxf;
        if (d) {
            if (d.fill && !out.fill) out.fill = d.fill;
            if (d.font) for (const k of ['b', 'i', 'u', 'strike', 'color']) if (d.font[k] !== undefined && !(k in out.font)) out.font[k] = d.font[k];
            if (d.border && !out.border) out.border = d.border;
        }
        if (rule.stop) break;
    }
    return out;
}

// ---------------------------------------------------------------- table styles

// The built-in table styles (TableStyleLight1..21, Medium1..28, Dark1..11), built from the theme colours as Excel
// draws them: each style = elements (wholeTable, headerRow, totalsRow, firstColumn, lastColumn, row / column
// stripes) with fill, font and borders. Within a family of seven, the first uses black (text 1), the others accent 1..6.
function builtinStyle(name, theme) {
    const m = /^TableStyle(Light|Medium|Dark)(\d+)$/.exec(name || '');
    if (!m) return null;
    const fam = m[1], n = +m[2];
    const accent = i => theme[4 + i] || '4472C4';
    const black = '000000', white = '#ffffff';
    const C = i => (i === 0 ? black : accent(i - 1));
    const T = (c, t) => '#' + (c === black && t > 0 ? tint(c, Math.min(0.95, t + 0.05)) : tint(c, t));
    const fill = c => ({color: c, bg: c});
    const b = (style, color) => side(style, color);
    const outline = bd => ({top: bd, bottom: bd, left: bd, right: bd});
    let el = null;
    if (fam === 'Light' && n <= 21) {
        const g = Math.floor((n - 1) / 7), i = (n - 1) % 7, c = C(i), cc = '#' + c;
        if (g === 0) el = {
            wholeTable: {font: {color: i ? T(c, -0.25) : undefined}, border: {top: b('thin', cc), bottom: b('thin', cc)}},
            headerRow: {font: {b: true}, border: {bottom: b('thin', cc)}}, totalsRow: {font: {b: true}, border: {top: b('double', cc)}},
            firstColumn: {font: {b: true}}, lastColumn: {font: {b: true}},
            firstRowStripe: {fill: fill(T(c, 0.8))}, firstColumnStripe: {fill: fill(T(c, 0.8))}};
        else if (g === 1) el = {
            wholeTable: {border: outline(b('thin', cc))},
            headerRow: {fill: fill(cc), font: {b: true, color: white}}, totalsRow: {font: {b: true}, border: {top: b('double', cc)}},
            firstColumn: {font: {b: true}}, lastColumn: {font: {b: true}},
            firstRowStripe: {border: {top: b('thin', cc), bottom: b('thin', cc)}},
            firstColumnStripe: {border: {left: b('thin', cc), right: b('thin', cc)}}};
        else el = {
            wholeTable: {border: {...outline(b('thin', cc)), insideH: b('thin', cc), insideV: b('thin', cc)}},
            headerRow: {font: {b: true}, border: {bottom: b('medium', cc)}}, totalsRow: {font: {b: true}, border: {top: b('double', cc)}},
            firstColumn: {font: {b: true}}, lastColumn: {font: {b: true}},
            firstRowStripe: {fill: fill(T(c, 0.8))}, firstColumnStripe: {fill: fill(T(c, 0.8))}};
    } else if (fam === 'Medium' && n <= 28) {
        const g = Math.floor((n - 1) / 7), i = (n - 1) % 7, c = C(i), cc = '#' + c;
        if (g === 0) {
            const line = b('thin', T(c, 0.4));
            el = {wholeTable: {border: {...outline(line), insideH: line}},
                  headerRow: {fill: fill(cc), font: {b: true, color: white}}, totalsRow: {font: {b: true}, border: {top: b('double', cc)}},
                  firstColumn: {font: {b: true}}, lastColumn: {font: {b: true}},
                  firstRowStripe: {fill: fill(T(c, 0.8))}, firstColumnStripe: {fill: fill(T(c, 0.8))}};
        } else if (g === 1) {
            const line = b('thin', white);
            el = {wholeTable: {fill: fill(T(c, i ? 0.8 : 0.85)), border: {insideH: line, insideV: line}},
                  headerRow: {fill: fill(cc), font: {b: true, color: white}, border: {bottom: b('thick', white)}},
                  totalsRow: {fill: fill(cc), font: {b: true, color: white}, border: {top: b('thick', white)}},
                  firstColumn: {fill: fill(cc), font: {b: true, color: white}}, lastColumn: {fill: fill(cc), font: {b: true, color: white}},
                  firstRowStripe: {fill: fill(T(c, i ? 0.6 : 0.65))}, firstColumnStripe: {fill: fill(T(c, i ? 0.6 : 0.65))}};
        } else if (g === 2) {
            const dark = '#000000';
            el = {wholeTable: {border: {top: b('medium', dark), bottom: b('medium', dark), insideH: b('thin', dark)}},
                  headerRow: {fill: fill(cc), font: {b: true, color: white}, border: {bottom: b('medium', dark)}},
                  totalsRow: {font: {b: true}, border: {top: b('double', dark)}},
                  firstColumn: {fill: fill(cc), font: {b: true, color: white}}, lastColumn: {fill: fill(cc), font: {b: true, color: white}},
                  firstRowStripe: {fill: fill('#d9d9d9')}, firstColumnStripe: {fill: fill('#d9d9d9')}};
        } else {
            const line = b('thin', T(c, 0.4));
            el = {wholeTable: {fill: fill(T(c, 0.8)), border: {...outline(line), insideH: line, insideV: line}},
                  headerRow: {font: {b: true}}, totalsRow: {font: {b: true}, border: {top: b('double', cc)}},
                  firstColumn: {font: {b: true}}, lastColumn: {font: {b: true}},
                  firstRowStripe: {fill: fill(T(c, 0.6))}, firstColumnStripe: {fill: fill(T(c, 0.6))}};
        }
    } else if (fam === 'Dark' && n <= 11) {
        if (n <= 7) {
            const i = n - 1, c = C(i);
            const body = i ? T(c, -0.25) : '#737373', band = i ? T(c, -0.5) : '#404040';
            el = {wholeTable: {fill: fill(body), font: {color: white}},
                  headerRow: {fill: fill('#000000'), font: {b: true, color: white}, border: {bottom: b('medium', white)}},
                  totalsRow: {fill: fill(band), font: {b: true, color: white}, border: {top: b('double', white)}},
                  firstColumn: {fill: fill(band), font: {b: true, color: white}}, lastColumn: {fill: fill(band), font: {b: true, color: white}},
                  firstRowStripe: {fill: fill(band)}, firstColumnStripe: {fill: fill(band)}};
        } else {
            const pair = [[black, black], [accent(0), accent(1)], [accent(2), accent(3)], [accent(4), accent(5)]][n - 8];
            const c = pair[0];
            el = {wholeTable: {fill: fill(T(c, c === black ? 0.85 : 0.8))},
                  headerRow: {fill: fill('#000000'), font: {b: true, color: white}},
                  totalsRow: {font: {b: true}, border: {top: b('double', '#000000')}},
                  firstColumn: {fill: fill('#' + pair[1]), font: {b: true, color: white}},
                  lastColumn: {fill: fill('#' + pair[1]), font: {b: true, color: white}},
                  firstRowStripe: {fill: fill(T(c, c === black ? 0.65 : 0.6))}, firstColumnStripe: {fill: fill(T(c, c === black ? 0.65 : 0.6))}};
        }
    }
    return el;
}

// The workbook's own table styles (<tableStyles> in styles.xml): element type -> dxf
export function readTableStyles(doc, dxfs) {
    const out = {};
    for (const ts of all(doc, 'tableStyle')) {
        const el = {};
        for (const e of kids(ts, 'tableStyleElement')) {
            const d = dxfs[+e.getAttribute('dxfId')];
            if (d) el[e.getAttribute('type')] = {fill: d.fill, font: d.font || {}, border: d.border || {}};
        }
        out[ts.getAttribute('name')] = el;
    }
    return out;
}

export function tableModel(book, tb) {
    if (tb.model !== undefined) return tb.model;
    const info = tb.style || {};
    const el = (book.tableStyles && book.tableStyles[info.name]) || builtinStyle(info.name, book.theme || []);
    return (tb.model = el ? {el, info} : null);
}

// The table style elements that apply to cell (r, c) of table tb, lowest first, each with its region
function tableParts(tb, model, r, c) {
    const {info} = model, out = [];
    const top = tb.r1 + (tb.header ? 1 : 0), bottom = tb.r2 - (tb.totals || 0);
    const push = (name, r1, c1, r2, c2) => { if (model.el[name]) out.push({e: model.el[name], r1, c1, r2, c2}); };
    push('wholeTable', tb.r1, tb.c1, tb.r2, tb.c2);
    const data = r >= top && r <= bottom;
    if (info.colStripes && data) { const k = c - tb.c1; push(k % 2 === 0 ? 'firstColumnStripe' : 'secondColumnStripe', top, c, bottom, c); }
    if (info.rowStripes && data) { const k = r - top; push(k % 2 === 0 ? 'firstRowStripe' : 'secondRowStripe', r, tb.c1, r, tb.c2); }
    if (info.lastCol && c === tb.c2) push('lastColumn', tb.r1, c, tb.r2, c);
    if (info.firstCol && c === tb.c1) push('firstColumn', tb.r1, c, tb.r2, c);
    if (tb.header && r === tb.r1) {
        push('headerRow', r, tb.c1, r, tb.c2);
        if (info.firstCol && c === tb.c1) push('firstHeaderCell', r, c, r, c);
        if (info.lastCol && c === tb.c2) push('lastHeaderCell', r, c, r, c);
    }
    if (tb.totals && r === tb.r2) {
        push('totalsRow', r, tb.c1, r, tb.c2);
        if (info.firstCol && c === tb.c1) push('firstTotalCell', r, c, r, c);
        if (info.lastCol && c === tb.c2) push('lastTotalCell', r, c, r, c);
    }
    return out;
}

// {fill, font: {b, color, ...}, edge: {top, right, bottom, left}} of a table cell, or null outside every table
export function tableLook(book, sh, r, c) {
    for (const tb of sh.tables || []) {
        if (r < tb.r1 || r > tb.r2 || c < tb.c1 || c > tb.c2) continue;
        const model = tableModel(book, tb);
        if (!model) return null;
        const out = {fill: null, font: {}, edge: {}};
        for (const p of tableParts(tb, model, r, c)) {
            const e = p.e;
            if (e.fill) out.fill = e.fill;
            if (e.font) for (const k of ['b', 'i', 'u', 'strike', 'color']) if (e.font[k] !== undefined) out.font[k] = e.font[k];
            const bd = e.border || {};
            const at = {top: r === p.r1, bottom: r === p.r2, left: c === p.c1, right: c === p.c2};
            for (const s of ['top', 'bottom', 'left', 'right']) {
                const v = at[s] ? bd[s] : (s === 'top' || s === 'bottom' ? bd.insideH : bd.insideV);
                if (v) out.edge[s] = v;
            }
        }
        return out;
    }
    return null;
}

// ---------------------------------------------------------------- one cell's look

const OPP = {top: 'bottom', bottom: 'top', left: 'right', right: 'left'};

// The facts of cell (r, c) that its neighbours need too (fill, borders), kept for one drawing in `memo`
export function cellFacts(book, sh, r, c, memo, styleOf) {
    const k = r * KEY + c;
    let f = memo.get(k);
    if (f) return f;
    const cell = sh.cells.get(k);
    const s = cell ? cell.s : (sh.rowStyle[r] ?? sh.colStyle[c] ?? 0);
    const xf = book.xfs[s] || {};
    const tl = (sh.tables && sh.tables.length) ? tableLook(book, sh, r, c) : null;
    const cf = sh.cfByRow ? conditionalLook(book, sh, r, c) : null;
    const fill = (cf && cf.fill) || book.fills[xf.fill] || (tl && tl.fill) || null;
    f = {cell, s, xf, tl, cf, fill, border: book.borders[xf.border] || null, style: styleOf(s)};
    memo.set(k, f);
    return f;
}

// The CSS of one edge of cell A, against its neighbour B over that edge (null: the sheet's edge). Both cells decide
// the same line the same way: the cells' own borders (the heavier), else the table style's, else no grid line when
// either cell is filled (Excel's fill covers it), else the grid line (the default of the stylesheet: '').
export function edgeCss(a, b, s) {
    const o = OPP[s];
    const own = (a.cf && a.cf.border && a.cf.border[s]) || (a.border && a.border[s]);
    const other = b && ((b.cf && b.cf.border && b.cf.border[o]) || (b.border && b.border[o]));
    let pick = own && other ? (other.rank > own.rank ? other : own) : own || other;
    if (!pick) {
        const t1 = a.tl && a.tl.edge[s], t2 = b && b.tl && b.tl.edge[o];
        pick = t1 && t2 ? (t2.rank > t1.rank ? t2 : t1) : t1 || t2;
    }
    if (pick) return sideCss(pick);
    const fill = a.fill || (b && b.fill);
    return fill ? `1px solid ${fill.color}` : '';
}

// The background of a cell: data bar, diagonal lines, then its fill
export function backgroundCss(f) {
    const layers = [];
    const bar = f.cf && f.cf.bar;
    if (bar) layers.push(`linear-gradient(90deg, ${bar.color}, ${mix(bar.color, '#ffffff', 0.25)}) 1px 50% / calc(${bar.pct.toFixed(1)}% - 2px) 76% no-repeat`);
    const bd = f.border;
    const line = (dir, d) => `linear-gradient(to ${dir}, transparent calc(50% - 0.6px), ${d.color} calc(50% - 0.6px), ${d.color} calc(50% + 0.6px), transparent calc(50% + 0.6px))`;
    if (bd && bd.down) layers.push(line('top right', bd.down));
    if (bd && bd.up) layers.push(line('bottom right', bd.up));
    if (!layers.length) return f.fill ? `background:${f.fill.bg}` : '';
    return `background:${layers.join(', ')}${f.fill ? ', ' + f.fill.bg : ''}`;
}

// font CSS for {b, i, u, strike, color} -- only what is given
export function fontCss(font) {
    if (!font) return '';
    const css = [];
    if (font.b !== undefined) css.push(`font-weight:${font.b ? 700 : 400}`);
    if (font.i !== undefined) css.push(`font-style:${font.i ? 'italic' : 'normal'}`);
    if (font.u !== undefined || font.strike !== undefined) {
        const d = [font.u && 'underline', font.strike && 'line-through'].filter(Boolean).join(' ');
        if (d || font.u === false || font.strike === false) css.push(`text-decoration:${d || 'none'}`);
    }
    if (font.color) css.push(`color:${font.color}`);
    return css.join(';');
}

// Text rotation (alignment textRotation): 1..90 up, 91..180 down, 255 letters stacked
export function rotationCss(rot) {
    if (!rot) return '';
    if (rot === 255) return 'writing-mode:vertical-rl;text-orientation:upright';
    if (rot === 90) return 'writing-mode:vertical-rl;transform:rotate(180deg)';
    if (rot === 180) return 'writing-mode:vertical-rl';
    const deg = rot <= 90 ? -rot : rot - 90;
    return `display:inline-block;transform:rotate(${deg}deg);transform-origin:center`;
}
