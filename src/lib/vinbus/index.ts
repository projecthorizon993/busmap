/**
 * VinBus Maps API integration barrel exports.
 *
 * Modules:
 *   - client: VinBusHttpClient (reusable HTTP client with decryption)
 *   - decoder: decryptMessage, fetchAndDecrypt, VinBusApiError
 *   - models: Typed data models (Region, BusRoute, RouteDetail, etc.)
 *   - regionService: RegionService
 *   - routeService: RouteService
 *   - stationService: StationService
 *   - systemService: SystemService
 *   - tileProvider: Raster map tile provider
 */

export type {
  RegionCode, VehicleType, RouteDirection, Weekday,
  VinBusBase, Region, BusRoute, RouteStation, RouteDetail,
  RouteTimeline, BusStation, StationDetail, StationRoute,
  BusArrival, BusDetail, SystemStore,
  NavigationResult, NavigationDetail, NavigationShortItem,
  NotFoundError,
} from './models';

export type { TileCoord, TileLoadResult } from './tileProvider';

export {
  decryptMessage, fetchAndDecrypt, VinBusApiError,
} from './decoder';

export {
  VinBusHttpClient, VINBUS_API_BASE, DEFAULT_TIMEOUT_MS,
  type VinBusClientConfig,
} from './client';

export { RegionService } from './regionService';
export { RouteService } from './routeService';
export { StationService } from './stationService';
export { SystemService } from './systemService';

export {
  tileUrl, tileKey, loadTile, tilesForBounds,
  clearTileCache, getTileCacheSize,
} from './tileProvider';
