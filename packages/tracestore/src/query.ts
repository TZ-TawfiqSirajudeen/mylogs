import type { TraceQuery } from '@nexus/contracts';

export interface Scope { orgId: string; projectId: string; /** Environments the caller may read. Never empty. */ environmentIds: string[] }
export type MongoFilter = Record<string, unknown>;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function encodeCursor(primary: number, id: string): string { return Buffer.from(JSON.stringify([primary, id])).toString('base64url'); }
export function decodeCursor(c: string): [number, string] | null {
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as unknown;
    return Array.isArray(v) && typeof v[0] === 'number' && Number.isFinite(v[0]) && typeof v[1] === 'string' && v[1].length <= 80 ? [v[0], v[1]] : null;
  } catch { return null; }
}

/**
 * Turns a validated TraceQuery into a filter over `trace_summaries`. Tenant scope is applied first and unconditionally; user input only
 * narrows it. Every value is a string/number under a fixed field, and regular expressions are always escaped literals, so operator
 * objects cannot be injected.
 */
export function buildTraceFilter(q: TraceQuery, scope: Scope): MongoFilter {
  const envs = q.environmentIds?.length ? scope.environmentIds.filter((e) => q.environmentIds!.includes(e)) : scope.environmentIds;
  const f: MongoFilter = {
    orgId: scope.orgId, projectId: scope.projectId, environmentId: { $in: envs },
    start: { $gte: new Date(q.from), $lte: new Date(q.to) },
  };
  const and: MongoFilter[] = [];
  if (q.traceId) f.traceId = q.traceId;
  if (q.services?.length) f.services = { $in: q.services };
  if (q.spanName) and.push({ names: { $regex: escapeRegex(q.spanName), $options: 'i' } });
  if (q.errorsOnly) f.errorCount = { $gt: 0 };
  if (q.okOnly) f.errorCount = 0;
  if (q.minDurationMs !== undefined || q.maxDurationMs !== undefined) {
    f.durationNs = {
      ...(q.minDurationMs !== undefined ? { $gte: Math.round(q.minDurationMs * 1_000_000) } : {}),
      ...(q.maxDurationMs !== undefined ? { $lte: Math.round(q.maxDurationMs * 1_000_000) } : {}),
    };
  }
  if (q.httpStatus !== undefined) f.httpStatus = q.httpStatus;
  if (q.httpMethod) f.httpMethod = q.httpMethod;
  if (q.httpRoute) and.push({ httpRoute: { $regex: escapeRegex(q.httpRoute), $options: 'i' } });
  if (q.dbSystem) f.dbSystems = q.dbSystem;
  if (q.exceptionType) and.push({ exceptionTypes: { $regex: escapeRegex(q.exceptionType), $options: 'i' } });
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    if (c) {
      const [primary, id] = c;
      if (q.sort === 'recent') and.push({ $or: [{ start: { $lt: new Date(primary) } }, { start: new Date(primary), _id: { $lt: id } }] });
      else and.push({ $or: [{ durationNs: { $lt: primary } }, { durationNs: primary, _id: { $lt: id } }] });
    }
  }
  if (and.length) f.$and = and;
  return f;
}
