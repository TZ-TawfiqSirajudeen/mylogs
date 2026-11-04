import { DeploymentWrite, normalizeHttpsUrl, DEPLOYMENT_LIMITS } from '@nexus/contracts';
import { AuditService, type Database, type IncidentDoc } from '@nexus/database';
import { freshTestDatabase, startTestMongo } from '@nexus/database/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { affectedServices, deploymentPrecedesIncident } from './correlate.js';
import { canProgress, DeploymentError, DeploymentService, toDeploymentDto, type DeploymentActor, type WriteInput, type WriteScope } from './service.js';

let mongo: Awaited<ReturnType<typeof startTestMongo>>;
let db: Database;
let svc: DeploymentService;
let clock = new Date('2026-11-04T12:00:00.000Z');
const NOW = () => clock;

const ORG = 'org-a', PROJECT = 'proj-1', ENV_DEV = 'env-dev', ENV_PROD = 'env-prod';
const FOREIGN = { orgId: 'org-b', projectId: 'proj-x', environmentId: 'env-foreign' };
const dev: WriteScope = { orgId: ORG, projectId: PROJECT, environmentId: ENV_DEV };
const prod: WriteScope = { orgId: ORG, projectId: PROJECT, environmentId: ENV_PROD };
const tokenActor: DeploymentActor = { type: 'token', id: 'tok-1', name: 'ci-dev' };
const userActor: DeploymentActor = { type: 'user', id: 'user-1', name: 'Erin Engineer' };
const ctx = { requestId: 'req-deploy-01' };
const input = (over: Partial<WriteInput> = {}): WriteInput => ({ service: 'checkout', version: '1.2.3', status: 'succeeded', ...over });
const minutesAgo = (m: number) => new Date(clock.getTime() - m * 60_000).toISOString();
const readScope = (envs: string[]) => ({ orgId: ORG, projectId: PROJECT, environmentIds: envs });
const fails = async (p: Promise<unknown>, status: number, code?: string) => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(DeploymentError);
  expect((e as DeploymentError).status).toBe(status);
  if (code) expect((e as DeploymentError).code).toBe(code);
};

beforeAll(async () => {
  mongo = await startTestMongo();
  db = await freshTestDatabase(mongo.uri);
  svc = new DeploymentService(db, new AuditService(db), NOW);
  const now = new Date();
  await db.c.environments.insertMany([
    { _id: ENV_DEV, orgId: ORG, projectId: PROJECT, slug: 'dev', name: 'Dev', isProduction: false, createdAt: now },
    { _id: ENV_PROD, orgId: ORG, projectId: PROJECT, slug: 'prod', name: 'Prod', isProduction: true, createdAt: now },
    { _id: FOREIGN.environmentId, orgId: FOREIGN.orgId, projectId: FOREIGN.projectId, slug: 'f', name: 'F', isProduction: false, createdAt: now },
  ]);
}, 300_000);
afterAll(async () => { await db?.close(); await mongo?.stop(); });

describe('input validation (the shared contract)', () => {
  const ok = { service: 'checkout', version: '1.0.0', status: 'succeeded' };
  const parse = (o: object) => DeploymentWrite.safeParse({ ...ok, ...o });

  test('a minimal and a full body are accepted', () => {
    expect(parse({}).success).toBe(true);
    expect(parse({ commitSha: 'ABCDEF1', startedAt: '2026-11-04T10:00:00Z', finishedAt: '2026-11-04T10:05:00+01:00', notes: 'line1\nline2\ttab', linkUrl: 'https://ci.example.com/run/1', triggeredBy: 'octocat', idempotencyKey: 'gh-123/1:build' }).success).toBe(true);
  });
  test('required fields, status values and unknown fields are refused', () => {
    expect(DeploymentWrite.safeParse({ version: '1', status: 'succeeded' }).success).toBe(false);
    expect(DeploymentWrite.safeParse({ service: 's', version: '1' }).success).toBe(false);
    expect(parse({ status: 'done' }).success).toBe(false);
    expect(parse({ orgId: 'x' }).success).toBe(false); // strict: a tenant field is never accepted as "just ignored"
    expect(parse({ service: '   ' }).success).toBe(false);
  });
  test('length caps hold at the boundary', () => {
    expect(parse({ service: 'a'.repeat(128) }).success).toBe(true);
    expect(parse({ service: 'a'.repeat(129) }).success).toBe(false);
    expect(parse({ version: 'v'.repeat(129) }).success).toBe(false);
    expect(parse({ notes: 'n'.repeat(DEPLOYMENT_LIMITS.notes) }).success).toBe(true);
    expect(parse({ notes: 'n'.repeat(DEPLOYMENT_LIMITS.notes + 1) }).success).toBe(false);
    expect(parse({ triggeredBy: 't'.repeat(101) }).success).toBe(false);
    expect(parse({ idempotencyKey: 'k'.repeat(129) }).success).toBe(false);
  });
  test('control characters and bidirectional overrides are refused; tab and newline are allowed in notes only', () => {
    expect(parse({ service: 'chec\u0000kout' }).success).toBe(false);
    expect(parse({ service: 'a\nb' }).success).toBe(false);
    expect(parse({ version: '1.0‮0' }).success).toBe(false);
    expect(parse({ notes: 'a\u0007b' }).success).toBe(false);
    expect(parse({ notes: 'a‮b' }).success).toBe(false);
    expect(parse({ notes: 'a\nb\tc' }).success).toBe(true);
  });
  test('the commit sha is hexadecimal only', () => {
    for (const bad of ['xyz1234', 'abc', 'abcdefg', 'a'.repeat(65), '<script>']) expect(parse({ commitSha: bad }).success, bad).toBe(false);
  });
  test('only https links are accepted: javascript:, data:, http:, ftp:, file:, protocol-relative, credentials, whitespace', () => {
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>', 'http://ci.example.com/run', 'ftp://ci.example.com', 'file:///etc/passwd',
      '//ci.example.com/run', 'https://user:pw@ci.example.com/run', 'https://user@ci.example.com', 'https://ci.example.com/a b', 'https://', 'not a url', ' https://ci.example.com', 'https://ci.example.com/\u0000'])
      expect(parse({ linkUrl: bad }).success, bad).toBe(false);
    expect(parse({ linkUrl: `https://ci.example.com/${'a'.repeat(2000)}` }).success).toBe(false);
    expect(normalizeHttpsUrl('https://CI.example.com/run?id=1#x')).toBe('https://ci.example.com/run?id=1#x');
    expect(normalizeHttpsUrl('https://127.0.0.1:8443/run')).toBe('https://127.0.0.1:8443/run'); // never fetched, so an internal host is only a link
  });
  test('timestamps need an ISO date-time', () => {
    expect(parse({ startedAt: 'yesterday' }).success).toBe(false);
    expect(parse({ startedAt: '2026-11-04' }).success).toBe(false);
  });
});

describe('status transitions', () => {
  test('the table', () => {
    expect(canProgress('started', 'succeeded') && canProgress('started', 'failed') && canProgress('started', 'rolled_back')).toBe(true);
    expect(canProgress('succeeded', 'rolled_back') && canProgress('failed', 'rolled_back')).toBe(true);
    for (const [a, b] of [['succeeded', 'started'], ['succeeded', 'failed'], ['failed', 'succeeded'], ['rolled_back', 'succeeded'], ['rolled_back', 'started'], ['started', 'started']] as const) expect(canProgress(a, b), `${a}->${b}`).toBe(false);
  });
});

describe('recording', () => {
  test('a first write creates; tenant fields and the actor come from the caller; defaults are explicit', async () => {
    const r = await svc.record(dev, tokenActor, input({ commitSha: 'ABCDEF1234', notes: 'hello', linkUrl: 'https://ci.example.com/1', triggeredBy: 'octocat' }), ctx);
    expect(r.outcome).toBe('created');
    const d = r.deployment;
    expect(d).toMatchObject({ orgId: ORG, projectId: PROJECT, environmentId: ENV_DEV, service: 'checkout', version: '1.2.3', status: 'succeeded', commitSha: 'abcdef1234', notes: 'hello', triggeredBy: 'octocat' });
    expect(d.actor).toEqual(tokenActor);
    expect(d.startedAt).toEqual(clock);
    expect(d.finishedAt).toEqual(clock);
    expect(d.expireAt.getTime()).toBe(clock.getTime() + 365 * 86_400_000);
    expect(toDeploymentDto(d)).toMatchObject({ durationMs: 0, actor: { type: 'token', name: 'ci-dev' } });
    expect(JSON.stringify(toDeploymentDto(d))).not.toContain('tok-1'); // the token id is not exposed
  });

  test('a started deployment has no finish time; finishedAt with started is refused', async () => {
    const r = await svc.record(dev, userActor, input({ service: 'billing', status: 'started' }), ctx);
    expect(r.deployment.finishedAt).toBeNull();
    expect(toDeploymentDto(r.deployment).durationMs).toBeNull();
    await fails(svc.record(dev, userActor, input({ service: 'billing', status: 'started', finishedAt: minutesAgo(1) }), ctx), 400, 'invalid_time');
  });

  test('time bounds: too old, in the future, finish before start', async () => {
    await fails(svc.record(dev, tokenActor, input({ startedAt: new Date(clock.getTime() - 91 * 86_400_000).toISOString() }), ctx), 400, 'invalid_time');
    await fails(svc.record(dev, tokenActor, input({ startedAt: new Date(clock.getTime() + 6 * 60_000).toISOString() }), ctx), 400, 'invalid_time');
    await svc.record(dev, tokenActor, input({ service: 'skew', startedAt: new Date(clock.getTime() + 4 * 60_000).toISOString() }), ctx); // clock skew up to 5 minutes is tolerated
    await fails(svc.record(dev, tokenActor, input({ startedAt: minutesAgo(10), finishedAt: minutesAgo(11) }), ctx), 400, 'invalid_time');
    await fails(svc.record(dev, tokenActor, input({ startedAt: minutesAgo(10), finishedAt: new Date(clock.getTime() + 6 * 60_000).toISOString() }), ctx), 400, 'invalid_time');
  });

  test('markup in text fields is stored inert, exactly as sent; credentials in notes are scrubbed', async () => {
    const xss = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const r = await svc.record(dev, tokenActor, input({ service: xss, version: '"><svg onload=alert(3)>', notes: `${xss} password=hunter2hunter2 token: abcd1234efgh5678`, triggeredBy: '<b>me</b>' }), ctx);
    const d = toDeploymentDto(r.deployment);
    expect(d.service).toBe(xss);
    expect(d.version).toBe('"><svg onload=alert(3)>');
    expect(d.notes).toContain(xss);
    expect(d.notes).not.toContain('hunter2hunter2');
    expect(d.notes).not.toContain('abcd1234efgh5678');
    expect(d.triggeredBy).toBe('<b>me</b>');
  });

  test('a missing environment, or one of another project, is a 404', async () => {
    await fails(svc.record({ ...dev, environmentId: 'nope' }, tokenActor, input(), ctx), 404);
    await fails(svc.record({ ...dev, projectId: 'other-project' }, tokenActor, input(), ctx), 404); // the environment belongs to PROJECT
    await fails(svc.record({ ...dev, orgId: 'org-b' }, tokenActor, input(), ctx), 404);
  });

  test('every write is audited without notes or link; a token is a system actor that carries its id', async () => {
    const r = await svc.record(dev, tokenActor, input({ service: 'audited', notes: 'private note', linkUrl: 'https://ci.example.com/secret-run' }), ctx);
    const ev = await db.c.auditEvents.findOne({ targetId: r.deployment._id });
    expect(ev).toMatchObject({ action: 'deployment.recorded', actorType: 'system', actorUserId: null, projectId: PROJECT, environmentId: ENV_DEV });
    expect(ev?.metadata).toMatchObject({ service: 'audited', version: '1.2.3', status: 'succeeded', senderId: 'tok-1', senderName: 'ci-dev' });
    expect(JSON.stringify(ev?.metadata)).not.toContain('private note');
    expect(JSON.stringify(ev?.metadata)).not.toContain('secret-run');
    const u = await svc.record(dev, userActor, input({ service: 'audited-by-user' }), ctx);
    expect(await db.c.auditEvents.findOne({ targetId: u.deployment._id })).toMatchObject({ actorType: 'user', actorUserId: 'user-1' });
  });
});

describe('idempotency', () => {
  test('the same key and identity is the same deployment: an identical replay changes nothing', async () => {
    const a = await svc.record(dev, tokenActor, input({ service: 'idem-1', idempotencyKey: 'run-1' }), ctx);
    const b = await svc.record(dev, tokenActor, input({ service: 'idem-1', idempotencyKey: 'run-1' }), ctx);
    expect(a.outcome).toBe('created');
    expect(b.outcome).toBe('unchanged');
    expect(b.deployment._id).toBe(a.deployment._id);
    expect(await db.c.deployments.countDocuments({ service: 'idem-1' })).toBe(1);
    expect(await db.c.auditEvents.countDocuments({ targetId: a.deployment._id })).toBe(1); // the replay is not a second audit event
  });

  test('a replay with another startedAt is still the same deployment (a retry recomputes "now")', async () => {
    const a = await svc.record(dev, tokenActor, input({ service: 'idem-time', idempotencyKey: 'run-t', startedAt: minutesAgo(5) }), ctx);
    const b = await svc.record(dev, tokenActor, input({ service: 'idem-time', idempotencyKey: 'run-t', startedAt: minutesAgo(1) }), ctx);
    expect(b.outcome).toBe('unchanged');
    expect(b.deployment.startedAt).toEqual(a.deployment.startedAt);
  });

  test('started then succeeded with the same key is one record that progresses', async () => {
    const a = await svc.record(dev, tokenActor, input({ service: 'idem-2', status: 'started', idempotencyKey: 'run-2' }), ctx);
    clock = new Date(clock.getTime() + 90_000);
    const b = await svc.record(dev, tokenActor, input({ service: 'idem-2', status: 'succeeded', idempotencyKey: 'run-2', notes: 'done' }), ctx);
    expect(b.outcome).toBe('updated');
    expect(b.deployment._id).toBe(a.deployment._id);
    expect(b.deployment.status).toBe('succeeded');
    expect(b.deployment.finishedAt).toEqual(clock);
    expect(b.deployment.notes).toBe('done');
    expect(toDeploymentDto(b.deployment).durationMs).toBe(90_000);
    expect(await db.c.deployments.countDocuments({ service: 'idem-2' })).toBe(1);
    const events = await db.c.auditEvents.find({ targetId: a.deployment._id }).sort({ seq: 1 }).toArray();
    expect(events.map((e) => e.action)).toEqual(['deployment.recorded', 'deployment.updated']);
    expect(events[1]!.metadata).toMatchObject({ from: 'started', status: 'succeeded' });
    // then a later rollback is allowed, going back is not
    expect((await svc.record(dev, tokenActor, input({ service: 'idem-2', status: 'rolled_back', idempotencyKey: 'run-2' }), ctx)).outcome).toBe('updated');
    await fails(svc.record(dev, tokenActor, input({ service: 'idem-2', status: 'succeeded', idempotencyKey: 'run-2' }), ctx), 409, 'invalid_transition');
    await fails(svc.record(dev, tokenActor, input({ service: 'idem-2', status: 'started', idempotencyKey: 'run-2' }), ctx), 409, 'invalid_transition');
  });

  test('the same key with a different service, version or commit is a conflict, never an overwrite', async () => {
    await svc.record(dev, tokenActor, input({ service: 'idem-3', idempotencyKey: 'run-3', commitSha: 'abcdef1' }), ctx);
    await fails(svc.record(dev, tokenActor, input({ service: 'other', idempotencyKey: 'run-3' }), ctx), 409, 'idempotency_conflict');
    await fails(svc.record(dev, tokenActor, input({ service: 'idem-3', version: '9.9.9', idempotencyKey: 'run-3' }), ctx), 409, 'idempotency_conflict');
    await fails(svc.record(dev, tokenActor, input({ service: 'idem-3', idempotencyKey: 'run-3', commitSha: '1234567' }), ctx), 409, 'idempotency_conflict');
    expect((await svc.record(dev, tokenActor, input({ service: 'idem-3', idempotencyKey: 'run-3' }), ctx)).outcome).toBe('unchanged'); // a replay that omits the commit is fine
  });

  test('keys are per environment and per tenant: the same key elsewhere is a different deployment', async () => {
    const a = await svc.record(dev, tokenActor, input({ service: 'idem-4', idempotencyKey: 'shared-key' }), ctx);
    const b = await svc.record(prod, tokenActor, input({ service: 'idem-4', idempotencyKey: 'shared-key' }), ctx);
    const c = await svc.record(FOREIGN, tokenActor, input({ service: 'idem-4', idempotencyKey: 'shared-key' }), ctx);
    expect(new Set([a.deployment._id, b.deployment._id, c.deployment._id]).size).toBe(3);
    expect([a.outcome, b.outcome, c.outcome]).toEqual(['created', 'created', 'created']);
  });

  test('without a key nothing is de-duplicated', async () => {
    await svc.record(dev, tokenActor, input({ service: 'no-key' }), ctx);
    await svc.record(dev, tokenActor, input({ service: 'no-key' }), ctx);
    expect(await db.c.deployments.countDocuments({ service: 'no-key' })).toBe(2);
  });

  test('concurrent first writes with one key create exactly one record, and every caller gets an answer', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => svc.record(dev, tokenActor, input({ service: 'race', idempotencyKey: 'race-1', status: 'started' }), ctx)));
    expect(new Set(results.map((r) => r.deployment._id)).size).toBe(1);
    expect(results.filter((r) => r.outcome === 'created')).toHaveLength(1);
    expect(await db.c.deployments.countDocuments({ service: 'race' })).toBe(1);
  });

  test('concurrent progress to the same state applies once', async () => {
    await svc.record(dev, tokenActor, input({ service: 'race2', idempotencyKey: 'race-2', status: 'started' }), ctx);
    const results = await Promise.all(Array.from({ length: 8 }, () => svc.record(dev, tokenActor, input({ service: 'race2', idempotencyKey: 'race-2', status: 'succeeded' }), ctx)));
    expect(results.filter((r) => r.outcome === 'updated')).toHaveLength(1);
    expect(results.every((r) => r.deployment.status === 'succeeded')).toBe(true);
    expect(await db.c.auditEvents.countDocuments({ action: 'deployment.updated', targetId: results[0]!.deployment._id })).toBe(1);
  });
});

describe('per-environment write cap', () => {
  test('beyond the daily cap an environment refuses new records (429) and other environments are unaffected', async () => {
    expect(DEPLOYMENT_LIMITS.perEnvironmentPerDay).toBe(2000);
    const env = 'env-cap';
    await db.c.environments.insertOne({ _id: env, orgId: ORG, projectId: PROJECT, slug: 'cap', name: 'Cap', isProduction: false, createdAt: new Date() });
    const rows = Array.from({ length: DEPLOYMENT_LIMITS.perEnvironmentPerDay }, (_, i) => ({
      _id: `cap-${i}`, orgId: ORG, projectId: PROJECT, environmentId: env, service: 'bulk', version: String(i), commitSha: null, status: 'succeeded' as const,
      startedAt: new Date(clock.getTime() - 60_000), finishedAt: null, notes: null, linkUrl: null, triggeredBy: null, actor: tokenActor, idempotencyKey: null,
      createdAt: clock, updatedAt: clock, expireAt: new Date(clock.getTime() + 86_400_000),
    }));
    await db.c.deployments.insertMany(rows);
    await fails(svc.record({ ...dev, environmentId: env }, tokenActor, input(), ctx), 429, 'environment_limit');
    expect((await svc.record(dev, tokenActor, input({ service: 'unaffected' }), ctx)).outcome).toBe('created');
  }, 60_000);
});

describe('reading', () => {
  beforeAll(async () => {
    // A known set in a quiet service name space.
    const base = new Date('2026-11-04T09:00:00.000Z').getTime();
    const rows: [WriteScope, string, string, 'started' | 'succeeded' | 'failed' | 'rolled_back', number][] = [
      [dev, 'list-a', '1.0.0', 'succeeded', 0], [dev, 'list-a', '1.1.0', 'failed', 10], [dev, 'list-b', '2.0.0', 'succeeded', 20],
      [prod, 'list-a', '1.0.0', 'succeeded', 30], [prod, 'list-b', '2.0.0', 'rolled_back', 40], [prod, 'list-b', '2.1.0', 'succeeded', 50],
    ];
    for (const [scope, service, version, status, plusMin] of rows) {
      await svc.record(scope, tokenActor, { service, version, status, startedAt: new Date(base + plusMin * 60_000).toISOString(), finishedAt: new Date(base + plusMin * 60_000 + 60_000).toISOString() }, ctx);
    }
    await svc.record(FOREIGN, tokenActor, input({ service: 'list-a', version: 'foreign', startedAt: new Date(base + 5 * 60_000).toISOString() }), ctx);
  });
  const only = <T extends { service: string }>(items: T[]): T[] => items.filter((d) => d.service.startsWith('list-'));
  const q = (o: object = {}) => ({ limit: 50, ...o });

  test('newest first across the environments the caller may read, never another tenant', async () => {
    const all = await svc.list(readScope([ENV_DEV, ENV_PROD]), q({ service: undefined }));
    const mine = only(all.items);
    expect(mine.map((d) => d.version)).toEqual(['2.1.0', '2.0.0', '1.0.0', '2.0.0', '1.1.0', '1.0.0']);
    expect(mine.some((d) => d.version === 'foreign')).toBe(false);
  });
  test('an environment-restricted caller sees only their environments, even when they ask for another', async () => {
    const onlyDev = await svc.list(readScope([ENV_DEV]), q());
    expect(only(onlyDev.items).every((d) => d.environmentId === ENV_DEV)).toBe(true);
    expect(await svc.list(readScope([ENV_DEV]), q({ environmentId: ENV_PROD }))).toEqual({ items: [], nextCursor: null });
    expect(await svc.list(readScope([]), q())).toEqual({ items: [], nextCursor: null });
  });
  test('filters: service, status, environment, time range', async () => {
    const both = readScope([ENV_DEV, ENV_PROD]);
    expect((await svc.list(both, q({ service: 'list-b' }))).items.map((d) => d.version)).toEqual(['2.1.0', '2.0.0', '2.0.0']);
    expect((await svc.list(both, q({ service: 'list-a', status: 'failed' }))).items.map((d) => d.version)).toEqual(['1.1.0']);
    expect((await svc.list(both, q({ environmentId: ENV_PROD, service: 'list-b' }))).items.map((d) => d.version)).toEqual(['2.1.0', '2.0.0']);
    const win = await svc.list(both, q({ service: 'list-a', from: '2026-11-04T09:05:00.000Z', to: '2026-11-04T09:35:00.000Z' }));
    expect(win.items.map((d) => d.version)).toEqual(['1.0.0', '1.1.0']);
    await fails(svc.list(both, q({ from: '2026-11-05T00:00:00.000Z', to: '2026-11-04T00:00:00.000Z' })), 400, 'invalid_range');
  });
  test('keyset pagination visits every record once, in order, with a stable cursor', async () => {
    const both = readScope([ENV_DEV, ENV_PROD]);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await svc.list(both, q({ service: 'list-a', limit: 2, cursor }));
      seen.push(...page.items.map((d) => `${d.environmentId}/${d.version}`));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual([`${ENV_PROD}/1.0.0`, `${ENV_DEV}/1.1.0`, `${ENV_DEV}/1.0.0`]);
    await fails(svc.list(both, q({ cursor: '!!!' })), 400, 'invalid_cursor');
  });
  test('get: another tenant, another environment and an unknown id are all the same 404', async () => {
    const { items } = await svc.list(readScope([ENV_DEV, ENV_PROD]), q({ service: 'list-a', environmentId: ENV_PROD }));
    const prodId = items[0]!._id;
    expect((await svc.get(readScope([ENV_DEV, ENV_PROD]), prodId))._id).toBe(prodId);
    await fails(svc.get(readScope([ENV_DEV]), prodId), 404, 'not_found');
    await fails(svc.get({ ...readScope([ENV_DEV, ENV_PROD]), orgId: 'org-b' }, prodId), 404, 'not_found');
    await fails(svc.get(readScope([ENV_DEV, ENV_PROD]), 'does-not-exist'), 404, 'not_found');
  });
  test('markers: bounded window, scoped, no notes or links, oldest first', async () => {
    const both = readScope([ENV_DEV, ENV_PROD]);
    const m = await svc.markers(both, { from: '2026-11-04T09:00:00.000Z', to: '2026-11-04T09:25:00.000Z', service: 'list-a' });
    expect(m.items.map((x) => x.version)).toEqual(['1.0.0', '1.1.0']);
    expect(Object.keys(m.items[0]!).sort()).toEqual(['at', 'environmentId', 'finishedAt', 'id', 'service', 'status', 'version']);
    expect((await svc.markers(readScope([ENV_DEV]), { from: '2026-11-04T09:00:00.000Z', to: '2026-11-04T10:00:00.000Z', service: 'list-b' })).items.map((x) => x.version)).toEqual(['2.0.0']);
    await fails(svc.markers(both, { from: '2026-11-04T10:00:00.000Z', to: '2026-11-04T09:00:00.000Z' }), 400, 'invalid_range');
    await fails(svc.markers(both, { from: '2026-09-01T00:00:00.000Z', to: '2026-11-04T09:00:00.000Z' }), 400, 'invalid_range');
  });
  test('the marker cap is honest: the newest 200 are returned and the response says it was truncated', async () => {
    const env = 'env-many';
    await db.c.environments.insertOne({ _id: env, orgId: ORG, projectId: PROJECT, slug: 'many', name: 'Many', isProduction: false, createdAt: new Date() });
    const t0 = new Date('2026-10-01T00:00:00.000Z').getTime();
    await db.c.deployments.insertMany(Array.from({ length: 205 }, (_, i) => ({
      _id: `many-${i}`, orgId: ORG, projectId: PROJECT, environmentId: env, service: 'many', version: String(i), commitSha: null, status: 'succeeded' as const,
      startedAt: new Date(t0 + i * 60_000), finishedAt: null, notes: null, linkUrl: null, triggeredBy: null, actor: tokenActor, idempotencyKey: null,
      createdAt: clock, updatedAt: clock, expireAt: new Date(t0 + 400 * 86_400_000),
    })));
    const m = await svc.markers({ orgId: ORG, projectId: PROJECT, environmentIds: [env] }, { from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' });
    expect(m.truncated).toBe(true);
    expect(m.items).toHaveLength(200);
    expect(m.items[0]!.version).toBe('5');
    expect(m.items.at(-1)!.version).toBe('204');
  });
});

describe('query plans', () => {
  test('lists, filtered lists and markers use an index and never an in-memory sort', async () => {
    const both = [ENV_DEV, ENV_PROD];
    const stages = (p: { queryPlanner?: { winningPlan?: unknown } }): string[] => JSON.stringify(p.queryPlanner?.winningPlan ?? p).match(/"stage":"[A-Z_]+"/g)?.map((x) => x.slice(9, -1)) ?? [];
    const plans = {
      list: db.c.deployments.find({ orgId: ORG, projectId: PROJECT, environmentId: { $in: both } }).sort({ startedAt: -1, _id: -1 }).limit(51),
      byService: db.c.deployments.find({ orgId: ORG, projectId: PROJECT, environmentId: { $in: both }, service: 'list-a' }).sort({ startedAt: -1, _id: -1 }).limit(51),
      oneEnv: db.c.deployments.find({ orgId: ORG, projectId: PROJECT, environmentId: ENV_DEV, startedAt: { $gte: new Date(0) } }).sort({ startedAt: -1, _id: -1 }).limit(51),
    };
    for (const [name, cursor] of Object.entries(plans)) {
      const s = stages((await cursor.explain('queryPlanner')) as never);
      expect(s, name).toContain('IXSCAN');
      expect(s, name).not.toContain('COLLSCAN');
      expect(s, name).not.toContain('SORT');
    }
  });
  test('the idempotency index is unique only for records that carry a key, and the TTL index is on expireAt', async () => {
    const idx = await db.c.deployments.indexes();
    const uq = idx.find((i) => i.name === 'dep_idem_uq')!;
    expect(uq.unique).toBe(true);
    expect(uq.partialFilterExpression).toEqual({ idempotencyKey: { $type: 'string' } });
    expect(idx.find((i) => i.name === 'dep_ttl')).toMatchObject({ expireAfterSeconds: 0, key: { expireAt: 1 } });
  });
});

describe('correlation with incidents', () => {
  const open = new Date('2026-11-04T12:00:00.000Z');
  const dep = (startMin: number, endMin: number | null) => ({ startedAt: new Date(open.getTime() + startMin * 60_000), finishedAt: endMin === null ? null : new Date(open.getTime() + endMin * 60_000) });

  test('the 30 minute window: inclusive boundary, nothing after the incident, in-flight rollouts count', () => {
    expect(deploymentPrecedesIncident(dep(-10, -9), open)).toBe(true);
    expect(deploymentPrecedesIncident(dep(-30, -30), open)).toBe(true); // exactly 30 minutes before
    expect(deploymentPrecedesIncident(dep(-31, -31), open)).toBe(false);
    expect(deploymentPrecedesIncident(dep(-31, null), open)).toBe(false); // still "started" and old
    expect(deploymentPrecedesIncident(dep(-45, -20), open)).toBe(true); // a long rollout that ended inside the window
    expect(deploymentPrecedesIncident(dep(-5, 3), open)).toBe(true); // in flight when the incident opened
    expect(deploymentPrecedesIncident(dep(0, 0), open)).toBe(true);
    expect(deploymentPrecedesIncident(dep(1, 2), open)).toBe(false); // deployed AFTER the incident opened
    expect(deploymentPrecedesIncident(dep(-100, -50), open, 60 * 60_000)).toBe(true); // the window is a parameter
  });
  test('affected services: the rule\'s service filter and the group label, nothing else', () => {
    expect(affectedServices({ kind: 'metric', metric: 'm', service: 'checkout' }, {})).toEqual(['checkout']);
    expect(affectedServices({ kind: 'metric', metric: 'm' }, { service: 'billing' })).toEqual(['billing']);
    expect(affectedServices({ kind: 'logs', services: ['b', 'a'] }, { service: 'a', host: 'h1' })).toEqual(['a', 'b']);
    expect(affectedServices({ kind: 'metric', metric: 'm' }, { host: 'h1' })).toEqual([]);
    expect(affectedServices(null, undefined)).toEqual([]);
    expect(affectedServices({ kind: 'logs', services: [1, '', '  ', 'x'] as never }, {})).toEqual(['x']);
  });

  const incident = (over: Partial<IncidentDoc> = {}): IncidentDoc => ({
    _id: crypto.randomUUID(), orgId: ORG, projectId: PROJECT, environmentId: ENV_PROD, ruleId: 'rule-1', ruleName: 'High latency', severity: 'critical', title: 'High latency',
    groupKey: '', groupLabels: {}, status: 'open', active: true, openedAt: open, acknowledgedAt: null, acknowledgedBy: null, resolvedAt: null, resolvedBy: null, lastValue: 1,
    condition: { op: 'gt', threshold: 1, windowSeconds: 300 }, timeline: [], commentCount: 0, eventCount: 0, expireAt: null, ...over,
  });
  const rule = (id: string, query: Record<string, unknown>) => ({ _id: id, kind: 'rule' as const, orgId: ORG, projectId: PROJECT, environmentId: ENV_PROD, name: id, query }) as never;

  test('forIncident returns deployments of the incident\'s services in its environment within the window, with the fixed wording', async () => {
    await db.c.alertConfig.insertOne(rule('rule-1', { kind: 'metric', metric: 'http.server.request.duration', service: 'corr-svc' }));
    const at = (min: number) => new Date(open.getTime() + min * 60_000).toISOString();
    const rec = (scope: WriteScope, service: string, version: string, status: 'succeeded' | 'failed', startMin: number, endMin: number) =>
      svc.record(scope, tokenActor, { service, version, status, startedAt: at(startMin), finishedAt: at(endMin) }, ctx);
    // clock must allow these times
    clock = new Date(open.getTime() + 60 * 60_000);
    await rec(prod, 'corr-svc', 'in-window', 'succeeded', -12, -10);
    await rec(prod, 'corr-svc', 'in-window-failed', 'failed', -25, -24);
    await rec(prod, 'corr-svc', 'too-old', 'succeeded', -50, -45);
    await rec(prod, 'corr-svc', 'after', 'succeeded', 5, 6);
    await rec(prod, 'other-svc', 'other-service', 'succeeded', -5, -4);
    await rec(dev, 'corr-svc', 'other-environment', 'succeeded', -5, -4);
    await rec({ ...FOREIGN }, 'corr-svc', 'foreign', 'succeeded', -5, -4);
    const inc = incident();
    await db.c.incidents.insertOne(inc);

    const res = await svc.forIncident(readScope([ENV_PROD]), inc._id);
    expect(res.services).toEqual(['corr-svc']);
    expect(res.windowMinutes).toBe(30);
    expect(res.items.map((d) => d.version)).toEqual(['in-window-failed', 'in-window']); // oldest first
    expect(res.note).toBe('Deployed shortly before; correlation, not proof of cause.');
    expect(JSON.stringify(res)).not.toMatch(/caused|root cause|because/i);

    // The caller cannot read the incident's environment, or it is another tenant's: the incident does not exist for them.
    await fails(svc.forIncident(readScope([ENV_DEV]), inc._id), 404, 'not_found');
    await fails(svc.forIncident({ ...readScope([ENV_PROD]), orgId: 'org-b' }, inc._id), 404, 'not_found');
    await fails(svc.forIncident(readScope([ENV_PROD]), 'no-such-incident'), 404, 'not_found');
  });

  test('a rule that names no service gets no correlation (and the group label alone is enough when present)', async () => {
    await db.c.alertConfig.insertOne(rule('rule-2', { kind: 'metric', metric: 'cpu' }));
    const none = incident({ ruleId: 'rule-2' });
    await db.c.incidents.insertOne(none);
    expect(await svc.forIncident(readScope([ENV_PROD]), none._id)).toMatchObject({ services: [], items: [] });
    const grouped = incident({ ruleId: 'rule-2', groupKey: 'service=corr-svc', groupLabels: { service: 'corr-svc' } });
    await db.c.incidents.insertOne(grouped);
    expect((await svc.forIncident(readScope([ENV_PROD]), grouped._id)).items.length).toBeGreaterThan(0);
    // a deleted rule still works from the group labels
    const orphan = incident({ ruleId: 'rule-gone', groupLabels: { service: 'corr-svc' } });
    await db.c.incidents.insertOne(orphan);
    expect((await svc.forIncident(readScope([ENV_PROD]), orphan._id)).services).toEqual(['corr-svc']);
  });
});
