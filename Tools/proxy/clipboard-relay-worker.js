/**
 * Clipboard Helper Relay — Cloudflare Worker
 * ===========================================
 * Acts as a message queue between the website form and clipboard_helper.py.
 *
 *   POST /push  — website sends text (public, no auth)
 *   GET  /pop   — Python script polls for new messages (requires X-Admin-Key header)
 *
 * Setup (~5 minutes):
 *
 *   STEP 1 — Create a KV namespace
 *     Cloudflare dashboard → Workers & Pages → KV → Create namespace
 *     Name it "CLIPBOARD_MESSAGES"
 *
 *   STEP 2 — Deploy this Worker
 *     Workers & Pages → Create → Create Worker
 *     Replace all default code with this file → Deploy
 *
 *   STEP 3 — Bind the KV namespace
 *     Open the Worker → Settings → Variables → KV Namespace Bindings → Add binding
 *     Variable name:  MESSAGES
 *     KV namespace:   CLIPBOARD_MESSAGES
 *     → Save and deploy
 *
 *   STEP 4 — Set the admin key secret
 *     Run clipboard_helper.py — it shows your Admin Key in the GUI
 *     Back in the Worker → Settings → Variables → Environment Variables → Add variable
 *     Variable name:  ADMIN_KEY   (set as Secret — encrypted)
 *     Value:          (paste the key from clipboard_helper.py)
 *     → Save and deploy
 *
 *   STEP 5 — Wire up the website and the Python script
 *     Copy the Worker URL (e.g. https://clipboard-relay.stefankochtgt.workers.dev)
 *     In clipboard_helper.py GUI: paste the Worker URL → Save
 *     In index.html: replace the WORKER_URL placeholder with the Worker URL → push
 */

const MAX_BYTES = 50_000;  // 50 KB max per message
const TTL       = 3600;    // messages auto-expire after 1 hour if not picked up

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (request.method === 'POST' && url.pathname === '/push') {
    return handlePush(request);
  }

  if (request.method === 'GET' && url.pathname === '/pop') {
    return handlePop(request);
  }

  return new Response('Not found', { status: 404 });
}

async function handlePush(request) {
  let body;
  try { body = await request.json(); }
  catch { return jsonResp({ error: 'Invalid JSON' }, 400); }

  const text = String(body.text ?? '').slice(0, MAX_BYTES);
  if (!text.trim()) return jsonResp({ error: 'Empty text' }, 400);

  const key = `msg:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  await MESSAGES.put(key, text, { expirationTtl: TTL });

  return jsonResp({ ok: true }, 200);
}

async function handlePop(request) {
  if (request.headers.get('X-Admin-Key') !== ADMIN_KEY) {
    return new Response('Unauthorized', { status: 401 });
  }

  const list = await MESSAGES.list({ limit: 1 });
  if (!list.keys.length) return jsonResp({ text: null }, 200);

  const key  = list.keys[0].name;
  const text = await MESSAGES.get(key);
  await MESSAGES.delete(key);

  return jsonResp({ text }, 200);
}

function jsonResp(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  };
}
