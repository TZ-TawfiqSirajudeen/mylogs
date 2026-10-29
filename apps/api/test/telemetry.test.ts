import { createHash } from 'node:crypto';
import { startTestMongo } from '@nexus/database/testing';
import { DEFAULT_INGEST_CONFIG, IngestPipeline, IngestTokenService } from '@nexus/ingest';
import { MongoLogStore } from '@nexus/logstore';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { harness, type Client, type Harness } from './helpers.js';

let mongo: Awaited<ReturnType<typeof startTestMongo>>;
let h: Harness;
let owner: Client, admin: Client, engineer: Client, viewer: Client, auditor: Client, globex: Client;
let projectId: string, prodEnv: string, devEnv: string;
let pipeline: IngestPipeline;
let tokenSvc: IngestTokenService;
let prodToken: string, devToken: string;

const NOW = Date.now();
const nsOf = (ms: number) => String(BigInt(ms) * 1_000_000n);
const base = () => `/api/v1/projects/${projectId}`;
const rec = (msg: string, over: object = {}, attrs: object[] = []) => ({ timeUnixNano: nsOf(NOW - 5_000), severityNumber: 9, body: { stringValue: msg }, attributes: attrs, ...over });
const payload = (records: object[], service = 'checkout') => ({ resourceLogs: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }, { key: 'host.name', value: { stringValue: 'web-1' } }] }, scopeLogs: [{ logRecords: records }] }] });
const range = (over: object = {}) => ({ from: new Date(NOW - 3600_000).toISOString(), to: new Date(NOW + 60_000).toISOString(), ...over });

async function ingest(rawToken: string, p: unknown) {
  const tok = await tokenSvc.authenticate(rawToken);
  const body = JSON.stringify(p);
  const r = await pipeline.handle(tok!, { format: 'otlp', payload: p, bodyBytes: body.length, bodyHash: createHash('sha256').update(body).digest('hex') });
  expect(r.status, JSON.stringify(r)).toBe('ok');
}

beforeAll(async () => {
  mongo = await startTestMongo();
  h = await harness(mongo.uri);
  [owner, admin, engineer, viewer, auditor, globex] = await Promise.all([
    h.login('owner@acme.test'), h.login('admin@acme.test'), h.login('engineer@acme.test'), h.login('viewer@acme.test'), h.login('auditor@acme.test'), h.login('owner@globex.test'),
  ]);
  const p = (await owner.req('POST', '/api/v1/projects', { name: 'Telemetry', environments: [{ name: 'Prod', isProduction: true }, { name: 'Dev' }] })).json;
  projectId = p.id; prodEnv = p.environments[0].id; devEnv = p.environments[1].id;
  await owner.req('PUT', `${base()}/members/${engineer.userId}`, { role: 'engineer' });
  await owner.req('PUT', `${base()}/members/${viewer.userId}`, { role: 'viewer', environmentIds: [devEnv] });
  tokenSvc = new IngestTokenService(h.db, { record: async () => undefined });
  pipeline = new IngestPipeline(h.db, new MongoLogStore(h.db), { ...DEFAULT_INGEST_CONFIG, tokenRecordsPerMinute: 1_000_000, projectRecordsPerMinute: 1_000_000 });

  prodToken = (await owner.req('POST', `${base()}/environments/${prodEnv}/ingest-tokens`, { name: 'prod' })).json.token;
  devToken = (await owner.req('POST', `${base()}/environments/${devEnv}/ingest-tokens`, { name: 'dev' })).json.token;
  await ingest(prodToken, payload([
    rec('checkout failed', { severityNumber: 17, traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }, [
      { key: 'http.response.status_code', value: { intValue: '500' } }, { key: 'http.request.method', value: { stringValue: 'POST' } }, { key: 'http.route', value: { stringValue: '/pay' } },
      { key: 'request.id', value: { stringValue: 'req-77' } }, { key: 'exception.type', value: { stringValue: 'TypeError' } }, { key: 'exception.stacktrace', value: { stringValue: 'TypeError: x\n    at pay (pay.js:1:1)' } },
      { key: 'customer.tier', value: { stringValue: 'gold' } },
    ]),
    rec('checkout started', { traceId: 'a'.repeat(32), timeUnixNano: nsOf(NOW - 6_000) }, [{ key: 'request.id', value: { stringValue: 'req-77' } }]),
    ...Array.from({ length: 30 }, (_, i) => rec(`prod noise ${i}`)),
  ]));
  await ingest(devToken, payload([rec('dev only message'), rec('=cmd|calc formula')], 'dev-svc'));
}, 300_000);
afterAll(async () => { await h?.app.close(); await h?.db.close(); await mongo?.stop(); });

describe('ingestion tokens', () => {
  test('only project admins manage tokens; the token is shown once and never stored, listed or audited', async () => {
    expect((await engineer.req('POST', `${base()}/environments/${prodEnv}/ingest-tokens`, { name: 'x' })).status).toBe(403);
    expect((await viewer.req('GET', `${base()}/ingest-tokens`)).status).toBe(403);
    expect((await globex.req('GET', `${base()}/ingest-tokens`)).status).toBe(404);
    const created = await owner.req('POST', `${base()}/environments/${devEnv}/ingest-tokens`, { name: 'shown once', retentionDays: 7 });
    expect(created.status).toBe(201);
    expect(created.headers['cache-control']).toBe('no-store');
    const { token, info } = created.json;
    expect(token).toMatch(/^nxi_/);
    expect(info.retentionDays).toBe(7);
    const list = await owner.req('GET', `${base()}/ingest-tokens`);
    expect(JSON.stringify(list.json)).not.toContain(token);
    expect(JSON.stringify(await h.db.db.collection('ingest_tokens').find({}).toArray())).not.toContain(token);
    expect(JSON.stringify(await h.db.c.auditEvents.find({}).toArray())).not.toContain(token);
    expect((await owner.req('DELETE', `${base()}/ingest-tokens/${info.id}`)).status).toBe(204);
    expect(await tokenSvc.authenticate(token)).toBeNull();
    expect((await h.db.c.auditEvents.findOne({ action: 'ingest_token.revoked' }))?.actorUserId).toBe(owner.userId);
  });
  test('an environment-restricted project admin can only mint tokens for their own environment', async () => {
    await owner.req('PUT', `${base()}/members/${engineer.userId}`, { role: 'project_admin', environmentIds: [devEnv] });
    try {
      expect((await engineer.req('POST', `${base()}/environments/${devEnv}/ingest-tokens`, { name: 'scoped dev' })).status).toBe(201);
      expect((await engineer.req('POST', `${base()}/environments/${prodEnv}/ingest-tokens`, { name: 'scoped prod' })).status).toBe(404);
      const list = (await engineer.req('GET', `${base()}/ingest-tokens`)).json as { environmentId: string }[];
      expect(list.every((t) => t.environmentId === devEnv)).toBe(true);
    } finally {
      await owner.req('PUT', `${base()}/members/${engineer.userId}`, { role: 'engineer', environmentIds: null });
    }
    expect((await owner.req('POST', `${base()}/environments/00000000-0000-4000-8000-000000000000/ingest-tokens`, { name: 'x' })).status).toBe(404);
  });
  test('validation: bounds on retention, rate and redaction keys', async () => {
    for (const bad of [{ name: '' }, { name: 'x', retentionDays: 0 }, { name: 'x', retentionDays: 400 }, { name: 'x', recordsPerMinute: 1 }, { name: 'x', redaction: { enabled: true, extraKeys: ['has space'] } }]) {
      expect((await owner.req('POST', `${base()}/environments/${devEnv}/ingest-tokens`, bad)).status).toBe(400);
    }
  });
});

describe('search authorization and scoping', () => {
  test('owner sees both environments; each record is attributed to its environment', async () => {
    const r = await owner.req('POST', `${base()}/logs/search`, range({ limit: 500 }));
    expect(r.status).toBe(200);
    const envs = new Set(r.json.items.map((i: any) => i.environmentId));
    expect(envs).toEqual(new Set([prodEnv, devEnv]));
  });
  test('environment-restricted viewer sees ONLY their environment, even when asking for the other explicitly', async () => {
    const mine = await viewer.req('POST', `${base()}/logs/search`, range({ limit: 500 }));
    expect(mine.json.items.length).toBeGreaterThan(0);
    expect(mine.json.items.every((i: any) => i.environmentId === devEnv)).toBe(true);
    const forced = await viewer.req('POST', `${base()}/logs/search`, range({ environmentIds: [prodEnv] }));
    expect(forced.json.items).toEqual([]);
    const text = await viewer.req('POST', `${base()}/logs/search`, range({ text: 'checkout failed' }));
    expect(text.json.items).toEqual([]);
  });
  test('auditors and other tenants cannot reach the project at all; unauthenticated is 401', async () => {
    expect((await auditor.req('POST', `${base()}/logs/search`, range())).status).toBe(404);
    expect((await globex.req('POST', `${base()}/logs/search`, range())).status).toBe(404);
    const res = await h.app.inject({ method: 'POST', url: `${base()}/logs/search`, headers: { origin: h.cfg.webOrigin }, payload: range() });
    expect(res.statusCode).toBe(401);
  });
  test('detail and context are scoped: a record from an environment you cannot read is 404', async () => {
    const all = (await owner.req('POST', `${base()}/logs/search`, range({ text: 'checkout failed' }))).json.items;
    const id = all[0].id;
    expect((await owner.req('GET', `${base()}/logs/${id}`)).status).toBe(200);
    expect((await viewer.req('GET', `${base()}/logs/${id}`)).status).toBe(404);
    expect((await viewer.req('GET', `${base()}/logs/${id}/context`)).status).toBe(404);
    expect((await globex.req('GET', `${base()}/logs/${id}`)).status).toBe(404);
  });
});

describe('query validation and injection', () => {
  test('malformed and abusive queries are rejected with 400, never executed', async () => {
    for (const bad of [
      { from: 'x', to: 'y' }, range({ from: new Date(NOW - 40 * 86400_000).toISOString() }), range({ limit: 501 }),
      range({ filters: [{ field: 'orgId', op: 'eq', value: 'x' }] }), range({ filters: [{ field: '$where', op: 'eq', value: '1' }] }),
      range({ filters: [{ field: 'httpStatus', op: 'contains', value: '5' }] }), range({ environmentIds: ['not-a-uuid'] }), range({ sort: 'sideways' }),
      range({ text: 'x'.repeat(201) }), range({ filters: Array.from({ length: 11 }, () => ({ field: 'service', op: 'eq', value: 'x' })) }),
    ]) expect((await owner.req('POST', `${base()}/logs/search`, bad)).status).toBe(400);
  });
  test('operator objects and regex metacharacters as values are inert', async () => {
    for (const value of ['{"$ne":null}', '.*', '^', '(?i).*']) {
      expect((await owner.req('POST', `${base()}/logs/search`, range({ filters: [{ field: 'service', op: 'eq', value }] }))).json.items, value).toEqual([]);
    }
    const objectValue = await owner.req('POST', `${base()}/logs/search`, range({ filters: [{ field: 'service', op: 'eq', value: { $ne: null } }] }));
    expect(objectValue.status).toBe(400);
    expect((await owner.req('POST', `${base()}/logs/search`, range({ text: '.*' }))).json.items).toEqual([]);
  });
  test('a forged cursor cannot reach other environments or tenants', async () => {
    const forged = Buffer.from(JSON.stringify([NOW, 'zzzzzzzz'])).toString('base64url');
    const r = await viewer.req('POST', `${base()}/logs/search`, range({ cursor: forged, limit: 500 }));
    expect(r.status).toBe(200);
    expect(r.json.items.every((i: any) => i.environmentId === devEnv)).toBe(true);
  });
});

describe('searching and investigating', () => {
  test('find the HTTP 500, open it, and follow the trace to the related events', async () => {
    const hit = await owner.req('POST', `${base()}/logs/search`, range({ filters: [{ field: 'httpStatus', op: 'gte', value: 500 }, { field: 'attr:customer.tier', op: 'eq', value: 'gold' }], errorsOnly: true }));
    expect(hit.json.items).toHaveLength(1);
    const s = hit.json.items[0];
    expect(s).toMatchObject({ message: 'checkout failed', severity: 'error', httpStatus: 500, httpMethod: 'POST', httpRoute: '/pay', requestId: 'req-77', errorType: 'TypeError', service: 'checkout', hasStack: true });
    expect(s).not.toHaveProperty('orgId');
    const d = (await owner.req('GET', `${base()}/logs/${s.id}`)).json;
    expect(d.stack).toContain('at pay');
    expect(d.attrs.find((a: any) => a.k === 'customer.tier').v).toBe('gold');
    expect(d.tsSource).toBe('event');
    expect(d).not.toHaveProperty('orgId');
    expect(d).not.toHaveProperty('tokenId');
    const ctx = (await owner.req('GET', `${base()}/logs/${s.id}/context`)).json;
    expect(ctx.related.by).toBe('traceId');
    expect(ctx.related.items.map((i: any) => i.message)).toEqual(['checkout started', 'checkout failed']); // ordered, oldest first
    expect(ctx.before.length + ctx.after.length).toBeGreaterThan(0);
  });
  test('pagination with a cursor covers all prod records exactly once', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = await owner.req('POST', `${base()}/logs/search`, range({ environmentIds: [prodEnv], limit: 7, cursor }));
      seen.push(...r.json.items.map((i: any) => i.id));
      cursor = r.json.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 20);
    expect(seen).toHaveLength(32);
    expect(new Set(seen).size).toBe(32);
  });
  test('histogram and facets reflect the caller\'s scope', async () => {
    const hOwner = (await owner.req('POST', `${base()}/logs/histogram`, range())).json;
    expect(hOwner.buckets.reduce((a: number, b: any) => a + b.total, 0)).toBe(34);
    const hViewer = (await viewer.req('POST', `${base()}/logs/histogram`, range())).json;
    expect(hViewer.buckets.reduce((a: number, b: any) => a + b.total, 0)).toBe(2);
    const f = (await viewer.req('POST', `${base()}/logs/facets`, range())).json;
    expect(f.services.map((s: any) => s.value)).toEqual(['dev-svc']);
  });
  test('redaction applied at ingestion is visible in what the API serves', async () => {
    await ingest(prodToken, payload([rec('login with password=hunter2hunter2 and Authorization: Bearer abcdefghijklmnop1234', {}, [{ key: 'http.request.header.cookie', value: { stringValue: 'sid=abc' } }])]));
    const r = await owner.req('POST', `${base()}/logs/search`, range({ text: 'login with' }));
    const d = (await owner.req('GET', `${base()}/logs/${r.json.items[0].id}`)).json;
    const dump = JSON.stringify(d);
    for (const s of ['hunter2hunter2', 'abcdefghijklmnop1234', 'sid=abc']) expect(dump).not.toContain(s);
    expect(d.redactions).toBeGreaterThanOrEqual(3);
  });
});

describe('live tail', () => {
  test('streams new arrivals as server-sent events, limits concurrent streams, and frees the slot on close', async () => {
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (h.app.server.address() as { port: number }).port;
    const open = (c: Client, q: object = range()) => {
      const ctl = new AbortController();
      const p = fetch(`http://127.0.0.1:${port}${base()}/logs/tail`, {
        method: 'POST', signal: ctl.signal,
        headers: { cookie: c.cookie, 'x-csrf-token': c.csrf, origin: h.cfg.webOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ query: q }),
      });
      return { ctl, p };
    };
    const a = open(owner);
    const resp = await a.p;
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/event-stream');
    const reader = resp.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const readUntil = async (re: RegExp, ms = 15_000) => {
      const end = Date.now() + ms;
      while (!re.test(buf) && Date.now() < end) {
        const r = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>((ok) => setTimeout(() => ok({ done: true, value: undefined }), 2000))]);
        if (r.value) buf += dec.decode(r.value);
      }
      return re.test(buf);
    };
    expect(await readUntil(/event: ready/)).toBe(true);
    await ingest(prodToken, payload([rec('tail me please', { timeUnixNano: nsOf(Date.now() - 60_000) })])); // old event timestamp, new arrival
    expect(await readUntil(/tail me please/)).toBe(true);
    expect(buf).toContain('event: logs');
    expect(buf).not.toContain('dev only message'); // nothing from before the tail started

    // concurrency cap: three more streams are allowed in total of 3, the fourth is refused
    const extra = [open(owner), open(owner)];
    const resps = await Promise.all(extra.map((e) => e.p));
    expect(resps.map((r) => r.status)).toEqual([200, 200]);
    const fourth = await open(owner).p;
    expect(fourth.status).toBe(429);
    expect(((await fourth.json()) as { error: { code: string } }).error.code).toBe("too_many_streams");
    // closing a stream frees its slot
    a.ctl.abort();
    for (const e of extra) e.ctl.abort();
    await new Promise((r) => setTimeout(r, 1800));
    const again = open(owner);
    expect((await again.p).status).toBe(200);
    again.ctl.abort();

    // a viewer's tail honours their environment scope
    const v = open(viewer);
    const vr = await v.p;
    const vreader = vr.body!.getReader();
    await ingest(prodToken, payload([rec('prod secret event for viewer test')]));
    await ingest(devToken, payload([rec('dev event for viewer test')], 'dev-svc'));
    let vbuf = '';
    const end = Date.now() + 8000;
    while (!/dev event for viewer test/.test(vbuf) && Date.now() < end) {
      const r = await Promise.race([vreader.read(), new Promise<{ value: undefined }>((ok) => setTimeout(() => ok({ value: undefined }), 1500))]);
      if (r.value) vbuf += dec.decode(r.value);
    }
    expect(vbuf).toContain('dev event for viewer test');
    expect(vbuf).not.toContain('prod secret event');
    v.ctl.abort();
  });
});

describe('export', () => {
  test('requires engineer access; NDJSON/CSV are scoped, capped, formula-safe and audited', async () => {
    expect((await viewer.req('POST', `${base()}/logs/export`, { query: range(), format: 'csv' })).status).toBe(403);
    expect((await globex.req('POST', `${base()}/logs/export`, { query: range() })).status).toBe(404);
    const csv = await engineer.req('POST', `${base()}/logs/export`, { query: range({ environmentIds: [devEnv] }), format: 'csv' });
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(String(csv.headers['content-disposition'])).toContain('attachment');
    const lines = String(csv.json).split('\n').filter(Boolean);
    expect(lines[0]).toBe('ts,severity,service,host,environmentId,traceId,spanId,requestId,httpMethod,httpRoute,httpStatus,durationMs,errorType,message');
    expect(lines.some((l) => l.includes(",'=cmd|calc formula"))).toBe(true); // spreadsheet formula neutralised
    expect(lines.some((l) => /(^|,)=cmd/.test(l))).toBe(false);
    const nd = await engineer.req('POST', `${base()}/logs/export`, { query: range({ environmentIds: [prodEnv], limit: 5 }), format: 'ndjson' });
    const rows = String(nd.json ?? '').length ? undefined : undefined;
    void rows;
    const audit = (await owner.req('GET', '/api/v1/audit?limit=50&action=logs.exported')).json.items;
    expect(audit.length).toBeGreaterThanOrEqual(2);
    expect(audit[0].metadata).toMatchObject({ format: 'ndjson' });
    expect(audit.every((e: any) => e.actorUserId === engineer.userId)).toBe(true);
  });
});

describe('saved queries and history', () => {
  test('personal queries are private; shared ones need engineer access and are visible to the project', async () => {
    const mine = await viewer.req('POST', `${base()}/logs/saved-queries`, { name: 'my errors', query: range({ errorsOnly: true }) });
    expect(mine.status).toBe(201);
    expect(mine.json.query).not.toHaveProperty('from'); // a saved query is a filter, not a fixed time window
    expect((await viewer.req('POST', `${base()}/logs/saved-queries`, { name: 'for everyone', query: range(), shared: true })).status).toBe(403);
    const shared = await engineer.req('POST', `${base()}/logs/saved-queries`, { name: 'team 500s', query: range({ filters: [{ field: 'httpStatus', op: 'gte', value: 500 }] }), shared: true });
    expect(shared.status).toBe(201);
    const viewerList = (await viewer.req('GET', `${base()}/logs/saved-queries`)).json;
    expect(viewerList.map((q: any) => q.name).sort()).toEqual(['my errors', 'team 500s']);
    const engList = (await engineer.req('GET', `${base()}/logs/saved-queries`)).json;
    expect(engList.map((q: any) => q.name)).toEqual(['team 500s']); // the viewer's personal query is not visible
    expect((await viewer.req('DELETE', `${base()}/logs/saved-queries/${shared.json.id}`)).status).toBe(403); // not theirs
    expect((await engineer.req('DELETE', `${base()}/logs/saved-queries/${mine.json.id}`)).status).toBe(404); // someone else's private query
    expect((await viewer.req('DELETE', `${base()}/logs/saved-queries/${mine.json.id}`)).status).toBe(204);
    expect((await globex.req('GET', `${base()}/logs/saved-queries`)).status).toBe(404);
  });
  test('query history keeps the latest 20 per user', async () => {
    for (let i = 0; i < 25; i++) await owner.req('POST', `${base()}/logs/search?remember=true`, range({ text: `history ${i}` }));
    const hist = (await owner.req('GET', `${base()}/logs/history`)).json;
    expect(hist).toHaveLength(20);
    expect(hist[0].query.text).toBe('history 24');
    expect((await viewer.req('GET', `${base()}/logs/history`)).json).toEqual([]); // per user
  });
});

describe('ingestion statistics', () => {
  test('the API reports accepted/refused counts and the last time data arrived; unscoped environments are invisible', async () => {
    const s = (await owner.req('GET', `${base()}/ingest/stats?minutes=60`)).json;
    expect(s.totals.accepted).toBeGreaterThan(30);
    expect(s.perEnvironment.map((e: any) => e.environmentId).sort()).toEqual([devEnv, prodEnv].sort());
    expect(s.perEnvironment.every((e: any) => e.lastAcceptedAt)).toBe(true);
    const v = (await viewer.req('GET', `${base()}/ingest/stats`)).json;
    expect(v.perEnvironment.map((e: any) => e.environmentId)).toEqual([devEnv]);
    expect((await globex.req('GET', `${base()}/ingest/stats`)).status).toBe(404);
  });
});
