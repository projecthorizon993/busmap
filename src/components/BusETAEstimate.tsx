/**
 * BusETAEstimate - map overlay showing an estimated bus position with ETA loading bar.
 *
 * Used when live GPS coordinates are unavailable (VinBus API). The bus position is
 * estimated from ETA/distance data and interpolated along the route polyline.
 */

import { useEffect, useRef } from 'react';
import { Marker } from 'react-map-gl/maplibre';
import type { MapRef } from 'react-map-gl/maplibre';
import type { BusETAEstimate as BusETAEstimateType } from '@/lib/vinbus/busPositionEstimator';

interface BusETAEstimateProps {
  estimate: BusETAEstimateType;
}

export const BusETAEstimate: React.FC<BusETAEstimateProps> = ({
  estimate,
}) => {
  const minutes = Math.floor(estimate.etaSeconds / 60);
  const seconds = estimate.etaSeconds % 60;
  const etaText = minutes > 0
    ? `${minutes}'${seconds.toString().padStart(2, '0')}"`
    : `${seconds}"`;

  const isLive = estimate.isLiveData;
  const progress = estimate.progressPercent;

  return (
    <Marker
      key={estimate.busId}
      longitude={estimate.estimatedLng}
      latitude={estimate.estimatedLat}
      anchor="bottom"
    >
      <div
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
              className="h-full transition-all duration-500 ease-out"
              style={{
                width: `${Math.min(100, Math.max(0, progress))}%`,
                backgroundColor: isLive ? '#3b82f6' : '#f59e0b', // Blue = live GPS, Amber = scheduled
              }}
            />
          </div>
        </div>

        {/* Stop name + status */}
        <div className="flex items-start gap-2">
          <div className="text-[10px] text-gray-700 dark:text-gray-300 truncate">
            {estimate.stopName}
          </div>
          <div className="text-[10px] text-amber-600 dark:text-amber-300 font-bold truncate">
            {estimate.infoText || (isLive ? 'Live' : 'Scheduled')}
          </div>
        </div>
      </div>
    </Marker>
  );
};

export default BusETAEstimate;
