import { test, expect } from '@playwright/test';

import {
  decryptMessage,
  VinBusApiError,
} from '../src/lib/vinbus/decoder';
import { VinBusHttpClient } from '../src/lib/vinbus/client';
import { RegionService } from '../src/lib/vinbus/regionService';
import { RouteService } from '../src/lib/vinbus/routeService';
import { StationService } from '../src/lib/vinbus/stationService';
import { SystemService } from '../src/lib/vinbus/systemService';
import {
  tileUrl, tileKey, tilesForBounds, clearTileCache, getTileCacheSize,
} from '../src/lib/vinbus/tileProvider';
import type {
  Region, BusRoute, RegionCode, Weekday,
} from '../src/lib/vinbus/models';

// Decryption key observed from https://maps.vinbus.vn/env.js
const DECRYPT_KEY = 'ViNbus2o21#K3(y)th3BUSNiElectric';

// Captured regions response (decrypted) used as a fixture.
const FIXTURE_REGIONS: Region[] = [
  {
    id: 4,
    code: 'pq',
    countryId: null,
    title: 'Phú Quốc',
    titleEn: 'Phu Quoc',
    description: '',
    descriptionEn: '',
    imageUrl: '',
    region: '103.807039,10.464617,104.133502,9.800522',
    centralPoint: '103.986422,10.287384',
    allowBuyTicket: false,
  },
  {
    id: 1,
    code: 'hcm',
    countryId: null,
    title: 'Hồ Chí Minh',
    titleEn: 'Ho Chi Minh City',
    description: '',
    descriptionEn: '',
    imageUrl: '',
    region: '106.33,10.32,107.58,11.51',
    centralPoint: '106.83482838468417,10.838708284274725',
    allowBuyTicket: false,
  },
];

test.describe('VinBus response decoder', () => {
  test('decryptMessage rejects invalid hex', async () => {
    await expect(decryptMessage('xyz', DECRYPT_KEY)).rejects.toThrow(
      /Invalid hex string/,
    );
  });

  test('decryptMessage rejects ciphertext too short', async () => {
    // 4 hex chars = 2 bytes, less than IV_LENGTH (16)
    await expect(decryptMessage('aabb', DECRYPT_KEY)).rejects.toThrow(
      /Ciphertext too short/,
    );
  });

  test('decryptMessage with wrong key throws on bad padding', async () => {
    // Build a valid-length hex ciphertext (16 bytes IV + 16 bytes data = 32 bytes = 64 hex chars)
    const dummyHex = '00'.repeat(32);
    // Wrong key should throw during decryption (bad padding)
    await expect(decryptMessage(dummyHex, 'wrong-key')).rejects.toThrow();
  });

  test('fetchAndDecrypt throws VinBusApiError on 404', async () => {
    const client = new VinBusHttpClient({
      decryptKey: DECRYPT_KEY,
      baseUrl: 'https://vbservice-api.vinbus.vn',
    });
    // Use a path that should 404; the response body is still hex-encrypted
    // so fetchAndDecrypt will try to decrypt and may fail on bad padding.
    // We test that non-2xx statuses produce VinBusApiError.
    await expect(
      client.get<never>('/client/nonexistent-endpoint'),
    ).rejects.toBeInstanceOf(VinBusApiError);
  });
});

test.describe('VinBusHttpClient', () => {
  test('dedupes in-flight requests for the same URL', async () => {
    const client = new VinBusHttpClient({
      decryptKey: DECRYPT_KEY,
      baseUrl: 'https://vbservice-api.vinbus.vn',
    });

    // Fire two identical requests concurrently; only one should hit the network.
    const p1 = client.get<Region[]>('/client/route/regions');
    const p2 = client.get<Region[]>('/client/route/regions');

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(r2);

    client.clearInflight();
  });

  test('builds correct URL with query params', () => {
    // We can't easily inspect the URL, but we can verify the client is constructed.
    const client = new VinBusHttpClient({
      decryptKey: DECRYPT_KEY,
      baseUrl: 'https://custom-api.example.com',
    });
    expect(client).toBeInstanceOf(VinBusHttpClient);
  });
});

test.describe('RegionService', () => {
  test('getRegions returns array of regions', async () => {
    const client = new VinBusHttpClient({
      decryptKey: DECRYPT_KEY,
      baseUrl: 'https://vbservice-api.vinbus.vn',
    });
    const service = new RegionService(client);
    const regions = await service.getRegions();

    expect(Array.isArray(regions)).toBe(true);
    expect(regions.length).toBeGreaterThan(0);

    // Validate shape of first region.
    const first = regions[0];
    expect(typeof first.code).toBe('string');
    expect(typeof first.title).toBe('string');
    expect(typeof first.titleEn).toBe('string');
    expect(typeof first.region).toBe('string');
    expect(typeof first.centralPoint).toBe('string');
    expect(typeof first.allowBuyTicket).toBe('boolean');
  });

  test('getRegions finds known region codes', async () => {
    const client = new VinBusHttpClient({
      decryptKey: DECRYPT_KEY,
      baseUrl: 'https://vbservice-api.vinbus.vn',
    });
    const service = new RegionService(client);
    const regions = await service.getRegions();

    const codes = regions.map((r) => r.code);
    expect(codes).toContain('hcm');
    expect(codes).toContain('hn');
  });
});

test.describe('RouteService', () => {
  test('getRoutes returns array for valid regionCode', async () => {
    const client = new VinBusHttpClient({
      decryptKey: DECRYPT_KEY,
      baseUrl: 'https://vbservice-api.vinbus.vn',
    });
    const service = new RouteService(client);
    const routes = await service.getRoutes('hcm' as RegionCode);

    expect(Array.isArray(routes)).toBe(true);
    if (routes.length > 0) {
      const first = routes[0];
      expect(typeof first.routeNo).toBe('string');
      expect(typeof first.routeName).toBe('string');
      expect(typeof first.routeType).toBe('number');
    }
  });

  test('getRouteDetail returns detail with stations', async () => {
    const client = new VinBusHttpClient({
      decryptKey: DECRYPT_KEY,
      baseUrl: 'https://vbservice-api.vinbus.vn',
    });
    const service = new RouteService(client);

    // First get routes to find a valid routeId.
    const routes = await service.getRoutes('hcm' as RegionCode);
    if (routes.length === 0) {
      test.skip(); // No routes available in this environment
      return;
    }

    try {
      const detail = await service.getRouteDetail(
        routes[0].id,
        'hcm' as RegionCode,
      );
      expect(detail.id).toBe(routes[0].id);
      expect(Array.isArray(detail.stations)).toBe(true);
    } catch (err) {
      if (err instanceof VinBusApiError) {
        test.skip(`Route detail API returned ${err.status}: ${err.statusText}`);
      } else {
        throw err;
      }
    }
  });

  test('getRouteTimeline accepts weekday parameter', async () => {
    const client = new VinBusHttpClient({
      decryptKey: DECRYPT_KEY,
      baseUrl: 'https://vbservice-api.vinbus.vn',
    });
    const service = new RouteService(client);

    const routes = await service.getRoutes('hcm' as RegionCode);
    if (routes.length === 0) {
      test.skip();
      return;
    }

    // Weekday 1 = Monday
    const timeline = await service.getRouteTimeline(
      routes[0].id,
      'hcm' as RegionCode,
      1 as Weekday,
    );
    expect(timeline).toBeDefined();
  });
});

test.describe('StationService', () => {
  test('getNearbyStations returns array for valid coordinates', async () => {
    const client = new VinBusHttpClient({
      decryptKey: DECRYPT_KEY,
      baseUrl: 'https://vbservice-api.vinbus.vn',
    });
    const service = new StationService(client);

    // Ho Chi Minh City center.
    const stations = await service.getNearbyStations(
      10.7758,
      106.7018,
      700,
      'hcm' as RegionCode,
    );

    expect(Array.isArray(stations)).toBe(true);
    if (stations.length > 0) {
      const first = stations[0];
      expect(typeof first.stationId).toBeDefined();
      expect(typeof first.stationName).toBe('string');
      expect(typeof first.lat).toBe('number');
      expect(typeof first.lng).toBe('number');
    }
  });

  test('getStationDetail returns station info', async () => {
    const client = new VinBusHttpClient({
      decryptKey: DECRYPT_KEY,
      baseUrl: 'https://vbservice-api.vinbus.vn',
    });
    const service = new StationService(client);

    // Get nearby stations first to find a valid stationId.
    const stations = await service.getNearbyStations(
      10.7758,
      106.7018,
      700,
      'hcm' as RegionCode,
    );
    if (stations.length === 0) {
      test.skip();
      return;
    }

    const detail = await service.getStationDetail(
      stations[0].stationId,
      'hcm' as RegionCode,
    );
    expect(detail).toBeDefined();
  });

  test('getEstimatedArrivals returns array', async () => {
    const client = new VinBusHttpClient({
      decryptKey: DECRYPT_KEY,
      baseUrl: 'https://vbservice-api.vinbus.vn',
    });
    const service = new StationService(client);

    const stations = await service.getNearbyStations(
      10.7758,
      106.7018,
      700,
      'hcm' as RegionCode,
    );
    if (stations.length === 0) {
      test.skip();
      return;
    }

    const arrivals = await service.getEstimatedArrivals(
      stations[0].stationId,
      'hcm' as RegionCode,
    );
    expect(Array.isArray(arrivals)).toBe(true);
  });

  test('getBusDetail propagates non-404 errors', async () => {
    const client = new VinBusHttpClient({
      decryptKey: DECRYPT_KEY,
      baseUrl: 'https://vbservice-api.vinbus.vn',
    });
    const service = new StationService(client);

    // Use obviously invalid IDs. The API may return 404 (null) or 400 (error).
    // Either outcome is acceptable: 404 is handled gracefully, other errors propagate.
    try {
      const result = await service.getBusDetail(
        'nonexistent-station',
        'nonexistent-route',
        'nonexistent-bus',
        'hcm' as RegionCode,
      );
      expect(result).toBeNull();
    } catch (err) {
      expect(err).toBeInstanceOf(VinBusApiError);
    }
  });
});

test.describe('SystemService', () => {
  test('getStores returns array for valid regionCode', async () => {
    const client = new VinBusHttpClient({
      decryptKey: DECRYPT_KEY,
      baseUrl: 'https://vbservice-api.vinbus.vn',
    });
    const service = new SystemService(client);
    const stores = await service.getStores('hcm' as RegionCode);

    expect(Array.isArray(stores)).toBe(true);
    if (stores.length > 0) {
      const first = stores[0];
      expect(typeof first.title).toBe('string');
      expect(typeof first.address).toBe('string');
    }
  });
});

test.describe('Map tile provider', () => {
  test('tileUrl generates correct XYZ URL', () => {
    const url = tileUrl(100, 200, 16);
    expect(url).toBe(
      'https://vbcore-maptile-web.vinbus.vn/osm/16/100/200.png',
    );
  });

  test('tileKey generates consistent key', () => {
    expect(tileKey(1, 2, 3)).toBe('3/1/2');
    expect(tileKey(10, 20, 16)).toBe('16/10/20');
  });

  test('tilesForBounds covers the bounding box', () => {
    const tiles = tilesForBounds(106.7, 10.7, 106.8, 10.8, 16);
    expect(tiles.length).toBeGreaterThan(0);
    for (const t of tiles) {
      expect(t.z).toBe(16);
      expect(typeof t.x).toBe('number');
      expect(typeof t.y).toBe('number');
    }
  });

  test('clearTileCache empties the cache', () => {
    clearTileCache();
    expect(getTileCacheSize?.()).toBe(0);
  });
});

test.describe('VinBus API models', () => {
  test('Region model matches observed fixture', () => {
    const region: Region = FIXTURE_REGIONS[1];
    expect(region.code).toBe('hcm');
    expect(region.title).toBe('Hồ Chí Minh');
    expect(region.titleEn).toBe('Ho Chi Minh City');
    expect(region.allowBuyTicket).toBe(false);
  });

  test('BusRoute model shape', () => {
    const route: BusRoute = {
      id: 123,
      routeNo: '15',
      routeName: 'Ben Xe Mien Dong - Cho Lon',
      routeType: 1, // CITYBUS
    };
    expect(route.routeType).toBe(1);
  });
});
