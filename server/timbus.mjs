import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const TIMBUS_BASE = 'http://timbus.vn';
const FLEETS_URL = 'http://timbus.vn/fleets.aspx';
const CACHE_DIR = join(process.cwd(), 'cache');
const ROUTES_INDEX_FILE = join(CACHE_DIR, 'routes_index.json');
const ROUTES_DIR = join(CACHE_DIR, 'routes');
const TTL_MS = 24 * 60 * 60 * 1000;
const THROTTLE_MS = 250;

const HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  'Referer': 'http://timbus.vn/',
  'Origin': 'http://timbus.vn',
  'X-Requested-With': 'XMLHttpRequest',
};

let lastRequestTs = 0;

async function throttle() {
  const now = Date.now();
  const delay = THROTTLE_MS - (now - lastRequestTs);
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  lastRequestTs = Date.now();
}

async function timbusRequest(method, path, body) {
  await throttle();
  const res = await fetch(`${TIMBUS_BASE}${path}`, {
    method,
    headers: {
      ...HEADERS,
      'Content-Length': Buffer.byteLength(body ?? '').toString(),
    },
    body,
  });
  if (!res.ok) throw new Error(`timbus ${path} HTTP ${res.status}`);
  return res;
}

function formBody(fields) {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

function extractRouteCatalog(html) {
  const start = html.indexOf('["');
  if (start === -1) throw new Error('route catalog array not found');
  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '[') { depth++; continue; }
    if (ch === ']') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) throw new Error('could not close route catalog array');
  const routes = JSON.parse(html.slice(start, end + 1));
  if (!Array.isArray(routes)) throw new Error('catalog is not an array');
  return routes;
}

function isTestEntry(route) {
  const lower = String(route).toLowerCase();
  if (lower.includes('test')) return true;
  const code = String(route).split(' - ')[0].trim();
  if (code === '6969') return true;
  return false;
}

async function readJsonFile(file) {
  try {
    const data = await readFile(file, 'utf8');
    return JSON.parse(data);
  } catch { return null; }
}

async function writeJsonFile(file, value) {
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2));
}

async function readCachedRoutesIndex() {
  const obj = await readJsonFile(ROUTES_INDEX_FILE);
  if (obj && obj.generatedAt && Date.now() - obj.generatedAt < TTL_MS && Array.isArray(obj.routes)) {
    return obj.routes;
  }
  return null;
}

async function writeCachedRoutesIndex(routes) {
  await writeJsonFile(ROUTES_INDEX_FILE, { generatedAt: Date.now(), routes });
}

async function readCachedRouteDetail(fid) {
  const obj = await readJsonFile(join(ROUTES_DIR, `${fid}.json`));
  if (obj && obj.generatedAt && Date.now() - obj.generatedAt < TTL_MS) return obj.detail;
  return null;
}

async function writeCachedRouteDetail(fid, detail) {
  await writeJsonFile(join(ROUTES_DIR, `${fid}.json`), { generatedAt: Date.now(), detail });
}

async function syncCatalog() {
  const html = await (await fetch(FLEETS_URL)).text();
  const allRoutes = extractRouteCatalog(html);
  const routes = allRoutes.filter((r) => !isTestEntry(r));
  const index = [];
  for (const route of routes) {
    try {
      const res = await timbusRequest('POST', '/Engine/Business/Search/action.ashx', formBody({
        act: 'searchfull', typ: '1', key: route,
      }));
      const payload = await res.json();
      const dt = payload.dt;
      const data = dt && dt.Data;
      if (!Array.isArray(data) || data.length === 0) continue;
      const item = data[0];
      const fid = String(item.ObjectID ?? item.objectID ?? item.id ?? '');
      if (!fid) continue;

      let detail = await readCachedRouteDetail(fid);
      if (!detail) {
        const dres = await timbusRequest('POST', '/Engine/Business/Search/action.ashx', formBody({
          act: 'fleetdetail', fid,
        }));
        const dpayload = await dres.json();
        detail = dpayload.dt;
        if (detail) await writeCachedRouteDetail(fid, detail);
      }

      index.push({
        key: route,
        fid,
        shortName: String(route).split(' - ')[0].trim(),
        longName: String(route),
        hasDetail: !!detail,
      });
    } catch (err) {
      console.error(`[timbus-sync] failed for ${route}:`, err.message);
    }
  }
  await writeCachedRoutesIndex(index);
  return { total: routes.length, synced: index.length };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  const buf = Buffer.from(body, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Length': buf.length.toString(),
  });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

async function handleProxy(req, res, path) {
  const timbusPath = '/Engine/Business/' + path.replace(/^\/timbus\//, '');
  const body = await readBody(req);
  try {
    const timbusRes = await timbusRequest('POST', timbusPath, body);
    const contentType = timbusRes.headers.get('content-type') ?? 'application/json';
    const buf = await timbusRes.arrayBuffer();
    res.writeHead(timbusRes.status, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Content-Length': buf.byteLength.toString(),
    });
    res.end(Buffer.from(buf));
  } catch (err) {
    sendJson(res, 502, { error: 'proxy_error', message: err.message });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '', `http://${req.headers.host}`);
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/health') {
    return sendJson(res, 200, { ok: true, service: 'timbus-sync' });
  }

  if (method === 'POST' && pathname === '/api/sync') {
    try {
      const result = await syncCatalog();
      return sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  if (method === 'GET' && pathname === '/api/routes') {
    const routes = await readCachedRoutesIndex();
    if (routes) return sendJson(res, 200, { ok: true, routes, source: 'cache' });
    return sendJson(res, 404, { ok: false, error: 'routes cache empty; run POST /api/sync' });
  }

  const fidMatch = pathname.match(/^\/api\/routes\/([^\/]+)\/?$/);
  if (method === 'GET' && fidMatch) {
    const detail = await readCachedRouteDetail(fidMatch[1]);
    if (detail) return sendJson(res, 200, { ok: true, fid: fidMatch[1], detail, source: 'cache' });
    return sendJson(res, 404, { ok: false, error: `route detail ${fidMatch[1]} not cached` });
  }

  if (method === 'POST' && pathname.startsWith('/timbus/')) {
    return handleProxy(req, res, pathname);
  }

  return sendJson(res, 404, { ok: false, error: 'not found' });
});

const PORT = Number(process.env.PORT ?? 3001);
server.listen(PORT, () => {
  console.log(`[timbus-sync] listening on http://localhost:${PORT}`);
  console.log(`[timbus-sync] cache dir: ${CACHE_DIR}`);
});

export { syncCatalog, CACHE_DIR };
