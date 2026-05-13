/**
 * Cloudflare Worker — Anthropic API CORS Proxy
 * =============================================
 * Deploy via the Cloudflare dashboard web editor (no build step needed).
 *
 * Setup (2 minutes):
 *   1. Go to https://dash.cloudflare.com → Workers & Pages → Create
 *   2. Click "Create Worker", replace ALL default code with this file, click "Deploy"
 *   3. Copy the Worker URL (e.g. https://my-proxy.yourname.workers.dev)
 *   4. Paste it into the Proxy URL field in Claude Chat or FMEA Reworder
 */

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  try {
    var url    = new URL(request.url);
    var target = 'https://api.anthropic.com' + url.pathname + url.search;

    var response = await fetch(target, {
      method:  request.method,
      headers: request.headers,
      body:    request.body,
    });

    var headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', '*');

    return new Response(response.body, {
      status:     response.status,
      statusText: response.statusText,
      headers:    headers,
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status:  500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
}
