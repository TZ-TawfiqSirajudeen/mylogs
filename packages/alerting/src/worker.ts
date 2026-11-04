import { AuditService, type Database } from '@nexus/database';
import type { LogStore } from '@nexus/logstore';
import type { MetricStore } from '@nexus/metricstore';
import { SecretStore } from '@nexus/secrets';
import type { NetworkPolicy } from '@nexus/security';
import { DeliveryProcessor } from './delivery.js';
import { AlertEngine, type EngineOptions } from './engine.js';
import { IncidentService } from './incidents.js';
import { Notifier } from './notifier.js';

export interface AlertWorkerOptions {
  owner: string;
  tickMs: number;
  policy: NetworkPolicy;
  publicUrl?: string | null;
  engine?: Partial<Omit<EngineOptions, 'owner'>>;
  now?: () => Date;
  log?: (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;
}

/**
 * Runs the alert engine and the notification sender on the worker's schedule. Deliveries go first (they are cheap and time sensitive), then the
 * due rules. The loop never overlaps itself and never dies on an error: a failed tick is logged and the next one runs on schedule.
 */
export class AlertWorker {
  readonly engine: AlertEngine;
  readonly delivery: DeliveryProcessor;
  readonly incidents: IncidentService;
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private running: Promise<void> | null = null;
  private tickErrors = 0;
  private lastTickAt: number | null = null;

  constructor(db: Database, deps: { metrics: MetricStore; logs: LogStore; secrets: SecretStore }, private readonly o: AlertWorkerOptions) {
    const notifier = new Notifier(db, { publicUrl: o.publicUrl ?? null });
    this.incidents = new IncidentService(db, new AuditService(db), notifier);
    this.engine = new AlertEngine(db, { metrics: deps.metrics, logs: deps.logs }, this.incidents, { owner: o.owner, ...(o.now ? { now: o.now } : {}), ...(o.log ? { log: o.log } : {}), ...o.engine });
    this.delivery = new DeliveryProcessor(db, deps.secrets, { owner: o.owner, policy: o.policy, ...(o.now ? { now: o.now } : {}), ...(o.log ? { log: o.log } : {}) });
  }

  /** Returns true when the tick used its whole per-tick allowance, i.e. more rules are probably due: the loop then runs again almost at once. */
  async tick(): Promise<boolean> {
    let backlog = false;
    try {
      const sent = await this.delivery.tick();
      const evaluated = await this.engine.tick();
      backlog = evaluated.length >= (this.o.engine?.maxRulesPerTick ?? 50) || sent >= 20;
    } catch (e) {
      this.tickErrors++;
      this.o.log?.('error', 'alert tick failed', { error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.lastTickAt = Date.now();
    }
    return backlog;
  }

  start() {
    const loop = async () => {
      if (this.stopping) return;
      let backlog = false;
      this.running = this.tick().then((b) => { backlog = b; });
      await this.running;
      // A backlog is drained continuously (each tick is still bounded); an idle worker polls every tickMs.
      if (!this.stopping) this.timer = setTimeout(() => void loop(), backlog ? 50 : this.o.tickMs);
    };
    void loop();
  }

  async stop(graceMs = 15_000): Promise<{ drained: boolean }> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    const drained = await Promise.race([(this.running ?? Promise.resolve()).then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), graceMs))]);
    return { drained };
  }

  isAlive(now = Date.now()): boolean {
    return this.lastTickAt !== null && now - this.lastTickAt < Math.max(3 * this.o.tickMs, 30_000);
  }

  prometheus(): string {
    const e = this.engine.metrics, d = this.delivery.metrics;
    const line = (name: string, help: string, type: 'counter' | 'gauge', v: number | null) => `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name} ${v ?? 'NaN'}\n`;
    return [
      line('nexus_alert_rules_evaluated_total', 'Alert rule evaluations started', 'counter', e.rulesEvaluated),
      line('nexus_alert_evaluation_errors_total', 'Alert rule evaluations that failed (state unchanged)', 'counter', e.evaluationErrors),
      line('nexus_alert_evaluation_budget_exceeded_total', 'Alert rule evaluations abandoned for exceeding the per-rule time budget', 'counter', e.budgetExceeded),
      line('nexus_alert_incidents_opened_total', 'Incidents opened', 'counter', e.incidentsOpened),
      line('nexus_alert_incidents_auto_resolved_total', 'Incidents resolved automatically', 'counter', e.incidentsResolved),
      line('nexus_alert_evaluations_missed_total', 'Alert evaluations that were due but not run on time (worker down, lease expired, backlog)', 'counter', e.evaluationsMissed),
      line('nexus_alert_evaluations_replayed_total', 'Missed alert evaluations that were re-run in order by a replay policy', 'counter', e.evaluationsReplayed),
      line('nexus_alert_catch_up_notices_total', 'Catch-up notices created after a replay for incidents whose own notification was stale', 'counter', e.catchUpNotices),
      line('nexus_alert_last_tick_duration_ms', 'Duration of the last evaluation tick', 'gauge', e.lastTickDurationMs),
      line('nexus_alert_last_tick_rules', 'Rules evaluated by the last tick', 'gauge', e.lastTickRules),
      line('nexus_alert_deliveries_attempted_total', 'Notification attempts', 'counter', d.attempted),
      line('nexus_alert_deliveries_delivered_total', 'Notifications delivered', 'counter', d.delivered),
      line('nexus_alert_deliveries_retried_total', 'Notification attempts rescheduled for retry', 'counter', d.retried),
      line('nexus_alert_deliveries_failed_total', 'Notifications that failed permanently', 'counter', d.failed),
      line('nexus_alert_tick_errors_total', 'Alert scheduler ticks that failed', 'counter', this.tickErrors),
    ].join('');
  }
}
