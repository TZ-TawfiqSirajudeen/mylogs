import http from 'node:http';
import { hostname } from 'node:os';
import { AlertWorker } from '@nexus/alerting';
import { ConnectionService } from '@nexus/connections';
import { createDefaultRegistry } from '@nexus/connectors';
import { AuditService, connectDatabase } from '@nexus/database';
import { MongoLogStore } from '@nexus/logstore';
import { connectorMetricSink, MongoMetricStore, startRollupCompactor } from '@nexus/metricstore';
import { loadKeyring, SecretStore } from '@nexus/secrets';
import { parseNetworkPolicy } from '@nexus/security';
import { z } from 'zod';
import { MonitorWorker } from './monitor.js';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  MONGODB_URI: z.string().min(1),
  MONGODB_DB: z.string().default('nexus'),
  SECRETS_KEYS: z.string().optional(),
  SECRETS_CURRENT_KEY_ID: z.string().optional(),
  SECRETS_DEV_KEY_FILE: z.string().default('.dev-secrets/kek.json'),
  NETWORK_ALLOW_LOOPBACK: z.string().optional(),
  NETWORK_ALLOW_PRIVATE_CIDRS: z.string().optional(),
  NETWORK_ALLOW_INSECURE_HTTP: z.string().optional(),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
  WORKER_TICK_MS: z.coerce.number().int().min(500).max(60_000).default(5_000),
  /** Alert evaluation and notification scheduling (ADR-0006). `ALERTING_ENABLED=false` turns the engine off on this worker. */
  ALERTING_ENABLED: z.enum(['true', 'false']).default('true'),
  ALERT_TICK_MS: z.coerce.number().int().min(500).max(60_000).default(2_000),
  ALERT_MAX_RULES_PER_TICK: z.coerce.number().int().min(1).max(500).default(50),
  ALERT_RULE_BUDGET_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
  /** Used only to put a link to the incident in notifications. */
  WEB_ORIGIN: z.string().url().optional(),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  WORKER_HEALTH_HOST: z.string().default('127.0.0.1'),
  CONNECTION_TEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  /** Metric rollup compaction (ADR-0007): how often the worker rolls sealed minutes into the 5-minute and 1-hour tiers. 0 turns it off (queries then read minute documents). */
  METRIC_ROLLUP_INTERVAL_MS: z.coerce.number().int().min(0).max(3_600_000).default(30_000),
});

const log = (level: string, msg: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields }));

async function main() {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) throw new Error(`Invalid configuration: ${[...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(', ')}`);
  const e = parsed.data;
  const prod = e.NODE_ENV === 'production';
  const network = parseNetworkPolicy(e, prod);
  const keyring = loadKeyring({ SECRETS_KEYS: e.SECRETS_KEYS, SECRETS_CURRENT_KEY_ID: e.SECRETS_CURRENT_KEY_ID }, { production: prod, devKeyFile: e.SECRETS_DEV_KEY_FILE });

  const db = await connectDatabase(e.MONGODB_URI, e.MONGODB_DB);
  const svc = new ConnectionService({
    db, secrets: new SecretStore(db, keyring), registry: createDefaultRegistry(), audit: new AuditService(db), network, testTimeoutMs: e.CONNECTION_TEST_TIMEOUT_MS,
    // Database connectors (MongoDB, Redis) sample read-only metrics into the same metric store the OTLP ingestion uses.
    sink: connectorMetricSink(new MongoMetricStore(db)),
  });
  const worker = new MonitorWorker(svc, {
    owner: `${hostname()}:${process.pid}`, concurrency: e.WORKER_CONCURRENCY, tickMs: e.WORKER_TICK_MS,
    log: (level, msg, fields) => log(level, msg, fields),
  });

  // Liveness never touches the database (a DB outage must not restart-loop the worker); readiness requires a live scheduler loop AND the DB.
  const health = http.createServer(async (req, res) => {
    if (req.url === '/healthz') { res.writeHead(200).end('ok'); return; }
    if (req.url === '/readyz') {
      const ok = worker.isAlive() && (await db.ping());
      res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify({ status: ok ? 'ready' : 'degraded', scheduler: worker.isAlive(), mongodb: ok }));
      return;
    }
    if (req.url === '/metrics') { res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(worker.prometheus() + (alerts?.prometheus() ?? '')); return; }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => health.listen(e.WORKER_HEALTH_PORT, e.WORKER_HEALTH_HOST, r));

  const alerts = e.ALERTING_ENABLED === 'true'
    ? new AlertWorker(db, { metrics: new MongoMetricStore(db), logs: new MongoLogStore(db), secrets: new SecretStore(db, keyring) }, {
      owner: `${hostname()}:${process.pid}`, tickMs: e.ALERT_TICK_MS, policy: network, publicUrl: e.WEB_ORIGIN ?? null,
      engine: { maxRulesPerTick: e.ALERT_MAX_RULES_PER_TICK, ruleBudgetMs: e.ALERT_RULE_BUDGET_MS }, log: (level, msg, fields) => log(level, msg, fields),
    })
    : null;
  worker.start();
  const stopRollups = e.METRIC_ROLLUP_INTERVAL_MS > 0 ? startRollupCompactor(db, { intervalMs: e.METRIC_ROLLUP_INTERVAL_MS, owner: `${hostname()}:${process.pid}`, log: (level, msg, fields) => log(level, msg, fields) }) : async () => undefined;
  alerts?.start();
  log('info', 'worker started', { concurrency: e.WORKER_CONCURRENCY, tickMs: e.WORKER_TICK_MS, healthPort: e.WORKER_HEALTH_PORT });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log('info', 'shutting down', { signal });
    const { drained } = await worker.stop(15_000);
    if (!drained) log('warn', 'shutdown grace period elapsed with checks still running; their leases will expire');
    await alerts?.stop(15_000);
    await stopRollups();
    health.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
