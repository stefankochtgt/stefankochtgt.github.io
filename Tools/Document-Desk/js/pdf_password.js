// Password-protected PDFs (SFM-321): opens a PDF with pdf.js and asks for the password when the file needs one.
// Used by the Library viewer, the Document Desk and "Clean copied PDF text" (library plugin, next to pdf.js).
// The password goes only to pdf.js in this browser tab: it is never stored (no localStorage / IndexedDB), never sent
// to the server, and kept in memory only for the tab's lifetime, so a document opened again in the same tab doesn't
// ask twice. Notes can't be written into such a PDF (the app writes notes incrementally and never re-encrypts a
// file), so the callers show its notes read-only: `readNotes()` reads them in pdf.js (the server can't open the file).
// The same for a PDF that opens without a password but is encrypted with restrictions (owner password).

const remembered = new Map();           // caller key -> password, this tab only
let queue = Promise.resolve();          // one dialog at a time (a desk can reopen several protected PDFs at once)

export class PasswordCancelled extends Error {
    constructor() { super('The PDF is password protected and no password was given.'); this.name = 'PasswordCancelled'; }
}

const NEED = 1, WRONG = 2;              // pdf.js PasswordResponses

// {pdf, locked, encrypted}: locked = the file needed a password; encrypted = locked or restricted (see below). params = pdf.js getDocument() parameters; name = shown in the
// dialog; key = what the password is remembered under (Library identifier, desk file id; '' = not remembered);
// onTask(task) gets the pdf.js loading task at once (to destroy it when the viewer closes meanwhile).
export async function openPdf(pdfjsLib, params, {name = 'This PDF', key = '', onTask = null} = {}) {
    let locked = false, tried = false, cancelled = false;
    const task = pdfjsLib.getDocument(params);
    if (onTask) onTask(task);
    task.onPassword = (update, reason) => {
        locked = true;
        if (reason === NEED && key && remembered.has(key) && !tried) { tried = true; update(remembered.get(key)); return; }
        ask(name, reason === WRONG || tried).then(pw => {
            if (pw === null) { cancelled = true; update(new PasswordCancelled()); return; }
            tried = true;
            if (key) remembered.set(key, pw);
            update(pw);
        });
    };
    try {
        const pdf = await task.promise;
        // encrypted = a password was needed, or the file is encrypted with restrictions only (an owner password, e.g.
        // a publisher's "no editing"): pdf.js gives its permissions then, null for an unencrypted file
        const encrypted = locked || (await pdf.getPermissions().catch(() => null)) !== null;
        return {pdf, locked, encrypted, task};
    } catch (e) {
        if (key && locked) remembered.delete(key);
        throw cancelled ? new PasswordCancelled() : e;      // pdf.js passes the reason on as its own error
    }
}

export function forgetPassword(key) { remembered.delete(key); }

// For "Save a copy without password" (SFM-322): the password this tab opened the file with, else asked again
export async function passwordFor(key, name) {
    return (key && remembered.get(key)) || ask(name || 'This PDF', false);
}

// The dialog: resolves to the typed password or null (Cancel / Esc)
function ask(name, wrong) {
    const next = queue.then(() => dialog(name, wrong));
    queue = next.catch(() => null);
    return next;
}

function dialog(name, wrong) {
    style();
    return new Promise(resolve => {
        const dlg = document.createElement('dialog');
        dlg.className = 'pdf-pw';
        dlg.innerHTML = `<form method="dialog">
            <b>Password protected PDF</b>
            <div class="pdf-pw-name"></div>
            <label>Password <input type="password" autocomplete="off" spellcheck="false"></label>
            <div class="pdf-pw-wrong"${wrong ? '' : ' hidden'}>Wrong password -- try again.</div>
            <div class="pdf-pw-note">Only used to open the file in this tab: not saved, not sent anywhere.</div>
            <div class="pdf-pw-acts"><button type="submit" value="open">Open</button>
                <button type="button" class="secondary" value="cancel">Cancel</button></div></form>`;
        dlg.querySelector('.pdf-pw-name').textContent = name;
        const input = dlg.querySelector('input');
        let done = false;
        const finish = value => {
            if (done) return;
            done = true;
            input.value = '';
            dlg.close();
            dlg.remove();
            resolve(value);
        };
        dlg.querySelector('form').addEventListener('submit', e => { e.preventDefault(); finish(input.value); });
        dlg.querySelector('button[value=cancel]').addEventListener('click', () => finish(null));
        dlg.addEventListener('cancel', e => { e.preventDefault(); finish(null); });     // Esc
        dlg.addEventListener('keydown', e => e.stopPropagation());                         // the page's own shortcuts rest
        document.body.appendChild(dlg);
        dlg.showModal();
        input.focus();
    });
}

function style() {
    if (document.getElementById('pdf-pw-style')) return;
    const s = document.createElement('style');
    s.id = 'pdf-pw-style';
    s.textContent = `
dialog.pdf-pw{border:1px solid #94a3b8;border-radius:8px;padding:16px 18px;min-width:300px;max-width:440px;
  font:14px system-ui,sans-serif;color:#0f172a;background:#fff;box-shadow:0 10px 30px rgba(0,0,0,.25)}
dialog.pdf-pw::backdrop{background:rgba(15,23,42,.35)}
dialog.pdf-pw form{display:flex;flex-direction:column;gap:8px;margin:0}
dialog.pdf-pw .pdf-pw-name{color:#475569;word-break:break-all}
dialog.pdf-pw label{display:flex;flex-direction:column;gap:4px}
dialog.pdf-pw input{font:inherit;padding:5px 7px;border:1px solid #94a3b8;border-radius:4px}
dialog.pdf-pw .pdf-pw-wrong{color:#b91c1c;font-weight:600}
dialog.pdf-pw .pdf-pw-wrong[hidden]{display:none}
dialog.pdf-pw .pdf-pw-note{color:#64748b;font-size:12px}
dialog.pdf-pw .pdf-pw-acts{display:flex;gap:8px;justify-content:flex-end}`;
    document.head.appendChild(s);
}

// ---- notes of an open PDF, read in pdf.js, in the shape the Library's notes route gives (pdf_notes.list_notes)

const MARKUP = new Set(['Text', 'FreeText', 'Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Square', 'Circle', 'Ink',
                        'Line', 'Polygon', 'PolyLine', 'Stamp', 'Caret', 'FileAttachment']);
const pdfDate = s => {
    const d = /^D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?/.exec(s || '');
    return d ? `${d[1]}-${d[2]}-${d[3]}` + (d[4] ? ` ${d[4]}:${d[5] || '00'}` : '') : '';
};
const hex = c => c && c.length >= 3 ? '#' + [...c].slice(0, 3).map(v => Math.round(v).toString(16).padStart(2, '0')).join('') : '#ffd633';

export async function readNotes(pdf, maxPages = 3000) {
    const notes = [];
    for (let i = 1; i <= Math.min(pdf.numPages, maxPages); i++) {
        for (const a of await (await pdf.getPage(i)).getAnnotations()) {
            if (!MARKUP.has(a.subtype)) continue;
            const q = a.quadPoints ? Array.from(a.quadPoints) : [];
            notes.push({key: a.id || `p${i}-${notes.length}`, page: i, kind: a.subtype.toLowerCase(), target: null,
                rect: a.rect ? Array.from(a.rect) : [],
                quads: Array.from({length: Math.floor(q.length / 8)}, (_, k) => q.slice(k * 8, k * 8 + 8)),
                text: (a.contentsObj && a.contentsObj.str) || '', author: (a.titleObj && a.titleObj.str) || '',
                date: pdfDate(a.modificationDate || a.creationDate), color: hex(a.color), own: false,
                reply_to: a.inReplyTo || null});
        }
    }
    return notes;
}
