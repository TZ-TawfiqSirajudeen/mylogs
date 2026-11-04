import { AuditService, type Database } from '@nexus/database';
import { freshTestDatabase, startTestMongo } from '@nexus/database/testing';
import { IngestTokenService, TokenCreate } from '@nexus/ingest';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { buildIngestApp, DEFAULT_APP_CONFIG } from '../src/app.js';

// ADR-0011: the `deployments` scope lets a token record deployments through the API. It must never let the same token send telemetry,
// and a telemetry token must not gain the scope. (The API side of the same boundary is tested in apps/api/test/deployments.test.ts.)
let mongo: Awaited<ReturnType<typeof startTestMongo>>;
let db: Database;
let tokens: { deployments: string; telemetry: string; both: string };

beforeAll(async () => {
  mongo = await startTestMongo();
  db = await freshTestDatabase(mongo.uri);
  await db.c.environments.insertOne({ _id: 'env-a', orgId: 'org-a', projectId: 'proj-1', slug: 'a', name: 'a', isProduction: false, createdAt: new Date() });
  const svc = new IngestTokenService(db, new AuditService(db));
  const mk = async (name: string, signals?: ('logs' | 'deployments' | 'traces' | 'metrics')[]) =>
    (await svc.create({ orgId: 'org-a', projectId: 'proj-1', environmentIds: null }, 'env-a', { userId: 'u', ctx: { requestId: 'req-setup-01' } }, TokenCreate.parse({ name, ...(signals ? { signals } : {}) }))).token;
  tokens = { deployments: await mk('deploys-only', ['deployments']), telemetry: await mk('default'), both: await mk('both', ['logs', 'deployments']) };
}, 300_000);
afterAll(async () => { await db?.close(); await mongo?.stop(); });

const send = async (url: string, token: string) => {
  const { app } = await buildIngestApp(db, { ...DEFAULT_APP_CONFIG, logLevel: 'silent' });
  try { return await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: url === '/v1/json-logs' ? '[{"msg":"hello","service":"x"}]' : '{}' }); } finally { await app.close(); }
};

test('a deployments-only token cannot send logs, traces or metrics (403 forbidden_signal) and stores nothing', async () => {
  for (const url of ['/v1/logs', '/v1/json-logs', '/v1/traces', '/v1/metrics']) {
    const r = await send(url, tokens.deployments);
    expect(r.statusCode, url).toBe(403);
    expect(r.json().error, url).toBe('forbidden_signal');
  }
  expect(await db.c.logs.countDocuments({})).toBe(0);
});

test('the default token scopes are unchanged (no deployments) and a combined token can still send logs', async () => {
  expect((await db.c.ingestTokens.findOne({ name: 'default' }))?.scopes).toEqual(['logs', 'traces', 'metrics']);
  expect((await db.c.ingestTokens.findOne({ name: 'both' }))?.scopes).toEqual(['logs', 'deployments']);
  expect((await send('/v1/json-logs', tokens.both)).statusCode).toBe(200);
});
