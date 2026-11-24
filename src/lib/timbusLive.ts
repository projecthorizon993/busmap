import { vietnamProvider } from '@/lib/providers/vietnam';
import { getProvider } from '@/lib/provider';

export interface LiveVehicle {
  vehicleId: string;
  routeCode: string;
  distanceMeters: number;
  etaSeconds: number;
}

export interface MonitoredStation {
  stationId: string;
  name: string;
  lat: number;
  lon: number;
  fleetOver: string[];
}

/**
 * Polls the timbus.vn live vehicle/ETA endpoint (act=partremained) for a set of
 * monitored stations on a fixed interval (default 15s).
 *
 * Only active when the vietnam provider is selected. Failures for an individual
 * station never kill the poller.
 */
export class TimbusLivePoller {
  private stations = new Map<string, MonitoredStation>();
  private readonly onVehicles: (stationId: string, vehicles: LiveVehicle[]) => void;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(onVehicles: (stationId: string, vehicles: LiveVehicle[]) => void, options?: { intervalMs?: number }) {
    this.onVehicles = onVehicles;
    this.intervalMs = options?.intervalMs ?? 15_000;
  }

  isVietnam(): boolean {
    return getProvider().id === 'vietnam';
  }

  setStations(stations: MonitoredStation[]) {
    this.stations = new Map(stations.map((s) => [s.stationId, s]));
  }

  addStation(station: MonitoredStation) {
    this.stations.set(station.stationId, station);
  }

  removeStation(stationId: string) {
    this.stations.delete(stationId);
  }

  start() {
    if (this.running) return;
    this.running = true;
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

    const stations = Array.from(this.stations.values());
    let pending = stations.length;

    if (pending === 0) {
      this.scheduleNext();
      return;
    }

    const done = () => {
      pending -= 1;
      if (pending <= 0) {
        this.scheduleNext();
      }
    };

    for (const station of stations) {
      void this.fetchStation(station).then((vehicles) => {
        this.onVehicles(station.stationId, vehicles);
        done();
      }).catch(() => {
        this.onVehicles(station.stationId, []);
        done();
      });
    }
  }

  private async fetchStation(station: MonitoredStation): Promise<LiveVehicle[]> {
    if (!this.isVietnam()) return [];
    const vehicles = await vietnamProvider.fetchLiveVehiclesAtStation(station.stationId, station.fleetOver);
    return vehicles;
  }

  private scheduleNext() {
    if (!this.running) return;
    this.timer = setTimeout(() => this.tick(), this.intervalMs);
  }
}
