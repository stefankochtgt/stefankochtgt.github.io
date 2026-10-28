// Drawing PRO max (SFM-218): the standalone's store -- the document (the same XML as the workbench's
// model/drawings.xml and Export XML) is kept in this browser's localStorage. No model here, so no links.
window.DRAWING_STORE = {
    key: 'drawingProMax',
    models: false,
    async load() {
        try { return localStorage.getItem(this.key); } catch (e) { return null; }
    },
    async save(xml) {
        try { localStorage.setItem(this.key, xml); }
        catch (e) { throw new Error('This browser does not let the page store data (private window, or storage full) -- use Import / Export > Export XML to keep your work.'); }
    },
};
