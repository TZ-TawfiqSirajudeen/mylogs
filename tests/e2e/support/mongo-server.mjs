// Standalone throwaway MongoDB replica set for the e2e stack. Prints "MONGO_URI=<uri>" once ready.
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
console.log(`MONGO_URI=${rs.getUri()}`);
const stop = async () => { await rs.stop(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
setInterval(() => undefined, 1 << 30);
