/**
 * Estimate bus position and ETA from VinBus `estimate_bus_to_station` API response.
 *
 * The API returns vehicles with:
 * - speed: -1 means no live GPS data (scheduled only)
 * - status: Time string like "21:36 " (scheduled departure time)
 * - info: Status text like "Last trip"
 * - vehicleNumber: Actually shows " Expected time " text
 *
 * We parse the status time into ETA seconds and place the bus at the stop location
 * since we don't have real GPS coordinates.
 */

export interface RoutePoint {
  lat: number;
  lon: number;
}

export interface BusETAEstimate {
  busId: string;
  vehicleNumber: string;
  routeNo: string;
  routeName: string;
  color: string;
  distanceToStopMeters: number;
  etaSeconds: number;
  speedMps: number;
  stopLat: number;
  stopLng: number;
  stopName: string;
  estimatedLat: number;
  estimatedLng: number;
  progressPercent: number;
  hasArrived: boolean;
  isLiveData: boolean;      // true if speed >= 0 (real GPS data)
  statusText: string;       // Raw status string like "21:36 "
  infoText: string;         // Info text like "Last trip"
}

/** Parse a time string like "21:36 " into seconds from now */
function parseETASeconds(timeStr: string): number {
  if (!timeStr || typeof timeStr !== 'string') return -1;

  const match = timeStr.trim().match(/(\d{1,2}):(\d{2})/);
  if (!match) return -1;

  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);

  const now = new Date();
  const target = new Date();
  target.setHours(hours, minutes, 0, 0);

  // If target time already passed today, assume tomorrow
  if (target <= now) {
    target.setDate(target.getDate() + 1);
  }

  const diffMs = target.getTime() - now.getTime();
  return Math.max(0, Math.floor(diffMs / 1000));
}

export function parseBusETAList(
  rawList: unknown[],
  routeGeometry: unknown[],
  targetStopLat: number,
  targetStopLng: number,
  targetStopName: string,
): BusETAEstimate[] {
  const estimates: BusETAEstimate[] = [];

  for (const item of rawList) {
    if (typeof item !== 'object' || item === null) continue;
    const it = item as Record<string, unknown>;

    const busId = String(it.busId ?? it.vehicleId ?? it.id ?? '');
    const vehicleNumber = String(it.vehicleNumber ?? it.busId ?? '');
    const routeNo = String(it.routeNo ?? '');
    const routeName = String(it.routeName ?? '');
    const color = String(it.color ?? '#3b82f6');
    const speedMps = Number(it.speed ?? -1);
    const apiTime = Number(it.time ?? NaN);
    const etaSeconds = Number.isFinite(apiTime) && apiTime >= 0
      ? apiTime
      : parseETASeconds(String(it.status ?? ''));
    const statusText = String(it.status ?? '');
    const infoText = String(it.info ?? '');
    const isLiveData = speedMps >= 0;

    // If no live GPS data, place bus at the stop location
    // If we have route geometry, place at start of route (beginning of journey)
    let estimatedLat = targetStopLat;
    let estimatedLng = targetStopLng;
    let progressPercent = 0;

    if (routeGeometry && Array.isArray(routeGeometry) && routeGeometry.length > 0) {
      const firstPoint = routeGeometry[0] as Record<string, unknown>;
      if (firstPoint) {
        estimatedLat = Number(firstPoint.lat ?? targetStopLat);
        estimatedLng = Number(firstPoint.lon ?? targetStopLng);
        progressPercent = 0; // At start of route
      }
    }

    estimates.push({
      busId,
      vehicleNumber,
      routeNo,
      routeName,
      color,
      distanceToStopMeters: 0,
      etaSeconds,
      speedMps,
      stopLat: targetStopLat,
      stopLng: targetStopLng,
      stopName: targetStopName,
      estimatedLat,
      estimatedLng,
      progressPercent,
      hasArrived: etaSeconds <= 0,
      isLiveData,
      statusText,
      infoText,
    });
  }

  return estimates;
}
