import {
  CORRELATION_NOTE, DEPLOYMENT_LIMITS, normalizeHttpsUrl,
  type DeploymentDto, type DeploymentListQuery, type DeploymentMarker, type DeploymentStatusName, type DeploymentWrite, type IncidentDeployments,
} from '@nexus/contracts';
import type { AuditSink, Database, DeploymentDoc, RequestContext } from '@nexus/database';
import { scrubText } from '@nexus/telemetry';
import { affectedServices, deploymentPrecedesIncident } from './correlate.js';

const DAY = 86_400_000;
/** How far before an incident opened a deployment may have STARTED and still be examined (a rollout can take a while to finish). */
const CANDIDATE_LOOKBACK_MS = 6 * 3_600_000;

export class DeploymentError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) { super(message); }
}

export interface DeploymentActor { type: 'token' | 'user'; id: string; name: string }
/** Where a record goes. For a token this is the token's own scope; for a session it is the authorized project and environment. */
export interface WriteScope { orgId: string; projectId: string; environmentId: string }
/** What a reader may see: the exact environments of the caller's grant. */
export interface ReadScope { orgId: string; projectId: string; environmentIds: string[] }

export type WriteInput = Omit<DeploymentWrite, 'projectId' | 'environmentId'>;
export type WriteOutcome = 'created' | 'updated' | 'unchanged';

/** started -> anything; succeeded/failed -> rolled_back; nothing leaves rolled_back. */
const NEXT: Record<DeploymentStatusName, readonly DeploymentStatusName[]> = {
  started: ['succeeded', 'failed', 'rolled_back'],
  succeeded: ['rolled_back'],
  failed: ['rolled_back'],
  rolled_back: [],
};
export const canProgress = (from: DeploymentStatusName, to: DeploymentStatusName): boolean => NEXT[from].includes(to);

export const toDeploymentDto = (d: DeploymentDoc): DeploymentDto => ({
  id: d._id, projectId: d.projectId, environmentId: d.environmentId, service: d.service, version: d.version, commitSha: d.commitSha,
  status: d.status, startedAt: d.startedAt.toISOString(), finishedAt: d.finishedAt?.toISOString() ?? null,
  durationMs: d.finishedAt ? Math.max(0, d.finishedAt.getTime() - d.startedAt.getTime()) : null,
  notes: d.notes, linkUrl: d.linkUrl, triggeredBy: d.triggeredBy, actor: { type: d.actor.type, name: d.actor.name }, idempotencyKey: d.idempotencyKey,
  createdAt: d.createdAt.toISOString(), updatedAt: d.updatedAt.toISOString(),
});

const encodeCursor = (d: { startedAt: Date; _id: string }) => Buffer.from(JSON.stringify([d.startedAt.getTime(), d._id])).toString('base64url');
function decodeCursor(c: string): { t: Date; id: string } {
  try {
    const [t, id] = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as [unknown, unknown];
    if (typeof t === 'number' && Number.isFinite(t) && typeof id === 'string' && id.length <= 64) return { t: new Date(t), id };
  } catch { /* fall through */ }
  throw new DeploymentError(400, 'invalid_cursor', 'The cursor is not valid');
}

const isDuplicateKey = (e: unknown) => (e as { code?: number })?.code === 11000;

/**
 * Deployments / change markers (ADR-0011). Tenant fields always come from the caller's credential (a token's scope, or an authorized session).
 * Stored text is plain text: the API validates it, the notes are credential-scrubbed, and no consumer renders it as markup.
 */
export class DeploymentService {
  constructor(private readonly db: Database, private readonly audit: AuditSink, private readonly now: () => Date = () => new Date()) {}

  // ---------------------------------------------------------------- write

  async record(scope: WriteScope, actor: DeploymentActor, input: WriteInput, ctx: RequestContext): Promise<{ outcome: WriteOutcome; deployment: DeploymentDoc }> {
    const env = await this.db.c.environments.findOne({ _id: scope.environmentId, orgId: scope.orgId, projectId: scope.projectId });
    if (!env) throw new DeploymentError(404, 'not_found', 'Environment not found');

    const normalized = {
      service: input.service, version: input.version, status: input.status,
      commitSha: input.commitSha ? input.commitSha.toLowerCase() : null,
      notes: input.notes ? scrubText(input.notes).text.trim() || null : null,
      linkUrl: input.linkUrl ? normalizeHttpsUrl(input.linkUrl) : null,
      triggeredBy: input.triggeredBy ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
    };
    if (input.linkUrl && !normalized.linkUrl) throw new DeploymentError(400, 'invalid_link', 'linkUrl must be an https:// URL without credentials');

    // A key that is already known means "the same deployment, reported again".
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = normalized.idempotencyKey
        ? await this.db.c.deployments.findOne({ orgId: scope.orgId, environmentId: scope.environmentId, idempotencyKey: normalized.idempotencyKey })
        : null;
      if (existing) {
        const r = await this.progress(existing, actor, input, normalized, ctx);
        if (r) return r;
        continue; // lost a race with a concurrent update: decide again on the fresh state
      }
      try {
        return { outcome: 'created', deployment: await this.create(scope, actor, input, normalized, ctx) };
      } catch (e) {
        if (isDuplicateKey(e) && normalized.idempotencyKey) continue; // a concurrent first write won: take the replay path
        throw e;
      }
    }
    throw new DeploymentError(409, 'conflict', 'The deployment was changed concurrently; retry');
  }

  private checkTimes(startedAt: Date, finishedAt: Date | null, status: DeploymentStatusName, now: Date) {
    const t = now.getTime();
    if (startedAt.getTime() < t - DEPLOYMENT_LIMITS.maxAgeDays * DAY) throw new DeploymentError(400, 'invalid_time', `startedAt is more than ${DEPLOYMENT_LIMITS.maxAgeDays} days in the past`);
    if (startedAt.getTime() > t + DEPLOYMENT_LIMITS.maxFutureMs) throw new DeploymentError(400, 'invalid_time', 'startedAt is in the future');
    if (status === 'started' && finishedAt) throw new DeploymentError(400, 'invalid_time', 'A deployment that has only started has no finishedAt');
    if (finishedAt) {
      if (finishedAt.getTime() < startedAt.getTime()) throw new DeploymentError(400, 'invalid_time', 'finishedAt is before startedAt');
      if (finishedAt.getTime() > t + DEPLOYMENT_LIMITS.maxFutureMs) throw new DeploymentError(400, 'invalid_time', 'finishedAt is in the future');
    }
  }

  private async create(
    scope: WriteScope, actor: DeploymentActor, input: WriteInput,
    n: { service: string; version: string; status: DeploymentStatusName; commitSha: string | null; notes: string | null; linkUrl: string | null; triggeredBy: string | null; idempotencyKey: string | null },
    ctx: RequestContext,
  ): Promise<DeploymentDoc> {
    const now = this.now();
    const startedAt = input.startedAt ? new Date(input.startedAt) : now;
    const finishedAt = n.status === 'started' ? null : input.finishedAt ? new Date(input.finishedAt) : now < startedAt ? startedAt : now;
    this.checkTimes(startedAt, n.status === 'started' ? (input.finishedAt ? new Date(input.finishedAt) : null) : finishedAt, n.status, now);

    // Storage growth limit per environment (a leaked token cannot fill the collection): a bounded index scan over the last 24 hours.
    const recent = await this.db.c.deployments.countDocuments(
      { orgId: scope.orgId, projectId: scope.projectId, environmentId: scope.environmentId, startedAt: { $gte: new Date(now.getTime() - DAY) } },
      { limit: DEPLOYMENT_LIMITS.perEnvironmentPerDay, maxTimeMS: 5_000 },
    );
    if (recent >= DEPLOYMENT_LIMITS.perEnvironmentPerDay) {
      throw new DeploymentError(429, 'environment_limit', `At most ${DEPLOYMENT_LIMITS.perEnvironmentPerDay} deployments can be recorded per environment in 24 hours`);
    }

    const doc: DeploymentDoc = {
      _id: crypto.randomUUID(), ...scope, service: n.service, version: n.version, commitSha: n.commitSha, status: n.status,
      startedAt, finishedAt, notes: n.notes, linkUrl: n.linkUrl, triggeredBy: n.triggeredBy, actor, idempotencyKey: n.idempotencyKey,
      createdAt: now, updatedAt: now, expireAt: new Date(startedAt.getTime() + DEPLOYMENT_LIMITS.retentionDays * DAY),
    };
    await this.db.transaction(async (session) => {
      await this.db.c.deployments.insertOne(doc, { session });
      await this.auditWrite('deployment.recorded', doc, actor, ctx, session);
    });
    return doc;
  }

  /** Decides what a repeated key means. Returns null when the update lost a race (the caller decides again). */
  private async progress(
    existing: DeploymentDoc, actor: DeploymentActor, input: WriteInput,
    n: { service: string; version: string; status: DeploymentStatusName; commitSha: string | null; notes: string | null; linkUrl: string | null; triggeredBy: string | null },
    ctx: RequestContext,
  ): Promise<{ outcome: WriteOutcome; deployment: DeploymentDoc } | null> {
    if (existing.service !== n.service || existing.version !== n.version || (n.commitSha !== null && existing.commitSha !== n.commitSha)) {
      throw new DeploymentError(409, 'idempotency_conflict', 'This idempotency key belongs to a different deployment (service, version or commit differ)');
    }
    if (existing.status === n.status) return { outcome: 'unchanged', deployment: existing };
    if (!canProgress(existing.status, n.status)) {
      throw new DeploymentError(409, 'invalid_transition', `A deployment that is ${existing.status.replace('_', ' ')} cannot become ${n.status.replace('_', ' ')}`);
    }
    const now = this.now();
    const finishedAt = input.finishedAt ? new Date(input.finishedAt) : now < existing.startedAt ? existing.startedAt : now;
    this.checkTimes(existing.startedAt, finishedAt, n.status, now);
    const set = { status: n.status, finishedAt, updatedAt: now, notes: n.notes ?? existing.notes, linkUrl: n.linkUrl ?? existing.linkUrl, triggeredBy: n.triggeredBy ?? existing.triggeredBy };
    const updated = await this.db.transaction(async (session) => {
      // Conditional on the status the decision was made on: two concurrent updates cannot both apply.
      const r = await this.db.c.deployments.findOneAndUpdate({ _id: existing._id, orgId: existing.orgId, status: existing.status }, { $set: set }, { returnDocument: 'after', session });
      if (r) await this.auditWrite('deployment.updated', r, actor, ctx, session, existing.status);
      return r;
    });
    return updated ? { outcome: 'updated', deployment: updated } : null;
  }

  private auditWrite(action: string, d: DeploymentDoc, actor: DeploymentActor, ctx: RequestContext, session: Parameters<AuditSink['record']>[2], from?: DeploymentStatusName) {
    return this.audit.record({
      orgId: d.orgId, actorUserId: actor.type === 'user' ? actor.id : null, action, targetType: 'deployment', targetId: d._id,
      projectId: d.projectId, environmentId: d.environmentId,
      // Names and states only: never the notes or the link.
      metadata: { service: d.service, version: d.version, status: d.status, ...(from ? { from } : {}), ...(actor.type === 'token' ? { senderId: actor.id, senderName: actor.name } : {}) },
    }, ctx, session);
  }

  // ---------------------------------------------------------------- read

  private filter(scope: ReadScope, environmentId?: string): Record<string, unknown> | null {
    if (environmentId && !scope.environmentIds.includes(environmentId)) return null;
    const envs = environmentId ? [environmentId] : scope.environmentIds;
    if (envs.length === 0) return null;
    return { orgId: scope.orgId, projectId: scope.projectId, environmentId: envs.length === 1 ? envs[0] : { $in: envs } };
  }

  async list(scope: ReadScope, q: Pick<DeploymentListQuery, 'environmentId' | 'service' | 'status' | 'from' | 'to' | 'limit' | 'cursor'>): Promise<{ items: DeploymentDoc[]; nextCursor: string | null }> {
    const base = this.filter(scope, q.environmentId);
    if (!base) return { items: [], nextCursor: null };
    const and: Record<string, unknown>[] = [];
    if (q.service) base.service = q.service;
    if (q.status) base.status = q.status;
    const range: Record<string, Date> = {};
    if (q.from) range.$gte = new Date(q.from);
    if (q.to) range.$lte = new Date(q.to);
    if (range.$gte && range.$lte && range.$gte > range.$lte) throw new DeploymentError(400, 'invalid_range', '"from" is after "to"');
    if (Object.keys(range).length) and.push({ startedAt: range });
    if (q.cursor) { const c = decodeCursor(q.cursor); and.push({ $or: [{ startedAt: { $lt: c.t } }, { startedAt: c.t, _id: { $lt: c.id } }] }); }
    const rows = await this.db.c.deployments.find(and.length ? { ...base, $and: and } : base).sort({ startedAt: -1, _id: -1 }).limit(q.limit + 1).maxTimeMS(5_000).toArray();
    const items = rows.slice(0, q.limit);
    return { items, nextCursor: rows.length > q.limit ? encodeCursor(items[items.length - 1]!) : null };
  }

  async get(scope: ReadScope, id: string): Promise<DeploymentDoc> {
    const base = this.filter(scope);
    const d = base ? await this.db.c.deployments.findOne({ ...base, _id: id } as never) : null;
    if (!d) throw new DeploymentError(404, 'not_found', 'Deployment not found');
    return d;
  }

  /** Chart markers in [from, to]: at most `markerLimit` (the newest), oldest first, without notes or links. */
  async markers(scope: ReadScope, q: { from: string; to: string; environmentId?: string | undefined; service?: string | undefined }): Promise<{ items: DeploymentMarker[]; truncated: boolean }> {
    const from = new Date(q.from), to = new Date(q.to);
    if (!(from < to)) throw new DeploymentError(400, 'invalid_range', '"from" must be before "to"');
    if (to.getTime() - from.getTime() > 31 * DAY) throw new DeploymentError(400, 'invalid_range', 'The window is limited to 31 days');
    const base = this.filter(scope, q.environmentId);
    if (!base) return { items: [], truncated: false };
    if (q.service) base.service = q.service;
    const rows = await this.db.c.deployments.find({ ...base, startedAt: { $gte: from, $lte: to } })
      .project<Pick<DeploymentDoc, '_id' | 'environmentId' | 'service' | 'version' | 'status' | 'startedAt' | 'finishedAt'>>({ _id: 1, environmentId: 1, service: 1, version: 1, status: 1, startedAt: 1, finishedAt: 1 })
      .sort({ startedAt: -1, _id: -1 }).limit(DEPLOYMENT_LIMITS.markerLimit + 1).maxTimeMS(5_000).toArray();
    const kept = rows.slice(0, DEPLOYMENT_LIMITS.markerLimit).reverse();
    return {
      truncated: rows.length > DEPLOYMENT_LIMITS.markerLimit,
      items: kept.map((d) => ({ id: d._id, environmentId: d.environmentId, service: d.service, version: d.version, status: d.status, at: d.startedAt.toISOString(), finishedAt: d.finishedAt?.toISOString() ?? null })),
    };
  }

  /** Deployments of the services an incident is about, in its environment, shortly before it opened. Read-only; says nothing about cause. */
  async forIncident(scope: ReadScope, incidentId: string): Promise<IncidentDeployments> {
    const incident = await this.db.c.incidents.findOne({ _id: incidentId, orgId: scope.orgId, projectId: scope.projectId });
    // An incident in an environment the caller cannot read does not exist for them.
    if (!incident || !scope.environmentIds.includes(incident.environmentId)) throw new DeploymentError(404, 'not_found', 'Incident not found');
    const rule = await this.db.c.alertConfig.findOne({ _id: incident.ruleId, kind: 'rule', orgId: scope.orgId, projectId: scope.projectId });
    const services = affectedServices(rule && rule.kind === 'rule' ? rule.query : null, incident.groupLabels);
    const windowMinutes = DEPLOYMENT_LIMITS.correlationWindowMs / 60_000;
    if (services.length === 0) return { services, windowMinutes, items: [], note: CORRELATION_NOTE };
    const candidates = await this.db.c.deployments.find({
      orgId: scope.orgId, projectId: scope.projectId, environmentId: incident.environmentId, service: { $in: services },
      startedAt: { $gte: new Date(incident.openedAt.getTime() - CANDIDATE_LOOKBACK_MS), $lte: incident.openedAt },
    }).sort({ startedAt: -1, _id: -1 }).limit(100).maxTimeMS(5_000).toArray();
    const items = candidates.filter((d) => deploymentPrecedesIncident(d, incident.openedAt)).reverse().slice(-20);
    return { services, windowMinutes, items: items.map(toDeploymentDto), note: CORRELATION_NOTE };
  }
}
