import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { connectDatabase, type Database } from './client.js';

/** Test-only: a real mongod replica set (transactions work) on an ephemeral port. */
export async function startTestMongo(): Promise<{ uri: string; stop(): Promise<void> }> {
  const rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  return { uri: rs.getUri(), stop: async () => { await rs.stop(); } };
}

let n = 0;
export async function freshTestDatabase(uri: string): Promise<Database> {
  return connectDatabase(uri, `nexus_test_${Date.now()}_${n++}`);
}
