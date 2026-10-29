// Test-only HTTP window onto the e2e database (the specs cannot import the mongodb driver under Playwright's loader).
// POST /op  { op: "find"|"count"|"update", collection, filter, update? }  ->  JSON result. Dates are revived from {"$date": iso}.
import http from 'node:http';
import { MongoClient } from 'mongodb';

const [uri, dbName, port] = [process.env.E2E_MONGO_URI, process.env.E2E_DB, Number(process.env.E2E_DB_PORT)];
const client = new MongoClient(uri);
await client.connect();
const db = client.db(dbName);
const revive = (v) => JSON.parse(JSON.stringify(v), (_k, x) => (x && typeof x === 'object' && '$date' in x ? new Date(x.$date) : x));

http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  try {
    const { op, collection, filter = {}, update } = revive(JSON.parse(body || '{}'));
    const c = db.collection(collection);
    const out = op === 'find' ? await c.find(filter).toArray()
      : op === 'count' ? await c.countDocuments(filter)
      : op === 'update' ? (await c.updateMany(filter, update)).modifiedCount
      : (() => { throw new Error(`unknown op ${op}`); })();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
}).listen(port, '127.0.0.1', () => console.log('DB_READY'));
