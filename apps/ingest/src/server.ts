import { connectDatabase } from '@nexus/database';
import { DEFAULT_INGEST_CONFIG } from '@nexus/ingest';
import { MAX_SERIES_PER_ENVIRONMENT, MAX_SERIES_PER_METRIC, MongoMetricStore } from '@nexus/metricstore';
import { DEFAULT_LIMITS } from '@nexus/telemetry';
import { z } from 'zod';
import { buildIngestApp } from './app.js';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  MONGODB_URI: z.string().min(1),
  MONGODB_DB: z.string().default('nexus'),
  // 4318 is the standard OTLP/HTTP port, so stock exporters and collectors need no extra configuration.
  INGEST_PORT: z.coerce.number().int().min(1).max(65535).default(4318),
  INGEST_HOST: z.string().default('127.0.0.1'),
  INGEST_MAX_BODY_BYTES: z.coerce.number().int().min(1024).max(32 * 1024 * 1024).default(4 * 1024 * 1024),
  INGEST_MAX_RECORDS_PER_REQUEST: z.coerce.number().int().min(1).max(50_000).default(5000),
  INGEST_TOKEN_RECORDS_PER_MINUTE: z.coerce.number().int().min(100).default(60_000),
  INGEST_PROJECT_RECORDS_PER_MINUTE: z.coerce.number().int().min(100).default(200_000),
  INGEST_MAX_INFLIGHT_WRITES: z.coerce.number().int().min(1).max(256).default(8),
  INGEST_MAX_QUEUED_WRITES: z.coerce.number().int().min(0).max(4096).default(64),
  // Metric cardinality limits (one series = one label combination of one service instance).
  METRIC_MAX_SERIES_PER_METRIC: z.coerce.number().int().min(10).max(100_000).default(MAX_SERIES_PER_METRIC),
  METRIC_MAX_SERIES_PER_ENVIRONMENT: z.coerce.number().int().min(100).max(1_000_000).default(MAX_SERIES_PER_ENVIRONMENT),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

async function main() {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) throw new Error(`Invalid configuration: ${[...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(', ')}`);
  const e = parsed.data;
  const db = await connectDatabase(e.MONGODB_URI, e.MONGODB_DB);
  const { app } = await buildIngestApp(db, {
    maxBodyBytes: e.INGEST_MAX_BODY_BYTES, logLevel: e.LOG_LEVEL, authFailuresPerMinute: 30,
    ingest: {
      ...DEFAULT_INGEST_CONFIG, limits: { ...DEFAULT_LIMITS, maxRecordsPerRequest: e.INGEST_MAX_RECORDS_PER_REQUEST },
      tokenRecordsPerMinute: e.INGEST_TOKEN_RECORDS_PER_MINUTE, projectRecordsPerMinute: e.INGEST_PROJECT_RECORDS_PER_MINUTE,
      maxInflightWrites: e.INGEST_MAX_INFLIGHT_WRITES, maxQueuedWrites: e.INGEST_MAX_QUEUED_WRITES,
    },
  }, { metricStore: new MongoMetricStore(db, { maxSeriesPerMetric: e.METRIC_MAX_SERIES_PER_METRIC, maxSeriesPerEnvironment: e.METRIC_MAX_SERIES_PER_ENVIRONMENT }) });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    try { await app.close(); await db.close(); } finally { process.exit(0); }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  await app.listen({ port: e.INGEST_PORT, host: e.INGEST_HOST });
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
