import type { Collection } from 'mongodb';
import type { AlertChannelDoc, AlertConfigDoc, AlertRuleDoc, AlertSilenceDoc, Database } from '@nexus/database';

/** Typed views of the single `alert_config` collection (the `kind` discriminator is always part of the filter). */
export const ruleCol = (db: Database) => db.c.alertConfig as unknown as Collection<AlertRuleDoc>;
export const channelCol = (db: Database) => db.c.alertConfig as unknown as Collection<AlertChannelDoc>;
export const silenceCol = (db: Database) => db.c.alertConfig as unknown as Collection<AlertSilenceDoc>;
export type { AlertConfigDoc };

export const DAY_MS = 86_400_000;
/** Resolved incidents are kept this long, delivery logs this long, ended silences one day. */
export const RETENTION = { incidentDays: 90, deliveryDays: 30, silenceGraceDays: 1 } as const;

export interface RequestContext { requestId: string; ip?: string }

/**
 * Who is acting and what they may touch. Built by the API from the session and the project grant, never from request input.
 * `environmentIds === null` means every environment of the project.
 */
export interface ActorScope { orgId: string; projectId: string; environmentIds: string[] | null; userId: string }

export class AlertingError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) { super(message); this.name = 'AlertingError'; }
}
export const notFound = (what: string) => new AlertingError(404, 'not_found', `${what} not found`);
export const conflict = (msg: string) => new AlertingError(409, 'conflict', msg);
export const invalid = (msg: string, details?: unknown) => new AlertingError(422, 'validation_error', msg, details);
export const forbiddenScope = () => new AlertingError(403, 'forbidden', 'You do not have access to this environment');

/** The environment filter for a scoped read: restricts to the caller's environments, or nothing extra when they may see all. */
export const envFilter = (s: ActorScope) => (s.environmentIds === null ? {} : { environmentId: { $in: s.environmentIds } });

export const isDuplicateKey = (e: unknown) => (e as { code?: number })?.code === 11000;

export const encodeCursor = (ms: number, id: string) => Buffer.from(JSON.stringify([ms, id])).toString('base64url');
export function decodeCursor(c: string | undefined): [Date, string] | null {
  if (!c) return null;
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as unknown;
    return Array.isArray(v) && typeof v[0] === 'number' && Number.isFinite(v[0]) && typeof v[1] === 'string' && v[1].length <= 80 ? [new Date(v[0]), v[1]] : null;
  } catch { return null; }
}

/** The secret-store namespace of one channel. Channel secrets live in the existing `secrets` collection, scoped (and cipher-bound) to this name. */
export const channelSecretOwner = (channelId: string) => `alert-channel:${channelId}`;
