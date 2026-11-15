// Drawing (SFM-218): the standalone's store -- the document (the same XML as the workbench's
// model/drawings.xml and Export XML) is kept in this browser. No model here, so no links.
// Since pictures (SFM-291) it lives in IndexedDB (database "drawingProMax", store "doc", key "xml"): localStorage
// holds only about 5 MB, one screenshot can fill that. A document an older version kept in localStorage is read once
// and moved over.
// Revisions (SFM-310): key "versions" = [{n, saved, summary, note, changes}], key "r<n>" = the XML of revision n.
// A folder on this computer (SFM-312, like the Fault Tree's SFM-199): with the File System Access API (Chrome, Edge)
// the drawing is also written into a folder the user picks -- drawings.xml on every change, versions/versions.json and
// versions/rNNNN.xml for the revisions. The browser's copy stays (it is what the page opens); the folder is the copy on
// disk. The folder is remembered (key "folder"); after a restart the browser asks once for permission again (File >
// Reconnect the folder); until then the folder is not written and the page says so.
window.DRAWING_STORE = {
    key: 'drawingProMax',
    models: false,
    db() {
        if (!this._db) this._db = new Promise((resolve, reject) => {
            const req = indexedDB.open(this.key, 1);
            req.onupgradeneeded = () => req.result.createObjectStore('doc');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return this._db;
    },
    async request(mode, fn) {
        const db = await this.db();
        return new Promise((resolve, reject) => {
            const req = fn(db.transaction('doc', mode).objectStore('doc'));
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    },
    get: function (k) { return this.request('readonly', s => s.get(k)); },
    put: function (k, v) { return this.request('readwrite', s => s.put(v, k)); },
    async load() {
        let xml = null;
        try { xml = await this.get('xml'); } catch (e) { /* no IndexedDB: localStorage below */ }
        if (xml) return xml;
        try { return localStorage.getItem(this.key); } catch (e) { return null; }
    },
    async save(xml) {
        try {
            await this.put('xml', xml);
        } catch (e) {
            throw new Error('This browser does not let the page store data (private window, or storage full) -- use Import / Export > Export XML to keep your work.');
        }
        try { localStorage.removeItem(this.key); } catch (e) { /* moved: the old copy goes */ }
        const dir = await this.folderAccess(false);
        if (dir) {
            try { await this.writeText(dir, 'drawings.xml', xml); this.folderError = ''; }
            catch (e) { this.folderError = e.message; }
        }
    },

    // ---- revisions (SFM-310) --------------------------------------------------------------------
    async versionList() { try { return (await this.get('versions')) || []; } catch (e) { return []; } },
    async versions() { return [...await this.versionList()].sort((a, b) => b.n - a.n); },
    async version(n) {
        let xml = null;
        try { xml = await this.get('r' + n); } catch (e) { /* below */ }
        if (!xml) {
            const dir = await this.folderAccess(false);
            if (dir) xml = await this.readText(await dir.getDirectoryHandle('versions', { create: true }), this.revisionFile(n));
        }
        if (!xml) throw new Error(`Revision ${n} is not in this browser any more.`);
        return xml;
    },
    async saveVersion(xml, meta) {
        const list = await this.versionList();
        const n = list.reduce((m, v) => Math.max(m, v.n), 0) + 1;
        const v = { n, saved: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), summary: meta.summary || '', note: meta.note || '',
                    changes: (meta.changes || []).slice(0, 500) };
        try {
            await this.put('r' + n, xml);
            await this.put('versions', [...list, v]);
        } catch (e) {
            throw new Error('The browser could not store the revision (storage full?) -- use Import / Export > Export XML to keep a copy.');
        }
        const dir = await this.folderAccess(false);
        if (dir) { try { await this.writeVersions(dir, [n]); } catch (e) { this.folderError = e.message; } }
        return v;
    },

    // ---- a folder on this computer (SFM-312) -----------------------------------------------------------
    hasFolderApi() { return typeof window.showDirectoryPicker === 'function'; },
    revisionFile(n) { return `r${String(n).padStart(4, '0')}.xml`; },
    async handle() {
        if (this._handle === undefined) { try { this._handle = (await this.get('folder')) || null; } catch (e) { this._handle = null; } }
        return this._handle;
    },
    async folderAccess(ask) {
        const h = await this.handle();
        if (!h) return null;
        try {
            let p = await h.queryPermission({ mode: 'readwrite' });
            if (p !== 'granted' && ask) p = await h.requestPermission({ mode: 'readwrite' });
            return p === 'granted' ? h : null;
        } catch (e) { return null; }
    },
    async writeText(dir, name, text) {
        const file = await dir.getFileHandle(name, { create: true }), w = await file.createWritable();
        await w.write(text); await w.close();
    },
    async readText(dir, name) {
        try { return await (await (await dir.getFileHandle(name)).getFile()).text(); } catch (e) { return null; }
    },
    async writeVersions(dir, only) {            // versions/versions.json and the revision copies (all, or `only`)
        const vdir = await dir.getDirectoryHandle('versions', { create: true }), list = await this.versionList();
        for (const v of list) if (!only || only.includes(v.n)) {
            const xml = await this.get('r' + v.n);
            if (xml) await this.writeText(vdir, this.revisionFile(v.n), xml);
        }
        await this.writeText(vdir, 'versions.json', JSON.stringify(list, null, 1));
    },
    async writeAll(dir) {
        const xml = await this.load();
        if (xml) await this.writeText(dir, 'drawings.xml', xml);
        await this.writeVersions(dir, null);
        this.folderError = '';
    },
    async folderState() {
        const h = await this.handle();
        return { api: this.hasFolderApi(), name: h ? h.name : '', granted: h ? !!(await this.folderAccess(false)) : false,
                 error: this.folderError || '' };
    },
    // File > Keep on this computer: pick a folder (or, when one is linked but not allowed now, allow it again)
    async chooseFolder() {
        if (!this.hasFolderApi()) throw new Error('Keeping the drawing in a folder needs Chrome or Edge. Here: Import / Export > Export XML keeps a copy.');
        const linked = await this.handle();
        if (linked && !(await this.folderAccess(false))) {               // reconnect after a restart
            const dir = await this.folderAccess(true);
            if (!dir) throw new Error(`The browser did not allow writing into "${linked.name}".`);
            await this.writeAll(dir);
            return;
        }
        let dir;
        try { dir = await window.showDirectoryPicker({ id: 'drawing', mode: 'readwrite' }); }
        catch (e) {            // a cancelled dialog stays silent -- a blocked one (e.g. by a company policy) says so
            if (e && e.name === 'AbortError') return;
            throw new Error(`This browser did not open the folder dialog (${(e && e.name) || 'Error'}: ${(e && e.message) || e}).\n\n`
                            + 'On company computers the IT policy often switches off folder access for web pages. '
                            + 'Keep a copy with Import / Export > Export XML instead (open it again with Import XML).');
        }
        const there = await this.readText(dir, 'drawings.xml');
        if (there && there.includes('safety-model-drawings') && confirm(
            `The folder "${dir.name}" already holds a drawing.\n\nOK: open it here (the drawing in this browser is replaced; `
            + 'save a revision or export it first if you need it).\nCancel: keep the drawing of this browser and save it into the folder.')) {
            const vdir = await dir.getDirectoryHandle('versions', { create: true });
            let list = [];
            try { list = JSON.parse((await this.readText(vdir, 'versions.json')) || '[]') || []; } catch (e) { list = []; }
            for (const v of list) {
                const xml = await this.readText(vdir, this.revisionFile(v.n));
                if (xml) await this.put('r' + v.n, xml);
            }
            await this.put('versions', list.filter(v => v && Number.isInteger(v.n)));
            await this.put('xml', there);
            this._handle = dir;
            await this.put('folder', dir);
            location.reload();
            return;
        }
        this._handle = dir;
        await this.put('folder', dir);
        await this.writeAll(dir);
    },
    async stopFolder() {
        const h = await this.handle();
        if (!h || !confirm(`Stop keeping the drawing in "${h.name}"? The files there stay; the drawing stays in this browser.`)) return;
        this._handle = null;
        try { await this.request('readwrite', s => s.delete('folder')); } catch (e) { /* gone anyway */ }
    },
};
