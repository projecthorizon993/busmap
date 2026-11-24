/**
 * StationService for the VinBus Maps API.
 *
 * GET /client/station/near
 *   Method: getNearbyStations(lat, lng, radius, regionCode)
 *
 * GET /client/station/detail
 *   Method: getStationDetail(stationId, regionCode)
 *
 * GET /client/station/estimate_bus_to_station
 *   Method: getEstimatedArrivals(stationId, regionCode, group, isInternalStation)
 *
 * GET /client/station/bus_detail
 *   Method: getBusDetail(stationId, routeId, busId, regionCode)
 *
 * NOTE: /client/station/bus_detail returned HTTP 404 for some captured
 * combinations. Handle missing data gracefully.
 */

import type {
  RegionCode, BusStation, StationDetail, BusArrival, BusDetail,
} from './models';
import { VinBusHttpClient } from './client';
import { VinBusApiError } from './decoder';

export class StationService {
  private readonly client: VinBusHttpClient;

  constructor(client: VinBusHttpClient) {
    this.client = client;
  }

  /**
   * Retrieve nearby stations around a map position.
   *
   * @param lat - Latitude of the search center.
   * @param lng - Longitude of the search center.
   * @param radius - Search radius in meters.
   * @param regionCode - Region code.
   * @returns Array of BusStation objects.
   */
  async getNearbyStations(
    lat: number,
    lng: number,
    radius: number,
    regionCode: RegionCode,
  ): Promise<BusStation[]> {
    return (await this.client.get<BusStation[]>(
      '/client/station/near',
      { lat: String(lat), lng: String(lng), r: String(radius), regionCode },
    )) ?? [];
  }

  /**
   * Retrieve station details.
   *
   * @param stationId - Station ID.
   * @param regionCode - Region code.
   * @returns StationDetail object.
   */
  async getStationDetail(
    stationId: string | number,
    regionCode: RegionCode,
  ): Promise<StationDetail> {
    return this.client.get<StationDetail>(
      '/client/station/detail',
      { stationId: String(stationId), regionCode },
    );
  }

  /**
   * Retrieve estimated bus arrivals at a station.
   *
   * @param stationId - Station ID.
   * @param regionCode - Region code.
   * @param group - Group parameter (observed value: 1).
   * @param isInternalStation - Whether the station is internal (observed value: 0).
   * @returns Array of BusArrival objects.
   */
  async getEstimatedArrivals(
    stationId: string | number,
    regionCode: RegionCode,
    group: number | string = 1,
    isInternalStation: number | string = 0,
  ): Promise<BusArrival[]> {
    return (await this.client.get<BusArrival[]>(
      '/client/station/estimate_bus_to_station',
      {
        regionCode,
        stationId: String(stationId),
        group: String(group),
        isInternalStation: String(isInternalStation),
      },
    )) ?? [];
  }

  /**
   * Retrieve bus detail at a station.
   *
   * NOTE: This endpoint returned HTTP 404 for some captured combinations.
   * Callers should catch VinBusApiError with status 404 and handle gracefully.
   *
   * @param stationId - Station ID.
   * @param routeId - Route ID.
   * @param busId - Bus ID.
   * @param regionCode - Region code.
   * @returns BusDetail object, or null on 404.
   */
  async getBusDetail(
    stationId: string | number,
    routeId: string | number,
    busId: string | number,
    regionCode: RegionCode,
  ): Promise<BusDetail | null> {
    try {
      return await this.client.get<BusDetail>(
        '/client/station/bus_detail',
        {
          regionCode,
          stationId: String(stationId),
          routeId: String(routeId),
          busId: String(busId),
        },
      );
    } catch (err) {
      if (err instanceof VinBusApiError) {
        if (err.status === 404) {
          return null;
        }
      }
      throw err;
    }
  }
}
