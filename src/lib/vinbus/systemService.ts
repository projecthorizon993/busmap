/**
 * SystemService for the VinBus Maps API.
 *
 * GET /client/system/stores
 *   Method: getStores(regionCode)
 */

import type { RegionCode, SystemStore } from './models';
import { VinBusHttpClient } from './client';

export class SystemService {
  private readonly client: VinBusHttpClient;

  constructor(client: VinBusHttpClient) {
    this.client = client;
  }

  /**
   * Retrieve ticket stores for a region.
   *
   * @param regionCode - Region code.
   * @returns Array of SystemStore objects.
   */
  async getStores(regionCode: RegionCode): Promise<SystemStore[]> {
    return (await this.client.get<SystemStore[]>(
      '/client/system/stores',
      { regionCode },
    )) ?? [];
  }
}
