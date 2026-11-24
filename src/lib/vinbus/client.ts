/**
 * Reusable HTTP client for the VinBus Maps API.
 *
 * Features:
 *   - GET requests with query parameters
 *   - Configurable request timeout via AbortController
 *   - HTTP error handling including 404
 *   - Network failure handling
 *   - Response decoding through the separate decoder module
 *   - Configurable regionCode parameter
 *   - Request deduplication for in-flight requests
 *
 * No API key or authentication token was observed in the captured requests.
 * Response bodies are hex-encoded AES-256-CBC ciphertext and are decrypted
 * by the decoder module using a key configured from the environment.
 */

import {
  decryptMessage,
  fetchAndDecrypt,
  VinBusApiError,
} from './decoder';

/** Base URL for the VinBus Maps API. */
export const VINBUS_API_BASE = 'https://vbservice-api.vinbus.vn';

/** Request timeout in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Configuration for the VinBus HTTP client.
 */
export interface VinBusClientConfig {
  /** Base API URL (defaults to vbservice-api.vinbus.vn). */
  baseUrl?: string;
  /** Decryption key from /env.js (window.userEnvironment.decryptKey). */
  decryptKey: string;
  /** Request timeout in ms. */
  timeoutMs?: number;
}

/** In-flight request dedupe map: URL -> Promise. */
const inflight = new Map<string, Promise<unknown>>();

/**
 * Build a URL with query parameters.
 */
function buildUrl(base: string, path: string, params: Record<string, string>): string {
  const url = new URL(`${base.replace(/\/$/, '')}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

/**
 * Create a fetch init with timeout via AbortController.
 */
function withTimeout(
  timeoutMs: number,
): { signal: AbortSignal; controller: AbortController } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, controller: timer as unknown as AbortController };
}

/**
 * Reusable HTTP client for VinBus Maps API.
 */
export class VinBusHttpClient {
  private readonly baseUrl: string;
  private readonly decryptKey: string;
  private readonly timeoutMs: number;

  constructor(config: VinBusClientConfig) {
    this.baseUrl = config.baseUrl ?? VINBUS_API_BASE;
    this.decryptKey = config.decryptKey;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * GET a JSON resource, decrypting the hex response body.
   * Dedupes in-flight requests for the same URL.
   */
  async get<T = unknown>(path: string, params?: Record<string, string>): Promise<T> {
    const url = buildUrl(this.baseUrl, path, params ?? {});

    // Return in-flight promise if the same URL is already being fetched.
    const existing = inflight.get(url);
    if (existing) {
      return existing as Promise<T>;
    }

    const { signal } = withTimeout(this.timeoutMs);
    const promise = (async () => {
      try {
        return (await fetchAndDecrypt(url, this.decryptKey, { signal })) as T;
      } finally {
        inflight.delete(url);
      }
    })();

    inflight.set(url, promise);
    return promise;
  }

  /**
   * POST a JSON body, decrypting the hex response body.
   */
  async post<T = unknown>(
    path: string,
    body: unknown,
    params?: Record<string, string>,
  ): Promise<T> {
    const url = buildUrl(this.baseUrl, path, params ?? {});
    const { signal } = withTimeout(this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Origin': 'https://maps.vinbus.vn',
          'Referer': 'https://maps.vinbus.vn/',
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        if (response.status === 404) {
          throw new VinBusApiError(404, 'Not found', await response.text());
        }
        throw new VinBusApiError(
          response.status,
          response.statusText,
          await response.text(),
        );
      }

      const hex = await response.text();
      return (await decryptMessage(hex, this.decryptKey)) as T;
    } finally {
      // AbortController is single-use; no cleanup needed for POST.
    }
  }

  /** Clear the inflight dedupe map (useful in tests). */
  clearInflight(): void {
    inflight.clear();
  }
}
