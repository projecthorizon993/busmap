import type {
  Route, RoutePattern, Stop, StopRoute, TransportMode, VehicleTrip,
} from '@/types';
import {
  LiveVehicleAtStation, ParsedVehicle, StopTimetableResult,
  TransitProvider,
} from '@/lib/provider';
import { stripRouteIdPrefix } from '@/lib/routeId';
import { createCache } from '@/lib/cache';

const getEnv = (name: string, fallback: string): string => {
  return import.meta.env?.[name] ?? fallback;
};

const API_BASE = getEnv('VITE_VIETNAM_API_BASE', '');
const PROXY_BASE = getEnv('VITE_VIETNAM_PROXY_BASE', 'https://busmap-api-proxy.lequangglobal.workers.dev').replace(/\/$/, '');

// Decryption key for timbus.vn AES-256-CBC encrypted responses
const DECRYPT_KEY = getEnv('VITE_VIETNAM_DECRYPT_KEY', '');
const IV_LENGTH = 16; // AES-CBC IV is 16 bytes

// Helper: Convert hex string to Uint8Array (browser-compatible, no Node Buffer).
function hexToUint8Array(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string');
  if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error('Invalid hex string');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

// Decrypt AES-256-CBC encrypted response from timbus.vn
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

// timbus.vn endpoints (HTTP). All POST form-urlencoded.
const SEARCH_PATH = 'Search/action.ashx';

const timbusUrl = (path: string): string => {
  // When using PROXY_BASE (Cloudflare Worker), path is like "/Search/action.ashx"
  // The Worker forwards to http://timbus.vn/Engine/Business/${path}
  if (PROXY_BASE) return `${PROXY_BASE}${path}`;
  // Direct timbus.vn access (no proxy)
  return `${API_BASE}/Engine/Business/${path}`;
};

const SEARCH_URL = timbusUrl(SEARCH_PATH);

const requestHeaders: Record<string, string> = {
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  'Accept': 'application/json',
  'Referer': 'http://timbus.vn/',
  'Origin': 'http://timbus.vn',
  'X-Requested-With': 'XMLHttpRequest',
};

const postForm = async (url: string, body: Record<string, string>): Promise<unknown> => {
  const formBody = Object.entries(body)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const response = await fetch(url, {
    method: 'POST',
    headers: requestHeaders,
    body: formBody,
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

const parseGeoList = (value: unknown): { lat: number; lon: number }[] => {
  if (value === null || value === undefined) return [];

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];

    const segments = trimmed.split(/[;\s|]+/).filter(Boolean);
    const points: { lat: number; lon: number }[] = [];
    for (const seg of segments) {
      const pt = parseGeoString(seg);
      if (pt) points.push(pt);
    }
    return points;
  }

  if (Array.isArray(value)) {
    const points: { lat: number; lon: number }[] = [];
    for (const item of value as unknown[]) {
      const pt = parseGeoString(item);
      if (pt) points.push(pt);
    }
    return points;
  }

  return [];
};

const routeIdToFleetId = (routeId: string): string => stripRouteIdPrefix(routeId);

// 24h TTL cache for static fleetdetail payloads (routes, geometry, stations).
const fleetCache = createCache();

const FLEET_DETAIL_CACHE_KEY = (fid: string) => `fleetdetail:${fid}`;

const fetchFleetDetailRaw = async (fid: string): Promise<Record<string, unknown> | null> => {
  if (!API_BASE && !PROXY_BASE) return null;

  const key = FLEET_DETAIL_CACHE_KEY(fid);
  const cached = fleetCache.readTimedCacheValue(key, 'dt', (v): Record<string, unknown> | null => (
    isRecord(v) ? v : null
  ));
  if (cached) return cached.value;

  try {
    const payload = await postForm(SEARCH_URL, {
      act: 'fleetdetail',
      fid,
    });

    const dt = getDt(payload);
    if (!dt || typeof dt !== 'object') {
      console.log('[Vietnam] fleetdetail fid=' + fid + ': no dt data');
      return null;
    }

    const d = dt as Record<string, unknown>;
    const goStation = (d as { Go?: { Station?: unknown[] } }).Go?.Station;
    const reStation = (d as { Re?: { Station?: unknown[] } }).Re?.Station;
    const stationsGo = goStation?.length ?? 0;
    const stationsRe = reStation?.length ?? 0;
    console.log('[Vietnam] fleetdetail fid=' + fid + ': Go=' + stationsGo + ' Re=' + stationsRe + ' stations');
    fleetCache.writePersistentTimedCacheValue(key, 'dt', d);
    return d;
  } catch (err) {
    console.log('[Vietnam] fleetdetail fid=' + fid + ': error', err);
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const parseFleetOver = (value: unknown): string[] => {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') {
    return value.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.map(String).filter(Boolean);
  }
  return [];
};

const normalizeVietnamRoute = (r: Record<string, unknown>): Route => {
  const code = String(r.Code ?? r.code ?? r.shortName ?? r.routeNo ?? '');
  const name = String(r.Name ?? r.name ?? r.longName ?? r.routeName ?? code);
  return {
    gtfsId: `${getEnv('VITE_VIETNAM_ROUTE_ID_PREFIX', 'TB:')}${code}`,
    shortName: code,
    longName: name,
    mode: 'bus' as TransportMode,
  };
};

const normalizeVietnamStop = (s: {
  objectID: string; name: string; geo: { lat: number; lon: number } | null;
  fleetOver: string[]; routes: StopRoute[];
}): Stop => {
  return {
    gtfsId: s.objectID,
    name: s.name,
    code: s.objectID,
    lat: s.geo?.lat ?? 0,
    lon: s.geo?.lon ?? 0,
    vehicleMode: 'bus' as TransportMode,
    routes: s.routes,
    fleetOver: s.fleetOver,
  };
};

export const vietnamProvider: TransitProvider = {
  id: 'vietnam',
  label: 'Vietnam Transit (timbus.vn)',
  cacheKeyPrefix: 'busmap-vietnam-',
  routeIdPrefix: getEnv('VITE_VIETNAM_ROUTE_ID_PREFIX', 'TB:'),
  timezone: getEnv('VITE_VIETNAM_TIMEZONE', 'Asia/Ho_Chi_Minh'),
  mqttBroker: '',
  mqttTopicPrefix: '',
  mqttDirOffset: 1,
  isApiKeyConfigured: () => true,
  normalizeMode: (): TransportMode => 'bus',
  fetchAllRoutes: async (): Promise<Route[]> => {
    if (!API_BASE && !PROXY_BASE) return [];

    // Prefer the synced route catalog (served over HTTPS via the backend proxy)
    // instead of brute-forcing searchfull prefixes.
    if (PROXY_BASE) {
      try {
        const res = await fetch(`${PROXY_BASE}/api/routes`);
        if (res.ok) {
          const payload = await res.json();
          const catalog = (Array.isArray(payload?.routes) ? payload.routes : []) as unknown[];
          const routes = catalog
            .filter((r): r is { fid: string; shortName?: string; longName?: string } =>
              typeof r === 'object' && r !== null && typeof (r as { fid?: unknown }).fid === 'string' && (r as { fid: string }).fid.length > 0,
            )
            .map((r) => ({
              gtfsId: `${getEnv('VITE_VIETNAM_ROUTE_ID_PREFIX', 'TB:')}${r.fid}`,
              shortName: r.shortName || r.fid,
              longName: r.longName || r.shortName || r.fid,
              mode: 'bus' as TransportMode,
            }));
          if (routes.length > 0) {
            console.log('[Vietnam] Catalog loaded', routes.length, 'routes from proxy');
            return routes.sort((a: Route, b: Route) => a.shortName.localeCompare(b.shortName));
          }
        }
      } catch (err) {
        console.log('[Vietnam] Catalog fetch failed:', err);
      }
    }

    // Fallback: timbus.vn searchfull supports a key prefix. Discover all routes by
    // querying numeric prefixes 0-9 plus E, BRT, CNG, then deduplicate by ObjectID.
    const prefixes = [
      '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
      'E', 'BRT', 'CNG',
    ];

    const seen = new Set<string>();
    const routes: Route[] = [];

    for (const prefix of prefixes) {
      try {
        const payload = await postForm(SEARCH_URL, {
          act: 'searchfull',
          typ: '1',
          key: prefix,
        });

        const dt = getDt(payload);
        if (!dt || typeof dt !== 'object') continue;

        const data = (dt as Record<string, unknown>).Data;
        if (!Array.isArray(data)) continue;

        for (const r of data) {
          if (typeof r !== 'object' || r === null) continue;
          const objectID = String(
            (r as Record<string, unknown>).ObjectID ??
            (r as Record<string, unknown>).objectID ??
            (r as Record<string, unknown>).id ??
            '',
          );
          if (!objectID || seen.has(objectID)) continue;
          seen.add(objectID);
          routes.push(normalizeVietnamRoute(r as Record<string, unknown>));
        }
      } catch {
        // Skip individual prefix failures
      }
    }

    console.log('[Vietnam] Prefix discovery found', routes.length, 'routes');
    return routes.sort((a, b) => a.shortName.localeCompare(b.shortName));
  },
  fetchAllStops: async (): Promise<Stop[]> => {
    if (!API_BASE && !PROXY_BASE) return [];

    // timbus.vn has no standalone "all stops" endpoint. Stops are discovered
    // per-route via fleetdetail, so collect stations across all routes.
    const routes = await vietnamProvider.fetchAllRoutes();
    if (routes.length === 0) return [];

    const stationsById = new Map<string, {
      objectID: string; name: string; geo: { lat: number; lon: number } | null;
      fleetOver: string[]; routes: StopRoute[];
    }>();

    const concurrency = 6;
    for (let i = 0; i < routes.length; i += concurrency) {
      const batch = routes.slice(i, i + concurrency);
      await Promise.all(batch.map(async (route) => {
        const fid = routeIdToFleetId(route.gtfsId);
        try {
          const d = await fetchFleetDetailRaw(fid);
          if (!d || typeof d !== 'object') return;

          const detail = d as Record<string, unknown>;
          for (const dirKey of ['Go', 'Re']) {
            const dir = detail[dirKey];
            if (!dir || typeof dir !== 'object') continue;
            const dirObj = dir as Record<string, unknown>;
            const stations = dirObj.Station;
            if (!Array.isArray(stations)) continue;

            for (const s of stations) {
              if (typeof s !== 'object' || s === null) continue;
              const st = s as Record<string, unknown>;
              const objectID = String(st.ObjectID ?? st.objectID ?? st.id ?? '');
              if (!objectID) continue;

              const geo = parseGeoString(st.Geo);
              const fleetOver = parseFleetOver(st.FleetOver);

              const routeEntry: StopRoute = {
                gtfsId: `${getEnv('VITE_VIETNAM_ROUTE_ID_PREFIX', 'TB:')}${route.gtfsId}`,
                shortName: route.shortName,
                longName: route.longName,
                mode: 'bus' as TransportMode,
              };

              const existing = stationsById.get(objectID);
              if (existing) {
                if (geo && !existing.geo) existing.geo = geo;
                for (const code of fleetOver) {
                  if (!existing.fleetOver.includes(code)) existing.fleetOver.push(code);
                }
                if (!existing.routes.some((r) => r.gtfsId === route.gtfsId)) {
                  existing.routes.push(routeEntry);
                }
              } else {
                stationsById.set(objectID, {
                  objectID,
                  name: String(st.Name ?? st.name ?? objectID),
                  geo: geo ?? null,
                  fleetOver,
                  routes: [routeEntry],
                });
              }
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
      const fid = routeIdToFleetId(routeId);
      const d = await fetchFleetDetailRaw(fid);
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
      const fid = routeIdToFleetId(routeId);
      const d = await fetchFleetDetailRaw(fid);
      if (!d) continue;
      const detail = d as Record<string, unknown>;
      const list: RoutePattern[] = [];
      for (const dirKey of ['Go', 'Re'] as const) {
        const dir = detail[dirKey];
        if (!dir || typeof dir !== 'object') continue;
        const points = parseGeoList((dir as Record<string, unknown>).Geo);
        if (points.length > 0) {
          list.push({
            gtfsId: routeId,
            name: String(detail.Code ?? detail.code ?? routeId),
            geometry: points,
          });
        }
      }
      patterns.set(routeId, list);
    }
    return patterns;
  },

  fetchStopTimetable: async (_stopId: string): Promise<StopTimetableResult> => {
    // timbus.vn exposes no public timetable endpoint.
    return { departures: [], directions: {} };
  },

  fetchVehicleTrip: async (
    _routeId: string,
    _direction: 1 | 2,
    _operatingDay: string,
    _startTime: string,
  ): Promise<VehicleTrip | null> => {
    // timbus.vn exposes no vehicle-trip endpoint.
    return null;
  },

  fetchStopRoutes: async (_stopId: string): Promise<StopRoute[]> => {
    // timbus.vn exposes no station-to-routes endpoint.
    return [];
  },

  fetchLiveVehiclesAtStation: async (
    _stationId: string,
    _fleetOver: string[],
  ): Promise<LiveVehicleAtStation[]> => {
    // timbus.vn exposes no live-vehicles-at-station endpoint.
    return [];
  },

  parseVehicleMessage: (_topic: string, _payload: Buffer): ParsedVehicle | null => {
    // Vietnam provider has no MQTT live-vehicle feed.
    return null;
  },
};