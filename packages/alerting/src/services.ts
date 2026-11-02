import type { AuditSink, Database } from '@nexus/database';
import type { SecretStore } from '@nexus/secrets';
import type { NetworkPolicy } from '@nexus/security';
import { ChannelService, RuleService, SilenceService } from './config.js';
import { DeliveryProcessor, type DeliveryOptions } from './delivery.js';
import { IncidentService } from './incidents.js';
import { Notifier } from './notifier.js';

/** Everything the API needs, wired the same way the worker wires it. */
export function createAlertingServices(db: Database, audit: AuditSink, secrets: SecretStore, policy: NetworkPolicy, opts: { publicUrl?: string | null; sender?: DeliveryOptions['sender']; now?: () => Date } = {}) {
  const notifier = new Notifier(db, { publicUrl: opts.publicUrl ?? null });
  const incidents = new IncidentService(db, audit, notifier, opts.now ? { now: opts.now } : {});
  const delivery = new DeliveryProcessor(db, secrets, { owner: 'api', policy, ...(opts.sender ? { sender: opts.sender } : {}), ...(opts.now ? { now: opts.now } : {}) });
  const clock = opts.now ? { now: opts.now } : {};
  return {
    incidents, delivery, notifier,
    rules: new RuleService(db, audit, incidents, clock),
    channels: new ChannelService(db, audit, secrets, policy, delivery, clock),
    silences: new SilenceService(db, audit, clock),
  };
}
export type AlertingServices = ReturnType<typeof createAlertingServices>;
