import type {
  Route, RoutePattern, Stop, StopRoute, VehicleTrip,
  TransportMode,
} from '@/types';
import {
  ParsedVehicle, StopTimetableResult, TransitProvider,
} from '@/lib/provider';
import { stripRouteIdPrefix } from '@/lib/routeId';
import { createCache } from '@/lib/cache';

const getEnv = (name: string, fallback: string): string => {
  return import.meta.env[name] ?? fallback;
};

const API_BASE = getEnv('VITE_VIETNAM_API_BASE', '');
const PROXY_BASE = getEnv('VITE_VIETNAM_PROXY_BASE', '').replace(/\/$/, '');

// timbus.vn endpoints (HTTP). All POST form-urlencoded.
const SEARCH_PATH = 'Search/action.ashx';
const VEHICLE_PATH = 'Vehicle/action.ashx';

const timbusUrl = (path: string): string => (
  PROXY_BASE ? `${PROXY_BASE}/timbus/${path}` : `${API_BASE}/Engine/Business/${path}`
);

const SEARCH_URL = timbusUrl(SEARCH_PATH);
const VEHICLE_URL = timbusUrl(VEHICLE_PATH);

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

  return await response.json();
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
    if (!dt || typeof dt !== 'object') return null;

    const d = dt as Record<string, unknown>;
    fleetCache.writePersistentTimedCacheValue(key, 'dt', d);
    return d;
  } catch {
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
            return routes.sort((a: Route, b: Route) => a.shortName.localeCompare(b.shortName));
          }
        }
      } catch {
        // Fall through to prefix discovery below
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
                gtfsId: route.gtfsId,
                shortName: route.shortName,
                longName: route.longName,
                mode: 'bus',
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
    if (!API_BASE && !PROXY_BASE || routeIds.length === 0) return [];

    const routes: Route[] = [];
    for (const routeId of routeIds) {
      try {
        const fid = routeIdToFleetId(routeId);
        const payload = await postForm(SEARCH_URL, {
          act: 'fleetdetail',
          fid,
        });

        const dt = getDt(payload);
        if (!dt || typeof dt !== 'object') continue;

        const d = dt as Record<string, unknown>;
        routes.push(normalizeVietnamRouteFromDetail(d));
      } catch {
        // Skip individual route failures
      }
    }
    return routes;
  },
  fetchRoutePatterns: async (routeIds: string[]): Promise<Map<string, RoutePattern[]>> => {
    const result = new Map<string, RoutePattern[]>();
    if (!API_BASE && !PROXY_BASE || routeIds.length === 0) return result;

    for (const routeId of routeIds) {
      result.set(routeId, []);
      try {
        const fid = routeIdToFleetId(routeId);
        const d = await fetchFleetDetailRaw(fid);
        if (!d || typeof d !== 'object') continue;

        const detail = d as Record<string, unknown>;
        const patterns: RoutePattern[] = [];

        for (const dirKey of ['Go', 'Re']) {
          const dir = detail[dirKey];
          if (!dir || typeof dir !== 'object') continue;

          const dirObj = dir as Record<string, unknown>;
          const geo = dirObj.Geo;
          const geometry = parseGeoList(geo);

          if (geometry.length > 0) {
            patterns.push({
              gtfsId: routeId,
              name: dirKey === 'Go' ? 'Outbound' : 'Inbound',
              geometry,
            });
          }
        }

        result.set(routeId, patterns);
      } catch {
        // Skip individual route failures
      }
    }
    return result;
  },
  fetchStopTimetable: async (): Promise<StopTimetableResult> => {
    // timbus.vn static API does not expose live departures/ETAs.
    return { departures: [], directions: {} };
  },
  fetchVehicleTrip: async (): Promise<VehicleTrip | null> => {
    // timbus.vn static API does not expose live vehicle trips.
    return null;
  },
  fetchStopRoutes: async (stopId: string): Promise<StopRoute[]> => {
    // Stop-to-routes mapping is populated from fleetdetail station data.
    return [];
  },
  parseVehicleMessage: (): ParsedVehicle | null => {
    // timbus.vn has no MQTT live vehicle GPS feed.
    return null;
  },
  /**
   * Fetch live vehicles approaching a stop (eta/gps).
   *
   * POST act=partremained to Engine/Business/Vehicle/action.ashx.
   * Returns vehicles with license plate, route code, distance remaining (m)
   * and time remaining (s).
   */
  fetchLiveVehiclesAtStation: async (stationId: string, fleetOver: string[]): Promise<Array<{
    vehicleId: string;
    routeCode: string;
    distanceMeters: number;
    etaSeconds: number;
  }>> => {
    if (!API_BASE && !PROXY_BASE) return [];

    try {
      const payload = await postForm(VEHICLE_URL, {
        act: 'partremained',
        State: 'true',
        StationID: stationId,
        FleetOver: fleetOver.join(','),
      });

      const dt = getDt(payload);
      const arr: unknown[] = Array.isArray(dt) ? dt
        : (isRecord(dt) && Array.isArray(dt.Data) ? dt.Data : []);

      return arr
        .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
        .map((v) => ({
          vehicleId: String(v.BienKiemSoat ?? v.bienKiemSoat ?? v.plate ?? v.id ?? ''),
          routeCode: String(v.FleetCode ?? v.fleetCode ?? v.route ?? ''),
          distanceMeters: Number(v.PartRemained ?? v.partRemained ?? v.distance ?? 0) || 0,
          etaSeconds: Number(v.TimeRemained ?? v.timeRemained ?? v.eta ?? 0) || 0,
        }))
        .filter((v) => v.vehicleId.length > 0);
    } catch {
      return [];
    }
  },
};

const normalizeVietnamRoute = (raw: Record<string, unknown>): Route => {
  const objectID = raw.ObjectID ?? raw.objectID ?? raw.id ?? raw.route_id ?? '';
  const shortName = String(
    raw.ShortName ?? raw.short_name ?? raw.route_short_name ??
    raw.Name ?? raw.name ?? '',
  );
  const longName = String(
    raw.LongName ?? raw.long_name ?? raw.route_long_name ??
    raw.Name ?? raw.name ?? '',
  );
  const cost = raw.Cost ?? raw.cost ?? null;

  return {
    gtfsId: `${getEnv('VITE_VIETNAM_ROUTE_ID_PREFIX', 'TB:')}${objectID}`,
    shortName: shortName || String(objectID),
    longName: longName || shortName || String(objectID),
    mode: 'bus',
    ...(cost !== null && cost !== undefined ? { color: undefined } : {}),
  };
};

const normalizeVietnamRouteFromDetail = (d: Record<string, unknown>): Route => {
  const objectID = d.ObjectID ?? d.objectID ?? d.id ?? '';
  const shortName = String(
    d.ShortName ?? d.short_name ?? d.route_short_name ??
    d.Name ?? d.name ?? String(objectID),
  );
  const longName = String(
    d.LongName ?? d.long_name ?? d.route_long_name ??
    d.Name ?? d.name ?? shortName,
  );

  return {
    gtfsId: `${getEnv('VITE_VIETNAM_ROUTE_ID_PREFIX', 'TB:')}${objectID}`,
    shortName: shortName || String(objectID),
    longName: longName || shortName || String(objectID),
    mode: 'bus',
  };
};

const normalizeVietnamStop = (s: {
  objectID: string; name: string; geo: { lat: number; lon: number } | null;
  fleetOver: string[]; routes: StopRoute[];
}): Stop => {
  const gtfsId = `${getEnv('VITE_VIETNAM_ROUTE_ID_PREFIX', 'TB:')}${s.objectID}`;
  const lat = s.geo?.lat ?? 0;
  const lon = s.geo?.lon ?? 0;

  return {
    gtfsId,
    name: s.name || s.objectID,
    code: s.objectID,
    lat,
    lon,
    vehicleMode: 'bus',
    routes: s.routes,
    ...(s.fleetOver.length > 0 ? { fleetOver: s.fleetOver } : {}),
  };
};
