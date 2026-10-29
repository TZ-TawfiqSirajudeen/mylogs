import { createHash, randomBytes } from 'node:crypto';
import { ALL_SIGNALS, type AuditSink, type Database, type IngestTokenDoc, type RequestContext } from '@nexus/database';
import { z } from 'zod';

export const TOKEN_PATTERN = /^nxi_[A-Za-z0-9_-]{43}$/;
export const MAX_TOKENS_PER_ENVIRONMENT = 20;

const hash = (t: string) => createHash('sha256').update(t).digest('hex');

export const TokenCreate = z.object({
  name: z.string().trim().min(1).max(80),
  /** Which signals the token may send. Defaults to all three. */
  signals: z.array(z.enum(['logs', 'traces', 'metrics'])).min(1).max(3).default([...ALL_SIGNALS]),
  retentionDays: z.number().int().min(1).max(90).default(30),
  redaction: z.object({
    enabled: z.boolean().default(true),
    extraKeys: z.array(z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/)).max(50).default([]),
  }).default({ enabled: true, extraKeys: [] }),
  recordsPerMinute: z.number().int().min(100).max(1_000_000).nullable().default(null),
});
export type TokenCreate = z.infer<typeof TokenCreate>;

export interface TokenScope { orgId: string; projectId: string; /** null = all environments of the project */ environmentIds: string[] | null }
export interface Actor { userId: string; ctx: RequestContext }

export class TokenError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export interface TokenDto {
  id: string; projectId: string; environmentId: string; name: string; prefix: string; scopes: string[];
  retentionDays: number; redaction: { enabled: boolean; extraKeys: string[] }; recordsPerMinute: number | null;
  createdAt: string; lastUsedAt: string | null; revokedAt: string | null;
}

const toDto = (t: IngestTokenDoc): TokenDto => ({
  id: t._id, projectId: t.projectId, environmentId: t.environmentId, name: t.name, prefix: t.prefix, scopes: t.scopes,
  retentionDays: t.retentionDays, redaction: t.redaction, recordsPerMinute: t.recordsPerMinute,
  createdAt: t.createdAt.toISOString(), lastUsedAt: t.lastUsedAt?.toISOString() ?? null, revokedAt: t.revokedAt?.toISOString() ?? null,
});

/**
 * Ingestion credentials. A token is bound to ONE environment of ONE project: telemetry sent with it can only ever land
 * there, whatever the payload claims. Only a SHA-256 of the token is stored; the token is shown exactly once at creation.
 */
export class IngestTokenService {
  private readonly lastUsedWrite = new Map<string, number>();

  constructor(private readonly db: Database, private readonly audit: AuditSink, private readonly now: () => Date = () => new Date()) {}

  async create(scope: TokenScope, environmentId: string, actor: Actor, input: TokenCreate): Promise<{ token: string; info: TokenDto }> {
    if (scope.environmentIds && !scope.environmentIds.includes(environmentId)) throw new TokenError(404, 'not_found', 'Environment not found');
    const env = await this.db.c.environments.findOne({ _id: environmentId, projectId: scope.projectId, orgId: scope.orgId });
    if (!env) throw new TokenError(404, 'not_found', 'Environment not found');
    if ((await this.db.c.ingestTokens.countDocuments({ orgId: scope.orgId, environmentId, revokedAt: null })) >= MAX_TOKENS_PER_ENVIRONMENT) {
      throw new TokenError(409, 'limit_reached', `An environment can have at most ${MAX_TOKENS_PER_ENVIRONMENT} active ingestion tokens`);
    }
    const token = `nxi_${randomBytes(32).toString('base64url')}`;
    const doc: IngestTokenDoc = {
      _id: crypto.randomUUID(), orgId: scope.orgId, projectId: scope.projectId, environmentId, name: input.name,
      prefix: token.slice(0, 8), tokenHash: hash(token), scopes: [...new Set(input.signals)], retentionDays: input.retentionDays,
      redaction: input.redaction, recordsPerMinute: input.recordsPerMinute,
      createdBy: actor.userId, createdAt: this.now(), lastUsedAt: null, revokedAt: null,
    };
    await this.db.transaction(async (session) => {
      await this.db.c.ingestTokens.insertOne(doc, { session });
      await this.audit.record({
        orgId: scope.orgId, actorUserId: actor.userId, action: 'ingest_token.created', targetType: 'ingest_token', targetId: doc._id,
        projectId: scope.projectId, environmentId, metadata: { name: input.name, prefix: doc.prefix, signals: doc.scopes, retentionDays: input.retentionDays, redaction: input.redaction.enabled },
      }, actor.ctx, session);
    });
    return { token, info: toDto(doc) };
  }

  async list(scope: TokenScope, environmentId?: string): Promise<TokenDto[]> {
    const filter: Record<string, unknown> = { orgId: scope.orgId, projectId: scope.projectId };
    if (scope.environmentIds) filter.environmentId = { $in: scope.environmentIds };
    if (environmentId) {
      if (scope.environmentIds && !scope.environmentIds.includes(environmentId)) return [];
      filter.environmentId = environmentId;
    }
    return (await this.db.c.ingestTokens.find(filter).sort({ createdAt: -1 }).limit(200).toArray()).map(toDto);
  }

  async revoke(scope: TokenScope, id: string, actor: Actor): Promise<void> {
    const filter: Record<string, unknown> = { _id: id, orgId: scope.orgId, projectId: scope.projectId };
    if (scope.environmentIds) filter.environmentId = { $in: scope.environmentIds };
    const t = await this.db.c.ingestTokens.findOne(filter as never);
    if (!t) throw new TokenError(404, 'not_found', 'Token not found');
    if (t.revokedAt) return;
    await this.db.transaction(async (session) => {
      await this.db.c.ingestTokens.updateOne({ _id: id }, { $set: { revokedAt: this.now() } }, { session });
      await this.audit.record({
        orgId: scope.orgId, actorUserId: actor.userId, action: 'ingest_token.revoked', targetType: 'ingest_token', targetId: id,
        projectId: scope.projectId, environmentId: t.environmentId, metadata: { name: t.name, prefix: t.prefix },
      }, actor.ctx, session);
    });
  }

  /** Resolves a presented token. Unknown, malformed and revoked tokens are indistinguishable to the caller. */
  async authenticate(raw: string | undefined): Promise<IngestTokenDoc | null> {
    if (!raw || !TOKEN_PATTERN.test(raw)) return null;
    const t = await this.db.c.ingestTokens.findOne({ tokenHash: hash(raw) });
    if (!t || t.revokedAt) return null;
    const now = this.now().getTime();
    if (now - (this.lastUsedWrite.get(t._id) ?? 0) > 60_000) {
      this.lastUsedWrite.set(t._id, now);
      void this.db.c.ingestTokens.updateOne({ _id: t._id }, { $set: { lastUsedAt: new Date(now) } }).catch(() => undefined);
    }
    return t;
  }
}
