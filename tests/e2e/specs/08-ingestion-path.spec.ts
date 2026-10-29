import { DEMO, env, expect, login, test, apiAs } from '../support/fixtures.js';
import { createProject, uniq } from '../support/helpers.js';
import { sendTraffic, startSampleApp } from '../support/sample-app.js';

test.describe('the real OpenTelemetry SDK -> ingestion service -> storage (no browser UI)', () => {
  for (const protocol of ['proto', 'json'] as const) {
    test(`OTLP/${protocol === 'proto' ? 'protobuf' : 'JSON'} from the instrumented sample app is decoded, normalized, redacted and stored`, async ({ page, db }) => {
      test.setTimeout(120_000);
      await login(page, DEMO.owner);
      const p = await createProject(page, uniq(`E2E Wire ${protocol}`));
      const envId = p.environments[0]!.id;
      const service = `wire-${protocol}-${Date.now().toString(36)}`;
      const created = await apiAs(page, 'POST', `/api/v1/projects/${p.id}/environments/${envId}/ingest-tokens`, { name: `wire-${protocol}` });
      expect(created.status).toBe(201);

      const app = await startSampleApp({ ingestUrl: env().ingest, token: created.json.token, protocol, service });
      try {
        await sendTraffic(app.url, 12, `wire-${protocol}`);
        await expect.poll(async () => db.count('logs', { projectId: p.id, service }), { timeout: 30_000, intervals: [500] }).toBeGreaterThanOrEqual(12);
      } finally { await app.stop(); }

      const logs = await db.find('logs', { projectId: p.id, service });
      // tenant comes from the token, never from what the app claims (it claims deployment.environment=demo)
      expect(logs.every((l) => l.orgId && l.environmentId === envId && l.projectId === p.id)).toBe(true);
      expect(logs.every((l) => l.source === 'otlp')).toBe(true);

      const fail = logs.find((l) => l.httpStatus === 500);
      expect(fail, 'the HTTP 500 request must be searchable').toBeTruthy();
      expect(fail).toMatchObject({ severity: 'error', httpMethod: 'GET', httpRoute: '/orders/:id', serviceVersion: '1.2.3' });
      expect(fail.requestId).toMatch(/^wire-/);
      expect(fail.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(fail.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(fail.durationMs).toBeGreaterThanOrEqual(0);

      // the exception is a separate record of the same request: it carries the error type and a real stack trace
      const exception = logs.find((l) => l.errorType === 'TypeError');
      expect(exception, 'the exception log must be stored with its type').toBeTruthy();
      expect(exception.stack).toContain('TypeError');
      expect(exception.stack).toMatch(/at .*app\.ts/);
      expect(exception.severity).toBe('error');

      // the request log and the exception log of one request share the trace id: observed correlation, not inference
      expect(exception.traceId).toBe(fail.traceId);
      expect(logs.filter((l) => l.traceId === fail.traceId).length).toBeGreaterThanOrEqual(2);
      expect(exception.requestId).toBe(fail.requestId);

      // provider-specific fields are preserved as attributes
      expect(fail.attrs.map((a: { k: string }) => a.k)).toEqual(expect.arrayContaining(['http.route', 'request.id']));
      expect(fail.resource.find((a: { k: string; v: string }) => a.k === 'service.name').v).toBe(service);
      expect(logs.some((l) => l.severity === 'warn' && l.httpStatus === 404)).toBe(true);
      expect(logs.some((l) => l.severity === 'info')).toBe(true);

      // secrets the app logged on purpose never reached the database
      const dump = JSON.stringify(logs);
      for (const secret of ['hunter2hunter2', 'sk_live_abcdefghijklmnop', 'abcdefghijklmnop0123456789', 'supersecretsessionvalue']) expect(dump, secret).not.toContain(secret);
      const loginLog = logs.find((l) => /login attempt/.test(l.message));
      expect(loginLog.message).toContain('[REDACTED]');
      expect(loginLog.redactions).toBeGreaterThanOrEqual(4);
      expect(loginLog.attrs.find((a: { k: string; v: string }) => a.k === 'user.password').v).toBe('[REDACTED]');
      expect(loginLog.attrs.find((a: { k: string; v: string }) => a.k === 'customer.tier').v).toBe('gold'); // not over-redacted
    });
  }

  test('revoking a token makes the sender receive 401s; nothing more is stored', async ({ page, db }) => {
    await login(page, DEMO.owner);
    const p = await createProject(page, uniq('E2E Revoke'));
    const envId = p.environments[0]!.id;
    const created = await apiAs(page, 'POST', `/api/v1/projects/${p.id}/environments/${envId}/ingest-tokens`, { name: 'to revoke' });
    const body = (m: string) => JSON.stringify([{ level: 'info', msg: m }]);
    const send = (m: string) => fetch(`${env().ingest}/v1/json-logs`, { method: 'POST', headers: { authorization: `Bearer ${created.json.token}`, 'content-type': 'application/json' }, body: body(m) });
    expect((await send('before revoke')).status).toBe(200);
    expect((await apiAs(page, 'DELETE', `/api/v1/projects/${p.id}/ingest-tokens/${created.json.info.id}`)).status).toBe(204);
    const after = await send('after revoke');
    expect(after.status).toBe(401);
    expect(await db.count('logs', { projectId: p.id, message: 'after revoke' })).toBe(0);
    expect(await db.count('logs', { projectId: p.id, message: 'before revoke' })).toBe(1);
  });

  test('ingestion is unreachable without a token; the service reports health and metrics', async ({ request }) => {
    expect((await request.post(`${env().ingest}/v1/logs`, { data: {} })).status()).toBe(401);
    expect((await request.get(`${env().ingest}/readyz`)).ok()).toBe(true);
    const m = await (await request.get(`${env().ingest}/metrics`)).text();
    expect(m).toContain('nexus_ingest_records_accepted_total');
  });
});
