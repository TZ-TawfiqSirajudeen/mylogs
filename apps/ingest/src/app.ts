import { createHash, randomUUID } from 'node:crypto';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { Transform } from 'node:stream';
import type { Database } from '@nexus/database';
import { DEFAULT_INGEST_CONFIG, IngestPipeline, IngestTokenService, MetricPipeline, RateLimiter, TracePipeline, type IngestConfig, type IngestOutcome } from '@nexus/ingest';
import { MongoLogStore, type LogStore } from '@nexus/logstore';
import { MongoMetricStore, type MetricStore } from '@nexus/metricstore';
import {
  decodeLogsRequest, decodeMetricsRequest, decodeTracesRequest, encodeLogsResponse, encodeMetricsResponse, encodeTracesResponse, ProtobufDecodeError,
} from '@nexus/telemetry';
import { MongoTraceStore, type TraceStore } from '@nexus/tracestore';
import { AuditService } from '@nexus/database';
import Fastify from 'fastify';

export interface IngestAppConfig {
  maxBodyBytes: number;
  logLevel: string;
  ingest: IngestConfig;
  /** Failed-authentication budget per client address per minute (brute-force protection). */
  authFailuresPerMinute: number;
}
export const DEFAULT_APP_CONFIG: IngestAppConfig = { maxBodyBytes: 4 * 1024 * 1024, logLevel: 'info', ingest: DEFAULT_INGEST_CONFIG, authFailuresPerMinute: 30 };

const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;
const retryAfterSeconds = (ms?: number) => String(Math.max(1, Math.ceil((ms ?? 1000) / 1000)));

/** Enforces the body limit on the DECODED stream, so a tiny compressed bomb cannot expand past it. */
class LimitStream extends Transform {
  private n = 0;
  constructor(private readonly max: number) { super(); }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null, d?: Buffer) => void) {
    this.n += chunk.length;
    if (this.n > this.max) return cb(Object.assign(new Error('Payload too large'), { statusCode: 413, code: 'FST_ERR_CTP_BODY_TOO_LARGE' }));
    cb(null, chunk);
  }
}

export async function buildIngestApp(db: Database, cfg: IngestAppConfig = DEFAULT_APP_CONFIG, deps: { store?: LogStore; traceStore?: TraceStore; metricStore?: MetricStore; logStream?: { write(msg: string): void } } = {}) {
  const app = Fastify({
    logger: { level: cfg.logLevel, ...(deps.logStream ? { stream: deps.logStream } : {}), redact: { paths: ['req.headers.authorization', 'req.headers["x-nexus-token"]'], censor: '[REDACTED]' } },
    bodyLimit: cfg.maxBodyBytes,
    requestTimeout: 30_000,
    connectionTimeout: 60_000,
    genReqId: (req) => { const h = req.headers['x-request-id']; return typeof h === 'string' && REQUEST_ID.test(h) ? h : randomUUID(); },
    trustProxy: false,
  });
  const store = deps.store ?? new MongoLogStore(db);
  const tokens = new IngestTokenService(db, new AuditService(db));
  const pipeline = new IngestPipeline(db, store, cfg.ingest);
  const tracePipeline = new TracePipeline(db, deps.traceStore ?? new MongoTraceStore(db), cfg.ingest);
  const metricPipeline = new MetricPipeline(db, deps.metricStore ?? new MongoMetricStore(db), cfg.ingest);
  const authLimiter = new RateLimiter();

  app.addHook('onSend', async (req, reply) => { reply.header('x-request-id', req.id); reply.header('x-content-type-options', 'nosniff'); });

  // Compressed bodies (OTLP exporters commonly send gzip): decode as a stream, bounded by the same body limit.
  app.addHook('preParsing', async (req, _reply, payload) => {
    const enc = String(req.headers['content-encoding'] ?? '').toLowerCase();
    if (!enc || enc === 'identity') return payload;
    const dec = enc === 'gzip' || enc === 'x-gzip' ? createGunzip() : enc === 'deflate' ? createInflate() : enc === 'br' ? createBrotliDecompress() : null;
    if (!dec) throw Object.assign(new Error(`Unsupported content-encoding "${enc}"`), { statusCode: 415 });
    delete req.headers['content-length'];
    const limited = new LimitStream(cfg.maxBodyBytes);
    dec.on('error', (e) => limited.destroy(Object.assign(e, { statusCode: 400 })));
    return payload.pipe(dec).pipe(limited);
  });

  // We parse the raw bytes ourselves (we need them for the idempotency hash).
  for (const type of ['application/json', 'application/x-protobuf', 'application/protobuf', 'application/x-ndjson', 'text/plain']) {
    app.addContentTypeParser(type, { parseAs: 'buffer', bodyLimit: cfg.maxBodyBytes }, (_req, body, done) => done(null, body));
  }

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status === 413) return reply.code(413).send({ error: 'payload_too_large', message: `Request body exceeds ${cfg.maxBodyBytes} bytes`, requestId: req.id });
    if (status === 415) {
      // A gRPC exporter gets told what to do instead of a bare "Unsupported Media Type".
      const grpc = String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/grpc');
      const message = grpc
        ? 'OTLP/gRPC is not supported. Send OTLP over HTTP (POST /v1/traces, /v1/metrics or /v1/logs with application/x-protobuf or application/json; set OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf), or send gRPC to an OpenTelemetry Collector that exports to this service with the otlphttp exporter.'
        : err.message;
      return reply.code(415).send({ error: 'unsupported_media_type', message, requestId: req.id });
    }
    if (status < 500) return reply.code(status).send({ error: 'bad_request', message: 'Malformed request', requestId: req.id });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error', message: 'Internal error', requestId: req.id });
  });

  /** Token from `Authorization: Bearer` or `X-Nexus-Token`. All failures look identical; repeated failures are throttled per address. */
  async function authenticate(req: { headers: Record<string, unknown>; ip: string }) {
    const auth = String(req.headers.authorization ?? '');
    const raw = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : (req.headers['x-nexus-token'] as string | undefined);
    const token = await tokens.authenticate(raw);
    if (token) return { token } as const;
    const r = authLimiter.take(`authfail:${req.ip}`, 1, cfg.authFailuresPerMinute);
    return { token: null, throttled: !r.ok } as const;
  }

  function respond(reply: import('fastify').FastifyReply, o: IngestOutcome, protobuf: boolean) {
    if (o.status === 'quota' || o.status === 'overloaded' || o.status === 'storage_unavailable') {
      reply.header('retry-after', retryAfterSeconds(o.retryAfterMs));
      return reply.code(o.status === 'quota' ? 429 : 503).send({ error: o.status, message: o.message, rejected: o.rejected });
    }
    if (o.status === 'invalid') return reply.code(400).send({ error: 'invalid', message: o.message ?? 'No valid records in the request', rejected: o.rejected });
    // OTLP "partial success": 200 with the number of refused records, so the client can see data was not fully accepted.
    if (protobuf) return reply.code(200).header('content-type', 'application/x-protobuf').send(Buffer.from(encodeLogsResponse(o.rejected, o.message ?? '')));
    return reply.code(200).send(o.rejected ? { partialSuccess: { rejectedLogRecords: String(o.rejected), errorMessage: o.message ?? 'Some records were rejected' } } : {});
  }

  const handler = (format: 'otlp' | 'json') => async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    const a = await authenticate(req);
    if (!a.token) {
      if (a.throttled) return reply.header('retry-after', '60').code(429).send({ error: 'rate_limited', message: 'Too many failed authentication attempts', requestId: req.id });
      return reply.code(401).send({ error: 'unauthorized', message: 'A valid ingestion token is required', requestId: req.id });
    }
    if (!a.token.scopes.includes('logs')) return reply.code(403).send({ error: 'forbidden_signal', message: 'This token is not allowed to send logs', requestId: req.id });
    const body = req.body as Buffer | undefined;
    if (!body || body.length === 0) return reply.code(200).send({});
    const ctype = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    const bodyHash = createHash('sha256').update(body).digest('hex');
    let payload: unknown;
    const protobuf = ctype.includes('protobuf');
    if (format === 'otlp') {
      try {
        payload = protobuf ? decodeLogsRequest(body) : JSON.parse(body.toString('utf8'));
      } catch (e) {
        return reply.code(400).send({ error: 'invalid', message: e instanceof ProtobufDecodeError ? 'Body is not valid OTLP protobuf' : 'Body is not valid JSON', requestId: req.id });
      }
    } else payload = body.toString('utf8');
    const outcome = await pipeline.handle(a.token, { format, payload, bodyBytes: body.length, bodyHash });
    return respond(reply, outcome, protobuf && format === 'otlp');
  };

  /**
   * Traces and metrics: OTLP only (JSON or protobuf, optionally gzip/deflate/br). The same token authentication and failure
   * throttling as logs, plus an explicit per-signal scope check: a token created for logs only cannot write spans or metrics.
   */
  const otlpSignal = (signal: 'traces' | 'metrics') => {
    const pipe = signal === 'traces' ? tracePipeline : metricPipeline;
    const decode = signal === 'traces' ? decodeTracesRequest : decodeMetricsRequest;
    const encode = signal === 'traces' ? encodeTracesResponse : encodeMetricsResponse;
    const partialKey = signal === 'traces' ? 'rejectedSpans' : 'rejectedDataPoints';
    return async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
      const a = await authenticate(req);
      if (!a.token) {
        if (a.throttled) return reply.header('retry-after', '60').code(429).send({ error: 'rate_limited', message: 'Too many failed authentication attempts', requestId: req.id });
        return reply.code(401).send({ error: 'unauthorized', message: 'A valid ingestion token is required', requestId: req.id });
      }
      if (!a.token.scopes.includes(signal)) return reply.code(403).send({ error: 'forbidden_signal', message: `This token is not allowed to send ${signal}. Create a token that includes "${signal}".`, requestId: req.id });
      const body = req.body as Buffer | undefined;
      if (!body || body.length === 0) return reply.code(200).send({});
      const protobuf = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase().includes('protobuf');
      let payload: unknown;
      try { payload = protobuf ? decode(body) : JSON.parse(body.toString('utf8')); } catch (e) {
        return reply.code(400).send({ error: 'invalid', message: e instanceof ProtobufDecodeError ? 'Body is not valid OTLP protobuf' : 'Body is not valid JSON', requestId: req.id });
      }
      const o = await pipe.handle(a.token, { payload, bodyBytes: body.length, bodyHash: createHash('sha256').update(body).digest('hex') });
      if (o.status === 'quota' || o.status === 'overloaded' || o.status === 'storage_unavailable') {
        reply.header('retry-after', retryAfterSeconds(o.retryAfterMs));
        return reply.code(o.status === 'quota' ? 429 : 503).send({ error: o.status, message: o.message, rejected: o.rejected });
      }
      if (o.status === 'invalid') return reply.code(400).send({ error: 'invalid', message: o.message ?? 'No valid records in the request', rejected: o.rejected });
      if (protobuf) return reply.code(200).header('content-type', 'application/x-protobuf').send(Buffer.from(encode(o.rejected, o.message ?? '')));
      return reply.code(200).send(o.rejected ? { partialSuccess: { [partialKey]: String(o.rejected), errorMessage: o.message ?? 'Some records were rejected' } } : {});
    };
  };

  app.post('/v1/logs', handler('otlp'));
  app.post('/v1/json-logs', handler('json'));
  app.post('/v1/traces', otlpSignal('traces'));
  app.post('/v1/metrics', otlpSignal('metrics'));

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    const ok = await db.ping();
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ready' : 'degraded', checks: { mongodb: ok ? 'up' : 'down' } });
  });
  app.get('/metrics', async (_req, reply) => {
    const m = pipeline.metrics;
    const line = (n: string, h: string, t: 'counter' | 'gauge', v: number) => `# HELP ${n} ${h}\n# TYPE ${n} ${t}\n${n} ${v}\n`;
    return reply.header('content-type', 'text/plain; version=0.0.4').send([
      line('nexus_ingest_requests_total', 'Ingestion requests', 'counter', m.requests),
      line('nexus_ingest_bytes_total', 'Request body bytes', 'counter', m.bytes),
      line('nexus_ingest_records_accepted_total', 'Records durably stored', 'counter', m.accepted),
      line('nexus_ingest_records_duplicate_total', 'Records recognised as retransmissions', 'counter', m.duplicates),
      line('nexus_ingest_records_rejected_invalid_total', 'Records refused as invalid/too old', 'counter', m.rejectedInvalid),
      line('nexus_ingest_records_rejected_quota_total', 'Records refused by rate limits', 'counter', m.rejectedQuota),
      line('nexus_ingest_records_rejected_overload_total', 'Records refused by backpressure', 'counter', m.rejectedOverload),
      line('nexus_ingest_records_rejected_storage_total', 'Records refused because storage failed', 'counter', m.rejectedStorage),
      line('nexus_ingest_store_errors_total', 'Storage write errors (including retried)', 'counter', m.storeErrors),
      line('nexus_ingest_redactions_total', 'Values masked by redaction', 'counter', m.redactions),
      line('nexus_ingest_inflight_writes', 'Writes in progress', 'gauge', pipeline.inflight),
      line('nexus_ingest_queued_writes', 'Requests waiting for a write slot', 'gauge', pipeline.queued),
      ...(['traces', 'metrics'] as const).flatMap((sig) => {
        const p = sig === 'traces' ? tracePipeline : metricPipeline;
        const s = sig === 'traces' ? 'spans' : 'datapoints';
        return [
          line(`nexus_ingest_${s}_accepted_total`, `${sig}: records durably stored`, 'counter', p.metrics.accepted),
          line(`nexus_ingest_${s}_duplicate_total`, `${sig}: retransmissions recognised`, 'counter', p.metrics.duplicates),
          line(`nexus_ingest_${s}_rejected_invalid_total`, `${sig}: records refused as invalid/unsupported/over limits`, 'counter', p.metrics.rejectedInvalid),
          line(`nexus_ingest_${s}_rejected_quota_total`, `${sig}: records refused by rate limits`, 'counter', p.metrics.rejectedQuota),
          line(`nexus_ingest_${s}_rejected_overload_total`, `${sig}: records refused by backpressure`, 'counter', p.metrics.rejectedOverload),
          line(`nexus_ingest_${s}_rejected_storage_total`, `${sig}: records refused because storage failed`, 'counter', p.metrics.rejectedStorage),
          line(`nexus_ingest_${s}_store_errors_total`, `${sig}: storage write errors (including retried)`, 'counter', p.metrics.storeErrors),
          line(`nexus_ingest_${s}_redactions_total`, `${sig}: values masked by redaction`, 'counter', p.metrics.redactions),
          line(`nexus_ingest_${s}_inflight_writes`, `${sig}: writes in progress`, 'gauge', p.inflight),
        ];
      }),
      line('nexus_ingest_metric_datapoints_unsupported_total', 'Metric data points refused as an unsupported type or temporality', 'counter', metricPipeline.unsupported),
    ].join(''));
  });

  return { app, pipeline, tracePipeline, metricPipeline };
}
