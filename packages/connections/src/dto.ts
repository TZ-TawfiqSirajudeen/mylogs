import type { ConnectionDto } from '@nexus/contracts';
import type { ConnectionDoc } from '@nexus/database';
import type { ConnectorRegistry } from '@nexus/connector-sdk';
import { isStale, TEST_FRESH_MS } from './health.js';

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const errRec = (e: { at: Date; kind: string; message: string; remediation: string }) => ({ ...e, at: e.at.toISOString() });

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
    selection: c.selection, settings: c.settings,
    lastTest: c.lastTest ? { at: c.lastTest.at.toISOString(), ok: c.lastTest.ok, steps: c.lastTest.steps, facts: c.lastTest.facts, durationMs: c.lastTest.durationMs, stale: lastTestStale } : null,
    health: {
      state: c.health.state, lastCheckAt: iso(c.health.lastCheckAt), lastSuccessAt: iso(c.health.lastSuccessAt), nextCheckAt: iso(c.health.nextCheckAt),
      lastCheckDurationMs: c.health.lastCheckDurationMs, consecutiveFailures: c.health.consecutiveFailures,
      lastError: c.health.lastError ? errRec(c.health.lastError) : null, recentErrors: c.health.recentErrors.map(errRec),
      stale, collectionLagSeconds: c.health.collectionLagSeconds,
      remediation: c.health.state === 'healthy' ? null : c.health.lastError?.remediation ?? null,
    },
    collection: {
      status: c.collection.status, lastSuccessfulCollectionAt: iso(c.collection.lastSuccessfulCollectionAt),
      note: d?.collection === 'implemented'
        ? 'Collection is enabled for this connector.'
        : 'Telemetry collection is not implemented yet: this connection is verified and monitored for health only; no data is being collected.',
    },
    createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString(), activatedAt: iso(c.activatedAt),
  };
}
