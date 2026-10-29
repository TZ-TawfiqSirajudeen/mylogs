import { ConnectionSettings } from '@nexus/contracts';
import type { ConnectionDoc, ConnectionHealthState, Database, StoredResource } from '@nexus/database';
import type { AuditSink, RequestContext } from '@nexus/database';
import { SecretDecryptionError, SecretNotFoundError, type SecretStore } from '@nexus/secrets';
import {
  ConnectorError, REMEDIATION, toConnectorError, withDeadline,
  type Connector, type ConnectorContext, type ConnectorRegistry, type DiscoveryResult, type TestReport,
} from '@nexus/connector-sdk';
import { scrubKnownSecrets, type NetworkPolicy } from '@nexus/security';
import { toDto } from './dto.js';
import { notFound, ServiceError } from './errors.js';
import { applyReport, initialHealth, TEST_FRESH_MS } from './health.js';

export interface Scope {
  orgId: string;
  projectId: string;
  /** null = every environment of the project; otherwise only these (the caller's environment-scoped access). */
  environmentIds: string[] | null;
}
export interface Actor { userId: string | null; ctx: RequestContext }

export interface ConnectionServiceDeps {
  db: Database;
  secrets: SecretStore;
  registry: ConnectorRegistry;
  audit: AuditSink;
  network: NetworkPolicy;
  now?: () => Date;
  testTimeoutMs?: number;
  maxConnectionsPerEnvironment?: number;
}

const MAX_RESOURCES = 500;
const MAX_STR = 300;
const DEFAULT_INTERVAL_S = 60;

const isDuplicateKey = (e: unknown) => (e as { code?: number })?.code === 11000;
const clip = (s: string) => (s.length > MAX_STR ? `${s.slice(0, MAX_STR)}…` : s);

/** Applies `fn` to every string inside a JSON-like value (used to scrub secrets out of anything a connector returned). */
function mapStrings<T>(v: T, fn: (s: string) => string): T {
  if (typeof v === 'string') return fn(v) as T;
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn)) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, fn)])) as T;
  return v;
}

export class ConnectionService {
  private readonly now: () => Date;

  constructor(private readonly d: ConnectionServiceDeps) {
    this.now = d.now ?? (() => new Date());
  }

  // ------------------------------------------------------------------ helpers

  private filter(scope: Scope, id?: string): Record<string, unknown> {
    return {
      ...(id ? { _id: id } : {}), orgId: scope.orgId, projectId: scope.projectId,
      ...(scope.environmentIds ? { environmentId: { $in: scope.environmentIds } } : {}),
    };
  }

  /** Every read/write of a connection goes through here: org + project + environment scope, 404 otherwise. */
  private async load(scope: Scope, id: string): Promise<ConnectionDoc> {
    const c = await this.d.db.c.connections.findOne(this.filter(scope, id) as never);
    if (!c) throw notFound('Connection');
    return c;
  }

  private dto(c: ConnectionDoc) { return toDto(c, this.d.registry, this.now()); }

  private connector(type: string): Connector<any, any> {
    const entry = this.d.registry.get(type);
    if (!entry) throw new ServiceError(404, 'unknown_connector', `Unknown connector "${type}"`);
    if (entry.descriptor.mode === 'push') {
      throw new ServiceError(400, 'use_ingestion_tokens', `${entry.descriptor.displayName} sends data to the platform: create an ingestion token (Data Sources → Ingestion) instead of a connection`);
    }
    if (!entry.connector) throw new ServiceError(501, 'connector_not_implemented', `The "${entry.descriptor.displayName}" connector is planned but not implemented yet`);
    return entry.connector;
  }

  private checkSecretNames(type: string, authMethod: string, given: Record<string, string>) {
    const descriptor = this.d.registry.get(type)!.descriptor;
    const method = descriptor.authMethods.find((a) => a.id === authMethod);
    if (!method) throw new ServiceError(400, 'invalid_auth_method', `Auth method "${authMethod}" is not supported by ${descriptor.displayName}`);
    const expected = method.secretFields.map((f) => f.name).sort();
    const got = Object.keys(given).sort();
    if (expected.join() !== got.join()) {
      throw new ServiceError(400, 'invalid_secrets', `Expected credential fields: ${expected.join(', ') || '(none)'}`);
    }
    const connector = this.d.registry.runnable(type)!;
    const parsed = connector.credentialSchema(authMethod)?.safeParse(given);
    if (!parsed?.success) throw new ServiceError(400, 'invalid_secrets', 'The credentials are not valid for this authentication method');
  }

  private parseConfig(connector: Connector<any, any>, config: unknown, authMethod: string): Record<string, unknown> {
    const r = connector.configSchema.safeParse(config);
    if (!r.success) {
      throw new ServiceError(400, 'invalid_config', 'The connection settings are not valid', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    }
    const issues = connector.validateConfig?.(r.data, authMethod) ?? [];
    if (issues.length) throw new ServiceError(400, 'invalid_config', 'The connection settings are not valid', issues.map((m) => ({ path: '', message: m })));
    return r.data as Record<string, unknown>;
  }

  // ------------------------------------------------------------------ create / read / update

  async create(
    scope: Scope, environmentId: string, actor: Actor,
    input: { connectorType: string; name: string; authMethod: string; config: Record<string, unknown>; secrets: Record<string, string> },
  ): Promise<ReturnType<ConnectionService['dto']>> {
    if (scope.environmentIds && !scope.environmentIds.includes(environmentId)) throw notFound('Environment');
    const env = await this.d.db.c.environments.findOne({ _id: environmentId, projectId: scope.projectId, orgId: scope.orgId });
    if (!env) throw notFound('Environment');
    const connector = this.connector(input.connectorType);
    this.checkSecretNames(input.connectorType, input.authMethod, input.secrets);
    const config = this.parseConfig(connector, input.config, input.authMethod);

    const max = this.d.maxConnectionsPerEnvironment ?? 25;
    if ((await this.d.db.c.connections.countDocuments({ orgId: scope.orgId, environmentId })) >= max) {
      throw new ServiceError(409, 'limit_reached', `An environment can have at most ${max} connections`);
    }

    const now = this.now();
    const id = crypto.randomUUID();
    const doc: ConnectionDoc = {
      _id: id, orgId: scope.orgId, projectId: scope.projectId, environmentId,
      connectorType: input.connectorType, name: input.name, authMethod: input.authMethod, lifecycle: 'draft', config,
      secretFields: Object.fromEntries(Object.keys(input.secrets).map((k) => [k, { updatedAt: now }])),
      discovered: null, capabilities: [], selection: null,
      settings: ConnectionSettings.parse({}),
      lastTest: null, health: initialHealth(), collection: { status: 'not_implemented', lastSuccessfulCollectionAt: null },
      lease: null, configVersion: 1, version: 1,
      createdBy: actor.userId ?? 'system', createdAt: now, updatedAt: now, activatedAt: null, disconnectedAt: null,
    };
    try {
      await this.d.db.transaction(async (session) => {
        await this.d.db.c.connections.insertOne(doc, { session });
        for (const [name, value] of Object.entries(input.secrets)) {
          await this.d.secrets.put({ orgId: scope.orgId, connectionId: id, name }, value, actor.userId, session);
        }
        await this.d.audit.record({
          orgId: scope.orgId, actorUserId: actor.userId, action: 'connection.created', targetType: 'connection', targetId: id,
          projectId: scope.projectId, environmentId,
          // field NAMES only; values never enter audit
          metadata: { connectorType: input.connectorType, authMethod: input.authMethod, name: input.name, fieldNames: Object.keys(input.secrets) },
        }, actor.ctx, session);
      });
    } catch (e) {
      if (isDuplicateKey(e)) throw new ServiceError(409, 'conflict', `A connection named "${input.name}" already exists in this environment`);
      throw e;
    }
    return this.dto(doc);
  }

  async get(scope: Scope, id: string) { return this.dto(await this.load(scope, id)); }

  async list(scope: Scope, environmentId?: string) {
    if (environmentId && scope.environmentIds && !scope.environmentIds.includes(environmentId)) return [];
    const filter = { ...this.filter(scope), ...(environmentId ? { environmentId } : {}) };
    const rows = await this.d.db.c.connections.find(filter as never).sort({ createdAt: 1 }).limit(500).toArray();
    return rows.map((c) => this.dto(c));
  }

  async updateConfig(scope: Scope, id: string, actor: Actor, patch: { name?: string | undefined; config?: Record<string, unknown> | undefined }) {
    const c = await this.load(scope, id);
    const connector = this.connector(c.connectorType);
    const set: Record<string, unknown> = { updatedAt: this.now() };
    if (patch.name) set.name = patch.name;
    let configChanged = false;
    if (patch.config) {
      set.config = this.parseConfig(connector, patch.config, c.authMethod);
      configChanged = true;
    }
    try {
      await this.d.db.transaction(async (session) => {
        const r = await this.d.db.c.connections.updateOne(
          { _id: id, orgId: scope.orgId, configVersion: c.configVersion },
          {
            $set: { ...set, ...(configChanged ? { discovered: null, selection: null, capabilities: [], 'health.state': 'pending' as ConnectionHealthState, ...(c.lifecycle === 'active' ? { 'health.nextCheckAt': this.now() } : {}) } : {}) },
            ...(configChanged ? { $inc: { configVersion: 1 } } : {}),
          }, { session },
        );
        if (r.modifiedCount !== 1) throw new ServiceError(409, 'connection_changed', 'The connection was modified concurrently; reload and try again');
        await this.d.audit.record({ orgId: scope.orgId, actorUserId: actor.userId, action: 'connection.updated', targetType: 'connection', targetId: id, projectId: scope.projectId, environmentId: c.environmentId, metadata: { fields: [...(patch.name ? ['name'] : []), ...(configChanged ? ['config'] : [])] } }, actor.ctx, session);
      });
    } catch (e) {
      if (isDuplicateKey(e)) throw new ServiceError(409, 'conflict', 'A connection with that name already exists in this environment');
      throw e;
    }
    return this.get(scope, id);
  }

  // ------------------------------------------------------------------ running a connector

  private async prepare(c: ConnectionDoc) {
    const connector = this.connector(c.connectorType);
    const parsed = connector.configSchema.safeParse(c.config);
    if (!parsed.success) throw new ConnectorError('misconfigured', 'The stored configuration is no longer valid', { remediation: 'Edit the connection settings and test again.' });
    const method = this.d.registry.get(c.connectorType)!.descriptor.authMethods.find((a) => a.id === c.authMethod);
    if (!method) throw new ConnectorError('misconfigured', 'The authentication method is not supported');
    let creds: Record<string, string>;
    try {
      creds = await this.d.secrets.getAll(c.orgId, c._id, method.secretFields.map((f) => f.name));
    } catch (e) {
      if (e instanceof SecretNotFoundError) throw new ConnectorError('misconfigured', 'The credentials for this connection are missing', { remediation: 'Rotate the credentials to set them again.' });
      if (e instanceof SecretDecryptionError) throw new ConnectorError('internal', 'The stored credentials could not be decrypted', { remediation: 'Re-enter the credentials (rotate). If this repeats, the encryption key configuration may have changed.' });
      throw e;
    }
    const valid = connector.credentialSchema(c.authMethod)?.safeParse(creds);
    if (!valid?.success) throw new ConnectorError('misconfigured', 'The stored credentials are not valid for this authentication method', { remediation: 'Rotate the credentials.' });
    return { connector, config: parsed.data, creds, secretValues: Object.values(creds) };
  }

  private context(signal: AbortSignal): ConnectorContext {
    return { signal, network: this.d.network, now: this.now, logger: { info: () => undefined, warn: () => undefined } };
  }

  /** Runs connector.test with a deadline; never throws for expected failures; scrubs the exact secret values from the result. */
  private async runTest(c: ConnectionDoc): Promise<TestReport> {
    const started = Date.now();
    const fail = (e: ConnectorError, secrets: string[] = []): TestReport => ({
      ok: false, steps: [], capabilities: [], facts: {}, durationMs: Date.now() - started,
      failure: { kind: e.kind, message: scrubKnownSecrets(clip(e.message), secrets), remediation: e.remediation ?? REMEDIATION[e.kind], ...(e.retryAfterMs ? { retryAfterMs: e.retryAfterMs } : {}) },
    });
    let prepared;
    try { prepared = await this.prepare(c); } catch (e) { return fail(toConnectorError(e)); }
    const dl = withDeadline(undefined, this.d.testTimeoutMs ?? 30_000);
    try {
      const report = await prepared.connector.test(this.context(dl.signal), prepared.config, prepared.creds);
      return mapStrings(report, (s) => scrubKnownSecrets(s, prepared.secretValues));
    } catch (e) {
      const err = dl.timedOut() ? new ConnectorError('timeout', 'The check exceeded its time limit') : toConnectorError(e);
      return fail(err, prepared.secretValues);
    } finally {
      dl.dispose();
    }
  }

  private async persistTest(c: ConnectionDoc, report: TestReport, o: { scheduled: boolean }): Promise<ConnectionDoc> {
    const now = this.now();
    const interval = (c.settings?.pollIntervalSeconds ?? DEFAULT_INTERVAL_S) * 1000;
    const health = applyReport(c.health, report, now, { scheduled: o.scheduled, intervalMs: interval });
    const set: Record<string, unknown> = {
      health, updatedAt: now,
      lastTest: { at: now, ok: report.ok, steps: report.steps, facts: report.facts, durationMs: report.durationMs, configVersion: c.configVersion },
    };
    // Keep the last known capability list if a failed run could not determine any.
    if (report.capabilities.length > 0) set.capabilities = report.capabilities;
    const r = await this.d.db.c.connections.findOneAndUpdate(
      // Only write if the configuration/credentials did not change while the check was running.
      { _id: c._id, orgId: c.orgId, configVersion: c.configVersion }, { $set: set }, { returnDocument: 'after' },
    );
    if (!r) throw new ServiceError(409, 'connection_changed', 'The connection changed while the check was running; run it again');
    return r;
  }

  private async auditHealthChange(before: ConnectionDoc, after: ConnectionDoc, actor: Actor) {
    if (before.health.state === after.health.state) return;
    await this.d.audit.record({
      orgId: after.orgId, actorUserId: actor.userId, action: 'connection.health_changed', targetType: 'connection', targetId: after._id,
      projectId: after.projectId, environmentId: after.environmentId,
      metadata: { from: before.health.state, to: after.health.state, kind: after.health.lastError?.kind ?? null },
    }, actor.ctx);
  }

  // ------------------------------------------------------------------ wizard steps: test, discover, select, configure, preview, activate

  async test(scope: Scope, id: string, actor: Actor) {
    const c0 = await this.load(scope, id);
    this.connector(c0.connectorType); // 501 for planned connectors
    let c = c0;
    if (c.lifecycle === 'disconnected') throw new ServiceError(409, 'disconnected', 'Rotate the credentials to reconnect before testing');
    if (c.health.state !== 'healthy') {
      await this.d.db.c.connections.updateOne({ _id: id, orgId: scope.orgId }, { $set: { 'health.state': 'connecting' as ConnectionHealthState } });
    }
    const report = await this.runTest(c);
    c = await this.persistTest(c0, report, { scheduled: c0.lifecycle === 'active' });
    await this.d.audit.record({
      orgId: scope.orgId, actorUserId: actor.userId, action: 'connection.tested', targetType: 'connection', targetId: id,
      projectId: scope.projectId, environmentId: c.environmentId, metadata: { ok: report.ok, failureKind: report.failure?.kind ?? null, steps: report.steps.length },
    }, actor.ctx);
    await this.auditHealthChange(c0, c, actor);
    return { report, connection: this.dto(c) };
  }

  async discover(scope: Scope, id: string, actor: Actor) {
    const c0 = await this.load(scope, id);
    if (c0.lifecycle === 'disconnected') throw new ServiceError(409, 'disconnected', 'Rotate the credentials to reconnect first');
    let prepared;
    try { prepared = await this.prepare(c0); } catch (e) { throw this.discoveryFailure(toConnectorError(e)); }
    const dl = withDeadline(undefined, this.d.testTimeoutMs ?? 30_000);
    let result: DiscoveryResult;
    try {
      result = await prepared.connector.discover(this.context(dl.signal), prepared.config, prepared.creds);
    } catch (e) {
      throw this.discoveryFailure(dl.timedOut() ? new ConnectorError('timeout', 'Discovery exceeded its time limit') : toConnectorError(e), prepared.secretValues);
    } finally { dl.dispose(); }

    const clean = mapStrings(result, (s) => scrubKnownSecrets(clip(s), prepared.secretValues));
    const truncated = clean.truncated || clean.resources.length > MAX_RESOURCES;
    const resources: StoredResource[] = clean.resources.slice(0, MAX_RESOURCES).map((r) => ({ id: r.id, type: r.type, name: r.name, attributes: r.attributes, signals: r.signals }));
    const updated = await this.d.db.c.connections.findOneAndUpdate(
      { _id: id, orgId: scope.orgId, configVersion: c0.configVersion },
      { $set: { discovered: { at: this.now(), resources, truncated }, capabilities: clean.capabilities, selection: null, updatedAt: this.now() } },
      { returnDocument: 'after' },
    );
    if (!updated) throw new ServiceError(409, 'connection_changed', 'The connection changed during discovery; run it again');
    await this.d.audit.record({
      orgId: scope.orgId, actorUserId: actor.userId, action: 'connection.discovered', targetType: 'connection', targetId: id,
      projectId: scope.projectId, environmentId: c0.environmentId, metadata: { resources: resources.length, truncated },
    }, actor.ctx);
    return { discovery: { resources, capabilities: clean.capabilities, truncated }, connection: this.dto(updated) };
  }

  private discoveryFailure(e: ConnectorError, secrets: string[] = []) {
    return new ServiceError(422, 'discovery_failed', scrubKnownSecrets(clip(e.message), secrets), { kind: e.kind, remediation: e.remediation ?? REMEDIATION[e.kind] });
  }

  async setSelection(scope: Scope, id: string, actor: Actor, input: { resourceIds: string[]; signals: string[] }) {
    const c = await this.load(scope, id);
    if (!c.discovered) throw new ServiceError(409, 'not_discovered', 'Run discovery before selecting resources');
    const byId = new Map(c.discovered.resources.map((r) => [r.id, r]));
    const unknown = input.resourceIds.filter((r) => !byId.has(r));
    if (unknown.length) throw new ServiceError(400, 'unknown_resource', 'Some selected resources were not discovered on this connection', { count: unknown.length });
    const descriptor = this.d.registry.get(c.connectorType)!.descriptor;
    const offered = new Set(input.resourceIds.flatMap((r) => byId.get(r)!.signals));
    for (const s of input.signals) {
      const declared = descriptor.signals.find((x) => x.signal === s);
      if (!declared || declared.availability === 'unsupported' || declared.availability === 'planned') {
        throw new ServiceError(400, 'unsupported_signal', `${descriptor.displayName} does not provide ${s}`);
      }
      if (!offered.has(s)) throw new ServiceError(400, 'unavailable_signal', `None of the selected resources provides ${s} with the current permissions`);
    }
    await this.d.db.c.connections.updateOne({ _id: id, orgId: scope.orgId }, { $set: { selection: { resourceIds: [...new Set(input.resourceIds)], signals: [...new Set(input.signals)] }, updatedAt: this.now() } });
    await this.d.audit.record({ orgId: scope.orgId, actorUserId: actor.userId, action: 'connection.selection_updated', targetType: 'connection', targetId: id, projectId: scope.projectId, environmentId: c.environmentId, metadata: { resources: input.resourceIds.length, signals: input.signals } }, actor.ctx);
    return this.get(scope, id);
  }

  async setSettings(scope: Scope, id: string, actor: Actor, input: unknown) {
    const c = await this.load(scope, id);
    const parsed = ConnectionSettings.safeParse(input);
    if (!parsed.success) throw new ServiceError(400, 'invalid_settings', 'The collection settings are not valid', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    const set: Record<string, unknown> = { settings: parsed.data, updatedAt: this.now() };
    await this.d.db.c.connections.updateOne({ _id: id, orgId: scope.orgId }, { $set: set });
    await this.d.audit.record({ orgId: scope.orgId, actorUserId: actor.userId, action: 'connection.settings_updated', targetType: 'connection', targetId: id, projectId: scope.projectId, environmentId: c.environmentId, metadata: { ...parsed.data } }, actor.ctx);
    return this.get(scope, id);
  }

  async preview(scope: Scope, id: string) {
    const c = await this.load(scope, id);
    const descriptor = this.d.registry.get(c.connectorType)!.descriptor;
    const method = descriptor.authMethods.find((a) => a.id === c.authMethod);
    const settings = c.settings ?? ConnectionSettings.parse({});
    const chosen = new Set(c.selection?.resourceIds ?? []);
    const warnings = [
      ...(c.lastTest?.steps.filter((s) => s.status === 'warn').map((s) => `${s.label}: ${s.detail ?? ''}`) ?? []),
      ...(!c.lastTest || c.lastTest.configVersion !== c.configVersion ? ['The connection has not been tested since it was last changed.'] : []),
      ...(descriptor.collection === 'not_implemented' ? ['Collection is not implemented for this connector yet: starting the connection enables health monitoring only; no telemetry will be collected.'] : []),
    ];
    return {
      connector: descriptor.displayName, authMethod: method?.label ?? c.authMethod, target: c.config,
      credentials: (method?.secretFields ?? []).map((f) => ({ field: f.label, set: f.name in c.secretFields })),
      resources: (c.discovered?.resources ?? []).filter((r) => chosen.has(r.id)).map((r) => ({ id: r.id, name: r.name, type: r.type })),
      signals: c.selection?.signals ?? [], settings,
      schedule: `Health check every ${settings.pollIntervalSeconds}s (exponential backoff on failures, up to ${Math.round(15)} min)`,
      collection: descriptor.collection === 'implemented' ? `Sampling ${Math.round(settings.sampling * 100)}%, retention ${settings.retentionDays} days` : 'Not collected (not implemented yet)',
      warnings,
    };
  }

  async activate(scope: Scope, id: string, actor: Actor) {
    const c = await this.load(scope, id);
    if (c.lifecycle === 'active') return this.dto(c);
    if (c.lifecycle === 'disconnected') throw new ServiceError(409, 'disconnected', 'Rotate the credentials to reconnect first');
    const now = this.now();
    const missing: string[] = [];
    if (!c.lastTest?.ok || c.lastTest.configVersion !== c.configVersion || now.getTime() - c.lastTest.at.getTime() > TEST_FRESH_MS) missing.push('a passing, recent connection test for the current settings');
    if (!c.selection) missing.push('selected resources and signals');
    if (!c.settings) missing.push('collection settings');
    if (missing.length) throw new ServiceError(409, 'precondition_failed', `Cannot start yet: ${missing.join('; ')}`, { missing });
    const interval = (c.settings!.pollIntervalSeconds) * 1000;
    const descriptor = this.d.registry.get(c.connectorType)!.descriptor;
    const r = await this.d.db.c.connections.findOneAndUpdate(
      { _id: id, orgId: scope.orgId, lifecycle: 'draft', configVersion: c.configVersion },
      { $set: { lifecycle: 'active', activatedAt: now, updatedAt: now, 'health.nextCheckAt': new Date(now.getTime() + interval), collection: { status: descriptor.collection === 'implemented' ? 'not_started' : 'not_implemented', lastSuccessfulCollectionAt: null } } },
      { returnDocument: 'after' },
    );
    if (!r) throw new ServiceError(409, 'connection_changed', 'The connection changed; review and try again');
    await this.d.audit.record({ orgId: scope.orgId, actorUserId: actor.userId, action: 'connection.activated', targetType: 'connection', targetId: id, projectId: scope.projectId, environmentId: c.environmentId, metadata: { connectorType: c.connectorType } }, actor.ctx);
    return this.dto(r);
  }

  // ------------------------------------------------------------------ credential lifecycle

  async rotate(scope: Scope, id: string, actor: Actor, secrets: Record<string, string>) {
    const c = await this.load(scope, id);
    this.connector(c.connectorType);
    this.checkSecretNames(c.connectorType, c.authMethod, secrets);
    const now = this.now();
    const wasDisconnected = c.lifecycle === 'disconnected';
    await this.d.db.transaction(async (session) => {
      for (const [name, value] of Object.entries(secrets)) await this.d.secrets.put({ orgId: scope.orgId, connectionId: id, name }, value, actor.userId, session);
      await this.d.db.c.connections.updateOne({ _id: id, orgId: scope.orgId }, {
        $set: {
          ...Object.fromEntries(Object.keys(secrets).map((k) => [`secretFields.${k}`, { updatedAt: now }])), updatedAt: now,
          // A disconnected connection comes back as a draft: it must be tested and started again deliberately.
          ...(wasDisconnected ? { lifecycle: 'draft', disconnectedAt: null, 'health.state': 'pending' as ConnectionHealthState, 'health.nextCheckAt': null } : {}),
        },
        $inc: { configVersion: 1 },
      }, { session });
      await this.d.audit.record({ orgId: scope.orgId, actorUserId: actor.userId, action: 'connection.credentials_rotated', targetType: 'connection', targetId: id, projectId: scope.projectId, environmentId: c.environmentId, metadata: { fieldNames: Object.keys(secrets) } }, actor.ctx, session);
    });
    try { await this.d.registry.runnable(c.connectorType)?.onCredentialRotation?.(c.config); } catch { /* best effort */ }
    // Revalidate immediately: a rotation that does not work must show up now, not at the next scheduled check.
    return this.test(scope, id, actor);
  }

  /** Disconnect = stop monitoring AND revoke: the stored credentials are deleted. Reconnecting requires entering them again. */
  async disconnect(scope: Scope, id: string, actor: Actor) {
    const c = await this.load(scope, id);
    await this.bestEffortRemoteCleanup(c);
    const now = this.now();
    await this.d.db.transaction(async (session) => {
      await this.d.secrets.deleteAllForConnection(scope.orgId, id, session);
      await this.d.db.c.connections.updateOne({ _id: id, orgId: scope.orgId }, {
        $set: { lifecycle: 'disconnected', disconnectedAt: now, updatedAt: now, secretFields: {}, lease: null, 'health.state': 'disconnected' as ConnectionHealthState, 'health.nextCheckAt': null },
        $inc: { configVersion: 1 },
      }, { session });
      await this.d.audit.record({ orgId: scope.orgId, actorUserId: actor.userId, action: 'connection.disconnected', targetType: 'connection', targetId: id, projectId: scope.projectId, environmentId: c.environmentId, metadata: { previousState: c.health.state } }, actor.ctx, session);
    });
    return this.get(scope, id);
  }

  async remove(scope: Scope, id: string, actor: Actor): Promise<void> {
    const c = await this.load(scope, id);
    await this.bestEffortRemoteCleanup(c);
    await this.d.db.transaction(async (session) => {
      await this.d.secrets.deleteAllForConnection(scope.orgId, id, session);
      await this.d.db.c.connections.deleteOne({ _id: id, orgId: scope.orgId }, { session });
      await this.d.audit.record({ orgId: scope.orgId, actorUserId: actor.userId, action: 'connection.deleted', targetType: 'connection', targetId: id, projectId: scope.projectId, environmentId: c.environmentId, metadata: { connectorType: c.connectorType, name: c.name } }, actor.ctx, session);
    });
  }

  private async bestEffortRemoteCleanup(c: ConnectionDoc) {
    const connector = this.d.registry.runnable(c.connectorType);
    if (!connector?.onDisconnect || c.lifecycle === 'disconnected') return;
    const dl = withDeadline(undefined, 10_000);
    try {
      const p = await this.prepare(c);
      await connector.onDisconnect(this.context(dl.signal), p.config, p.creds);
    } catch { /* cleanup must never block disconnect/delete */ } finally { dl.dispose(); }
  }

  /** Drafts abandoned mid-wizard still hold encrypted credentials; delete them (and the secrets) after `olderThanMs`. */
  async purgeStaleDrafts(olderThanMs = 24 * 3600_000): Promise<number> {
    const cutoff = new Date(this.now().getTime() - olderThanMs);
    const stale = await this.d.db.c.connections.find({ lifecycle: 'draft', updatedAt: { $lt: cutoff } }).limit(200).toArray();
    for (const c of stale) {
      await this.d.db.transaction(async (session) => {
        await this.d.secrets.deleteAllForConnection(c.orgId, c._id, session);
        await this.d.db.c.connections.deleteOne({ _id: c._id, lifecycle: 'draft' }, { session });
        await this.d.audit.record({ orgId: c.orgId, actorUserId: null, action: 'connection.draft_purged', targetType: 'connection', targetId: c._id, projectId: c.projectId, environmentId: c.environmentId, metadata: { name: c.name, connectorType: c.connectorType } }, { requestId: 'system:draft-purge' }, session);
      });
    }
    return stale.length;
  }

  // ------------------------------------------------------------------ monitoring (used by the worker)

  /** Atomically leases up to `limit` due connections so that several workers never check the same one concurrently. */
  async claimDue(owner: string, limit: number, leaseMs = 120_000): Promise<ConnectionDoc[]> {
    const out: ConnectionDoc[] = [];
    for (let i = 0; i < limit; i++) {
      const now = this.now();
      const c = await this.d.db.c.connections.findOneAndUpdate(
        { lifecycle: 'active', 'health.nextCheckAt': { $lte: now }, $or: [{ lease: null }, { 'lease.until': { $lt: now } }] },
        { $set: { lease: { owner, until: new Date(now.getTime() + leaseMs) } } },
        { sort: { 'health.nextCheckAt': 1 }, returnDocument: 'after' },
      );
      if (!c) break;
      out.push(c);
    }
    return out;
  }

  /** One scheduled health check for a leased connection. Never throws; the lease is always released. */
  async runMonitorCheck(c0: ConnectionDoc, owner: string): Promise<ConnectionDoc['health']['state']> {
    const actor: Actor = { userId: null, ctx: { requestId: `worker:${owner}` } };
    try {
      const report = await this.runTest(c0);
      const c = await this.persistTest(c0, report, { scheduled: true });
      try { await this.auditHealthChange(c0, c, actor); } catch { /* auditing must not break monitoring */ }
      return c.health.state;
    } catch {
      // e.g. configuration changed mid-run: just retry soon
      await this.d.db.c.connections.updateOne({ _id: c0._id, 'lease.owner': owner }, { $set: { 'health.nextCheckAt': new Date(this.now().getTime() + 5_000) } });
      return c0.health.state;
    } finally {
      await this.d.db.c.connections.updateOne({ _id: c0._id, 'lease.owner': owner }, { $set: { lease: null } });
    }
  }
}
