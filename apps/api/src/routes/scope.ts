import { createHash } from 'node:crypto';
import type { Database } from '@nexus/database';
import type { FastifyRequest } from 'fastify';
import type { ProjectAction } from '../authz/policy.js';
import { principalOf } from '../plugins/auth.js';
import type { ProjectService } from '../services/projects.js';

export interface TelemetryScope { orgId: string; projectId: string; environmentIds: string[] }

/**
 * Authorization for every trace/metric/service endpoint: project access (RBAC) -> the exact set of environments this caller may read.
 * The scope is derived on the server from the session; nothing in a request can widen it.
 */
export function makeAuthorize(db: Database, projects: ProjectService) {
  return async function authorize(req: FastifyRequest, projectId: string, action: ProjectAction) {
    const p = principalOf(req);
    const { access } = await projects.requireProject(p, projectId, action);
    let environmentIds = access.environmentIds;
    if (environmentIds === null) environmentIds = (await db.c.environments.find({ orgId: p.orgId, projectId }).project({ _id: 1 }).toArray()).map((e) => e._id as string);
    const scope: TelemetryScope = { orgId: p.orgId, projectId, environmentIds };
    return { p, access, scope };
  };
}
export type Authorize = ReturnType<typeof makeAuthorize>;

export const sessionKey = (req: FastifyRequest, cookieName: string) => createHash('sha256').update(req.cookies?.[cookieName] ?? req.ip).digest('hex').slice(0, 24);

/**
 * Short-lived in-process cache for read-only aggregates. Keys always contain the AUTHORIZED SCOPE (organization, project and the exact
 * environment set the caller may read) plus the request parameters, so a result can only ever be served to a caller with identical
 * access; two users with different access can never share an entry. Bounded size, bounded age.
 */
export class ScopedCache<T> {
  private readonly m = new Map<string, { at: number; v: T }>();
  constructor(private readonly ttlMs = 10_000, private readonly max = 200, private readonly now: () => number = Date.now) {}
  key(scope: TelemetryScope, kind: string, params: unknown): string {
    return createHash('sha256').update(JSON.stringify([scope.orgId, scope.projectId, [...scope.environmentIds].sort(), kind, params])).digest('hex');
  }
  async get(key: string, load: () => Promise<T>): Promise<{ value: T; cached: boolean }> {
    const hit = this.m.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return { value: hit.v, cached: true };
    const v = await load();
    if (this.m.size >= this.max) this.m.delete(this.m.keys().next().value as string);
    this.m.set(key, { at: this.now(), v });
    return { value: v, cached: false };
  }
}

/** Records how long telemetry queries take and how often they fail (per process; shown in the diagnostics endpoint). */
export class QueryMonitor {
  private readonly durations = new Map<string, number[]>();
  private readonly failures = new Map<string, number>();
  async time<T>(kind: string, fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    try { return await fn(); } catch (e) { this.failures.set(kind, (this.failures.get(kind) ?? 0) + 1); throw e; } finally {
      const list = this.durations.get(kind) ?? [];
      list.push(performance.now() - t0);
      if (list.length > 200) list.shift();
      this.durations.set(kind, list);
    }
  }
  snapshot() {
    return [...this.durations].map(([kind, d]) => {
      const s = [...d].sort((a, b) => a - b);
      return { kind, count: d.length, failures: this.failures.get(kind) ?? 0, p50Ms: Math.round(s[Math.floor(s.length * 0.5)] ?? 0), p95Ms: Math.round(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] ?? 0) };
    });
  }
}
