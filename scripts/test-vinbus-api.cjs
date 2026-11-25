const crypto = require('crypto');
const https = require('https');

const VINBUS_API_BASE = 'https://vbservice-api.vinbus.vn';
const KEY = 'ViNbus2o21#K3(y)th3BUSNiElectric';
const IV_LEN = 16;

function hexToUint8Array(hex) {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex');
  if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error('Invalid hex');
  return Buffer.from(hex, 'hex');
}

function unwrapJsonString(text) {
  const t = text.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try { return JSON.parse(t); } catch { }
  }
  return text;
}

function decryptMessage(hex, key) {
  const bytes = hexToUint8Array(hex);
  const iv = bytes.subarray(0, IV_LEN);
  const ct = bytes.subarray(IV_LEN);
  const keyBuf = Buffer.from(key, 'utf8').subarray(0, 32);
  const decipher = crypto.createDecipheriv('aes-256-cbc', keyBuf, iv);
  decipher.setAutoPadding(true);
  let dec = decipher.update(ct);
  dec = Buffer.concat([dec, decipher.final()]);
  const str = dec.toString('utf8');
  try { return JSON.parse(str); } catch { return str; }
}

async function get(path, params) {
  const url = new URL(VINBUS_API_BASE + path);
  if (params)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  return new Promise((resolve, reject) => {
    https.get(url.toString(), {
      headers: {
        'Accept': 'application/json',
        'Origin': 'https://maps.vinbus.vn',
        'Referer': 'https://maps.vinbus.vn/',
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`STATUS: ${res.statusCode} for ${path}`);
        try {
          const hex = unwrapJsonString(data);
          const result = decryptMessage(hex, KEY);
          console.log(`RESULT keys: ${Object.keys(result || {}).join(', ')}`);
          resolve(result);
        } catch (e) {
          console.error(`DECRYPT ERROR: ${e.message}`);
          resolve(null);
        }
      });
    }).on('error', (err) => {
      console.error(`REQUEST ERROR: ${err.message}`);
      reject(err);
    });
  });
}

async function main() {
  let failures = 0;

  console.log('='.repeat(60));
  console.log('VINBUS API INTEGRATION TEST');
  console.log('='.repeat(60));

  // Test 1: Regions
  console.log('\n--- Test 1: Get regions ---');
  try {
    const regions = await get('/client/route/regions');
    if (Array.isArray(regions) && regions.length > 0) {
      console.log(`PASS: Got ${regions.length} regions`);
      regions.forEach(r => console.log(`  - ${r.code}: ${r.title} (${r.titleEn})`));
    } else {
      console.log('FAIL: No regions returned');
      failures++;
    }
  } catch (e) {
    console.error(`FAIL: Regions request failed: ${e.message}`);
    failures++;
  }

  // Test 2: Routes for Hanoi (hn)
  console.log('\n--- Test 2: Get routes for Hanoi (hn) ---');
  try {
    const routes = await get('/client/route/list', { regionCode: 'hn' });
    if (Array.isArray(routes) && routes.length > 0) {
      console.log(`PASS: Got ${routes.length} routes for Hanoi`);
      routes.slice(0, 5).forEach(r => console.log(`  - ${r.routeNo}: ${r.routeName} (type:${r.routeType})`));
    } else {
      console.log('FAIL: No routes returned for Hanoi');
      failures++;
    }
  } catch (e) {
    console.error(`FAIL: Routes request failed: ${e.message}`);
    failures++;
  }

  // Test 3: Nearby stations for Hanoi
  console.log('\n--- Test 3: Get nearby stations for Hanoi ---');
  try {
    const stations = await get('/client/station/near', {
      lat: '21.0285', lng: '105.8542', r: '1500', regionCode: 'hn'
    });
    if (Array.isArray(stations) && stations.length > 0) {
      console.log(`PASS: Got ${stations.length} stations near Hanoi`);
      stations.slice(0, 3).forEach(s => console.log(`  - ${s.stationName} (${s.lat}, ${s.lng}) routes: ${s.arrRouteNo?.join(',') || 'none'}`));
    } else {
      console.log('FAIL: No stations returned for Hanoi');
      failures++;
    }
  } catch (e) {
    console.error(`FAIL: Stations request failed: ${e.message}`);
    failures++;
  }

  // Test 4: Route detail for a Hanoi route
  console.log('\n--- Test 4: Get route detail for Hanoi route 01 ---');
  try {
    const detail = await get('/client/route/detail', {
      routeId: '01',
      regionCode: 'hn'
    });
    if (detail && detail.stations) {
      console.log(`PASS: Got route detail with ${detail.stations.length} stations`);
      console.log(`  First station: ${detail.stations[0]?.stationName} (${detail.stations[0]?.lat}, ${detail.stations[0]?.lng})`);
    } else {
      console.log('FAIL: No route detail returned');
      failures++;
    }
  } catch (e) {
    console.error(`FAIL: Route detail request failed: ${e.message}`);
    failures++;
  }

  // Test 5: ETA for a Hanoi station
  console.log('\n--- Test 5: Get ETA for Hanoi station ---');
  try {
    const arrivals = await get('/client/station/estimate_bus_to_station', {
      regionCode: 'hn',
      stationId: '1073',
      group: '1',
      isInternalStation: '0'
    });
    if (Array.isArray(arrivals)) {
      const hasVehicles = arrivals.some(a => a.list && a.list.length > 0);
      console.log(`PASS: Got ${arrivals.length} route groups, ${hasVehicles ? 'with vehicles' : 'no live vehicles'}`);
      arrivals.slice(0, 3).forEach(a => {
        const busCount = a.list?.length || 0;
        console.log(`  - ${a.routeNo}: ${busCount} bus(es), eta: ${a.message || 'N/A'}`);
      });
    } else {
      console.log('FAIL: No arrival data returned');
      failures++;
    }
  } catch (e) {
    console.error(`FAIL: ETA request failed: ${e.message}`);
    failures++;
  }

  console.log('\n' + '='.repeat(60));
  console.log(`TEST SUMMARY: ${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`);
  console.log('='.repeat(60));

  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
