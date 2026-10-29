import type { Database } from '@nexus/database';

export interface IngestStatsSummary {
  window: { from: string; to: string; minutes: number };
  totals: { requests: number; bytes: number; accepted: number; duplicates: number; rejectedInvalid: number; rejectedQuota: number; rejectedOverload: number; rejectedStorage: number; redactions: number };
  /** Total records the platform refused in the window, for any reason. Non-zero means the sender is losing data unless it retries. */
  refused: number;
  perEnvironment: { environmentId: string; accepted: number; refused: number; lastAcceptedAt: string | null }[];
}

/**
 * Per-environment ingestion accounting from the per-minute buckets. `lastAcceptedAt` is what lets the UI say
 * "no telemetry received" honestly, instead of showing an empty chart that looks like a healthy quiet system.
 */
export async function readIngestStats(db: Database, scope: { orgId: string; projectId: string; environmentIds: string[] }, minutes = 60, now = new Date()): Promise<IngestStatsSummary> {
  const from = new Date(now.getTime() - minutes * 60_000);
  const rows = await db.c.ingestStats.find({ orgId: scope.orgId, projectId: scope.projectId, environmentId: { $in: scope.environmentIds }, minute: { $gte: from } }).limit(100_000).toArray();
  const totals = { requests: 0, bytes: 0, accepted: 0, duplicates: 0, rejectedInvalid: 0, rejectedQuota: 0, rejectedOverload: 0, rejectedStorage: 0, redactions: 0 };
  const per = new Map<string, { accepted: number; refused: number; last: Date | null }>();
  for (const r of rows) {
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += r[k] ?? 0;
    const e = per.get(r.environmentId) ?? { accepted: 0, refused: 0, last: null };
    e.accepted += r.accepted ?? 0;
    e.refused += (r.rejectedInvalid ?? 0) + (r.rejectedQuota ?? 0) + (r.rejectedOverload ?? 0) + (r.rejectedStorage ?? 0);
    if ((r.accepted ?? 0) > 0 && (!e.last || r.minute > e.last)) e.last = r.minute;
    per.set(r.environmentId, e);
  }
  // Last accepted time may be older than the window: look it up so "silent for 3 hours" is reported, not "never".
  const out: IngestStatsSummary['perEnvironment'] = [];
  for (const environmentId of scope.environmentIds) {
    const e = per.get(environmentId);
    let last = e?.last ?? null;
    if (!last) {
      const older = await db.c.ingestStats.find({ orgId: scope.orgId, projectId: scope.projectId, environmentId, accepted: { $gt: 0 } }).sort({ minute: -1 }).limit(1).next();
      last = older?.minute ?? null;
    }
    out.push({ environmentId, accepted: e?.accepted ?? 0, refused: e?.refused ?? 0, lastAcceptedAt: last ? last.toISOString() : null });
  }
  return {
    window: { from: from.toISOString(), to: now.toISOString(), minutes }, totals, perEnvironment: out,
    refused: totals.rejectedInvalid + totals.rejectedQuota + totals.rejectedOverload + totals.rejectedStorage,
  };
}
