/**
 * Typed data models for the VinBus Maps API.
 *
 * These models are derived from observed decrypted API responses. Fields that
 * appear in responses are typed; fields not yet observed are omitted rather
 * than invented. Unknown fields are preserved via the optional `raw` record
 * on models where round-tripping is important.
 *
 * NOTE: Response envelopes differ between endpoints. Some return arrays
 * directly, others return objects. Each service method documents its shape.
 */

/** Region code used to scope all VinBus API requests. */
export type RegionCode = string;

/** VinBus vehicle/route type codes observed in the frontend. */
export type VehicleType =
  | 0 // VINBUS
  | 1 // CITYBUS
  | 2 // MRT
  | 3 // BTS
  | 4 // BRT
  | 100 // WALK
  | 101; // WATER

/** Direction codes observed in the frontend. */
export type RouteDirection = 0 | 1; // BACKWARD | FORWARD

/** Weekday: 0 = Sunday ... 6 = Saturday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Base shape for objects that may carry extra undeclared fields. */
export interface VinBusBase {
  /** Preserve undeclared fields from the API response. */
  readonly [key: string]: unknown;
}

/**
 * Region returned by GET /client/route/regions.
 */
export interface Region extends VinBusBase {
  readonly id: number;
  readonly code: RegionCode;
  readonly countryId: number | null;
  readonly title: string;
  readonly titleEn: string;
  readonly description: string | null;
  readonly descriptionEn: string | null;
  readonly imageUrl: string;
  /** "west,south,east,north" bounding box string. */
  readonly region: string;
  /** "lon,lat" center point string. */
  readonly centralPoint: string;
  readonly allowBuyTicket: boolean;
}

/**
 * Bus route summary returned by GET /client/route/list.
 */
export interface BusRoute extends VinBusBase {
  readonly id: number | string;
  readonly routeNo: string;
  readonly routeName: string;
  readonly routeType: VehicleType;
  readonly isInternalRoute?: boolean;
  readonly iconUrl?: string;
}

/**
 * Route detail returned by GET /client/route/detail.
 */
export interface RouteStation {
  readonly stationId: number | string;
  readonly stationName: string;
  readonly stationAddress: string;
  readonly lat: number;
  readonly lng: number;
  readonly stationDirection: RouteDirection;
  readonly stationOrder: number;
  /** Space-separated "lon,lat" pairs (observed in route polyline rendering). */
  readonly pathPoints?: string;
}

export interface RouteDetail extends VinBusBase {
  readonly id: number | string;
  readonly routeNo: string;
  readonly routeName: string;
  readonly routeType: VehicleType;
  readonly stations: RouteStation[];
  readonly direction?: RouteDirection;
  readonly normalTicket?: string;
  /** Preserve additional fields from the response. */
  readonly [key: string]: unknown;
}

/**
 * Route timeline (timetable) returned by GET /client/route/timeline.
 * Shape inferred from usage: passed to setTimeline(f).
 */
export interface RouteTimeline extends VinBusBase {
  readonly [key: string]: unknown;
}

/**
 * Bus station returned by GET /client/station/near.
 */
export interface BusStation extends VinBusBase {
  readonly stationId: number | string;
  readonly stationName: string;
  readonly stationAddress: string;
  readonly lat: number;
  readonly lng: number;
  readonly stationType?: number;
  readonly distance?: number;
  readonly stationDirection?: RouteDirection;
  readonly stationOrder?: number;
}

/**
 * Station detail returned by GET /client/station/detail.
 */
export interface StationDetail extends VinBusBase {
  readonly stationId: number | string;
  readonly stationInfo?: BusStation;
  readonly allRouteThroughStation?: StationRoute[];
}

/** Route passing through a station. */
export interface StationRoute extends VinBusBase {
  readonly class?: string;
  readonly rightIconUrl?: string;
  readonly routeId?: number | string;
  readonly routeNo?: string;
  readonly routeName?: string;
}

/**
 * Estimated bus arrival returned by GET /client/station/estimate_bus_to_station.
 */
export interface BusArrival extends VinBusBase {
  readonly [key: string]: unknown;
}

/**
 * Bus detail returned by GET /client/station/bus_detail (may 404).
 */
export interface BusDetail extends VinBusBase {
  readonly [key: string]: unknown;
}

/**
 * System store / ticket store returned by GET /client/system/stores.
 */
export interface SystemStore extends VinBusBase {
  readonly id: number | string;
  readonly title: string;
  readonly address: string;
  readonly lat?: number;
  readonly lng?: number;
  readonly distance?: number;
}

/** Navigation result from POST /client/navigation. */
export interface NavigationResult extends VinBusBase {
  readonly class?: string;
  readonly cost?: number | string;
  readonly navigation: NavigationDetail[];
  readonly shortList?: NavigationShortItem[];
}

export interface NavigationDetail extends VinBusBase {
  readonly class?: string;
}

export interface NavigationShortItem extends VinBusBase {
  readonly busStation?: { readonly stationId: number | string };
  readonly busRoute?: { readonly routeId: number | string; readonly isInternalRoute?: boolean };
}

/** Error shape for endpoints that may return HTTP 404. */
export interface NotFoundError {
  readonly status: 404;
  readonly message: string;
}
