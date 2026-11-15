// The PDF's own links (SFM-319, library plugin; used by the Library viewer and the Document Desk): table of contents,
// cross-references ("see section 4.2", "Table 3"), footnote marks and web links, read by pdf.js from the page's /Link
// annotations. A link inside the document goes to its page and place; a web or mail link (http, https, mailto only)
// opens in a new browser tab. Links to other files (GoToR) are the Library's notes (SFM-300) and are left out here;
// links that run JavaScript or launch programs are never followed.

const SAFE_WEB = /^(https?:|mailto:)/i;
const NAMED = {NextPage: +1, PrevPage: -1, FirstPage: 'first', LastPage: 'last'};

// The links of a pdf.js page as [{rect: [x1, y1, x2, y2] in PDF points, dest | url | named}]
export async function pageLinks(page) {
    let annots;
    try { annots = await page.getAnnotations({intent: 'display'}); } catch { return []; }
    const out = [];
    for (const a of annots) {
        if (a.subtype !== 'Link' || !a.rect) continue;
        if (a.dest) out.push({rect: a.rect, dest: a.dest});
        else if (a.url && SAFE_WEB.test(a.url)) out.push({rect: a.rect, url: a.url});
        else if (a.action && a.action in NAMED) out.push({rect: a.rect, named: a.action});
    }
    return out;
}

// Where an internal link goes: {page (1-based), x, y (PDF points of the target page, null = not given)} or null
export async function resolveDest(pdf, dest) {
    try {
        const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
        if (!Array.isArray(explicit) || !explicit.length) return null;
        const ref = explicit[0];
        const index = typeof ref === 'number' ? ref : await pdf.getPageIndex(ref);
        if (!(index >= 0 && index < pdf.numPages)) return null;
        const kind = explicit[1] && explicit[1].name, args = explicit.slice(2);
        const num = v => (typeof v === 'number' && isFinite(v) ? v : null);
        let x = null, y = null;
        if (kind === 'XYZ') { x = num(args[0]); y = num(args[1]); }
        else if (kind === 'FitH' || kind === 'FitBH') y = num(args[0]);
        else if (kind === 'FitV' || kind === 'FitBV') x = num(args[0]);
        else if (kind === 'FitR') { x = num(args[0]); y = num(args[3]); }
        return {page: index + 1, x, y};
    } catch { return null; }
}

// The target of a named action seen from page `current` (1-based) of a document of n pages
export function namedPage(named, current, n) {
    const v = NAMED[named];
    const p = v === 'first' ? 1 : v === 'last' ? n : current + v;
    return Math.max(1, Math.min(n, p));
}

// The links of one drawn page as <a> elements in `layer` (above the text layer). `go(link)` is called on a click
// on an internal link (dest / named); web links open in a new tab by themselves. Returns the number of links.
export async function drawLinks(page, viewport, layer, pdf, go) {
    const links = await pageLinks(page);
    layer.replaceChildren();
    for (const link of links) {
        const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(link.rect);
        const a = document.createElement('a');
        a.className = 'pdf-link';
        Object.assign(a.style, {left: Math.min(x1, x2) + 'px', top: Math.min(y1, y2) + 'px',
                                width: Math.max(4, Math.abs(x2 - x1)) + 'px', height: Math.max(4, Math.abs(y2 - y1)) + 'px'});
        if (link.url) {
            a.href = link.url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.title = link.url;
        } else {
            a.href = '#';
            a.title = link.named ? {NextPage: 'Next page', PrevPage: 'Previous page', FirstPage: 'First page', LastPage: 'Last page'}[link.named]
                                 : 'Go to …';
            if (link.dest) resolveDest(pdf, link.dest).then(t => { a.title = t ? `Go to p. ${t.page}` : 'Link target not found in this PDF'; });
            a.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); go(link); });
        }
        a.addEventListener('pointerdown', e => e.stopPropagation());     // not a text selection / window drag
        layer.appendChild(a);
    }
    return links.length;
}
