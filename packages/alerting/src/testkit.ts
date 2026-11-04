import { AuditService, type Database } from '@nexus/database';
import { freshTestDatabase } from '@nexus/database/testing';
import type { AlertRuleCreate } from '@nexus/contracts';
import { generateKeyBase64, parseKeyring, SecretStore } from '@nexus/secrets';
import { STRICT_POLICY, type NetworkPolicy } from '@nexus/security';
import { AlertEngine, type EngineOptions } from './engine.js';
import type { EvalDeps } from './evaluator.js';
import type { ActorScope } from './common.js';
import { createAlertingServices } from './services.js';
import type { WebhookSender } from './webhook.js';

/** Test-only helpers (not exported from the package index). */
export interface World {
  db: Database; secrets: SecretStore; audit: AuditService; clock: { t: number; now(): Date; advance(seconds: number): void };
  orgA: string; projA: string; envA: string; envA2: string; orgB: string; projB: string; envB: string;
  scopeA: ActorScope; scopeB: ActorScope; userA: string; userB: string;
  svc: ReturnType<typeof createAlertingServices>;
  sent: { url: string; body: string; event: string; deliveryId: string; headers?: never }[];
  senderResult: { current: Awaited<ReturnType<WebhookSender>> };
  engine(deps: EvalDeps, over?: Partial<EngineOptions>): AlertEngine;
}

export async function makeWorld(mongoUri: string, policy: NetworkPolicy = { ...STRICT_POLICY, allowInsecureHttp: true, resolver: async () => ['93.184.216.34'] }): Promise<World> {
  const db = await freshTestDatabase(mongoUri);
  const secrets = new SecretStore(db, parseKeyring(`k1:${generateKeyBase64()}`, 'k1'));
  const audit = new AuditService(db);
  const clock = { t: Math.floor(Date.now() / 60_000) * 60_000, // near real time: TTL indexes (retention) compare expireAt with the server's real clock
     now() { return new Date(this.t); }, advance(s: number) { this.t += s * 1000; } };
  const ids = { orgA: crypto.randomUUID(), projA: crypto.randomUUID(), envA: crypto.randomUUID(), envA2: crypto.randomUUID(), orgB: crypto.randomUUID(), projB: crypto.randomUUID(), envB: crypto.randomUUID(), userA: crypto.randomUUID(), userB: crypto.randomUUID() };
  const mk = (orgId: string, projectId: string, envId: string, slug: string) => ({ _id: envId, orgId, projectId, slug, name: slug, isProduction: false, createdAt: new Date() });
  await db.c.environments.insertMany([mk(ids.orgA, ids.projA, ids.envA, 'dev'), mk(ids.orgA, ids.projA, ids.envA2, 'prod'), mk(ids.orgB, ids.projB, ids.envB, 'dev')]);
  for (const [id, email] of [[ids.userA, 'a@a.test'], [ids.userB, 'b@b.test']] as const) await db.c.users.insertOne({ _id: id, email, emailLower: email, displayName: email.split('@')[0]!, externalSubject: null, createdAt: new Date(), disabledAt: null });

  const sent: World['sent'] = [];
  const senderResult: World['senderResult'] = { current: { ok: true, httpStatus: 200, code: null, message: 'Delivered (HTTP 200)', retryable: false } };
  const sender: WebhookSender = async (req) => { sent.push({ url: req.url, body: req.body, event: req.event, deliveryId: req.deliveryId }); return senderResult.current; };
  const svc = createAlertingServices(db, audit, secrets, policy, { sender, now: () => clock.now() });
  const engine = (deps: EvalDeps, over: Partial<EngineOptions> = {}) =>
    new AlertEngine(db, deps, svc.incidents, { owner: 'test-engine', now: () => clock.now(), ...over });
  return {
    db, secrets, audit, clock, ...ids, svc, sent, senderResult, engine,
    scopeA: { orgId: ids.orgA, projectId: ids.projA, environmentIds: null, userId: ids.userA },
    scopeB: { orgId: ids.orgB, projectId: ids.projB, environmentIds: null, userId: ids.userB },
  };
}

export const metricRule = (w: Pick<World, 'envA'>, over: Partial<AlertRuleCreate> = {}): AlertRuleCreate => ({
  name: `rule-${Math.random().toString(36).slice(2, 8)}`, description: '', severity: 'critical', environmentId: w.envA, enabled: true,
  query: { kind: 'metric', metric: 'http.errors', filters: [], groupBy: [], agg: 'max' }, condition: { op: 'gt', threshold: 10 },
  windowSeconds: 300, forSeconds: 120, resolveAfterSeconds: 120, noDataPolicy: 'keep', intervalSeconds: 60, channelIds: [],
  missedPolicy: 'skip', maxReplayEvaluations: 5, staleNotificationSeconds: 900, ...over,
});

/** A scripted metric store: `series` is what the next query returns; every call is recorded. */
export function scriptedStores() {
  const state: { series: { labels: Record<string, string>; value: number | null }[]; calls: { scope: unknown; query: unknown }[]; fail: Error | null; hang: boolean; logCount: number; hook?: () => Promise<void> } =
    { series: [{ labels: {}, value: 0 }], calls: [], fail: null, hang: false, logCount: 0 };
  const deps: EvalDeps = {
    metrics: {
      async query(scope, q) {
        state.calls.push({ scope, query: q });
        if (state.hook) await state.hook();
        if (state.hang) await new Promise(() => undefined);
        if (state.fail) throw state.fail;
        return {
          metric: q.metric, type: 'gauge', unit: null, agg: q.agg ?? null, stepMs: 60_000, from: q.from, to: q.to, truncated: false, notes: [],
          series: state.series.map((s) => ({ labels: s.labels, points: s.value === null ? [{ t: 0, v: null }] : [{ t: 0, v: s.value }], exemplars: [] })),
        } as never;
      },
    },
    logs: {
      async histogram(scope, q) {
        state.calls.push({ scope, query: q });
        if (state.fail) throw state.fail;
        return { bucketMs: 1000, buckets: [{ t: 0, total: state.logCount, errors: 0 }] };
      },
    },
  };
  return { state, deps };
}
