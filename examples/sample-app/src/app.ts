/**
 * A small web shop instrumented with the OpenTelemetry JS SDK. It is the reference for "an instrumented application":
 *  - structured logs with semantic-convention attributes (http.*, exception.*, request.id, service.*),
 *  - trace/span ids on every log (so logs correlate with traces once trace ingestion exists),
 *  - export over OTLP/HTTP using the STANDARD environment variables:
 *      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://127.0.0.1:4318/v1/logs
 *      OTEL_EXPORTER_OTLP_LOGS_HEADERS=Authorization=Bearer nxi_...
 *  - SAMPLE_PROTOCOL=proto (default, what the OTel Collector sends) or json.
 *
 * It deliberately logs a few secrets (a password, an Authorization header) so the platform's redaction can be seen working.
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { context, trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { SeverityNumber, type AnyValueMap } from '@opentelemetry/api-logs';
import { OTLPLogExporter as JsonExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPLogExporter as ProtoExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import Fastify from 'fastify';

const SERVICE = process.env.SAMPLE_SERVICE_NAME ?? 'sample-shop';
const PORT = Number(process.env.PORT ?? 3100);

// --- tracing context only (spans are not exported yet: trace ingestion arrives in a later phase)
new NodeTracerProvider({ spanProcessors: [] }).register();
const tracer = trace.getTracer(SERVICE, '1.2.3');

// --- logs over OTLP
const exporter = process.env.SAMPLE_PROTOCOL === 'json' ? new JsonExporter() : new ProtoExporter();
const loggers = new LoggerProvider({
  resource: resourceFromAttributes({
    'service.name': SERVICE, 'service.version': '1.2.3', 'deployment.environment': process.env.SAMPLE_ENV ?? 'demo', 'host.name': hostname(),
  }),
  processors: [new BatchLogRecordProcessor({ exporter, scheduledDelayMillis: Number(process.env.SAMPLE_FLUSH_MS ?? 400), maxExportBatchSize: 200 })],
});
const logger = loggers.getLogger('sample-shop/http', '1.0.0');

type Level = 'debug' | 'info' | 'warn' | 'error';
const SEVERITY: Record<Level, [SeverityNumber, string]> = {
  debug: [SeverityNumber.DEBUG, 'DEBUG'], info: [SeverityNumber.INFO, 'INFO'], warn: [SeverityNumber.WARN, 'WARN'], error: [SeverityNumber.ERROR, 'ERROR'],
};
function emit(span: Span | undefined, level: Level, body: string, attributes: AnyValueMap = {}) {
  const ctx = span ? trace.setSpan(context.active(), span) : context.active();
  logger.emit({ severityNumber: SEVERITY[level][0], severityText: SEVERITY[level][1], body, attributes, context: ctx });
}

const app = Fastify({ logger: false });
declare module 'fastify' { interface FastifyRequest { span?: Span; requestId?: string; startedAt?: number } }

app.addHook('onRequest', (req, _reply, done) => {
  req.requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
  req.startedAt = performance.now();
  req.span = tracer.startSpan(`${req.method} ${req.url.split('?')[0]}`);
  done();
});

app.addHook('onResponse', (req, reply, done) => {
  const status = reply.statusCode;
  const route = req.routeOptions?.url ?? req.url;
  const duration = Math.round((performance.now() - (req.startedAt ?? performance.now())) * 10) / 10;
  const level: Level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
  emit(req.span, level, `${req.method} ${route} -> ${status}`, {
    'http.request.method': req.method, 'http.route': route, 'http.response.status_code': status, 'duration_ms': duration,
    'request.id': req.requestId ?? '', 'url.path': req.url.split('?')[0] ?? '',
  });
  req.span?.setAttribute('http.response.status_code', status);
  if (status >= 500) req.span?.setStatus({ code: SpanStatusCode.ERROR });
  req.span?.end();
  done();
});

app.setErrorHandler((err: Error, req, reply) => {
  emit(req.span, 'error', `unhandled error while serving ${req.method} ${req.url}: ${err.message}`, {
    'exception.type': err.name, 'exception.message': err.message, 'exception.stacktrace': err.stack ?? '', 'request.id': req.requestId ?? '',
    'http.request.method': req.method, 'http.route': req.routeOptions?.url ?? req.url,
  });
  req.span?.recordException(err);
  reply.code(500).send({ error: 'internal_error', requestId: req.requestId });
});

app.get('/ok', async () => ({ ok: true }));

app.get<{ Params: { id: string } }>('/orders/:id', async (req, reply) => {
  if (req.params.id === '404') { emit(req.span, 'warn', `order ${req.params.id} not found`, { 'order.id': req.params.id, 'request.id': req.requestId ?? '' }); return reply.code(404).send({ error: 'not_found' }); }
  if (req.params.id === '500') {
    emit(req.span, 'info', 'charging card for order 500', { 'order.id': '500', 'request.id': req.requestId ?? '', 'payment.provider': 'acme-pay' });
    const customer = undefined as unknown as { tier: string };
    return { tier: customer.tier }; // TypeError -> HTTP 500 with a real stack trace
  }
  emit(req.span, 'debug', `loaded order ${req.params.id}`, { 'order.id': req.params.id, 'request.id': req.requestId ?? '' });
  return { id: req.params.id, status: 'shipped' };
});

app.post('/login', async (req, reply) => {
  const user = (req.headers['x-demo-user'] as string | undefined) ?? 'alice';
  // Deliberately sloppy logging: secrets in a message, in attributes, and in a header. The platform masks them on ingestion.
  emit(req.span, 'info', `login attempt for ${user} with password=hunter2hunter2 token=sk_live_abcdefghijklmnop`, {
    'user.name': user, 'user.password': 'hunter2hunter2', 'http.request.header.authorization': 'Bearer abcdefghijklmnop0123456789',
    'http.request.header.cookie': 'session=supersecretsessionvalue', 'request.id': req.requestId ?? '', 'customer.tier': 'gold',
  });
  return reply.code(200).send({ ok: true });
});

app.get('/slow', async (req) => {
  await new Promise((r) => setTimeout(r, 300));
  emit(req.span, 'warn', 'slow upstream: inventory-service took 300ms', { 'peer.service': 'inventory-service', 'duration_ms': 300, 'request.id': req.requestId ?? '' });
  return { slow: true };
});

async function shutdown(signal: string) {
  console.log(`[${SERVICE}] ${signal}: flushing logs`);
  await app.close();
  await loggers.shutdown(); // flushes the batch processor
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: PORT, host: '127.0.0.1' });
emit(undefined, 'info', `${SERVICE} started`, { 'process.pid': process.pid, 'server.port': PORT });
console.log(`[${SERVICE}] listening on http://127.0.0.1:${PORT} (protocol: ${process.env.SAMPLE_PROTOCOL ?? 'proto'})`);
