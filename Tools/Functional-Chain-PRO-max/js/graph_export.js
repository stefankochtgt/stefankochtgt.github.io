// JPG export of a whole cytoscape diagram (SFM-125): everything, not just what is in view, on a
// white background with a margin, at high resolution -- 4x the drawing size, capped so the longer
// side stays at most 12000 px (browsers' canvas limit). Same as the Manual FTA on www.tegrity.eu.
//
// `label` (optional): the model revision id, written small in light grey just above each node of
// `anchors` (the top events), so it stays with the picture wherever it is pasted (SFM-170).
const REVISION_GREY = '#9ca3af';

function exportGraphJpg(cy, fileBase, label, anchors) {
    if (!cy || !cy.nodes().length) { alert('There is nothing to export yet.'); return; }
    const bb = cy.elements().boundingBox();
    const fontModel = 7;                                   // text size in drawing units (box titles are 9)
    const tops = label && anchors && anchors.length ? anchors.map(a => {
        const b = a.boundingBox({ includeLabels: false });
        const boxLeft = typeof BOX_W !== 'undefined' && typeof U !== 'undefined' ? a.position('x') - BOX_W * U / 2 : b.x1;
        return { x: boxLeft, y: b.y1 };                   // the top-left corner of the top event's box
    }) : [];
    const above = tops.length ? fontModel + 4 : 0;        // room the text needs above the drawing
    const scale = Math.max(1, Math.min(4, 12000 / Math.max(bb.w + 80, bb.h + above + 80)));
    const img = new Image();
    img.onload = () => {
        const margin = Math.round(30 * scale);
        const top = Math.round(above * scale);
        const canvas = document.createElement('canvas');
        canvas.width = img.width + 2 * margin;
        canvas.height = img.height + 2 * margin + top;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, margin, margin + top);
        if (tops.length) {
            ctx.fillStyle = REVISION_GREY;
            ctx.font = `${Math.round(fontModel * scale)}px Arial, Helvetica, sans-serif`;
            ctx.textBaseline = 'bottom';
            for (const t of tops) {
                ctx.fillText(label, margin + (t.x - bb.x1) * scale, margin + top + (t.y - bb.y1) * scale - 2 * scale);
            }
        }
        canvas.toBlob(blob => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `${fileBase}_${new Date().toISOString().slice(0, 10)}.jpg`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        }, 'image/jpeg', 0.95);
    };
    img.src = cy.png({ output: 'base64uri', full: true, scale, bg: '#ffffff' });
}

// The JPG with the model revision id in light grey above every top event, and in the file name
// (SFM-169/170). Top events are the nodes in the first row of their tree (`depth` 0).
async function exportGraphJpgIdentified(cy, fileBase) {
    let ident = null;
    try { ident = await (await fetch('/api/model-identity')).json(); } catch (e) { /* export without it */ }
    const revision = ident && ident.revision ? ident.revision : '';
    const tops = cy ? cy.nodes().filter(x => x.data('depth') === 0 && x.data('code')) : null;
    exportGraphJpg(cy, revision ? `${fileBase}_${revision}` : fileBase, revision, tops);
}
