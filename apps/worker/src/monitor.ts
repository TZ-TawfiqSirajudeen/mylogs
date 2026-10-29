import type { ConnectionService } from '@nexus/connections';

export interface MonitorOptions {
  owner: string;
  /** Maximum checks in flight at once: a bound on outbound sockets and memory, whatever the backlog. */
  concurrency: number;
  tickMs: number;
  /** Abandoned wizard drafts hold encrypted credentials; purge them this often. */
  draftPurgeEveryMs?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;
}

export interface MonitorMetrics {
  checksStarted: number;
  checksFinished: number;
  checksUnhealthy: number;
  tickErrors: number;
  draftsPurged: number;
  inflight: number;
  lastTickAt: number | null;
  lastTickDurationMs: number | null;
}

/**
 * Scheduled health checks. Each tick leases due connections (so several workers share the load without double-checking)
 * and runs them with a fixed concurrency cap. A crashed worker's leases simply expire and are picked up by another.
 */
export class MonitorWorker {
  readonly metrics: MonitorMetrics = {
    checksStarted: 0, checksFinished: 0, checksUnhealthy: 0, tickErrors: 0, draftsPurged: 0, inflight: 0, lastTickAt: null, lastTickDurationMs: null,
  };
  private readonly inflight = new Set<Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private lastPurge = 0;
  private readonly log: NonNullable<MonitorOptions['log']>;

  constructor(private readonly svc: ConnectionService, private readonly o: MonitorOptions) {
    this.log = o.log ?? (() => undefined);
  }

  /** One scheduling pass. Resolves when everything it started has finished (tests rely on this; `start()` does not wait). */
  async tick(): Promise<number> {
    const t0 = Date.now();
    let started = 0;
    try {
      const free = this.o.concurrency - this.inflight.size;
      if (free > 0 && !this.stopping) {
        const due = await this.svc.claimDue(this.o.owner, free);
        for (const c of due) { this.launch(c); started++; }
      }
      await this.maybePurgeDrafts();
    } catch (err) {
      this.metrics.tickErrors++;
      this.log('error', 'tick failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.metrics.lastTickAt = Date.now();
      this.metrics.lastTickDurationMs = Date.now() - t0;
    }
    return started;
  }

  private launch(c: Parameters<ConnectionService['runMonitorCheck']>[0]) {
    this.metrics.checksStarted++;
    const p = this.svc.runMonitorCheck(c, this.o.owner)
      .then((state) => {
        if (state !== 'healthy') this.metrics.checksUnhealthy++;
        this.log('info', 'check finished', { connection: c._id, state });
      })
      .catch((err) => this.log('error', 'check crashed', { connection: c._id, error: err instanceof Error ? err.message : String(err) }))
      .finally(() => { this.metrics.checksFinished++; this.inflight.delete(p); this.metrics.inflight = this.inflight.size; });
    this.inflight.add(p);
    this.metrics.inflight = this.inflight.size;
  }

  private async maybePurgeDrafts() {
    const every = this.o.draftPurgeEveryMs ?? 3600_000;
    if (Date.now() - this.lastPurge < every) return;
    this.lastPurge = Date.now();
    const n = await this.svc.purgeStaleDrafts();
    this.metrics.draftsPurged += n;
    if (n) this.log('info', 'purged abandoned drafts', { count: n });
  }

  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  start() {
    const loop = async () => {
      if (this.stopping) return;
      await this.tick();
      if (!this.stopping) this.timer = setTimeout(() => void loop(), this.o.tickMs);
    };
    void loop();
  }

  /** Graceful shutdown: stop claiming, let running checks finish (bounded), release nothing half-done. */
  async stop(graceMs = 15_000): Promise<{ drained: boolean }> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    const drained = await Promise.race([this.idle().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), graceMs))]);
    return { drained };
  }

  /** Ready = the scheduler loop is alive (ticked recently). The DB check is done by the caller. */
  isAlive(now = Date.now()): boolean {
    return this.metrics.lastTickAt !== null && now - this.metrics.lastTickAt < Math.max(3 * this.o.tickMs, 15_000);
  }

  prometheus(): string {
    const m = this.metrics;
    const line = (name: string, help: string, type: 'counter' | 'gauge', v: number | null) =>
      `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name} ${v ?? 'NaN'}\n`;
    return [
      line('nexus_worker_checks_started_total', 'Health checks started', 'counter', m.checksStarted),
      line('nexus_worker_checks_finished_total', 'Health checks finished', 'counter', m.checksFinished),
      line('nexus_worker_checks_unhealthy_total', 'Checks that ended in a non-healthy state', 'counter', m.checksUnhealthy),
      line('nexus_worker_tick_errors_total', 'Scheduler ticks that failed', 'counter', m.tickErrors),
      line('nexus_worker_drafts_purged_total', 'Abandoned drafts purged', 'counter', m.draftsPurged),
      line('nexus_worker_inflight_checks', 'Checks currently running', 'gauge', m.inflight),
      line('nexus_worker_last_tick_timestamp_seconds', 'Unix time of the last scheduler tick', 'gauge', m.lastTickAt ? Math.floor(m.lastTickAt / 1000) : null),
    ].join('');
  }
}
