/**
 * RegionService for the VinBus Maps API.
 *
 * GET /client/route/regions
 *   Method: getRegions()
 *
 * Returns the list of available regions (e.g. Ho Chi Minh City, Hanoi, etc.).
 * The response is a decrypted JSON array of Region objects.
 */

import type { Region } from './models';
import { VinBusHttpClient } from './client';

export class RegionService {
  private readonly client: VinBusHttpClient;

  constructor(client: VinBusHttpClient) {
    this.client = client;
  }

  /**
   * Retrieve available regions.
   *
   * @returns Array of Region objects.
   */
  async getRegions(): Promise<Region[]> {
    return (await this.client.get<Region[]>('/client/route/regions')) ?? [];
  }
}
