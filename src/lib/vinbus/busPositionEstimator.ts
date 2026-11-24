/**
 * Estimate a bus position along a route polyline using ETA/distance data
 * from the VinBus `estimate_bus_to_station` endpoint.
 *
 * The API returns `distance` (meters remaining to the stop) and `time` (ETA seconds).
 * We place the bus on the route polyline at that distance before the target stop,
 * working backwards along the geometry.
 */

import { haversineDistance } from '@/lib';

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
  /** Estimated bus position on the route */
  estimatedLat: number;
  estimatedLng: number;
  /** Progress along route from start to target stop (0-100) */
  progressPercent: number;
  /** Whether the bus has arrived (ETA <= 0) */
  hasArrived: boolean;
}

/** Total distance along a polyline in meters. */
function polylineDistance(points: RoutePoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineDistance(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
  }
  return total;
}

/** Find the point on a polyline that is `d` meters from the end, working backwards. */
function pointAtDistanceFromEnd(points: RoutePoint[], dFromEnd: number): RoutePoint | null {
  if (points.length === 0) return null;
  if (dFromEnd <= 0) return { ...points[points.length - 1] };

  let accumulated = 0;
  for (let i = points.length - 1; i > 0; i--) {
    const seg = haversineDistance(points[i].lat, points[i].lon, points[i - 1].lat, points[i - 1].lon);
    if (accumulated + seg >= dFromEnd) {
      const remaining = dFromEnd - accumulated;
      const ratio = seg > 0 ? remaining / seg : 0;
      // Interpolate from points[i] toward points[i-1]
      return {
        lat: points[i].lat + (points[i - 1].lat - points[i].lat) * ratio,
        lon: points[i].lon + (points[i - 1].lon - points[i].lon) * ratio,
      };
    }
    accumulated += seg;
  }
  return { ...points[0] };
}

/**
 * Estimate bus position on a route given distance remaining to a target stop.
 *
 * @param routeGeometry - Ordered route polyline points (start → end)
 * @param distanceToStopMeters - Meters remaining to the target stop (from API `distance`)
 * @param targetStopLat - Target stop latitude
 * @param targetStopLng - Target stop longitude
 * @returns Estimated bus position and progress, or null if geometry is empty
 */
export function estimateBusPositionOnRoute(
  routeGeometry: RoutePoint[],
  distanceToStopMeters: number,
): { lat: number; lng: number; progressPercent: number } | null {
  if (routeGeometry.length === 0) return null;

  const totalDist = polylineDistance(routeGeometry);
  if (totalDist === 0) return null;

  // Clamp distance to route length
  const remaining = Math.min(Math.max(0, distanceToStopMeters), totalDist);
  const traveled = totalDist - remaining;

  const position = pointAtDistanceFromEnd(routeGeometry, remaining);
  if (!position) return null;

  const progressPercent = Math.min(100, Math.max(0, (traveled / totalDist) * 100));

  return { lat: position.lat, lng: position.lon, progressPercent };
}

/**
 * Parse raw `estimate_bus_to_station` list items into BusETAEstimate objects.
 * Requires route geometry to estimate position.
 */
export function parseBusETAList(
  rawList: unknown[],
  routeGeometry: RoutePoint[],
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
    const distanceToStopMeters = Number(it.distance ?? 0) || 0;
    const etaSeconds = Number(it.time ?? 0) || 0;
    const speedMps = Number(it.speed ?? 0) || 0;

    const pos = estimateBusPositionOnRoute(routeGeometry, distanceToStopMeters);
    const estimatedLat = pos?.lat ?? targetStopLat;
    const estimatedLng = pos?.lng ?? targetStopLng;
    const progressPercent = pos?.progressPercent ?? 0;

    estimates.push({
      busId,
      vehicleNumber,
      routeNo,
      routeName,
      color,
      distanceToStopMeters,
      etaSeconds,
      speedMps,
      stopLat: targetStopLat,
      stopLng: targetStopLng,
      stopName: targetStopName,
      estimatedLat,
      estimatedLng,
      progressPercent,
      hasArrived: etaSeconds <= 0,
    });
  }

  return estimates;
}
