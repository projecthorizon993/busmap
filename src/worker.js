/**
 * BusMap API Proxy - Cloudflare Worker
 * Proxies requests to timbus.vn and decrypts AES-256-CBC responses
 */

const IV_LENGTH = 16; // 16 bytes for AES-CBC IV

function hexToUint8Array(hex) {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string');
  if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error('Invalid hex string');
  return Buffer.from(hex, 'hex');
}

async function decryptAES256CBC(hexData, keyString) {
  try {
    const bytes = hexToUint8Array(hex);
    const iv = bytes.subarray(0, IV_LENGTH);
    const ciphertext = bytes.subarray(IV_LEN);

    const keyBuf = Buffer.from(keyString, 'utf8').subarray(0, 32);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyBuf,
      { name: 'AES-CBC' },
      false,
      ['decrypt']
    );

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv },
      cryptoKey,
      ciphertext
    );

    const str = new TextDecoder().decode(decrypted);
    try {
      return JSON.parse(str);
    } catch {
      return str;
    }
  } catch (e) {
    console.error('Decryption error:', e.message);
    throw e;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Only allow GET requests
    if (request.method !== 'GET') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // Extract the path from the request URL
    let path = url.pathname;

    // Strip /api/ or /timbus/ prefix if present
    path = path.replace(/^(\/api|\/timbus)\//, '/');

    // If path doesn't start with /Engine/Business/, add it
    if (!path.startsWith('/Engine/Business/')) {
      path = '/Engine/Business' + path;
    }

    // Build the timbus.vn URL
    const timbusUrl = new URL(`${env.TIMBUS_API_BASE}${path}`);

    // Copy query parameters
    url.searchParams.forEach((value, key) => {
      timbusUrl.searchParams.set(key, value);
    });

    try {
      const response = await fetch(timbusUrl.toString(), {
        headers: {
          'Accept': 'application/json',
          'Referer': 'http://timbus.vn/',
          'Origin': 'http://timbus.vn',
          'X-Requested-With': 'XMLHttpRequest',
        },
      });

      const data = await response.text();

      // Try to decrypt if it looks like hex-encoded AES
      let decryptedData;
      try {
        decryptedData = await decryptMessage(data, env.DECRYPT_KEY || 'ViNbus2o21#K3(y)th3BUSNiElectric');
      } catch {
        // If decryption fails, return raw text
        decryptedData = data;
      }

      return new Response(JSON.stringify(decryptedData), {
        status: response.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
          'Cache-Control': 'public, max-age=300', // Cache for 5 minutes
        },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
  },
};