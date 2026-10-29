import { searchNeedle } from '@nexus/database';
import { FIELD_TYPES, LogQuery, OPERATORS, SEVERITIES, MAX_LIMIT, MAX_RANGE_MS, LogFilter, type FieldName } from '@nexus/contracts';

/** The query schema lives in @nexus/contracts (shared with the web client); this module turns a validated query into a filter. */
export { FIELD_TYPES, LogQuery, OPERATORS, MAX_LIMIT, MAX_RANGE_MS, LogFilter };
export type { FieldName };
const levelOf = (s: (typeof SEVERITIES)[number]): number => SEVERITIES.indexOf(s);

export interface Scope { orgId: string; projectId: string; /** Environments the caller may read. Never empty. */ environmentIds: string[] }

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ci = (s: string) => ({ $regex: escapeRegex(s), $options: 'i' });

/** `"quoted phrase"` or bare words; at most 5 terms of at most 64 characters, all of which must match. */
export function searchTerms(text: string | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(/"([^"]+)"|(\S+)/g)) out.push((m[1] ?? m[2])!.slice(0, 64));
  return out.slice(0, 5);
}

export type MongoFilter = Record<string, unknown>;

export function encodeCursor(ms: number, id: string): string { return Buffer.from(JSON.stringify([ms, id])).toString('base64url'); }
export function decodeCursor(c: string): [number, string] | null {
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as unknown;
    return Array.isArray(v) && typeof v[0] === 'number' && typeof v[1] === 'string' && v[1].length <= 80 ? [v[0], v[1]] : null;
  } catch { return null; }
}

/**
 * Builds the database filter. Tenant scope is applied FIRST and unconditionally; user input only ever narrows it.
 * Every user-supplied value is a string or number placed under an allow-listed field, so operator objects (`{"$ne": …}`)
 * cannot be injected, and regular expressions are always escaped literals.
 */
export function buildFilter(q: LogQuery, scope: Scope, opts: { timeField?: 'ts' | 'receivedAt' } = {}): MongoFilter {
  const timeField = opts.timeField ?? 'ts';
  const envs = q.environmentIds?.length ? scope.environmentIds.filter((e) => q.environmentIds!.includes(e)) : scope.environmentIds;
  const and: MongoFilter[] = [];
  const f: MongoFilter = {
    orgId: scope.orgId, projectId: scope.projectId, environmentId: { $in: envs },
    [timeField]: { $gte: new Date(q.from), $lte: new Date(q.to) },
  };

  if (q.errorsOnly) and.push({ level: { $gte: levelOf('error') } });
  else if (q.minSeverity) and.push({ level: { $gte: levelOf(q.minSeverity) } });
  if (q.services?.length) and.push({ service: { $in: q.services } });
  // One plain (case-sensitive) match on the pre-lowercased `searchText`: a case-insensitive search that a covering index can serve.
  for (const term of searchTerms(q.text)) and.push({ searchText: { $regex: escapeRegex(searchNeedle(term)) } });
  for (const flt of q.filters) {
    if (flt.field.startsWith('attr:')) {
      const k = flt.field.slice(5);
      if (flt.op === 'exists') and.push({ 'attrs.k': k });
      else if (flt.op === 'contains') and.push({ attrs: { $elemMatch: { k, v: ci(String(flt.value)) } } });
      else if (flt.op === 'ne') and.push({ attrs: { $not: { $elemMatch: { k, v: String(flt.value) } } } });
      else and.push({ attrs: { $elemMatch: { k, v: String(flt.value) } } });
      continue;
    }
    const field = flt.field as FieldName;
    const isNum = FIELD_TYPES[field] === 'number';
    const v = isNum ? Number(flt.value) : String(flt.value ?? '');
    switch (flt.op) {
      case 'eq': and.push({ [field]: v }); break;
      case 'ne': and.push({ [field]: { $ne: v } }); break;
      case 'contains': and.push({ [field]: ci(String(v)) }); break;
      case 'gt': and.push({ [field]: { $gt: v } }); break;
      case 'gte': and.push({ [field]: { $gte: v } }); break;
      case 'lt': and.push({ [field]: { $lt: v } }); break;
      case 'lte': and.push({ [field]: { $lte: v } }); break;
      case 'exists': and.push({ [field]: { $ne: null } }); break;
    }
  }
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    if (c) {
      const [ms, id] = c;
      const d = new Date(ms);
      and.push(q.sort === 'desc'
        ? { $or: [{ [timeField]: { $lt: d } }, { [timeField]: d, _id: { $lt: id } }] }
        : { $or: [{ [timeField]: { $gt: d } }, { [timeField]: d, _id: { $gt: id } }] });
    }
  }
  if (and.length) f.$and = and;
  return f;
}
