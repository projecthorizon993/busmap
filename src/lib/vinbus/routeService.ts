/**
 * RouteService for the VinBus Maps API.
 *
 * GET /client/route/list
 *   Method: getRoutes(regionCode)
 *
 * GET /client/route/detail
 *   Method: getRouteDetail(routeId, regionCode)
 *
 * GET /client/route/timeline
 *   Method: getRouteTimeline(routeId, regionCode, weekday)
 */

import type {
  BusRoute, RegionCode, RouteDetail, RouteTimeline, Weekday,
} from './models';
import { VinBusHttpClient } from './client';

export class RouteService {
  private readonly client: VinBusHttpClient;

  constructor(client: VinBusHttpClient) {
    this.client = client;
  }

  /**
   * Retrieve available routes for a region.
   *
   * @param regionCode - Region code (e.g. "hcm", "hn").
   * @returns Array of BusRoute objects.
   */
  async getRoutes(regionCode: RegionCode): Promise<BusRoute[]> {
    return (await this.client.get<BusRoute[]>(
      '/client/route/list',
      { regionCode },
    )) ?? [];
  }

  /**
   * Retrieve full route detail including station geometry.
   *
   * @param routeId - Route ID.
   * @param regionCode - Region code.
   * @returns RouteDetail object.
   */
  async getRouteDetail(routeId: string | number, regionCode: RegionCode): Promise<RouteDetail> {
    return this.client.get<RouteDetail>(
      '/client/route/detail',
      { routeId: String(routeId), regionCode },
    );
  }

  /**
   * Retrieve route timetable for a weekday.
   *
   * @param routeId - Route ID.
   * @param regionCode - Region code.
   * @param weekday - 0 = Sunday ... 6 = Saturday.
   * @returns RouteTimeline object.
   */
  async getRouteTimeline(
    routeId: string | number,
    regionCode: RegionCode,
    weekday: Weekday,
  ): Promise<RouteTimeline> {
    return this.client.get<RouteTimeline>(
      '/client/route/timeline',
      { routeId: String(routeId), regionCode, weekday: String(weekday) },
    );
  }
}
