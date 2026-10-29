// Local development MongoDB (single-node replica set so transactions work). No Docker required.
// Data persists in ./.mongo-data. NOT for production.
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { mkdirSync } from 'node:fs';

mkdirSync('.mongo-data', { recursive: true });
const rs = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: 'wiredTiger', dbName: 'nexus' },
  instanceOpts: [{ port: 27017, dbPath: '.mongo-data', storageEngine: 'wiredTiger' }],
});
console.log(`MongoDB ready: ${rs.getUri()}`);
const stop = async () => { await rs.stop({ doCleanup: false }); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
