import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { collections } from './models.js';

/**
 * Verifies the role definitions published in docs/runbooks/mongodb-roles.md against a real auth-enabled mongod:
 * the application user can run the platform's collections normally but cannot update or delete audit events.
 */
const ROOT = { user: 'root', pwd: 'root-pass-123' };
// Derived from the code, so a new collection can never be silently missing from the role (the runbook is checked against it below).
const stub = { collection: (name: string) => name } as never;
const ALL = Object.values(collections(stub)) as unknown as string[];
const APP_COLLECTIONS = [...ALL.filter((c) => c !== 'audit_events'), 'schema_migrations'];

let server: MongoMemoryServer;
let port: number;
beforeAll(async () => {
  server = await MongoMemoryServer.create({ auth: { enable: true, customRootName: ROOT.user, customRootPwd: ROOT.pwd } });
  port = Number(new URL(server.getUri()).port);
  const admin = new MongoClient(`mongodb://${ROOT.user}:${ROOT.pwd}@127.0.0.1:${port}/?authSource=admin&directConnection=true`);
  await admin.connect();
  const a = admin.db('admin');
  await a.command({
    createRole: 'nexusApp',
    privileges: APP_COLLECTIONS.map((collection) => ({ resource: { db: 'nexus', collection }, actions: ['find', 'insert', 'update', 'remove', 'createIndex', 'createCollection', 'dropIndex'] })),
    roles: [],
  });
  await a.command({
    createRole: 'nexusAuditAppendOnly',
    privileges: [{ resource: { db: 'nexus', collection: 'audit_events' }, actions: ['find', 'insert', 'createIndex', 'createCollection'] }],
    roles: [],
  });
  await a.command({ createUser: 'nexus_app', pwd: 'app-pass-123', roles: ['nexusApp', 'nexusAuditAppendOnly'] });
  await admin.close();
}, 240_000);
afterAll(async () => { await server?.stop(); });

test('the app user manages platform collections but can only append to the audit trail', async () => {
  const app = new MongoClient(`mongodb://nexus_app:app-pass-123@127.0.0.1:${port}/?authSource=admin&directConnection=true`);
  await app.connect();
  try {
    const db = app.db('nexus');
    await db.collection('projects').insertOne({ _id: 'p' as never, name: 'x' });
    await db.collection('projects').updateOne({ _id: 'p' as never }, { $set: { name: 'y' } });
    await db.collection('projects').deleteOne({ _id: 'p' as never });
    await db.collection('counters').updateOne({ _id: 'audit:o' as never }, { $inc: { value: 1 } }, { upsert: true });

    const audit = db.collection('audit_events');
    await audit.insertOne({ _id: 'e1' as never, action: 'x' });
    expect(await audit.countDocuments({})).toBe(1);
    await expect(audit.updateOne({ _id: 'e1' as never }, { $set: { action: 'tampered' } })).rejects.toThrow(/not authorized/i);
    await expect(audit.deleteOne({ _id: 'e1' as never })).rejects.toThrow(/not authorized/i);
    await expect(audit.deleteMany({})).rejects.toThrow(/not authorized/i);
    await expect(audit.drop()).rejects.toThrow(/not authorized/i);
    expect((await audit.findOne({ _id: 'e1' as never }))?.action).toBe('x');
  } finally {
    await app.close();
  }
});

test('the published runbook lists exactly the collections the code uses (so the documented role is sufficient)', () => {
  const doc = readFileSync(new URL('../../../docs/runbooks/mongodb-roles.md', import.meta.url), 'utf8');
  const block = /privileges: \[\s*([\s\S]*?)\]\.map/.exec(doc)?.[1] ?? '';
  const listed = [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!).sort();
  expect(listed).toEqual([...APP_COLLECTIONS].sort());
});
