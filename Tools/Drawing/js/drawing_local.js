// Drawing (SFM-218): the standalone's store -- the document (the same XML as the workbench's
// model/drawings.xml and Export XML) is kept in this browser. No model here, so no links.
// Since pictures (SFM-291) it lives in IndexedDB (database "drawingProMax", store "doc", key "xml"): localStorage
// holds only about 5 MB, one screenshot can fill that. A document an older version kept in localStorage is read once
// and moved over.
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
    async load() {
        let xml = null;
        try { xml = await this.request('readonly', s => s.get('xml')); } catch (e) { /* no IndexedDB: localStorage below */ }
        if (xml) return xml;
        try { return localStorage.getItem(this.key); } catch (e) { return null; }
    },
    async save(xml) {
        try {
            await this.request('readwrite', s => s.put(xml, 'xml'));
        } catch (e) {
            throw new Error('This browser does not let the page store data (private window, or storage full) -- use Import / Export > Export XML to keep your work.');
        }
        try { localStorage.removeItem(this.key); } catch (e) { /* moved: the old copy goes */ }
    },
};
