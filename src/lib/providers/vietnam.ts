import type {
  Route, RoutePattern, Stop, StopRoute, TransportMode, VehicleTrip,
} from '@/types';
import {
  LiveVehicleAtStation, ParsedVehicle, StopTimetableResult,
  TransitProvider,
} from '@/lib/provider';
import { createCache } from '@/lib/cache';

const getEnv = (name: string, fallback: string): string => {
  return import.meta.env?.[name] ?? fallback;
};

const PROXY_BASE = getEnv('VITE_VIETNAM_PROXY_BASE', 'https://busmap-api-proxy.lequangglobal.workers.dev').replace(/\/$/, '');

// Decryption key for vbservice-api.vinbus.vn AES-256-CBC encrypted responses
const DECRYPT_KEY = getEnv('VITE_VIETNAM_DECRYPT_KEY', 'ViNbus2o21#K3(y)th3BUSNiElectric');
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

const ROUTE_LIST_URL = timbusUrl('/client/route/list');
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

const getJson = async (url: string): Promise<unknown> => {
  const response = await fetch(url, {
    method: 'GET',
    headers: requestHeaders,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

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
};

const getDt = (payload: unknown): unknown => {
  const p = payload as Record<string, unknown> | null;
  if (!p) return null;
  return p.dt ?? null;
};

const parseGeoString = (value: unknown): { lat: number; lon: number } | null => {
  if (value === null || value === undefined) return null;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;

    const parts = trimmed.split(',').map((p) => Number(p.trim()));
    if (parts.length === 2 && parts.every((p) => Number.isFinite(p))) {
      const [a, b] = parts;
      if (Math.abs(a) <= 90 && Math.abs(b) <= 180) {
        return { lat: a, lon: b };
      }
      if (Math.abs(b) <= 90 && Math.abs(a) <= 180) {
        return { lat: b, lon: a };
      }
    }
    return null;
  }

  if (Array.isArray(value)) {
    const arr = value as unknown[];
    if (arr.length >= 2) {
      const a = Number(arr[0]);
      const b = Number(arr[1]);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        if (Math.abs(a) <= 90 && Math.abs(b) <= 180) {
          return { lat: a, lon: b };
        }
        if (Math.abs(b) <= 90 && Math.abs(a) <= 180) {
          return { lat: b, lon: a };
        }
      }
    }
    return null;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const lat = Number(obj.lat ?? obj.Lat ?? obj.latitude ?? obj.y ?? 0);
    const lon = Number(obj.lon ?? obj.lng ?? obj.Lon ?? obj.Lng ?? obj.longitude ?? obj.x ?? 0);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      return { lat, lon };
    }
    return null;
  }

  return null;
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

  try {
    const payload = await getJson(`${ROUTE_DETAIL_URL}?routeId=${encodeURIComponent(routeId)}&regionCode=hn`);

    const dt = getDt(payload);
    if (!dt || typeof dt !== 'object') {
      console.log('[Vietnam] route detail routeId=' + routeId + ': no dt data');
      return null;
    }

    const d = dt as Record<string, unknown>;
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
  const code = String(r.Code ?? r.code ?? r.routeNo ?? r.shortName ?? '');
  const name = String(r.Name ?? r.name ?? r.longName ?? r.routeName ?? code);
  return {
    gtfsId: `${getEnv('VITE_VIETNAM_ROUTE_ID_PREFIX', 'TB:')}${code}`,
    shortName: code,
    longName: name,
    mode: 'bus' as TransportMode,
  };
};

const normalizeVietnamStop = (s: {
  stationId: string | number; stationName: string; lat: number; lng: number;
}): Stop => {
  return {
    gtfsId: String(s.stationId),
    name: s.stationName,
    code: String(s.stationId),
    lat: s.lat,
    lon: s.lng,
    vehicleMode: 'bus' as TransportMode,
    routes: [],
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
    if (!PROXY_BASE) return [];

    try {
      const payload = await getJson(`${ROUTE_LIST_URL}?regionCode=hn`);

      // Proxy returns decrypted JSON directly. Handle all response shapes:
      // 1) Direct array: [...]
      // 2) Object with .Data: { Data: [...] }
      // 3) Object with .dt: { dt: { Data: [...] } }
      let data: unknown[] | null = null;
      if (Array.isArray(payload)) {
        data = payload;
      } else if (payload && typeof payload === 'object') {
        const p = payload as Record<string, unknown>;
        data = p.Data ?? (p.dt && typeof p.dt === 'object' ? (p.dt as Record<string, unknown>).Data : null) ?? null;
      }

      if (!Array.isArray(data)) {
        console.log('[Vietnam] route list: Data is not array');
        return [];
      }
      if (!Array.isArray(data)) {
        console.log('[Vietnam] route list: Data is not array');
        return [];
      }

      const routes: Route[] = [];
      for (const r of data) {
        if (typeof r !== 'object' || r === null) continue;
        routes.push(normalizeVietnamRoute(r as Record<string, unknown>));
      }

      console.log('[Vietnam] Route list loaded', routes.length, 'routes');
      return routes.sort((a: Route, b: Route) => a.shortName.localeCompare(b.shortName));
    } catch (err) {
      console.log('[Vietnam] Route list fetch failed:', err);
      return [];
    }
  },

  fetchAllStops: async (): Promise<Stop[]> => {
    if (!PROXY_BASE) return [];

    // vbservice-api.vinbus.vn has no standalone "all stops" endpoint.
    // Stops are discovered per-route via route detail, so collect stations across all routes.
    const routes = await vietnamProvider.fetchAllRoutes();
    if (routes.length === 0) return [];

    const stationsById = new Map<string, {
      stationId: string | number; stationName: string; lat: number; lng: number;
      routes: StopRoute[];
    }>();

    const concurrency = 4;
    for (let i = 0; i < routes.length; i += concurrency) {
      const batch = routes.slice(i, i + concurrency);
      await Promise.all(batch.map(async (route) => {
        try {
          const d = await fetchRouteDetailRaw(route.gtfsId);
          if (!d || typeof d !== 'object') return;

          const detail = d as Record<string, unknown>;
          const stations = detail.stations;
          if (!Array.isArray(stations)) return;

          for (const s of stations) {
            if (typeof s !== 'object' || s === null) continue;
            const st = s as Record<string, unknown>;
            const stationId = (st.stationId ?? st.station_id ?? st.id ?? '') as string | number;
            if (!stationId) continue;

            const geo = parseGeoString(st.lat ?? st.Lat ?? st.latitude) &&
              parseGeoString(st.lng ?? st.Lng ?? st.lon ?? st.longitude);
            const lat = typeof st.lat === 'number' ? st.lat : (geo?.lat ?? 0);
            const lng = typeof st.lng === 'number' ? st.lng : (geo?.lon ?? 0);

            const routeEntry: StopRoute = {
              gtfsId: route.gtfsId,
              shortName: route.shortName,
              longName: route.longName,
              mode: 'bus' as TransportMode,
            };

            const key = String(stationId);
            const existing = stationsById.get(key);
            if (existing) {
              if (!existing.routes.some((r) => r.gtfsId === route.gtfsId)) {
                existing.routes.push(routeEntry);
              }
            } else {
              stationsById.set(key, {
                stationId,
                stationName: String(st.stationName ?? st.station_name ?? st.name ?? key),
                lat,
                lng,
                routes: [routeEntry],
              });
            }
          }
        } catch {
          // Skip individual route detail failures
        }
      }));
    }

    return Array.from(stationsById.values()).map((s) => normalizeVietnamStop(s));
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
          const pt = parseGeoString(st.lat ?? st.Lat) &&
                     parseGeoString(st.lng ?? st.Lng);
          if (pt) geometry.push(pt);
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

  fetchStopTimetable: async (_stopId: string): Promise<StopTimetableResult> => {
    // vbservice-api.vinbus.vn exposes no public timetable endpoint.
    return { departures: [], directions: {} };
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
