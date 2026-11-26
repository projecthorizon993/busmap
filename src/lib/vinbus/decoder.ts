/**
 * Response decoder for VinBus Maps API.
 *
 * The VinBus API returns HTTP 200 with a body that is a hexadecimal string
 * representing AES-256-CBC encrypted data. The first 16 bytes of the decoded
 * ciphertext are the IV; the remainder is the ciphertext. Decryption uses
 * PKCS#7 padding and a key loaded from /env.js (window.userEnvironment.decryptKey).
 *
 * This module mirrors the frontend KeyService.decryptMessage() behaviour
 * observed in the VinBus frontend JS bundles, implemented with the Web Crypto
 * API so no extra npm dependency is required.
 *
 * LIMITATION: Without the runtime decryptKey (provided by /env.js on
 * maps.vinbus.vn), decryption cannot be performed. The decoder accepts the key
 * as a constructor parameter so it can be configured from the environment.
 */

const IV_LENGTH = 16;

function hexToUint8Array(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string');
  if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error('Invalid hex string');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

/**
 * Decrypt a hex-encoded AES-256-CBC response body and parse it as JSON.
 *
 * @param hex - Hex-encoded encrypted response body from the VinBus API.
 * @param key - Decryption key (from window.userEnvironment.decryptKey / /env.js).
 * @returns Parsed JSON value, or the raw UTF-8 string if JSON parsing fails.
 * @throws Error if the hex string is invalid or decryption fails.
 */
export async function decryptMessage(
  hex: string,
  key: string,
): Promise<unknown> {
  const bytes = hexToUint8Array(hex);
  if (bytes.length < IV_LENGTH + 1) {
    throw new Error('Ciphertext too short to contain IV + data');
  }

  const iv = bytes.slice(0, IV_LENGTH);
  const ciphertext = bytes.slice(IV_LENGTH);

  // AES-256 requires a 32-byte key. Use the first 32 bytes of the UTF-8 key.
  const keyBuffer = new TextEncoder().encode(key).slice(0, 32);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBuffer,
    { name: 'AES-CBC' },
    false,
    ['decrypt'],
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv },
    cryptoKey,
    ciphertext,
  );

  const str = new TextDecoder().decode(decrypted);
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

/**
 * Convenience wrapper: fetch a URL, then decrypt the hex response body.
 *
 * @param url - Full API URL to fetch.
 * @param key - Decryption key.
 * @param init - Optional fetch init (headers, signal, etc.).
 * @returns Decrypted and parsed response value.
 */
export async function fetchAndDecrypt(
  url: string,
  key: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await fetch(url, init);
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
  const hex = await unwrapJsonString(await response.text());
  return decryptMessage(hex, key);
}

/**
 * If the response body is a JSON-quoted string (e.g. "\"hexdata\""),
 * unwrap it to the inner string. Otherwise return the input unchanged.
 * The VinBus API wraps hex ciphertext in JSON string quotes.
 */
function unwrapJsonString(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // If JSON.parse fails, return as-is
    }
  }
  return text;
}
export class VinBusApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly body: string;

  constructor(status: number, statusText: string, body: string) {
    super(`VinBus API error ${status}: ${statusText}`);
    this.name = 'VinBusApiError';
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }
}

export { IV_LENGTH };
