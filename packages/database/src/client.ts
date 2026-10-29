import { MongoClient, type ClientSession, type Db } from 'mongodb';
import { collections, type Collections } from './models.js';
import { migrateUp } from './migrations.js';

export interface Database {
  client: MongoClient;
  db: Db;
  c: Collections;
  /** Runs `fn` in a multi-document transaction (requires a replica set / Atlas). */
  transaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export async function connectDatabase(uri: string, dbName: string, opts: { migrate?: boolean } = {}): Promise<Database> {
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5_000,
    appName: 'nexus-api',
    retryWrites: true,
    // Control-plane writes must survive a primary failover.
    writeConcern: { w: 'majority' },
  });
  await client.connect();
  const db = client.db(dbName);
  if (opts.migrate !== false) await migrateUp(db);
  return {
    client,
    db,
    c: collections(db),
    async transaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
      const session = client.startSession();
      try {
        let result: T;
        await session.withTransaction(async () => { result = await fn(session); }, {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
        });
        return result!;
      } finally {
        await session.endSession();
      }
    },
    async ping() {
      try { await db.command({ ping: 1 }); return true; } catch { return false; }
    },
    close: () => client.close(),
  };
}
