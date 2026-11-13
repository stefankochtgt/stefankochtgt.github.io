// JPG export of a whole cytoscape diagram (SFM-125): everything, not just what is in view, on a
// white background with a margin, at high resolution -- 4x the drawing size, capped so the longer
// side stays at most 12000 px (browsers' canvas limit). Same as the Manual FTA on www.tegrity.eu.
//
// `label` (optional): the model revision id, written small in light grey just above each node of
// `anchors` (the top events), so it stays with the picture wherever it is pasted (SFM-170).
// `footer` (optional): the document control in one line (export_control.js, SFM-225), written in light
// grey below the drawing -- split over several lines when it is wider than the picture.
// `type` (optional): 'image/png' for a PNG instead of the JPG.
//
// The same picture goes into the Drawing (SFM-291): opened there in a hidden frame with ?picture=1, a fault
// tree page calls sendPicture(cy) once it is drawn and hands the PNG to the Drawing (postMessage, same origin).
const REVISION_GREY = '#9ca3af';

// The diagram drawn onto a canvas (see above): resolves {canvas, scale}, or null when there is nothing to draw.
function graphCanvas(cy, label, anchors, footer, maxSide = 12000) {
    if (!cy || !cy.nodes().length) return Promise.resolve(null);
    const bb = cy.elements().boundingBox();
    const fontModel = 7;                                   // text size in drawing units (box titles are 9)
    const tops = label && anchors && anchors.length ? anchors.map(a => {
        const b = a.boundingBox({ includeLabels: false });
        const boxLeft = typeof BOX_W !== 'undefined' && typeof U !== 'undefined' ? a.position('x') - BOX_W * U / 2 : b.x1;
        return { x: boxLeft, y: b.y1 };                   // the top-left corner of the top event's box
    }) : [];
    const above = tops.length ? fontModel + 4 : 0;        // room the text needs above the drawing
    // the footer at the same text size, at most as wide as the drawing (about 0.5 drawing units per point)
    const footerLines = footer ? (window.exportControl ? exportControl.wrap(footer, Math.max(60, Math.floor(bb.w / (fontModel * 0.5))))
                                                       : [footer]) : [];
    const below = footerLines.length ? footerLines.length * (fontModel + 3) + 6 : 0;
    const scale = Math.max(1, Math.min(4, maxSide / Math.max(bb.w + 80, bb.h + above + below + 80)));
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const margin = Math.round(30 * scale);
            const top = Math.round(above * scale);
            const bottom = Math.round(below * scale);
            const font = `${Math.round(fontModel * scale)}px Arial, Helvetica, sans-serif`;
            const measure = document.createElement('canvas').getContext('2d');
            measure.font = font;
            const footerWidth = Math.max(0, ...footerLines.map(t => Math.ceil(measure.measureText(t).width)));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(img.width, footerWidth) + 2 * margin;   // a small drawing: wide enough for the footer
            canvas.height = img.height + 2 * margin + top + bottom;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, margin, margin + top);
            ctx.fillStyle = REVISION_GREY;
            ctx.font = font;
            ctx.textBaseline = 'bottom';
            for (const t of tops) {
                ctx.fillText(label, margin + (t.x - bb.x1) * scale, margin + top + (t.y - bb.y1) * scale - 2 * scale);
            }
            footerLines.forEach((text, i) => {
                ctx.fillText(text, margin, margin + top + img.height + Math.round((6 + (i + 1) * (fontModel + 3)) * scale));
            });
            resolve({ canvas, scale });
        };
        img.onerror = () => reject(new Error('The diagram could not be drawn as a picture.'));
        img.src = cy.png({ output: 'base64uri', full: true, scale, bg: '#ffffff' });
    });
}

function exportGraphJpg(cy, fileBase, label, anchors, footer, type) {
    if (!cy || !cy.nodes().length) { alert('There is nothing to export yet.'); return; }
    const png = type === 'image/png';
    graphCanvas(cy, label, anchors, footer).then(({ canvas }) => canvas.toBlob(blob => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${fileBase}_${new Date().toISOString().slice(0, 10)}.${png ? 'png' : 'jpg'}`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, png ? 'image/png' : 'image/jpeg', 0.95)).catch(e => alert(e.message));
}

// The JPG with the model revision id in light grey above every top event, and in the file name
// (SFM-169/170), and -- in the workbench -- the document control of the chosen work product in the
// footer (SFM-225). Top events are the nodes in the first row of their tree (`depth` 0).
async function exportGraphJpgIdentified(cy, fileBase, content) {
    let ident = null, footer = '';
    if (window.exportControl) {
        ident = await exportControl.ask(content);
        if (!ident) return;                                // cancelled
        footer = ident.line;
    } else {
        try { ident = await (await fetch('/api/model-identity')).json(); } catch (e) { /* export without it */ }
    }
    const revision = ident && ident.revision ? ident.revision : '';
    const tops = cy ? cy.nodes().filter(x => x.data('depth') === 0 && x.data('code')) : null;
    exportGraphJpg(cy, revision ? `${fileBase}_${revision}` : fileBase, revision, tops, footer);
}

// ---- picture for the Drawing (SFM-291) -------------------------------------------------------------
// True when this page was opened by the Drawing's "Insert fault tree" in its hidden frame: the page then must not
// remember anything in this browser (chosen analysis etc.) -- it is not the user looking at it.
const PICTURE_MODE = (() => {
    try { return window.parent !== window && new URLSearchParams(location.search).get('picture') === '1'; }
    catch (e) { return false; }
})();
const PICTURE_MAX_SIDE = 6000;            // px -- sharp when zoomed in, small enough to keep in the drawing file

// Hands the drawn diagram to the Drawing that opened this page: {type: 'fta-picture', src (PNG data URI), width,
// height (its size in drawing px = canvas / scale), revision}, or {type: 'fta-picture', empty: true}. Waits until
// cytoscape has the block pictures (they are background images, loaded asynchronously) -- else they'd be missing.
async function sendPicture(cy) {
    if (!PICTURE_MODE) return;
    const post = msg => window.parent.postMessage({ type: 'fta-picture', ...msg }, location.origin);
    try {
        if (!cy || !cy.nodes().length) { post({ empty: true }); return; }
        const urls = [...new Set(cy.nodes().map(n => n.data('svg')).filter(Boolean))];
        await Promise.all(urls.map(u => new Promise(done => { const i = new Image(); i.onload = i.onerror = done; i.src = u; })));
        await new Promise(done => setTimeout(done, 400));     // cytoscape redraws once its own copies are loaded
        let revision = '';
        try { revision = (await (await fetch('/api/model-identity', { cache: 'no-store' })).json()).revision || ''; }
        catch (e) { /* the standalone has none */ }
        const tops = cy.nodes().filter(x => x.data('depth') === 0 && x.data('code'));
        const { canvas, scale } = await graphCanvas(cy, revision, tops, '', PICTURE_MAX_SIDE);
        post({ src: canvas.toDataURL('image/png'), width: canvas.width / scale, height: canvas.height / scale, revision });
    } catch (e) {
        post({ error: e.message || String(e) });
    }
}
