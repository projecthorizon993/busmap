/**
 * Raster tile provider for VinBus Maps.
 *
 * Tile URL: https://vbcore-maptile-web.vinbus.vn/osm/{z}/{x}/{y}.png
 *
 * Uses XYZ tile coordinates. Supports dynamic zoom, map panning, on-demand
 * tile loading, duplicate-tile avoidance, missing-tile handling, and caching.
 * Does not assume the complete supported zoom range (the HAR confirmed
 * zooms 16 and 17 only).
 */

export interface TileCoord {
  x: number;
  y: number;
  z: number;
}

export interface TileLoadResult {
  coord: TileCoord;
  /** data URL or blob URL of the tile image, or null if missing/failed. */
  dataUrl: string | null;
  /** true if the tile was served from cache. */
  cached: boolean;
}

/** VinBus map tile host (observed in frontend initializeMapOptions). */
const TILE_BASE = 'https://vbcore-maptile-web.vinbus.vn';

/**
 * Build a tile URL for the given XYZ coordinate.
 */
export function tileUrl(x: number, y: number, z: number): string {
  return `${TILE_BASE}/osm/${z}/${x}/${y}.png`;
}

/**
 * Build a cache key for a tile coordinate.
 */
export function tileKey(x: number, y: number, z: number): string {
  return `${z}/${x}/${y}`;
}

/**
 * In-memory tile cache. Keys are "z/x/y".
 */
class TileCache {
  private readonly cache = new Map<string, string>();

  get(key: string): string | undefined {
    return this.cache.get(key);
  }

  set(key: string, dataUrl: string): void {
    this.cache.set(key, dataUrl);
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }
}

const tileCache = new TileCache();
const inflight = new Map<string, Promise<string | null>>();

/**
 * Load a single tile as a data URL. Handles missing tiles gracefully
 * (returns null). Deduplicates in-flight requests for the same tile.
 * Caches successful results.
 *
 * @param coord - Tile coordinate.
 * @param signal - Optional AbortSignal for cancellation.
 */
export async function loadTile(
  coord: TileCoord,
  signal?: AbortSignal,
): Promise<TileLoadResult> {
  const key = tileKey(coord.x, coord.y, coord.z);

  // Cache hit.
  const cached = tileCache.get(key);
  if (cached) {
    return { coord, dataUrl: cached, cached: true };
  }

  // In-flight dedupe.
  const existing = inflight.get(key);
  if (existing) {
    const dataUrl = await existing;
    return { coord, dataUrl, cached: false };
  }

  const url = tileUrl(coord.x, coord.y, coord.z);
  const promise = (async () => {
    try {
      const response = await fetch(url, { signal });
      if (!response.ok) {
        // Missing tile (404) or other error — return null, do not cache.
        return null;
      }
      const blob = await response.blob();
      const dataUrl = await blobToDataUrl(blob);
      tileCache.set(key, dataUrl);
      return dataUrl;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  const dataUrl = await promise;
  return { coord, dataUrl, cached: false };
}

/**
 * Convert a Blob to a data URL.
 */
async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Compute the set of tile coordinates covering a bounding box at a zoom level.
 */
export function tilesForBounds(
  west: number,
  south: number,
  east: number,
  north: number,
  z: number,
): TileCoord[] {
  const tiles: TileCoord[] = [];
  const x0 = lonToTileX(west, z);
  const x1 = lonToTileX(east, z);
  const y0 = latToTileY(north, z);
  const y1 = latToTileY(south, z);

  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      tiles.push({ x, y, z });
    }
  }
  return tiles;
}

/** Convert longitude to tile X coordinate. */
function lonToTileX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, z));
}

/** Convert latitude to tile Y coordinate. */
function latToTileY(lat: number, z: number): number {
  const sin = Math.sin((lat * Math.PI) / 180);
  return Math.floor(
    ((1 - Math.log((1 + sin) / (1 - sin)) / Math.PI) / 2) * Math.pow(2, z),
  );
}

/**
 * Clear the tile cache and inflight dedupe map.
 */
export function clearTileCache(): void {
  tileCache.clear();
  inflight.clear();
}

/** Get current cache size. */
export function getTileCacheSize(): number {
  return tileCache.size();
}
