import { useEffect, useCallback, useRef } from 'react';
import type { TrackedVehicle } from '@/types';
import { haversineDistance } from '@/lib';

/** Maximum ETA (seconds) before we consider a bus "near" a stop and notify. */
export const ETA_NOTIFY_THRESHOLD_SECONDS = 100;

/** Minimum speed (m/s) below which we can't estimate arrival. */
export const MIN_SPEED_MPS = 0.5;

/** How often to re-check ETA (ms). */
export const ETA_POLL_MS = 5000;

/**
 * Monitors vehicle positions against nearby user stations and triggers
 * an ETA notification callback when a bus is within ~100s of a stop
 * the user is standing near.
 */
export const useEtaProximityMonitor = (
  vehicles: TrackedVehicle[],
  stops: Array<{ gtfsId: string; name: string; lat: number; lon: number }>,
  userLat: number | null,
  userLng: number | null,
  onNotify: (notification: {
    vehicleId: string; routeShortName: string; stopName: string; etaSeconds: number;
  }) => void,
) => {
  const notifiedRef = useRef<Set<string>>(new Set());

  const checkEta = useCallback(() => {
    if (!userLat || !userLng || stops.length === 0) return;

    for (const vehicle of vehicles) {
      if (vehicle.speed < MIN_SPEED_MPS) continue;

      // Find the nearest stop to this vehicle
      let nearestStop: { gtfsId: string; name: string; lat: number; lon: number } | null = null;
      let nearestDistance = Infinity;

      for (const stop of stops) {
        const d = haversineDistance(vehicle.lat, vehicle.lng, stop.lat, stop.lon);
        if (d < nearestDistance) {
          nearestDistance = d;
          nearestStop = stop;
        }
      }

      if (!nearestStop) continue;

      // Estimate ETA = distance / speed
      const etaSeconds = nearestDistance / vehicle.speed;
      const notificationKey = `${vehicle.vehicleId}-${nearestStop.gtfsId}`;

      if (etaSeconds <= ETA_NOTIFY_THRESHOLD_SECONDS && !notifiedRef.current.has(notificationKey)) {
        notifiedRef.current.add(notificationKey);
        onNotify({
          vehicleId: vehicle.vehicleId,
          routeShortName: vehicle.routeShortName,
          stopName: nearestStop.name,
          etaSeconds: Math.round(etaSeconds),
        });
      }

      // Clear notification once the bus has passed the stop (ETA > threshold again)
      if (etaSeconds > ETA_NOTIFY_THRESHOLD_SECONDS * 1.5) {
        notifiedRef.current.delete(notificationKey);
      }
    }
  }, [vehicles, stops, userLat, userLng, onNotify]);

  useEffect(() => {
    const id = setInterval(checkEta, ETA_POLL_MS);
    checkEta(); // run immediately on mount
    return () => clearInterval(id);
  }, [checkEta]);
};
