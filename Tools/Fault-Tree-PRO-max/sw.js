// Fault Tree PRO max -- offline cache (SFM-181), written by scripts/build_standalone_fta.py.
// Every file of the app is kept; a new build has a new CACHE name, so the next start loads it and drops the old.
const CACHE = 'fault-tree-pro-max-bbf99f502313';
const FILES = ["./", "css/style.css", "favicon.svg", "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "index.html", "js/fta_draw.js", "js/fta_tikz.js", "js/graph_export.js", "js/mfta_local.js", "manifest.json", "vendor/cytoscape.min.js"];
self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
    e.waitUntil(caches.keys()
        .then(keys => Promise.all(keys.filter(k => k.startsWith('fault-tree-pro-max-') && k !== CACHE).map(k => caches.delete(k))))
        .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
    if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
    e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request)));
});
