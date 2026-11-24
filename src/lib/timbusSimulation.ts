import { haversineDistance } from '@/lib/utils';

export interface SimSnapshot {
  vehicleId: string;
  routeCode: string;
  distanceMeters: number;
  etaSeconds: number;
}

const SIM_VEHICLE_SPEED_MPS = 8; // ~29 km/h city bus

const polylineLengthMeters = (geo: Array<{ lat: number; lon: number }>): number => {
  let len = 0;
  for (let i = 1; i < geo.length; i += 1) {
    len += haversineDistance(geo[i - 1].lat, geo[i - 1].lon, geo[i].lat, geo[i].lon);
  }
  return len;
};

const pointAt = (
  geo: Array<{ lat: number; lon: number }>,
  lengthM: number,
  t: number,
): { lat: number; lon: number } => {
  if (geo.length === 0) return { lat: 0, lon: 0 };
  if (geo.length === 1) return geo[0];

  const target = lengthM * Math.max(0, Math.min(1, t));
  let acc = 0;
  for (let i = 1; i < geo.length; i += 1) {
    const seg = haversineDistance(geo[i - 1].lat, geo[i - 1].lon, geo[i].lat, geo[i].lon);
    if (acc + seg >= target) {
      const frac = seg === 0 ? 0 : (target - acc) / seg;
      return {
        lat: geo[i - 1].lat + (geo[i].lat - geo[i - 1].lat) * frac,
        lon: geo[i - 1].lon + (geo[i].lon - geo[i - 1].lon) * frac,
      };
    }
    acc += seg;
  }
  return geo[geo.length - 1];
};

/**
 * A synthetic bus that moves along real route geometry (Go.Geo / Re.Geo)
 * coordinates, reporting its distance and ETA to a target station.
 * Used as a fallback when timbus.vn has no active buses (off-hours).
 */
export class SimulationBus {
  readonly vehicleId: string;
  readonly routeCode: string;
  private geo: Array<{ lat: number; lon: number }>;
  private readonly lengthM: number;
  private progress: number;
  private readonly stationLat: number;
  private readonly stationLon: number;
  private readonly speedMps: number;

  constructor(
    routeCode: string,
    vehicleId: string,
    geo: Array<{ lat: number; lon: number }>,
    stationLat: number,
    stationLon: number,
    speedMps: number = SIM_VEHICLE_SPEED_MPS,
  ) {
    this.routeCode = routeCode;
    this.vehicleId = vehicleId;
    this.geo = geo;
    this.lengthM = polylineLengthMeters(geo);
    this.progress = 0;
    this.stationLat = stationLat;
    this.stationLon = stationLon;
    this.speedMps = speedMps;
  }

  advance(dtSeconds: number) {
    if (this.lengthM <= 0) return;
    const dist = this.speedMps * dtSeconds;
    this.progress = (this.progress + dist / this.lengthM) % 1;
  }

  snapshot(): SimSnapshot {
    const pos = pointAt(this.geo, this.lengthM, this.progress);
    const distanceMeters = haversineDistance(pos.lat, pos.lon, this.stationLat, this.stationLon);
    const etaSeconds = this.speedMps > 0 ? distanceMeters / this.speedMps : 0;
    return {
      vehicleId: this.vehicleId,
      routeCode: this.routeCode,
      distanceMeters,
      etaSeconds,
    };
  }
}

/**
 * Runs one or more simulation buses per monitored station and emits snapshots
 * on an interval (default 15s), shaped like TimbusLivePoller results.
 */
export class SimulationEngine {
  private buses = new Map<string, SimulationBus[]>();
  private readonly onVehicles: (stationId: string, vehicles: SimSnapshot[]) => void;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private lastTick = Date.now();

  constructor(
    onVehicles: (stationId: string, vehicles: SimSnapshot[]) => void,
    options?: { intervalMs?: number },
  ) {
    this.onVehicles = onVehicles;
    this.intervalMs = options?.intervalMs ?? 15_000;
  }

  setStations(stations: Array<{
    stationId: string;
    routeCode: string;
    geo: Array<{ lat: number; lon: number }>;
    stationLat: number;
    stationLon: number;
  }>) {
    this.buses = new Map();
    for (const s of stations) {
      const bus = new SimulationBus(
        s.routeCode,
        `sim-${s.stationId}-${s.routeCode}`,
        s.geo,
        s.stationLat,
        s.stationLon,
      );
      const arr = this.buses.get(s.stationId) ?? [];
      arr.push(bus);
      this.buses.set(s.stationId, arr);
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTick = Date.now();
    this.tick();
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private tick() {
    if (!this.running) return;
    const now = Date.now();
    const dtSeconds = (now - this.lastTick) / 1000;
    this.lastTick = now;

    for (const [stationId, buses] of this.buses) {
      const snapshots: SimSnapshot[] = [];
      for (const bus of buses) {
        bus.advance(dtSeconds);
        snapshots.push(bus.snapshot());
      }
      this.onVehicles(stationId, snapshots);
    }

    this.timer = setTimeout(() => this.tick(), this.intervalMs);
  }
}
