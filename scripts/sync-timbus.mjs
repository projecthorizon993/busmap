import { syncCatalog } from '../server/timbus.mjs';

const result = await syncCatalog();
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok !== false ? 0 : 1);
