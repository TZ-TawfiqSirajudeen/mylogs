import type { Connector, ConnectorDescriptor } from './types.js';

/** Descriptor-only entry for connectors that are on the roadmap but have no implementation yet. */
export type RegistryEntry =
  | { descriptor: ConnectorDescriptor & { status: 'implemented' }; connector: Connector<any, any> }
  | { descriptor: ConnectorDescriptor & { status: 'implemented'; mode: 'push' }; connector: null }
  | { descriptor: ConnectorDescriptor & { status: 'planned' }; connector: null };

export class ConnectorRegistry {
  private readonly entries = new Map<string, RegistryEntry>();

  register(connector: Connector<any, any>): this {
    const d = connector.descriptor;
    if (d.status !== 'implemented' || d.mode === 'push') throw new Error(`Connector ${d.type} must be descriptor-only (use registerPlanned / registerPush)`);
    this.add({ descriptor: d as RegistryEntry['descriptor'] & { status: 'implemented' }, connector });
    return this;
  }

  /** An implemented source that pushes to the ingestion endpoint (e.g. OTLP): listed and documented, but not "connectable". */
  registerPush(descriptor: ConnectorDescriptor): this {
    if (descriptor.status !== 'implemented' || descriptor.mode !== 'push') throw new Error(`Descriptor ${descriptor.type} must be implemented with mode "push"`);
    this.add({ descriptor: descriptor as ConnectorDescriptor & { status: 'implemented'; mode: 'push' }, connector: null });
    return this;
  }

  registerPlanned(descriptor: ConnectorDescriptor): this {
    if (descriptor.status !== 'planned') throw new Error(`Descriptor ${descriptor.type} is not marked planned`);
    this.add({ descriptor: descriptor as ConnectorDescriptor & { status: 'planned' }, connector: null });
    return this;
  }

  private add(e: RegistryEntry) {
    if (this.entries.has(e.descriptor.type)) throw new Error(`Duplicate connector type ${e.descriptor.type}`);
    this.entries.set(e.descriptor.type, e);
  }

  get(type: string): RegistryEntry | undefined { return this.entries.get(type); }

  /** Only implemented connectors can run; planned ones yield undefined so callers cannot "connect" to them. */
  runnable(type: string): Connector<any, any> | undefined { return this.entries.get(type)?.connector ?? undefined; }

  list(): ConnectorDescriptor[] { return [...this.entries.values()].map((e) => e.descriptor); }
}

/** Markdown capability matrix generated from the registry (single source of truth, never hand-edited). */
export function capabilityMatrixMarkdown(descriptors: ConnectorDescriptor[]): string {
  const sig = (d: ConnectorDescriptor) => d.signals.map((s) => `${s.signal}: ${s.availability}`).join('<br>') || '—';
  const rows = descriptors.map((d) =>
    `| ${d.displayName} (\`${d.type}\`) | **${d.status}** | ${d.mode === 'push' ? 'push (ingestion token)' : d.collection === 'implemented' ? 'implemented' : 'not yet (health/discovery only)'} | ${sig(d)} | ${d.deploymentTypes.join(', ')} | ${d.authMethods.map((a) => a.label + (a.recommended ? ' ★' : '')).join('<br>') || '—'} | ${d.requiredPermissions.filter((p) => !p.optional).map((p) => p.permission).join('<br>') || '—'} | ${d.operations.join(', ') || '—'} | ${d.limitations.join('<br>') || '—'} |`);
  return [
    '# Integration capability matrix',
    '',
    '> Generated from the connector registry (`pnpm --filter @nexus/connectors matrix`). Do not edit by hand.',
    '> "implemented" means connection test, discovery and health reporting exist and are tested against a real or simulated target.',
    '> Telemetry **collection** is a separate column. Pull connectors (HTTP health, MongoDB, Redis) only verify and monitor; they do not collect.',
    '> Push sources (OTLP, JSON logs) deliver **logs** through authenticated ingestion tokens. "Last successful collection" and live',
    '> health are per-connection runtime values shown in the UI, not static facts.',
    '',
    '| Connector | Status | Collection | Signals | Deployment types | Auth (★ recommended) | Required permissions | Operations | Known limitations |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}
