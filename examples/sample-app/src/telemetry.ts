/**
 * OpenTelemetry bootstrap for a Node.js service: traces, metrics and logs over OTLP/HTTP, with W3C Trace Context propagation.
 *
 * IMPORT THIS FILE FIRST (before `fastify`, `express`, `http` consumers): instrumentation patches modules as they are loaded.
 *
 * Standard environment variables are honoured by the OpenTelemetry exporters — nothing here hard-codes an endpoint or a token:
 *   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces
 *   OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://127.0.0.1:4318/v1/metrics
 *   OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://127.0.0.1:4318/v1/logs
 *   OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer nxi_...            (use a secret store, never commit it)
 *   OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta|cumulative (default cumulative)
 *   OTEL_SEMCONV_STABILITY_OPT_IN=http                                 (http.server.request.duration in seconds instead of the legacy ms metric)
 * Sample-only knobs: SAMPLE_SERVICE_NAME, SAMPLE_FLUSH_MS, SAMPLE_METRIC_MS, SAMPLE_PROTOCOL=proto|json, SAMPLE_ENV.
 */
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { context, metrics, trace, type Span } from '@opentelemetry/api';
import { SeverityNumber, type AnyValueMap } from '@opentelemetry/api-logs';
import { OTLPLogExporter as JsonLogs } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPLogExporter as ProtoLogs } from '@opentelemetry/exporter-logs-otlp-proto';
import { OTLPMetricExporter as JsonMetrics } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPMetricExporter as ProtoMetrics } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter as JsonTraces } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPTraceExporter as ProtoTraces } from '@opentelemetry/exporter-trace-otlp-proto';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

export const SERVICE = process.env.SAMPLE_SERVICE_NAME ?? 'sample-shop';
export const VERSION = '1.3.0';
const json = process.env.SAMPLE_PROTOCOL === 'json';
const flushMs = Number(process.env.SAMPLE_FLUSH_MS ?? 400);

const resource = resourceFromAttributes({
  'service.name': SERVICE, 'service.version': VERSION, 'service.instance.id': randomUUID(),
  'deployment.environment': process.env.SAMPLE_ENV ?? 'demo', 'host.name': hostname(),
});

// ---- traces (W3C Trace Context + baggage propagators are the SDK default)
const tracerProvider = new NodeTracerProvider({
  resource,
  spanProcessors: [new BatchSpanProcessor(json ? new JsonTraces() : new ProtoTraces(), { scheduledDelayMillis: flushMs, maxExportBatchSize: 200 })],
});
tracerProvider.register(); // installs the async context manager and the global propagator

// ---- metrics
const meterProvider = new MeterProvider({
  resource,
  readers: [new PeriodicExportingMetricReader({ exporter: json ? new JsonMetrics() : new ProtoMetrics(), exportIntervalMillis: Number(process.env.SAMPLE_METRIC_MS ?? 2000) })],
});
metrics.setGlobalMeterProvider(meterProvider);

// ---- logs (each record carries the active trace/span id, which is what links logs to traces)
const loggerProvider = new LoggerProvider({
  resource,
  processors: [new BatchLogRecordProcessor({ exporter: json ? new JsonLogs() : new ProtoLogs(), scheduledDelayMillis: flushMs, maxExportBatchSize: 200 })],
});
const logger = loggerProvider.getLogger(`${SERVICE}/app`, VERSION);

// ---- automatic HTTP instrumentation: incoming requests become SERVER spans (continuing a remote W3C `traceparent`),
// outgoing http.request calls become CLIENT spans and inject `traceparent` into the request headers.
registerInstrumentations({ instrumentations: [new HttpInstrumentation()], tracerProvider, meterProvider });

export const tracer = trace.getTracer(SERVICE, VERSION);
export const meter = metrics.getMeter(SERVICE, VERSION);

export type Level = 'debug' | 'info' | 'warn' | 'error';
const SEV: Record<Level, [SeverityNumber, string]> = { debug: [SeverityNumber.DEBUG, 'DEBUG'], info: [SeverityNumber.INFO, 'INFO'], warn: [SeverityNumber.WARN, 'WARN'], error: [SeverityNumber.ERROR, 'ERROR'] };
/** Emits a log record in the CURRENT trace context (or in `span`'s). */
export function log(level: Level, body: string, attributes: AnyValueMap = {}, span?: Span) {
  const ctx = span ? trace.setSpan(context.active(), span) : context.active();
  logger.emit({ severityNumber: SEV[level][0], severityText: SEV[level][1], body, attributes, context: ctx });
}

export async function flushTelemetry() { await Promise.all([tracerProvider.forceFlush(), meterProvider.forceFlush(), loggerProvider.forceFlush()]); }
export async function shutdownTelemetry() { await Promise.all([tracerProvider.shutdown(), meterProvider.shutdown(), loggerProvider.shutdown()]); }
