/**
 * BusMap API Proxy - Cloudflare Worker
 * Proxies requests to timbus.vn and decrypts AES-256-CBC responses
 */

const IV_LENGTH = 16;

function hexToUint8Array(hex) {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string');
  if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error('Invalid hex string');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

async function decryptMessage(hex, key) {
  const bytes = hexToUint8Array(hex);
  const iv = bytes.subarray(0, IV_LENGTH);
  const ciphertext = bytes.subarray(IV_LENGTH);
  const keyBuf = new TextEncoder().encode(key).subarray(0, 32);

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
}

function isHexEncoded(str) {
  const trimmed = str.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length % 2 !== 0) return false;
  return /^[0-9a-fA-F]+$/.test(trimmed);
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

    // Allow GET and POST requests
    if (request.method !== 'GET' && request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // Extract the path from the request URL
    let path = url.pathname;

    // Strip /api/ or /timbus/ prefix if present
    path = path.replace(/^(\/api|\/timbus)\//, '/');

    // timbus.vn paths need /Engine/Business/ prefix
    if (!path.startsWith('/Engine/Business/')) {
      path = '/Engine/Business' + path;
    }

    // Build the timbus.vn URL
    const timbusUrl = new URL(`${env.TIMBUS_API_BASE}${path}`);

    // Copy query parameters
    url.searchParams.forEach((v, k) => {
      timbusUrl.searchParams.set(k, v);
    });

    // Build fetch options
    const fetchOptions = {
      method: request.method,
      headers: {
        'Accept': 'application/json',
        'Referer': 'http://timbus.vn/',
        'Origin': 'http://timbus.vn',
        'X-Requested-With': 'XMLHttpRequest',
      },
    };

    // Forward body for POST requests
    if (request.method === 'POST') {
      const contentType = request.headers.get('content-type') || '';
      fetchOptions.headers['Content-Type'] = contentType;
      fetchOptions.body = await request.text();
    }

    try {
      const response = await fetch(timbusUrl.toString(), fetchOptions);

      const responseText = await response.text();

      // Try to decrypt if it looks like hex-encoded AES
      let decrypted;
      try {
        decrypted = await decryptMessage(responseText, env.VITE_VIETNAM_DECRYPT_KEY || 'ViNbus2o21#K3(y)th3BUSNiElectric');
      } catch {
        // If decryption fails, return raw text
        decrypted = responseText;
      }

      return new Response(JSON.stringify(decrypted), {
        status: response.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
          'Cache-Control': 'public, max-age=300',
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
