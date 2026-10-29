import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateDownOne, migrateUp } from './migrations.js';
import { freshTestDatabase, startTestMongo } from './testing.js';
import type { Database } from './client.js';

let mongo: Awaited<ReturnType<typeof startTestMongo>>;
let database: Database;
beforeAll(async () => {
  mongo = await startTestMongo();
  database = await freshTestDatabase(mongo.uri);
}, 240_000);
afterAll(async () => {
  await database?.close();
  await mongo?.stop();
});

test('migrations are idempotent and create unique indexes', async () => {
  expect(await migrateUp(database.db)).toEqual([]); // already applied on connect
  await database.c.organizations.insertOne({ _id: 'a', slug: 's', name: 'n', createdAt: new Date() });
  await expect(
    database.c.organizations.insertOne({ _id: 'b', slug: 's', name: 'n', createdAt: new Date() }),
  ).rejects.toThrow(/duplicate/i);
});

test('transactions roll back on error', async () => {
  await expect(
    database.transaction(async (session) => {
      await database.c.organizations.insertOne({ _id: 'tx1', slug: 'tx', name: 'n', createdAt: new Date() }, { session });
      throw new Error('boom');
    }),
  ).rejects.toThrow('boom');
  expect(await database.c.organizations.countDocuments({ _id: 'tx1' })).toBe(0);
});

test('rollback reverts the newest migration first; re-applying restores them in order', async () => {
  const names = async (coll: string) => (await database.db.collection(coll).indexes()).map((i) => i.name);
  expect(await names('logs')).toContain('logs_scope_ts_search');
  expect(await names('logs')).not.toContain('logs_scope_ts'); // v5 replaced it
  expect(await names('spans')).toContain('spans_scope_trace');
  expect(await migrateDownOne(database.db)).toBe(6);
  expect(await names('spans')).not.toContain('spans_scope_trace');
  expect(await migrateDownOne(database.db)).toBe(5);
  expect(await names('logs')).toContain('logs_scope_ts'); // v5 rollback restores the v3 index…
  expect(await names('logs')).not.toContain('logs_scope_ts_search'); // …and removes what it added
  expect(await names('logs')).not.toContain('logs_scope_ts_svc_lvl');
  expect(await migrateDownOne(database.db)).toBe(4);
  expect(await names('auth_flows')).not.toContain('authflow_ttl');
  expect(await names('logs')).toContain('logs_scope_ts'); // v3 untouched by the v4 rollback
  expect(await migrateDownOne(database.db)).toBe(3);
  expect(await names('logs')).not.toContain('logs_scope_ts');
  expect(await names('connections')).toContain('conn_scope'); // v2 untouched by the v3 rollback
  expect(await migrateDownOne(database.db)).toBe(2);
  expect(await names('connections')).not.toContain('conn_scope');
  expect(await names('organizations')).toContain('org_slug_uq');
  expect(await migrateDownOne(database.db)).toBe(1);
  expect(await names('organizations')).not.toContain('org_slug_uq');
  expect(await migrateDownOne(database.db)).toBeNull(); // nothing left to roll back
  expect(await migrateUp(database.db)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(await names('organizations')).toContain('org_slug_uq');
  expect(await names('logs')).toContain('logs_ttl');
});

describe('migration lock', () => {
  const fresh = () => database.client.db(`nx_lock_${Date.now()}_${Math.random().toString(36).slice(2)}`);

  test('concurrent runners queue: everything is applied exactly once and nobody crashes', async () => {
    const db = fresh();
    const results = await Promise.all([migrateUp(db), migrateUp(db), migrateUp(db)]);
    expect(results.flat().sort()).toEqual([1, 2, 3, 4, 5, 6]); // each migration applied exactly once across all runners
    expect(await db.collection('schema_migrations').countDocuments({ _id: 'migration-lock' as never })).toBe(0);
  });

  test('a live lock makes a runner wait and then time out instead of running unprotected', async () => {
    const db = fresh();
    await db.collection('schema_migrations').insertOne({ _id: 'migration-lock' as never, lockedAt: new Date(), owner: 'other' });
    await expect(migrateUp(db, { lockWaitMs: 500 })).rejects.toThrow(/Timed out/);
    // the foreign lock must not have been released by the loser
    expect(await db.collection('schema_migrations').countDocuments({ _id: 'migration-lock' as never })).toBe(1);
  });

  test('a stale lock from a crashed runner is taken over', async () => {
    const db = fresh();
    await db.collection('schema_migrations').insertOne({ _id: 'migration-lock' as never, lockedAt: new Date(Date.now() - 10 * 60_000), owner: 'dead' });
    expect(await migrateUp(db)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('v5 search-text backfill', () => {
  test('records written before the migration become searchable, and re-running changes nothing', async () => {
    const db = database.client.db(`nx_backfill_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    await migrateUp(db, { target: 4 });
    const base = { orgId: 'o', projectId: 'p', environmentId: 'e', ts: new Date(), level: 2 };
    await db.collection('logs').insertMany([
      { _id: 'a' as never, ...base, message: 'Payment FAILED for Order 7', errorType: 'CardError', exceptionMessage: 'Declined' },
      { _id: 'b' as never, ...base, message: 'ok', errorType: null, exceptionMessage: null },
    ]);
    expect(await migrateUp(db)).toEqual([5, 6]);
    const [a, b] = await Promise.all([db.collection('logs').findOne({ _id: 'a' as never }), db.collection('logs').findOne({ _id: 'b' as never })]);
    expect(a?.searchText).toBe('payment failed for order 7carderrordeclined');
    expect(b?.searchText).toBe('ok');
    expect(await migrateUp(db)).toEqual([]);
  });
});
