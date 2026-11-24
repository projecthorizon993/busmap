// timbus.vn HTTPS proxy (zero-dependency Node.js sidecar).
//
// timbus.vn is HTTP-only while busmap runs on HTTPS (needed for
// navigator.geolocation and Browser Notifications). This sidecar forwards
// POST requests from the same origin to timbus.vn, adding the headers the
// endpoint requires (Referer, Origin, X-Requested-With) and rate-limiting
// live polls per stop/route to avoid hammering timbus.vn.
//
// Run:
//   PORT=8081 TIMBUS_BASE=http://timbus.vn node proxy/server.mjs
//
// Frontend sets VITE_VIETNAM_PROXY_BASE to this origin (e.g.
// http://localhost:8081 in dev, or the public origin in production behind
// nginx /timbus/). The app then POSTs to <proxyBase>/timbus/<Search|Vehicle>/action.ashx
// which this server forwards to http://timbus.vn/Engine/Business/<...>/action.ashx.

import { createServer } from 'node:http';
import { parse } from 'node:url';

const PORT = Number(process.env.PORT ?? 8081);
const TIMBUS_BASE = process.env.TIMBUS_BASE ?? 'http://timbus.vn';
const LIVE_CACHE_TTL_MS = Number(process.env.LIVE_CACHE_TTL_MS ?? 15000); // 15s
const STATIC_CACHE_TTL_MS = Number(process.env.STATIC_CACHE_TTL_MS ?? 24 * 60 * 60 * 1000); // 24h

const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN ?? '*';

// Headers timbus.vn requires on the originating request.
const TIMBUS_HEADERS = {
  'Referer': 'http://timbus.vn/',
  'Origin': 'http://timbus.vn',
  'X-Requested-With': 'XMLHttpRequest',
  'Accept': 'application/json',
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
};

// Cache: key -> { body, contentType, expiresAt }
const cache = new Map();

// In-flight request dedupe: key -> Promise
const inflight = new Map();

const corsHeaders = (origin) => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin',
});

const readBody = (req) => {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
};

const forwardToTimbus = async (path, body) => {
  const url = new URL(`${TIMBUS_BASE}/Engine/Business/${path}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  const response = await fetch(url.href, {
    method: 'POST',
    headers: TIMBUS_HEADERS,
    body,
    signal: controller.signal,
  });
  clearTimeout(timeout);

  const contentType = response.headers.get('content-type') ?? 'application/json';
  const bodyBuf = Buffer.from(await response.arrayBuffer());
  return { body: bodyBuf, contentType };
};

const getCacheTtl = (path, body) => {
  const text = body.toString();
  const isLive = path.includes('Vehicle/action.ashx') || /act=partremained/.test(text);
  return isLive ? LIVE_CACHE_TTL_MS : STATIC_CACHE_TTL_MS;
};

const cacheKey = (path, body) => {
  const text = body.toString();
  const act = (text.match(/act=([^&]*)/) || [])[1] ?? '';
  const station = (text.match(/StationID=([^&]*)/) || [])[1] ?? '';
  const fid = (text.match(/fid=([^&]*)/) || [])[1] ?? '';
  const key = (text.match(/key=([^&]*)/) || [])[1] ?? '';
  const id = station || fid || key || '';
  return `${path}:${act}:${encodeURIComponent(id)}`;
};

const sendJson = (res, origin, body, contentType) => {
  res.writeHead(200, {
    ...corsHeaders(origin),
    'Content-Type': contentType,
    'Cache-Control': 'private, no-store',
  });
  res.end(body);
};

const handleTimbus = async (req, res, path) => {
  const origin = req.headers.origin || ALLOW_ORIGIN;
  res.setHeader('Access-Control-Allow-Origin', origin);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(origin));
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { ...corsHeaders(origin), 'Content-Type': 'text/plain' });
    res.end('Method not allowed');
    return;
  }

  try {
    const body = await readBody(req);
    const key = cacheKey(path, body);

    // Serve from cache if fresh.
    const cached = cache.get(key);
    const now = Date.now();
    if (cached && now < cached.expiresAt) {
      res.writeHead(200, {
        ...corsHeaders(origin),
        'Content-Type': cached.contentType,
        'Cache-Control': 'private, max-age=10',
        'X-Busmap-Cache': 'hit',
      });
      res.end(cached.body);
      return;
    }

    // Collapse duplicate in-flight requests for the same key.
    const existing = inflight.get(key);
    if (existing) {
      const { body: b, contentType } = await existing;
      sendJson(res, origin, b, contentType);
      return;
    }

    const promise = (async () => {
      return await forwardToTimbus(path, body);
    })();
    inflight.set(key, promise);

    try {
      const { body: b, contentType } = await promise;
      sendJson(res, origin, b, contentType);

      // Cache the result.
      const ttl = getCacheTtl(path, body);
      cache.set(key, { body: b, contentType, expiresAt: now + ttl });
      if (cache.size > 2000) {
        for (const [k, v] of cache) {
          if (now > v.expiresAt) cache.delete(k);
        }
      }
    } finally {
      inflight.delete(key);
    }
  } catch (err) {
    res.writeHead(502, { ...corsHeaders(origin), 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'timbus upstream unavailable' }));
  }
};

const server = createServer(async (req, res) => {
  const origin = req.headers.origin || ALLOW_ORIGIN;
  const url = parse(req.url || '');
  const pathname = url.pathname || '';

  // Only proxy /timbus/<Search|Vehicle>/action.ashx
  const match = pathname.match(/^\/timbus\/(Search|Vehicle)\/action\.ashx$/i);
  if (!match) {
    res.writeHead(404, { ...corsHeaders(origin), 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  const path = match[0].replace(/^\/timbus\//, '');
  await handleTimbus(req, res, path);
});

server.listen(PORT, () => {
  console.log(`timbus proxy listening on http://127.0.0.1:${PORT} -> ${TIMBUS_BASE}`);
});
