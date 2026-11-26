/**
 * BusMap API Proxy - Cloudflare Worker
 * Proxies GET requests to vbservice-api.vinbus.vn with CORS headers.
 * The VinBus API returns AES-256-CBC encrypted hex responses; decryption
 * is performed client-side by the app using the key from the environment.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Only allow GET requests
    if (request.method !== 'GET') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // Extract the path from the request URL
    const path = url.pathname;

    // Build the vinbus API URL
    const vinbusUrl = new URL(`${env.VINBUS_API_BASE}${path}`);

    // Copy query parameters
    url.searchParams.forEach((v, k) => {
      vinbusUrl.searchParams.set(k, v);
    });

    try {
      const response = await fetch(vinbusUrl.toString(), {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Referer': 'https://maps.vinbus.vn/',
          'Origin': 'https://maps.vinbus.vn',
          'X-Requested-With': 'XMLHttpRequest',
        },
      });

      const responseText = await response.text();

      return new Response(responseText, {
        status: response.status,
        headers: {
          'Content-Type': response.headers.get('content-type') || 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
          'Cache-Control': 'public, max-age=300',
        },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
  },
};
