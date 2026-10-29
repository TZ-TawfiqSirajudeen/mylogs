import { redactSecrets } from '@nexus/security';
import type { ClientSession } from 'mongodb';
import type { Database } from './client.js';
import type { AuditEventDoc } from './models.js';

export interface RequestContext { requestId: string; ip?: string }

export interface AuditInput {
  orgId: string;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  projectId?: string | null;
  environmentId?: string | null;
  metadata?: Record<string, unknown>;
}

/** Anything that can record audit events (the API and the worker use the same implementation). */
export interface AuditSink {
  record(input: AuditInput, ctx: RequestContext, session?: ClientSession): Promise<void>;
}

/**
 * Append-only audit log. This module only exposes insert + read; production deployments should also grant the
 * API's MongoDB user insert/find (no update/remove) on `audit_events`. Metadata is redacted before it is stored,
 * so secrets can never reach the audit trail.
 */
export class AuditService implements AuditSink {
  constructor(private readonly db: Database) {}

  async record(input: AuditInput, ctx: RequestContext, session?: ClientSession): Promise<void> {
    const counter = await this.db.c.counters.findOneAndUpdate(
      { _id: `audit:${input.orgId}` },
      { $inc: { value: 1 } },
      { upsert: true, returnDocument: 'after', session },
    );
    const doc: AuditEventDoc = {
      _id: crypto.randomUUID(),
      seq: counter!.value,
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      actorType: input.actorUserId ? 'user' : 'system',
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      projectId: input.projectId ?? null,
      environmentId: input.environmentId ?? null,
      requestId: ctx.requestId,
      metadata: redactSecrets(input.metadata ?? {}) as Record<string, unknown>,
      createdAt: new Date(),
    };
    await this.db.c.auditEvents.insertOne(doc, { session });
  }

  async list(orgId: string, q: { before?: number; limit: number; action?: string; projectId?: string }) {
    const filter: Record<string, unknown> = { orgId };
    if (q.before) filter.seq = { $lt: q.before };
    if (q.action) filter.action = q.action;
    if (q.projectId) filter.projectId = q.projectId;
    const rows = await this.db.c.auditEvents.find(filter).sort({ seq: -1 }).limit(q.limit + 1).maxTimeMS(5_000).toArray();
    const page = rows.slice(0, q.limit);
    return { items: page, nextBefore: rows.length > q.limit ? page[page.length - 1]!.seq : null };
  }
}
