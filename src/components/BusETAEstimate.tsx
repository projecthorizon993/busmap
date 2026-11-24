/**
 * BusETAEstimate - map overlay showing an estimated bus position with ETA loading bar.
 *
 * Used when live GPS coordinates are unavailable (VinBus API). The bus position is
 * estimated from ETA/distance data and interpolated along the route polyline.
 */

import { useRef } from 'react';
import { Marker } from 'react-map-gl/maplibre';
import type { BusETAEstimate as BusETAEstimateType } from '@/lib/vinbus/busPositionEstimator';

interface BusETAEstimateProps {
  estimate: BusETAEstimateType;
}

export const BusETAEstimate: React.FC<BusETAEstimateProps> = ({
  estimate,
}) => {
  const markerRef = useRef<HTMLDivElement>(null);

  const minutes = Math.floor(estimate.etaSeconds / 60);
  const seconds = estimate.etaSeconds % 60;
  const etaText = minutes > 0
    ? `${minutes}'${seconds.toString().padStart(2, '0')}"`
    : `${seconds}"`;

  return (
    <Marker
      key={estimate.busId}
      longitude={estimate.estimatedLng}
      latitude={estimate.estimatedLat}
      anchor="bottom"
    >
      <div
        ref={markerRef}
        className="w-48 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 p-2"
      >
        {/* Route badge */}
        <div
          className="flex items-center gap-1.5 mb-1"
          style={{
            backgroundColor: estimate.color,
            color: 'white',
            padding: '2px 6px',
            borderRadius: '4px',
            fontSize: '11px',
            fontWeight: '600',
            display: 'inline-block',
          }}
        >
          {estimate.routeNo}
        </div>

        {/* ETA loading bar */}
        <div className="mb-1">
          <div className="flex justify-between text-[10px] text-gray-600 dark:text-gray-400 mb-0.5">
            <span>ETA</span>
            <span>{etaText}</span>
          </div>
          <div className="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 transition-all duration-500 ease-out"
              style={{
                width: `${Math.min(100, Math.max(0, estimate.progressPercent))}%`,
              }}
            />
          </div>
        </div>

        {/* Stop name */}
        <div className="text-[10px] text-gray-700 dark:text-gray-300 truncate">
          {estimate.stopName}
        </div>
      </div>
    </Marker>
  );
};

export default BusETAEstimate;
