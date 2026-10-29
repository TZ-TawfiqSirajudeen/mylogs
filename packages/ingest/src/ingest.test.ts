import { createHash } from 'node:crypto';
import { AuditService, type Database, type IngestTokenDoc, type LogDoc } from '@nexus/database';
import { freshTestDatabase, startTestMongo } from '@nexus/database/testing';
import { MongoLogStore, type LogStore } from '@nexus/logstore';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { DEFAULT_INGEST_CONFIG, IngestPipeline, type IngestConfig } from './pipeline.js';
import { Gate, RateLimiter } from './quota.js';
import { readIngestStats } from './stats.js';
import { IngestTokenService, TokenCreate, TokenError, type TokenScope } from './tokens.js';

let mongo: Awaited<ReturnType<typeof startTestMongo>>;
let db: Database;
let tokens: IngestTokenService;
let store: MongoLogStore;

const ORG = 'org-a', PROJECT = 'proj-1', ENV_A = 'env-a', ENV_B = 'env-b';
const scope: TokenScope = { orgId: ORG, projectId: PROJECT, environmentIds: null };
const actor = { userId: 'user-1', ctx: { requestId: 'req-ingest-01' } };
const NOW = new Date();
const nsOf = (ms: number) => String(BigInt(ms) * 1_000_000n);
const hashOf = (s: string) => createHash('sha256').update(s).digest('hex');

const otlp = (records: object[], resource: object[] = [{ key: 'service.name', value: { stringValue: 'checkout' } }]) => ({
  resourceLogs: [{ resource: { attributes: resource }, scopeLogs: [{ scope: { name: 'app' }, logRecords: records }] }],
});
const rec = (msg: string, over: object = {}) => ({ timeUnixNano: nsOf(NOW.getTime() - 1000), severityNumber: 9, body: { stringValue: msg }, ...over });
const input = (payload: unknown, body = JSON.stringify(payload)) => ({ format: 'otlp' as const, payload, bodyBytes: body.length, bodyHash: hashOf(body) });

async function newToken(env = ENV_A, over: Partial<TokenCreate> = {}, name = `tok-${Math.random().toString(36).slice(2, 7)}`): Promise<{ raw: string; doc: IngestTokenDoc }> {
  const { token, info } = await tokens.create(scope, env, actor, TokenCreate.parse({ name, ...over }));
  return { raw: token, doc: (await db.c.ingestTokens.findOne({ _id: info.id }))! };
}
const pipe = (cfg: Partial<IngestConfig> = {}, s: LogStore = store, clock: () => Date = () => new Date(), sleep: (ms: number) => Promise<void> = async () => undefined) =>
  new IngestPipeline(db, s, { ...DEFAULT_INGEST_CONFIG, ...cfg }, clock, sleep);

beforeAll(async () => {
  mongo = await startTestMongo();
  db = await freshTestDatabase(mongo.uri);
  tokens = new IngestTokenService(db, new AuditService(db));
  store = new MongoLogStore(db);
  const now = new Date();
  await db.c.environments.insertMany([
    { _id: ENV_A, orgId: ORG, projectId: PROJECT, slug: 'a', name: 'A', isProduction: false, createdAt: now },
    { _id: ENV_B, orgId: ORG, projectId: PROJECT, slug: 'b', name: 'B', isProduction: true, createdAt: now },
    { _id: 'env-foreign', orgId: 'org-b', projectId: 'proj-x', slug: 'f', name: 'F', isProduction: false, createdAt: now },
  ]);
}, 300_000);
afterAll(async () => { await db?.close(); await mongo?.stop(); });

describe('rate limiter and gate', () => {
  test('token bucket: bursts up to the allowance, then refuses with an honest wait, then refills', () => {
    let t = 0;
    const l = new RateLimiter(() => t);
    expect(l.take('k', 600, 600)).toEqual({ ok: true });
    const refused = l.take('k', 60, 600) as { ok: false; retryAfterMs: number };
    expect(refused.ok).toBe(false);
    expect(refused.retryAfterMs).toBeGreaterThanOrEqual(1000);
    t += 6_000; // 600/min = 10/s -> 60 units
    expect(l.take('k', 60, 600)).toEqual({ ok: true });
    expect(l.take('other', 1, 600)).toEqual({ ok: true }); // keys are independent
    expect((l.take('big', 601, 600) as { ok: false }).ok).toBe(false); // can never fit
    l.give('k', 10, 600);
    expect(l.take('k', 10, 600)).toEqual({ ok: true });
  });
  test('gate bounds both running and waiting work', async () => {
    const g = new Gate(2, 1);
    const r1 = await g.acquire(), r2 = await g.acquire();
    expect(g.inflight).toBe(2);
    const waiting = g.acquire();
    await Promise.resolve();
    expect(g.queued).toBe(1);
    expect(await g.acquire()).toBeNull(); // queue full -> backpressure
    r1!();
    const r3 = await waiting;
    expect(r3).not.toBeNull();
    expect(g.inflight).toBe(2); // the slot was handed over, never exceeded
    r2!(); r3!();
    expect(g.inflight).toBe(0);
  });
});

describe('ingestion tokens', () => {
  test('shown once; only a hash is stored; listing never exposes it; audit has no token', async () => {
    const { token, info } = await tokens.create(scope, ENV_A, actor, TokenCreate.parse({ name: 'main' }));
    expect(token).toMatch(/^nxi_[A-Za-z0-9_-]{43}$/);
    expect(info.prefix).toBe(token.slice(0, 8));
    const doc = (await db.c.ingestTokens.findOne({ _id: info.id }))!;
    expect(doc.tokenHash).toBe(hashOf(token));
    expect(JSON.stringify(await db.c.ingestTokens.find({}).toArray())).not.toContain(token);
    expect(JSON.stringify(await tokens.list(scope))).not.toContain(token);
    expect(JSON.stringify(await db.c.auditEvents.find({}).toArray())).not.toContain(token);
    expect((await db.c.auditEvents.findOne({ action: 'ingest_token.created' }))?.actorUserId).toBe('user-1');
  });
  test('authenticate: valid works; malformed, unknown and revoked are all just null', async () => {
    const { raw, doc } = await newToken();
    expect((await tokens.authenticate(raw))?._id).toBe(doc._id);
    for (const bad of [undefined, '', 'nxi_short', `nxi_${'a'.repeat(43)}`, raw.slice(0, -1), raw.toUpperCase(), `${raw} `]) expect(await tokens.authenticate(bad), String(bad)).toBeNull();
    await tokens.revoke(scope, doc._id, actor);
    expect(await tokens.authenticate(raw)).toBeNull();
    await tokens.revoke(scope, doc._id, actor); // idempotent
  });
  test('scope: other projects/orgs/environments cannot be targeted, listed or revoked', async () => {
    await expect(tokens.create(scope, 'env-foreign', actor, TokenCreate.parse({ name: 'x' }))).rejects.toMatchObject({ status: 404 });
    await expect(tokens.create({ ...scope, environmentIds: [ENV_A] }, ENV_B, actor, TokenCreate.parse({ name: 'x' }))).rejects.toMatchObject({ status: 404 });
    const { doc } = await newToken(ENV_B);
    expect((await tokens.list({ ...scope, environmentIds: [ENV_A] })).some((t) => t.id === doc._id)).toBe(false);
    await expect(tokens.revoke({ ...scope, orgId: 'org-b' }, doc._id, actor)).rejects.toBeInstanceOf(TokenError);
    await expect(tokens.revoke({ ...scope, environmentIds: [ENV_A] }, doc._id, actor)).rejects.toMatchObject({ status: 404 });
    expect((await db.c.ingestTokens.findOne({ _id: doc._id }))?.revokedAt).toBeNull();
  });
  test('bounds: retention, rate and redaction keys are validated; per-environment cap', async () => {
    for (const bad of [{ retentionDays: 0 }, { retentionDays: 91 }, { recordsPerMinute: 5 }, { redaction: { enabled: true, extraKeys: ['bad key!'] } }]) expect(() => TokenCreate.parse({ name: 'x', ...bad })).toThrow();
    const many = new IngestTokenService(db, new AuditService(db));
    await db.c.ingestTokens.deleteMany({ environmentId: ENV_B });
    for (let i = 0; i < 20; i++) await many.create(scope, ENV_B, actor, TokenCreate.parse({ name: `cap-${i}` }));
    await expect(many.create(scope, ENV_B, actor, TokenCreate.parse({ name: 'one too many' }))).rejects.toMatchObject({ status: 409 });
  });
});

describe('pipeline: accepting data', () => {
  test('OTLP records are stored under the TOKEN\'s tenant, whatever the payload claims', async () => {
    const { doc } = await newToken(ENV_A);
    const payload = otlp([rec('hello', { attributes: [{ key: 'deployment.environment', value: { stringValue: 'production' } }, { key: 'orgId', value: { stringValue: 'org-b' } }, { key: 'environmentId', value: { stringValue: ENV_B } }] })]);
    const r = await pipe().handle(doc, input(payload));
    expect(r).toMatchObject({ status: 'ok', accepted: 1, rejected: 0 });
    const stored = (await db.c.logs.findOne({ message: 'hello' }))!;
    expect(stored).toMatchObject({ orgId: ORG, projectId: PROJECT, environmentId: ENV_A, tokenId: doc._id });
    expect(stored.attrs.find((a) => a.k === 'environmentId')?.v).toBe(ENV_B); // kept as data, never used as tenancy
  });

  test('redaction happens BEFORE persistence: the secret never reaches the database', async () => {
    const { doc } = await newToken(ENV_A, { redaction: { enabled: true, extraKeys: ['customer.ssn'] } });
    const secret = 'sk_live_abcdefghijklmnopqrst';
    await pipe().handle(doc, input(otlp([rec(`payment declined using ${secret}`, { attributes: [
      { key: 'http.request.header.authorization', value: { stringValue: 'Bearer abcdefghijklmnop12345' } }, { key: 'customer.ssn', value: { stringValue: '123-45-6789' } },
      { key: 'exception.stacktrace', value: { stringValue: `Error: token=${secret}\n at x` } },
    ] })])));
    const dump = JSON.stringify(await db.c.logs.find({ message: /payment declined/ }).toArray());
    for (const s of [secret, 'abcdefghijklmnop12345', '123-45-6789']) expect(dump).not.toContain(s);
    expect((await db.c.logs.findOne({ message: /payment declined/ }))!.redactions).toBeGreaterThanOrEqual(4);
  });

  test('JSON format works through the same pipeline', async () => {
    const { doc } = await newToken(ENV_A);
    const body = JSON.stringify([{ level: 'error', msg: 'json failure', service: 'api', 'http.response.status_code': 500, time: NOW.toISOString() }]);
    const r = await pipe().handle(doc, { format: 'json', payload: body, bodyBytes: body.length, bodyHash: hashOf(body) });
    expect(r.accepted).toBe(1);
    expect(await db.c.logs.findOne({ message: 'json failure' })).toMatchObject({ severity: 'error', httpStatus: 500, source: 'json', service: 'api' });
  });

  test('retention: expireAt follows the token; records that would expire at once are refused, visibly', async () => {
    const { doc } = await newToken(ENV_A, { retentionDays: 2 });
    const old = NOW.getTime() - 3 * 86400_000;
    const r = await pipe().handle(doc, input(otlp([rec('fresh-ret'), rec('too old for 2d', { timeUnixNano: nsOf(old) })])));
    expect(r).toMatchObject({ status: 'ok', accepted: 1, rejected: 1 });
    const s = (await db.c.logs.findOne({ message: 'fresh-ret' }))!;
    expect(s.expireAt.getTime() - s.ts.getTime()).toBe(2 * 86400_000);
    expect(await db.c.logs.countDocuments({ message: 'too old for 2d' })).toBe(0);
  });

  test('partial success is reported; a request with nothing valid is "invalid"', async () => {
    const { doc } = await newToken(ENV_A);
    const mixed = await pipe().handle(doc, input({ resourceLogs: [{ scopeLogs: [{ logRecords: [null, 'x', { body: { stringValue: 'valid one' } }] }] }] }));
    expect(mixed).toMatchObject({ status: 'ok', accepted: 1, rejected: 2 });
    expect(mixed.message).toBeTruthy();
    const none = await pipe().handle(doc, input({ resourceLogs: [{ scopeLogs: [{ logRecords: [null, 3] }] }] }));
    expect(none).toMatchObject({ status: 'invalid', accepted: 0, rejected: 2 });
    expect(await pipe().handle(doc, input(otlp([])))).toMatchObject({ status: 'ok', accepted: 0, rejected: 0 }); // an empty batch is fine
  });

  test('a retransmitted request is idempotent; different requests with identical lines are both kept', async () => {
    const { doc } = await newToken(ENV_A);
    const payload = otlp([rec('retry me'), rec('retry me 2')]);
    const p = pipe();
    expect(await p.handle(doc, input(payload))).toMatchObject({ accepted: 2, duplicates: 0 });
    expect(await p.handle(doc, input(payload))).toMatchObject({ status: 'ok', accepted: 0, duplicates: 2 });
    expect(await db.c.logs.countDocuments({ message: /^retry me/ })).toBe(2);
    // same text, different request body (e.g. a legitimately repeated line a second later) -> stored separately
    await p.handle(doc, input(otlp([rec('retry me', { timeUnixNano: nsOf(NOW.getTime() - 500) })])));
    expect(await db.c.logs.countDocuments({ message: 'retry me' })).toBe(2);
  });
});

describe('pipeline: protecting the platform', () => {
  test('rate limit per token and per project: refused visibly with Retry-After, counted, and recovers over time', async () => {
    const { doc } = await newToken(ENV_A, { recordsPerMinute: 100 });
    let clock = Date.now();
    const p = pipe({}, store, () => new Date(clock));
    const batch = (tag: string) => otlp(Array.from({ length: 60 }, (_, i) => rec(`${tag} ${i}`, { timeUnixNano: nsOf(clock - 1000) })));
    expect((await p.handle(doc, input(batch('q1')))).status).toBe('ok');
    const refused = await p.handle(doc, input(batch('q2')));
    expect(refused).toMatchObject({ status: 'quota', accepted: 0, rejected: 60 });
    expect(refused.retryAfterMs).toBeGreaterThanOrEqual(1000);
    expect(await db.c.logs.countDocuments({ message: /^q2 / })).toBe(0);
    expect(p.metrics.rejectedQuota).toBe(60);
    clock += 60_000;
    expect((await p.handle(doc, input(batch('q3')))).status).toBe('ok');

    // project ceiling shared across tokens
    const a = (await newToken(ENV_A)).doc, b = (await newToken(ENV_A)).doc;
    const tight = pipe({ projectRecordsPerMinute: 100 });
    expect((await tight.handle(a, input(batch('pa')))).status).toBe('ok');
    expect((await tight.handle(b, input(batch('pb')))).status).toBe('quota');
  });

  test('overload: bounded concurrency and queue; the excess is refused (not dropped silently, not buffered without limit)', async () => {
    const { doc } = await newToken(ENV_A);
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    let active = 0, maxActive = 0;
    const slow: LogStore = Object.assign(Object.create(store) as LogStore, {
      insert: async (docs: LogDoc[]) => { active++; maxActive = Math.max(maxActive, active); await hold; active--; return store.insert(docs); },
    });
    const p = pipe({ maxInflightWrites: 2, maxQueuedWrites: 1 }, slow);
    const calls = Array.from({ length: 5 }, (_, i) => p.handle(doc, input(otlp([rec(`over ${i}`)]))));
    await new Promise((r) => setTimeout(r, 150));
    expect(p.inflight).toBe(2);
    expect(p.queued).toBe(1);
    release();
    const results = await Promise.all(calls);
    expect(results.filter((r) => r.status === 'ok')).toHaveLength(3);
    const over = results.filter((r) => r.status === 'overloaded');
    expect(over).toHaveLength(2);
    expect(over.every((r) => r.retryAfterMs! > 0 && r.rejected === 1)).toBe(true);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(p.metrics.rejectedOverload).toBe(2);
    expect(await db.c.logs.countDocuments({ message: /^over / })).toBe(3);
  });

  test('transient storage errors are retried with backoff and the request still succeeds', async () => {
    const { doc } = await newToken(ENV_A);
    let failures = 2;
    const flaky: LogStore = Object.assign(Object.create(store) as LogStore, {
      insert: async (docs: LogDoc[]) => { if (failures-- > 0) throw new Error('connection reset'); return store.insert(docs); },
    });
    const sleeps: number[] = [];
    const p = pipe({ storeRetries: 3 }, flaky, () => new Date(), async (ms) => { sleeps.push(ms); });
    expect(await p.handle(doc, input(otlp([rec('flaky ok')])))).toMatchObject({ status: 'ok', accepted: 1 });
    expect(p.metrics.storeRetries).toBe(2);
    expect(sleeps).toHaveLength(2);
    expect(await db.c.logs.countDocuments({ message: 'flaky ok' })).toBe(1);
  });

  test('storage down: the sender is told (503 semantics), the loss is counted, and a retry later succeeds without duplicates', async () => {
    const { doc } = await newToken(ENV_A);
    let down = true;
    const outage: LogStore = Object.assign(Object.create(store) as LogStore, {
      insert: async (docs: LogDoc[]) => { if (down) throw new Error('mongo unavailable'); return store.insert(docs); },
    });
    const p = pipe({ storeRetries: 1 }, outage);
    const payload = otlp([rec('during outage 1'), rec('during outage 2')]);
    const r = await p.handle(doc, input(payload));
    expect(r).toMatchObject({ status: 'storage_unavailable', accepted: 0, rejected: 2 });
    expect(r.retryAfterMs).toBeGreaterThan(0);
    expect(p.metrics.rejectedStorage).toBe(2);
    expect(await db.c.logs.countDocuments({ message: /^during outage/ })).toBe(0);
    down = false;
    expect(await p.handle(doc, input(payload))).toMatchObject({ status: 'ok', accepted: 2, duplicates: 0 });
    expect(await db.c.logs.countDocuments({ message: /^during outage/ })).toBe(2);
  });

  test('a failure half-way through a large batch is recovered by retransmission: no loss, no duplicates', async () => {
    const { doc } = await newToken(ENV_A);
    let calls = 0, failFrom: number | null = 2;
    const partial: LogStore = Object.assign(Object.create(store) as LogStore, {
      insert: async (docs: LogDoc[]) => { calls++; if (failFrom !== null && calls >= failFrom) throw new Error('died mid-batch'); return store.insert(docs); },
    });
    const p = pipe({ chunkSize: 2, storeRetries: 0 }, partial);
    const payload = otlp(Array.from({ length: 5 }, (_, i) => rec(`chunked ${i}`)));
    expect((await p.handle(doc, input(payload))).status).toBe('storage_unavailable');
    expect(await db.c.logs.countDocuments({ message: /^chunked / })).toBe(2); // first chunk landed
    failFrom = null;
    const again = await p.handle(doc, input(payload));
    expect(again).toMatchObject({ status: 'ok', accepted: 3, duplicates: 2 });
    expect(await db.c.logs.countDocuments({ message: /^chunked / })).toBe(5);
  });

  test('many concurrent senders: everything stored once, concurrency never exceeds the bound', async () => {
    const { doc } = await newToken(ENV_A, { recordsPerMinute: 1_000_000 });
    let active = 0, maxActive = 0;
    const watched: LogStore = Object.assign(Object.create(store) as LogStore, {
      insert: async (docs: LogDoc[]) => { active++; maxActive = Math.max(maxActive, active); try { return await store.insert(docs); } finally { active--; } },
    });
    const p = pipe({ maxInflightWrites: 4, maxQueuedWrites: 200, tokenRecordsPerMinute: 1_000_000, projectRecordsPerMinute: 1_000_000 }, watched);
    const results = await Promise.all(Array.from({ length: 60 }, (_, i) => p.handle(doc, input(otlp(Array.from({ length: 20 }, (_, j) => rec(`conc ${i}-${j}`)))))));
    expect(results.every((r) => r.status === 'ok')).toBe(true);
    expect(await db.c.logs.countDocuments({ message: /^conc / })).toBe(1200);
    expect(maxActive).toBeLessThanOrEqual(4);
  });
});

describe('ingest statistics (loss is never silent)', () => {
  test('per-environment accepted/refused counts and the last time data arrived', async () => {
    await db.c.ingestStats.deleteMany({});
    const a = (await newToken(ENV_A, { recordsPerMinute: 100 })).doc;
    const p = pipe();
    await p.handle(a, input(otlp([rec('s1'), rec('s2')])));
    await p.handle(a, input({ resourceLogs: [{ scopeLogs: [{ logRecords: [null] }] }] })); // invalid
    await p.handle(a, input(otlp(Array.from({ length: 150 }, (_, i) => rec(`big ${i}`))))); // over quota
    const s = await readIngestStats(db, { orgId: ORG, projectId: PROJECT, environmentIds: [ENV_A, ENV_B] }, 60);
    expect(s.totals.accepted).toBe(2);
    expect(s.totals.rejectedInvalid).toBe(1);
    expect(s.totals.rejectedQuota).toBe(150);
    expect(s.refused).toBe(151);
    const envA = s.perEnvironment.find((e) => e.environmentId === ENV_A)!;
    expect(envA).toMatchObject({ accepted: 2, refused: 151 });
    expect(envA.lastAcceptedAt).toBeTruthy();
    // an environment that never received anything says so: null, not zero-looking "healthy"
    expect(s.perEnvironment.find((e) => e.environmentId === ENV_B)!.lastAcceptedAt).toBeNull();
  });
  test('statistics are tenant scoped', async () => {
    const s = await readIngestStats(db, { orgId: 'org-b', projectId: PROJECT, environmentIds: [ENV_A] }, 60);
    expect(s.totals.accepted).toBe(0);
    expect(s.perEnvironment[0]!.lastAcceptedAt).toBeNull();
  });
});
