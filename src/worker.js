/**
 * BusMap API Proxy + aggregation cache - Cloudflare Worker
 */
const IV_LENGTH = 16;

function hexToUint8Array(hex) {
  const cleaned = hex.replace(/^"(.*)"$/, '$1');
  if (cleaned.length % 2 !== 0) throw new Error('Invalid hex string');
  if (!/^[0-9a-fA-F]+$/.test(cleaned)) throw new Error('Invalid hex string');
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleaned.substr(i * 2, 2), 16);
  }
  return bytes;
}

async function decryptMessage(hex, key) {
  const bytes = hexToUint8Array(hex);
  const iv = bytes.subarray(0, IV_LENGTH);
  const ciphertext = bytes.subarray(IV_LENGTH);
  const keyBuf = new TextEncoder().encode(key).subarray(0, 32);
  const cryptoKey = await crypto.subtle.importKey('raw', keyBuf, { name: 'AES-CBC' }, false, ['decrypt']);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, ciphertext);
  const str = new TextDecoder().decode(decrypted);
  try { return JSON.parse(str); } catch { return str; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

async function fetchVinBus(path, env) {
  const url = new URL(`${env.VINBUS_API_BASE}${path}`);
  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'Referer': 'https://maps.vinbus.vn/',
      'Origin': 'https://maps.vinbus.vn',
      'X-Requested-With': 'XMLHttpRequest',
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return decryptMessage(text, env.VITE_VIETNAM_DECRYPT_KEY || 'ViNbus2o21#K3(y)th3BUSNiElectric');
}

async function getRoutes(region, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(`https://busmap-cache/api/routes?region=${region}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const raw = await fetchVinBus(`/client/route/list?regionCode=${region}`, env);
  const routes = (Array.isArray(raw) ? raw : []).map((r) => ({
    gtfsId: `TB:${r.routeId ?? r.id}`,
    shortName: String(r.routeNo ?? ''),
    longName: String(r.routeName ?? r.routeNo ?? ''),
    mode: 'bus',
    _routeId: r.routeId ?? r.id,
  }));

  const res = new Response(JSON.stringify(routes), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400', ...CORS_HEADERS },
  });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return routes;
}

async function getStops(region, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(`https://busmap-cache/api/stops?region=${region}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const routes = await getRoutes(region, env, ctx);
  const stationsById = new Map();
  for (const route of routes) {
    try {
      const detail = await fetchVinBus(`/client/route/detail?routeId=${route._routeId}&regionCode=${region}`, env);
      const stations = Array.isArray(detail?.stations) ? detail.stations : [];
      for (const s of stations) {
        const stationId = s.stationId ?? s.id;
        if (!stationId) continue;
        const routeEntry = { gtfsId: route.gtfsId, shortName: route.shortName, longName: route.longName, mode: 'bus' };
        const key = String(stationId);
        const existing = stationsById.get(key);
        if (existing) {
          if (!existing.routes.some((r) => r.gtfsId === route.gtfsId)) existing.routes.push(routeEntry);
        } else {
          stationsById.set(key, {
            gtfsId: key,
            name: String(s.stationName ?? s.name ?? key),
            code: key,
            lat: typeof s.lat === 'number' ? s.lat : 0,
            lon: typeof s.lng === 'number' ? s.lng : 0,
            vehicleMode: 'bus',
            routes: [routeEntry],
          });
        }
      }
    } catch (e) {
      // skip
    }
    await sleep(100);
  }

  const stops = Array.from(stationsById.values());
  const res = new Response(JSON.stringify(stops), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400', ...CORS_HEADERS },
  });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return stops;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    if (request.method !== 'GET') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
    }

    const path = url.pathname;
    const region = url.searchParams.get('regionCode') || 'hn';

    // Aggregated endpoints
    if (path === '/api/routes') {
      try {
        const routes = await getRoutes(region, env, ctx);
        // strip internal _routeId from response
        const clean = routes.map(({ _routeId, ...r }) => r);
        return new Response(JSON.stringify(clean), { headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
      }
    }
    if (path === '/api/stops') {
      try {
        const stops = await getStops(region, env, ctx);
        return new Response(JSON.stringify(stops), { headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
      }
    }
    if (path === '/api/eta') {
      // proxy raw estimate endpoint
      const stationId = url.searchParams.get('stationId');
      if (!stationId) {
        return new Response(JSON.stringify({ error: 'stationId required' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
      }
      const vinbusPath = `/client/station/estimate_bus_to_station?regionCode=${encodeURIComponent(region)}&stationId=${encodeURIComponent(stationId)}&group=${url.searchParams.get('group') || '1'}&isInternalStation=${url.searchParams.get('isInternalStation') || '0'}`;
      const vinbusUrl = new URL(`${env.VINBUS_API_BASE}${vinbusPath}`);
      const res = await fetch(vinbusUrl.toString(), {
        method: 'GET',
        headers: { 'Accept': 'application/json', 'Referer': 'https://maps.vinbus.vn/', 'Origin': 'https://maps.vinbus.vn', 'X-Requested-With': 'XMLHttpRequest' },
      });
      const text = await res.text();
      return new Response(text, { status: res.status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=60', ...CORS_HEADERS } });
    }

    // Default raw proxy
    const vinbusUrl = new URL(`${env.VINBUS_API_BASE}${path}`);
    url.searchParams.forEach((v, k) => vinbusUrl.searchParams.set(k, v));
    try {
      const response = await fetch(vinbusUrl.toString(), {
        method: 'GET',
        headers: { 'Accept': 'application/json', 'Referer': 'https://maps.vinbus.vn/', 'Origin': 'https://maps.vinbus.vn', 'X-Requested-With': 'XMLHttpRequest' },
      });
      const responseText = await response.text();
      return new Response(responseText, {
        status: response.status,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'public, max-age=300' },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }
  },
};
