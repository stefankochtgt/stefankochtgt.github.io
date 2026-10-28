// Functional Chain PRO max (SFM-217): the standalone's store -- the document (the same XML as the
// workbench's model/manual_chain.xml and Export XML) is kept in this browser's localStorage.
// app/static/js/manual_chain.js uses window.CHAIN_STORE instead of the workbench's /api/manual-chain.
window.CHAIN_STORE = {
    key: 'functionalChainProMax',
    async load() {
        try { return localStorage.getItem(this.key); } catch (e) { return null; }
    },
    async save(xml) {
        try { localStorage.setItem(this.key, xml); }
        catch (e) { throw new Error('This browser does not let the page store data (private window, or storage full) -- use Import / Export > Export XML to keep your work.'); }
    },
};
