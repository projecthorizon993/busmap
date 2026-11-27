import { writeFileSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';

const API_BASE = 'https://vbservice-api.vinbus.vn';
const REGION = process.env.VINBUS_REGION || 'hn';
const DECRYPT_KEY = 'ViNbus2o21#K3(y)th3BUSNiElectric';
const ROUTE_PREFIX = 'TB:';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decrypt(hex) {
  const cleaned = String(hex).trim().replace(/^"(.*)"$/, '$1');
  const buf = Buffer.from(cleaned, 'hex');
  const iv = buf.subarray(0, 16);
  const ct = buf.subarray(16);
  const key = Buffer.from(DECRYPT_KEY).subarray(0, 32);
  const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return JSON.parse(d.update(ct, undefined, 'utf8') + d.final('utf8'));
}

async function getJson(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Accept: 'application/json',
      Referer: 'https://maps.vinbus.vn/',
      Origin: 'https://maps.vinbus.vn',
      'X-Requested-With': 'XMLHttpRequest',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  const text = await res.text();
  return decrypt(text);
}

async function main() {
  console.log(`Fetching VinBus route list for region=${REGION}...`);
  const routeList = await getJson(`/client/route/list?regionCode=${REGION}`);
  console.log(`Got ${routeList.length} routes`);

  const routes = routeList.map((r) => ({
    gtfsId: `${ROUTE_PREFIX}${r.routeId ?? r.id}`,
    shortName: String(r.routeNo ?? ''),
    longName: String(r.routeName ?? r.routeNo ?? ''),
    mode: 'bus',
  }));

  const stationsById = new Map();
  let done = 0;
  for (const r of routeList) {
    const routeId = r.routeId ?? r.id;
    const gtfsId = `${ROUTE_PREFIX}${routeId}`;
    const route = routes.find((x) => x.gtfsId === gtfsId);
    try {
      const detail = await getJson(`/client/route/detail?routeId=${routeId}&regionCode=${REGION}`);
      const stations = Array.isArray(detail?.stations) ? detail.stations : [];
      for (const s of stations) {
        const stationId = s.stationId ?? s.id;
        if (!stationId) continue;
        const lat = typeof s.lat === 'number' ? s.lat : 0;
        const lng = typeof s.lng === 'number' ? s.lng : 0;
        const entry = {
          stationId,
          stationName: String(s.stationName ?? s.name ?? stationId),
          lat,
          lng,
        };
        const key = String(stationId);
        const existing = stationsById.get(key);
        const routeEntry = { gtfsId: route.gtfsId, shortName: route.shortName, longName: route.longName, mode: 'bus' };
        if (existing) {
          if (!existing.routes.some((x) => x.gtfsId === route.gtfsId)) existing.routes.push(routeEntry);
        } else {
          stationsById.set(key, { ...entry, routes: [routeEntry] });
        }
      }
    } catch (e) {
      console.warn(`  skip route ${routeId}: ${e.message}`);
    }
    done += 1;
    if (done % 25 === 0) console.log(`  processed ${done}/${routeList.length}`);
    await sleep(250);
  }

  const stops = Array.from(stationsById.values()).map((s) => ({
    gtfsId: String(s.stationId),
    name: s.stationName,
    code: String(s.stationId),
    lat: s.lat,
    lon: s.lng,
    vehicleMode: 'bus',
    routes: s.routes,
  }));

  mkdirSync('public/data', { recursive: true });
  writeFileSync('public/data/vn-routes.json', JSON.stringify(routes));
  writeFileSync('public/data/vn-stops.json', JSON.stringify(stops));
  console.log(`Wrote ${routes.length} routes and ${stops.length} stops to public/data/`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
