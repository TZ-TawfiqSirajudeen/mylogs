/**
 * Deployment (change marker) documents, ADR-0011. One collection, `deployments`.
 * Tenant fields (org, project, environment) always come from the credential that wrote the record, never from a payload.
 */
export type DeploymentStatus = 'started' | 'succeeded' | 'failed' | 'rolled_back';

export interface DeploymentDoc {
  _id: string; orgId: string; projectId: string; environmentId: string;
  /** Free text, compared by exact equality with telemetry `service.name`. Never interpreted as markup. */
  service: string; version: string;
  /** Lower-case hex, 7 to 64 characters; null when not sent. */
  commitSha: string | null;
  status: DeploymentStatus;
  startedAt: Date; finishedAt: Date | null;
  /** Length-capped, control characters removed, credential-scrubbed. Plain text. */
  notes: string | null;
  /** https only (validated); never fetched by the server. */
  linkUrl: string | null;
  /** Client-supplied label of whoever triggered it in CI (a label, not an identity). */
  triggeredBy: string | null;
  /** Server-derived from the credential: the ingestion token (name) or the signed-in user (display name). */
  actor: { type: 'token' | 'user'; id: string; name: string };
  /** Unique per (orgId, environmentId) when present. */
  idempotencyKey: string | null;
  createdAt: Date; updatedAt: Date;
  /** TTL: startedAt + 365 days. */
  expireAt: Date;
}
