/**
 * Clipboard Helper Relay — Cloudflare Worker (Upstash Redis backend)
 * ===================================================================
 * POST /push  — website sends text (public)
 * GET  /pop   — Python script polls for messages (requires X-Admin-Key)
 *
 * Environment variables (set in Worker Settings → Variables):
 *   ADMIN_KEY      — secret key used by clipboard_helper.py
 *   UPSTASH_URL    — your Upstash Redis REST URL
 *   UPSTASH_TOKEN  — your Upstash Redis REST token
 */

const KEY = 'clipboard';
const MAX_BYTES = 50_000;

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

  await redis(['LPUSH', KEY, text]);
  return jsonResp({ ok: true }, 200);
}

async function handlePop(request) {
  if (request.headers.get('X-Admin-Key') !== ADMIN_KEY) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Get all pending messages and clear the list atomically
  const result = await redis(['LRANGE', KEY, '0', '-1']);
  const messages = result.result || [];

  if (!messages.length) return jsonResp({ text: null }, 200);

  await redis(['DEL', KEY]);
  return jsonResp({ text: messages.reverse().join('\n\n') }, 200);
}

async function redis(command) {
  const resp = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  return resp.json();
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
