import type {
  Route, RoutePattern, Stop, StopDeparture, StopRoute, TransportMode, VehicleTrip,
} from '@/types';
import {
  LiveVehicleAtStation, ParsedVehicle, StopTimetableResult,
  TransitProvider,
} from '@/lib/provider';
import { createCache } from '@/lib/cache';

const getEnv = (name: string, fallback: string): string => {
  return import.meta.env?.[name] ?? fallback;
};

const PROXY_BASE = getEnv('VITE_VIETNAM_PROXY_BASE', 'https://busmap.lequangglobal.workers.dev').replace(/\/$/, '');

// Decryption key for vbservice-api.vinbus.vn AES-256-CBC encrypted responses
const DECRYPT_KEY = getEnv('VITE_VIETNAM_DECRYPT_KEY', 'ViNbus2o21#K3(y)th3BUSNiElectric');

// Route id prefix + default region for vbservice-api.vinbus.vn
const ROUTE_ID_PREFIX = getEnv('VITE_VIETNAM_ROUTE_ID_PREFIX', 'TB:');
const REGION_CODE = getEnv('VITE_VINBUS_DEFAULT_REGION', 'hn');
const IV_LENGTH = 16; // AES-CBC IV is 16 bytes

// Helper: Convert hex string to Uint8Array (browser-compatible, no Node Buffer).
function hexToUint8Array(hex: string): Uint8Array {
  // VinBus API returns JSON-quoted hex strings (e.g. "a3554f79...")
  const cleaned = hex.replace(/^"(.*)"$/, '$1');
  if (cleaned.length % 2 !== 0) throw new Error('Invalid hex string');
  if (!/^[0-9a-fA-F]+$/.test(cleaned)) throw new Error('Invalid hex string');
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleaned.substr(i * 2, 2), 16);
  }
  return bytes;
}

// Decrypt AES-256-CBC encrypted response from vbservice-api.vinbus.vn
async function decryptMessage(hex: string, key: string): Promise<unknown> {
  const bytes = hexToUint8Array(hex);
  const iv = bytes.subarray(0, IV_LENGTH);
  const ciphertext = bytes.subarray(IV_LENGTH);
  const keyBuf = new TextEncoder().encode(key).subarray(0, 32);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBuf,
    { name: 'AES-CBC' },
    false,
    ['decrypt']
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: iv as unknown as ArrayBufferView<ArrayBuffer> },
    cryptoKey,
    ciphertext as unknown as ArrayBufferView<ArrayBuffer>,
  );

  const str = new TextDecoder().decode(decrypted);
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

// vbservice-api.vinbus.vn endpoints (GET, AES-256-CBC encrypted hex responses)
const timbusUrl = (path: string): string => {
  // When using PROXY_BASE (Cloudflare Worker), path is like "/client/route/list"
  if (PROXY_BASE) return `${PROXY_BASE}${path}`;
  // Direct vbservice-api.vinbus.vn access (no proxy)
  return `https://vbservice-api.vinbus.vn${path}`;
};

const ROUTE_DETAIL_URL = timbusUrl('/client/route/detail');
// VinBus endpoints (GET, AES-256-CBC encrypted hex responses)
// /client/route/list?regionCode=hn
// /client/route/detail?routeId=X&regionCode=hn
// /client/station/near?lat=...&lng=...&r=700&regionCode=hn

const requestHeaders: Record<string, string> = {
  'Accept': 'application/json',
  'Referer': 'https://maps.vinbus.vn/',
  'Origin': 'https://maps.vinbus.vn',
  'X-Requested-With': 'XMLHttpRequest',
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const getJson = async (url: string, retries = 4): Promise<unknown> => {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch(url, {
      method: 'GET',
      headers: requestHeaders,
    });

    if (response.ok) {
      const responseText = await response.text();

      // Try to decrypt if it's hex-encoded AES
      let decryptedData;
      try {
        decryptedData = await decryptMessage(responseText, DECRYPT_KEY);
      } catch {
        // If decryption fails, return raw text parsed as JSON if possible
        try {
          decryptedData = JSON.parse(responseText);
        } catch {
          decryptedData = responseText;
        }
      }

      return decryptedData;
    }

    lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
    if (response.status === 429 && attempt < retries) {
      await sleep(2000 * (attempt + 1) + Math.floor(Math.random() * 500));
      continue;
    }
    throw lastError;
  }

  throw lastError ?? new Error('Request failed');
};

const getDt = (payload: unknown): unknown => {
  const p = payload as Record<string, unknown> | null;
  if (!p) return null;
  return p.dt ?? null;
};


// 24h TTL cache for static route detail payloads (routes, geometry, stations).
const fleetCache = createCache();

const FLEET_DETAIL_CACHE_KEY = (routeId: string) => `routedetail:${routeId}`;

const fetchRouteDetailRaw = async (routeId: string): Promise<Record<string, unknown> | null> => {
  if (!PROXY_BASE) return null;

  const key = FLEET_DETAIL_CACHE_KEY(routeId);
  const cached = fleetCache.readTimedCacheValue(key, 'dt', (v): Record<string, unknown> | null => (
    isRecord(v) ? v : null
  ));
  if (cached) return cached.value;

  const numericId = routeId.startsWith(ROUTE_ID_PREFIX)
    ? routeId.slice(ROUTE_ID_PREFIX.length)
    : routeId;

  try {
    const payload = await getJson(`${ROUTE_DETAIL_URL}?routeId=${encodeURIComponent(numericId)}&regionCode=${encodeURIComponent(REGION_CODE)}`);

    const dt = getDt(payload);
    const d = (dt && isRecord(dt))
      ? dt
      : (isRecord(payload) ? payload : null);
    if (!d) {
      console.log('[Vietnam] route detail routeId=' + routeId + ': no data');
      return null;
    }

    fleetCache.writePersistentTimedCacheValue(key, 'dt', d);
    return d;
  } catch (err) {
    console.log('[Vietnam] route detail routeId=' + routeId + ': error', err);
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const normalizeVietnamRoute = (r: Record<string, unknown>): Route => {
  const code = String(r.routeNo ?? r.Code ?? r.code ?? r.shortName ?? '');
  const name = String(r.routeName ?? r.Name ?? r.name ?? r.longName ?? code);
  const numericId = String(r.routeId ?? r.id ?? code);
  return {
    gtfsId: `${ROUTE_ID_PREFIX}${numericId}`,
    shortName: code,
    longName: name,
    mode: 'bus' as TransportMode,
  };
};


export const vietnamProvider: TransitProvider = {
  id: 'vietnam',
  label: 'Vietnam Transit (vbservice-api.vinbus.vn)',
  cacheKeyPrefix: 'busmap-vietnam-',
  routeIdPrefix: getEnv('VITE_VIETNAM_ROUTE_ID_PREFIX', 'TB:'),
  timezone: getEnv('VITE_VIETNAM_TIMEZONE', 'Asia/Ho_Chi_Minh'),
  mqttBroker: '',
  mqttTopicPrefix: '',
  mqttDirOffset: 1,
  isApiKeyConfigured: () => true,
  normalizeMode: (): TransportMode => 'bus',
  fetchAllRoutes: async (): Promise<Route[]> => {
    try {
      console.log('[Vietnam] fetchAllRoutes: loading prefetched routes');
      const res = await fetch('/data/vn-routes.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const routes = (await res.json()) as Route[];
      console.log('[Vietnam] Route list loaded', routes.length, 'routes');
      return routes.sort((a: Route, b: Route) => a.shortName.localeCompare(b.shortName));
    } catch (err) {
      console.log('[Vietnam] Route list fetch failed:', err);
      return [];
    }
  },

  fetchAllStops: async (): Promise<Stop[]> => {
    try {
      console.log('[Vietnam] fetchAllStops: loading prefetched stops');
      const res = await fetch('/data/vn-stops.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const stops = (await res.json()) as Stop[];
      console.log('[Vietnam] Stops loaded', stops.length, 'stops');
      return stops;
    } catch (err) {
      console.log('[Vietnam] Stops fetch failed:', err);
      return [];
    }
  },

  fetchRoutesByIds: async (routeIds: string[]): Promise<Route[]> => {
    const routes: Route[] = [];
    for (const routeId of routeIds) {
      const d = await fetchRouteDetailRaw(routeId);
      if (!d) continue;
      routes.push(normalizeVietnamRoute(d as Record<string, unknown>));
    }
    return routes;
  },

  fetchRoutePatterns: async (
    routeIds: string[],
  ): Promise<Map<string, RoutePattern[]>> => {
    const patterns = new Map<string, RoutePattern[]>();
    for (const routeId of routeIds) {
      const d = await fetchRouteDetailRaw(routeId);
      if (!d) continue;
      const detail = d as Record<string, unknown>;
      const list: RoutePattern[] = [];

      // VinBus route detail has stations with lat/lng per station order
      const stations = detail.stations;
      if (Array.isArray(stations)) {
        const geometry: { lat: number; lon: number }[] = [];
        for (const s of stations) {
          if (typeof s !== 'object' || s === null) continue;
          const st = s as Record<string, unknown>;
          const pathPoints = typeof st.pathPoints === 'string' ? st.pathPoints.trim() : '';
          if (pathPoints) {
            for (const pair of pathPoints.split(/\s+/)) {
              const [lonStr, latStr] = pair.split(',');
              const lon = Number(lonStr);
              const lat = Number(latStr);
              if (Number.isFinite(lat) && Number.isFinite(lon)) {
                geometry.push({ lat, lon });
              }
            }
            continue;
          }
          const lat = typeof st.lat === 'number' ? st.lat : Number(st.lat ?? st.Lat);
          const lng = typeof st.lng === 'number' ? st.lng : Number(st.lng ?? st.Lng);
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            geometry.push({ lat, lon: lng });
          }
        }
        if (geometry.length > 0) {
          list.push({
            gtfsId: routeId,
            name: String(detail.Code ?? detail.code ?? detail.routeNo ?? routeId),
            geometry,
          });
        }
      }

      patterns.set(routeId, list);
    }
    return patterns;
  },

  fetchStopTimetable: async (stopId: string): Promise<StopTimetableResult> => {
    try {
      const payload = await getJson(`${PROXY_BASE}/api/eta?regionCode=${encodeURIComponent(REGION_CODE)}&stationId=${encodeURIComponent(stopId)}&group=1&isInternalStation=0`);
      const routes = Array.isArray(payload) ? payload : [];
      const nowSec = Math.floor(Date.now() / 1000);
      const midnight = nowSec - (nowSec % 86400);
      const departures: StopDeparture[] = [];
      for (const routeItem of routes) {
        if (typeof routeItem !== 'object' || routeItem === null) continue;
        const ri = routeItem as Record<string, unknown>;
        const routeId = ri.routeId ?? ri.id;
        const routeNo = String(ri.routeNo ?? '');
        const routeName = String(ri.routeName ?? routeNo);
        const buses = Array.isArray(ri.list) ? ri.list : [];
        for (const bus of buses) {
          if (typeof bus !== 'object' || bus === null) continue;
          const b = bus as Record<string, unknown>;
          const eta = Number(b.time ?? NaN);
          if (!Number.isFinite(eta) || eta < 0) continue;
          departures.push({
            scheduledDeparture: (nowSec - midnight) + eta,
            realtimeDeparture: (nowSec - midnight) + eta,
            departureDelay: 0,
            realtime: true,
            realtimeState: 'UPDATED',
            headsign: routeName,
            serviceDay: midnight,
            routeGtfsId: `${ROUTE_ID_PREFIX}${routeId}`,
            routeShortName: routeNo,
            routeLongName: routeName,
            routeMode: 'bus',
            directionId: Number(b.direction ?? 0),
            tripStartTime: '',
          });
        }
      }
      return { departures, directions: {} };
    } catch {
      return { departures: [], directions: {} };
    }
  },

  fetchVehicleTrip: async (
    _routeId: string,
    _direction: 1 | 2,
    _operatingDay: string,
    _startTime: string,
  ): Promise<VehicleTrip | null> => {
    // vbservice-api.vinbus.vn exposes no vehicle-trip endpoint.
    return null;
  },

  fetchStopRoutes: async (_stopId: string): Promise<StopRoute[]> => {
    // vbservice-api.vinbus.vn exposes no station-to-routes endpoint.
    return [];
  },

  fetchLiveVehiclesAtStation: async (
    _stationId: string,
    _fleetOver: string[],
  ): Promise<LiveVehicleAtStation[]> => {
    // vbservice-api.vinbus.vn exposes no live-vehicles-at-station endpoint.
    return [];
  },

  parseVehicleMessage: (_topic: string, _payload: Buffer): ParsedVehicle | null => {
    // Vietnam provider has no MQTT live-vehicle feed.
    return null;
  },
};
