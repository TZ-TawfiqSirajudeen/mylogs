import type { ConnectionDto } from '@nexus/contracts';
import type { ConnectionDoc } from '@nexus/database';
import type { ConnectorRegistry } from '@nexus/connector-sdk';
import { isStale, TEST_FRESH_MS } from './health.js';

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const errRec = (e: { at: Date; kind: string; message: string; remediation: string }) => ({ ...e, at: e.at.toISOString() });

/** Names for the chosen resource ids, from the stored discovery; an id that is no longer in it is still listed (by id) rather than dropped. */
function selectedResources(c: ConnectionDoc): { id: string; name: string; type: string }[] {
  const known = new Map((c.discovered?.resources ?? []).map((r) => [r.id, r]));
  return (c.selection?.resourceIds ?? []).map((id) => { const r = known.get(id); return { id, name: r?.name ?? id, type: r?.type ?? 'unknown' }; });
}

/** Seconds since the last successful collection while collection is expected to run; null otherwise. Grows if the worker stops. */
function collectionLag(c: ConnectionDoc, now: Date): number | null {
  const last = c.collection.lastSuccessfulCollectionAt;
  if (!last || c.lifecycle !== 'active' || (c.collection.status !== 'running' && c.collection.status !== 'stopped')) return null;
  return Math.max(0, Math.round((now.getTime() - last.getTime()) / 1000));
}

/** One plain sentence about what is (not) being collected, derived only from stored facts. */
function collectionNote(c: ConnectionDoc, connectorCollects: boolean, now: Date): string {
  if (!connectorCollects) return 'Metric collection is not implemented for this connector: it is verified and monitored for health only; no data is being collected.';
  const every = c.settings?.pollIntervalSeconds ?? 60;
  switch (c.collection.status) {
    case 'not_selected': return 'Nothing is collected: the metrics signal is not selected (it was not chosen in setup, or the settings were changed, which clears the selection). Create the connection again with metrics selected.';
    case 'not_started': return c.lifecycle === 'active' ? `Waiting for the first collection (every ${every}s).` : 'Collection starts when monitoring is started.';
    case 'running': {
      const lag = collectionLag(c, now);
      return `Collecting every ${every}s${c.collection.lastSeries ? `, ${c.collection.lastSeries} series per collection` : ''}.${lag !== null && lag > 3 * every ? ` The last successful collection was ${lag}s ago: the worker may be down.` : ''}`;
    }
    case 'stopped': return c.collection.lastError ? `Collection is failing: ${c.collection.lastError.message}` : 'Collection is paused because the connection check is failing; it resumes when the connection is healthy again.';
    default: return 'Collection is not active.';
  }
}

/**
 * The ONLY place a connection leaves the service layer. Secret values are not part of ConnectionDoc at all (they live in
 * the secret store); `secrets` here is just "which fields are set and when". Internal fields (lease, version) are dropped.
 */
export function toDto(c: ConnectionDoc, registry: ConnectorRegistry, now = new Date()): ConnectionDto {
  const entry = registry.get(c.connectorType);
  const d = entry?.descriptor;
  const stale = isStale(c, now);
  const lastTestStale = !!c.lastTest && (c.lastTest.configVersion !== c.configVersion || now.getTime() - c.lastTest.at.getTime() > TEST_FRESH_MS);
  return {
    id: c._id, projectId: c.projectId, environmentId: c.environmentId,
    connectorType: c.connectorType, connectorName: d?.displayName ?? c.connectorType, connectorStatus: d?.status ?? 'planned',
    name: c.name, authMethod: c.authMethod, lifecycle: c.lifecycle, config: c.config,
    secrets: Object.fromEntries(Object.entries(c.secretFields).map(([k, v]) => [k, { set: true as const, updatedAt: v.updatedAt.toISOString() }])),
    signals: (d?.signals ?? []).map((s) => ({ signal: s.signal, availability: s.availability })),
    capabilities: c.capabilities.map((x) => ({ id: x.id, label: x.label, available: x.available, ...(x.signal ? { signal: x.signal } : {}), ...(x.reason ? { reason: x.reason } : {}) })),
    selection: c.selection ? { ...c.selection, resources: selectedResources(c) } : null, settings: c.settings,
    lastTest: c.lastTest ? { at: c.lastTest.at.toISOString(), ok: c.lastTest.ok, steps: c.lastTest.steps, facts: c.lastTest.facts, durationMs: c.lastTest.durationMs, stale: lastTestStale } : null,
    health: {
      state: c.health.state, lastCheckAt: iso(c.health.lastCheckAt), lastSuccessAt: iso(c.health.lastSuccessAt), nextCheckAt: iso(c.health.nextCheckAt),
      lastCheckDurationMs: c.health.lastCheckDurationMs, consecutiveFailures: c.health.consecutiveFailures,
      lastError: c.health.lastError ? errRec(c.health.lastError) : null, recentErrors: c.health.recentErrors.map(errRec),
      stale, collectionLagSeconds: collectionLag(c, now),
      remediation: c.health.state === 'healthy' ? null : c.health.lastError?.remediation ?? null,
    },
    collection: {
      status: c.collection.status, lastSuccessfulCollectionAt: iso(c.collection.lastSuccessfulCollectionAt),
      lastAttemptAt: iso(c.collection.lastAttemptAt ?? null), consecutiveFailures: c.collection.consecutiveFailures ?? 0,
      lastError: c.collection.lastError ? errRec(c.collection.lastError) : null, lastSeries: c.collection.lastSeries ?? null,
      notes: c.collection.lastNotes ?? [], note: collectionNote(c, d?.collection === 'implemented', now),
    },
    createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString(), activatedAt: iso(c.activatedAt),
  };
}
