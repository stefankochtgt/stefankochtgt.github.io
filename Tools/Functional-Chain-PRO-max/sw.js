// Functional Chain moved to ../Functional-Chain/ (2026-11-05). This replaces the old offline copy: it takes over the open
// pages, sends them to the new address and removes itself. Saved fault trees / drawings stay (same browser storage).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
    await self.clients.claim();
    const pages = await self.clients.matchAll({ type: 'window' });
    await self.registration.unregister();
    for (const p of pages) p.navigate('../Functional-Chain/').catch(() => {});
})()));
