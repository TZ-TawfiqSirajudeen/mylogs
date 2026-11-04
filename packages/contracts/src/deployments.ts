/// <reference lib="dom" />
import { z } from 'zod';
import { Id } from './common.js';

/**
 * Deployments (change markers), ADR-0011. Every text field is plain text: it is validated here, stored as text and rendered as text.
 * Nothing in this file interprets markup. `linkUrl` is the only value a browser may navigate to, and only over https.
 */
export const DEPLOYMENT_STATUSES = ['started', 'succeeded', 'failed', 'rolled_back'] as const;
export const DeploymentStatus = z.enum(DEPLOYMENT_STATUSES);
export type DeploymentStatusName = z.infer<typeof DeploymentStatus>;

export const DEPLOYMENT_LIMITS = {
  service: 128, version: 128, notes: 1000, link: 2000, triggeredBy: 100, idempotencyKey: 128,
  /** startedAt may be at most this far in the past / future. */
  maxAgeDays: 90, maxFutureMs: 5 * 60_000,
  /** A deployment finished at most this long before an incident opened counts as "shortly before". */
  correlationWindowMs: 30 * 60_000,
  retentionDays: 365,
  writesPerMinute: 30, perEnvironmentPerDay: 2_000, bodyBytes: 16 * 1024,
  listLimit: 100, markerLimit: 200,
} as const;

// Control characters (except tab/newline/carriage return where a field is multi-line) and bidirectional overrides, which can make text lie about itself.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩]/;
const CONTROL_SINGLE_LINE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;
const noControl = (s: string) => !CONTROL.test(s);
const singleLine = (s: string) => !CONTROL_SINGLE_LINE.test(s);

/** https only, a host, no user-info, no whitespace or control characters. Returns the normalized URL or null. Never fetched by the server. */
export function normalizeHttpsUrl(raw: string): string | null {
  if (raw.length > DEPLOYMENT_LIMITS.link || /[\s\u0000-\u001f\u007f-\u009f]/.test(raw)) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return null;
  return u.href;
}

const text = (max: number) => z.string().trim().min(1).max(max).refine(singleLine, 'must not contain control characters');
const iso = z.iso.datetime({ offset: true });

export const DeploymentWrite = z.object({
  service: text(DEPLOYMENT_LIMITS.service),
  version: text(DEPLOYMENT_LIMITS.version),
  commitSha: z.string().trim().regex(/^[0-9a-fA-F]{7,64}$/, '7 to 64 hexadecimal characters').optional(),
  status: DeploymentStatus,
  startedAt: iso.optional(),
  finishedAt: iso.optional(),
  notes: z.string().max(DEPLOYMENT_LIMITS.notes).refine(noControl, 'must not contain control characters').optional(),
  linkUrl: z.string().max(DEPLOYMENT_LIMITS.link).refine((s) => normalizeHttpsUrl(s) !== null, 'must be an https:// URL without credentials').optional(),
  triggeredBy: text(DEPLOYMENT_LIMITS.triggeredBy).optional(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:@/-]{1,128}$/, 'letters, digits and . _ : @ / - (1 to 128 characters)').optional(),
  /** Session callers only: where the record goes. A token supplies both, so a token request that names them is refused. */
  projectId: Id.optional(),
  environmentId: Id.optional(),
}).strict();
export type DeploymentWrite = z.infer<typeof DeploymentWrite>;

export const DeploymentDto = z.object({
  id: Id, projectId: Id, environmentId: Id, service: z.string(), version: z.string(), commitSha: z.string().nullable(),
  status: DeploymentStatus, startedAt: z.iso.datetime(), finishedAt: z.iso.datetime().nullable(), durationMs: z.number().nullable(),
  notes: z.string().nullable(), linkUrl: z.string().nullable(), triggeredBy: z.string().nullable(),
  actor: z.object({ type: z.enum(['token', 'user']), name: z.string() }), idempotencyKey: z.string().nullable(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
export type DeploymentDto = z.infer<typeof DeploymentDto>;

export const DeploymentWriteResult = z.object({ outcome: z.enum(['created', 'updated', 'unchanged']), deployment: DeploymentDto });
export type DeploymentWriteResult = z.infer<typeof DeploymentWriteResult>;

export const DeploymentProjectParam = z.object({ projectId: Id });
export const DeploymentParams = z.object({ projectId: Id, deploymentId: Id });
export const DeploymentIncidentParams = z.object({ projectId: Id, incidentId: Id });

export const DeploymentListQuery = z.object({
  environmentId: Id.optional(),
  service: z.string().trim().min(1).max(DEPLOYMENT_LIMITS.service).optional(),
  status: DeploymentStatus.optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(DEPLOYMENT_LIMITS.listLimit).default(50),
  cursor: z.string().max(200).optional(),
});
export type DeploymentListQuery = z.infer<typeof DeploymentListQuery>;
export const DeploymentPage = z.object({ items: z.array(DeploymentDto), nextCursor: z.string().nullable() });
export type DeploymentPage = z.infer<typeof DeploymentPage>;

export const DeploymentMarkersQuery = z.object({
  from: z.iso.datetime(), to: z.iso.datetime(),
  environmentId: Id.optional(),
  service: z.string().trim().min(1).max(DEPLOYMENT_LIMITS.service).optional(),
});
/** What a chart needs: no notes, no link. */
export const DeploymentMarker = z.object({
  id: Id, environmentId: Id, service: z.string(), version: z.string(), status: DeploymentStatus, at: z.iso.datetime(), finishedAt: z.iso.datetime().nullable(),
});
export type DeploymentMarker = z.infer<typeof DeploymentMarker>;
export const DeploymentMarkers = z.object({ items: z.array(DeploymentMarker), truncated: z.boolean() });
export type DeploymentMarkers = z.infer<typeof DeploymentMarkers>;

export const IncidentDeployments = z.object({
  /** The services the incident is about (from its rule and group); empty when the rule names none. */
  services: z.array(z.string()),
  windowMinutes: z.number(),
  items: z.array(DeploymentDto),
  /** Fixed wording: this is a time coincidence, not a finding. */
  note: z.string(),
});
export type IncidentDeployments = z.infer<typeof IncidentDeployments>;

export const CORRELATION_NOTE = 'Deployed shortly before; correlation, not proof of cause.';
