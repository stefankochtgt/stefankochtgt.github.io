// Functional Chain PRO max -- offline cache (SFM-217), written by scripts/build_standalone_chain.py.
// Every file of the app is kept; a new build has a new CACHE name, so the next start loads it and drops the old.
const CACHE = 'functional-chain-pro-max-bddf6e51d07f';
const FILES = ["./", "css/style.css", "favicon.svg", "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "index.html", "js/chain_local.js", "js/graph_export.js", "js/manual_chain.js", "js/version.js", "manifest.json", "vendor/cytoscape-edgehandles.js", "vendor/cytoscape.min.js", "vendor/lodash.min.js"];
self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
    e.waitUntil(caches.keys()
        .then(keys => Promise.all(keys.filter(k => k.startsWith('functional-chain-pro-max-') && k !== CACHE).map(k => caches.delete(k))))
        .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
    if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
    if (new URL(e.request.url).pathname.endsWith('/version.json')) return;   // the published version: always fresh
    e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request)));
});
