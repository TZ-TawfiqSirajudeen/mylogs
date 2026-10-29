/**
 * Two cooperating, OpenTelemetry-instrumented services in one file (choose with SAMPLE_ROLE):
 *
 *   gateway   GET /orders/:id  --(http, W3C traceparent)-->  inventory   GET /stock/:sku  --> (manual "database" spans)
 *
 * What it demonstrates (all of it real SDK output sent to the platform):
 *   - automatic HTTP server/client spans and trace-context propagation across the two services (HttpInstrumentation),
 *   - manual spans for a datastore call, with semantic-convention attributes and a recorded exception on failure,
 *   - logs that carry the active trace and span id,
 *   - metrics: an explicit `http.server.request.duration` histogram (route TEMPLATE + status code labels), plus the instrumentation's own
 *     HTTP metric, and application metrics (a counter, a histogram).
 * Try:  /orders/17 (ok)   /orders/404 (inventory: not found -> 404)   /orders/500 (inventory throws -> 502)   /orders/slow (300 ms)
 *
 * NOTE: the datastore here is simulated; the spans are created manually. Automatic MongoDB/Redis instrumentation
 * (@opentelemetry/instrumentation-mongodb / -ioredis) is documented in docs/integrations/otlp-traces-metrics.md but NOT verified by this sample.
 */
import { createRequire } from 'node:module';
import './telemetry.js'; // must stay first: instrumentation patches modules as they load
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import Fastify from 'fastify';
import { flushTelemetry, log, meter, SERVICE, shutdownTelemetry, tracer } from './telemetry.js';

const require = createRequire(import.meta.url);
const http = require('node:http') as typeof import('node:http'); // via require so the instrumentation's patched version is used
const ROLE = process.env.SAMPLE_ROLE ?? 'gateway';
const PORT = Number(process.env.PORT ?? (ROLE === 'gateway' ? 3100 : 3101));
const INVENTORY_URL = process.env.INVENTORY_URL ?? 'http://127.0.0.1:3101';

const requestDuration = meter.createHistogram('http.server.request.duration', { unit: 's', description: 'Duration of HTTP server requests', advice: { explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] } });
const lookups = meter.createCounter('shop.stock.lookups', { description: 'Inventory lookups' });
const dbDuration = meter.createHistogram('shop.db.duration', { unit: 's', description: 'Datastore call duration', advice: { explicitBucketBoundaries: [0.005, 0.025, 0.1, 0.25, 0.5, 1] } });

const app = Fastify({ logger: false });
declare module 'fastify' { interface FastifyRequest { startedAt?: number } }

app.addHook('onRequest', (req, _reply, done) => { req.startedAt = performance.now(); done(); });
app.addHook('onResponse', (req, reply, done) => {
  const route = req.routeOptions?.url ?? 'unmatched'; // the route TEMPLATE, never the raw URL (bounded label cardinality)
  const seconds = (performance.now() - (req.startedAt ?? performance.now())) / 1000;
  requestDuration.record(seconds, { 'http.request.method': req.method, 'http.route': route, 'http.response.status_code': reply.statusCode });
  const span = trace.getActiveSpan();
  span?.setAttribute('http.route', route);
  log(reply.statusCode >= 500 ? 'error' : reply.statusCode >= 400 ? 'warn' : 'info', `${req.method} ${route} -> ${reply.statusCode}`, {
    'http.request.method': req.method, 'http.route': route, 'http.response.status_code': reply.statusCode, 'duration_ms': Math.round(seconds * 1000 * 10) / 10,
  });
  done();
});
app.setErrorHandler((err: Error, req, reply) => {
  log('error', `unhandled error serving ${req.method} ${req.url}: ${err.message}`, { 'exception.type': err.name, 'exception.message': err.message, 'exception.stacktrace': err.stack ?? '' });
  trace.getActiveSpan()?.recordException(err);
  trace.getActiveSpan()?.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
  void reply.code(500).send({ error: 'internal_error' });
});

app.get('/ok', async () => ({ ok: true, service: SERVICE }));
app.get('/__flush', async () => { await flushTelemetry(); return { flushed: true }; }); // sample/test helper: force an export now

if (ROLE === 'inventory') {
  app.get<{ Params: { sku: string } }>('/stock/:sku', async (req, reply) => {
    const { sku } = req.params;
    lookups.add(1, { 'shop.sku.kind': /^\d+$/.test(sku) ? 'numeric' : sku });
    // A datastore call, instrumented by hand: a CLIENT span with database semantic-convention attributes.
    const found = await tracer.startActiveSpan('stock.find', {
      kind: SpanKind.CLIENT,
      attributes: { 'db.system': 'mongodb', 'db.operation.name': 'find', 'db.collection.name': 'stock', 'server.address': 'mongo.internal' },
    }, async (span) => {
      const t0 = performance.now();
      try {
        if (sku === 'slow') await new Promise((r) => setTimeout(r, 300)); else await new Promise((r) => setTimeout(r, 8));
        if (sku === '500') throw new Error('stock database connection reset');
        return sku !== '404';
      } catch (e) {
        span.recordException(e as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message });
        throw e;
      } finally {
        dbDuration.record((performance.now() - t0) / 1000, { 'db.system': 'mongodb', 'db.operation.name': 'find' });
        span.end();
      }
    });
    log('info', `stock lookup for ${sku}: ${found ? 'found' : 'not found'}`, { 'shop.sku': sku });
    return found ? { sku, available: 12 } : reply.code(404).send({ error: 'unknown_sku' });
  });
} else {
  /** GET json from the inventory service with the node http module (the instrumentation injects `traceparent`). */
  const getInventory = (sku: string) => new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const req = http.get(`${INVENTORY_URL}/stock/${encodeURIComponent(sku)}`, (res) => {
      let data = '';
      res.on('data', (c: Buffer) => { data += c.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
  });
  app.get<{ Params: { id: string } }>('/orders/:id', async (req, reply) => {
    const { id } = req.params;
    log('info', `looking up order ${id}`, { 'order.id': id });
    const stock = await getInventory(id);
    if (stock.status === 404) return reply.code(404).send({ error: 'not_found' });
    if (stock.status >= 500) { log('error', `inventory failed for order ${id}`, { 'order.id': id, 'peer.service': 'inventory' }); return reply.code(502).send({ error: 'upstream_failed' }); }
    return { id, status: 'shipped', stock: stock.body };
  });
}

async function shutdown(signal: string) {
  console.log(`[${SERVICE}] ${signal}: flushing telemetry`);
  await app.close();
  await shutdownTelemetry();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: PORT, host: '127.0.0.1' });
log('info', `${SERVICE} started (${ROLE})`, { 'server.port': PORT });
console.log(`[${SERVICE}] ${ROLE} listening on http://127.0.0.1:${PORT}`);
