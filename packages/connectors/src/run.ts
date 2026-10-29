import { scrubKnownSecrets, TargetRejectedError } from '@nexus/security';
import {
  ConnectorError, REMEDIATION, toConnectorError,
  type ConnectorErrorKind, type DetectedCapability, type TestReport, type TestStep,
} from '@nexus/connector-sdk';

const MAX_TEXT = 300;

/** Collects the steps/capabilities of one test run and builds a report that is guaranteed secret-free. */
export class Run {
  readonly steps: TestStep[] = [];
  readonly capabilities: DetectedCapability[] = [];
  readonly facts: Record<string, string | number | boolean> = {};
  private readonly started = Date.now();

  constructor(private readonly secrets: string[]) {}

  clean(text: string): string {
    const t = scrubKnownSecrets(text, this.secrets);
    return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}…` : t;
  }

  /** Runs one step; failures are recorded and rethrown so the caller can stop and classify. */
  async step<T>(id: string, label: string, fn: () => Promise<T>, detail?: (v: T) => string | undefined): Promise<T> {
    const t0 = Date.now();
    try {
      const v = await fn();
      const d = detail?.(v);
      this.steps.push({ id, label, status: 'pass', ...(d ? { detail: this.clean(d) } : {}), durationMs: Date.now() - t0 });
      return v;
    } catch (e) {
      const err = toConnectorError(e);
      this.steps.push({ id, label, status: 'fail', detail: this.clean(err.message), remediation: err.remediation ?? REMEDIATION[err.kind], durationMs: Date.now() - t0 });
      throw err;
    }
  }

  warn(id: string, label: string, detail: string, remediation?: string) {
    this.steps.push({ id, label, status: 'warn', detail: this.clean(detail), ...(remediation ? { remediation } : {}) });
  }

  skip(id: string, label: string, detail: string) {
    this.steps.push({ id, label, status: 'skipped', detail });
  }

  capability(c: DetectedCapability) {
    this.capabilities.push(c.reason ? { ...c, reason: this.clean(c.reason) } : c);
  }

  report(failure?: ConnectorError): TestReport {
    const base = { steps: this.steps, capabilities: this.capabilities, facts: this.facts, durationMs: Date.now() - this.started };
    if (!failure) return { ok: true, ...base };
    return {
      ok: false,
      failure: {
        kind: failure.kind, message: this.clean(failure.message), remediation: failure.remediation ?? REMEDIATION[failure.kind],
        ...(failure.retryAfterMs ? { retryAfterMs: failure.retryAfterMs } : {}),
      },
      ...base,
    };
  }
}

/** Never lets an expected failure escape as an exception: it becomes a failed report. Cancellation is rethrown. */
export async function guarded(run: Run, body: () => Promise<void>): Promise<TestReport> {
  try {
    await body();
    return run.report();
  } catch (e) {
    const err = toConnectorError(e);
    if (err.kind === 'cancelled') throw err;
    return run.report(err);
  }
}

/** Network-policy rejections are configuration problems (or unreachable names), not transient failures. */
export function fromTargetRejection(e: unknown): ConnectorError {
  if (e instanceof TargetRejectedError) {
    if (e.code === 'dns_failure') {
      return new ConnectorError('unreachable', e.message, { remediation: 'The host name could not be resolved. Check the spelling and DNS.' });
    }
    return new ConnectorError('misconfigured', e.message, {
      remediation: 'This target is not permitted by the platform network policy. Public addresses are allowed by default; private networks require an administrator-approved network path or a private agent.',
    });
  }
  return toConnectorError(e);
}

export const kindRemediation = (k: ConnectorErrorKind) => REMEDIATION[k];

export function truncate(s: string, n = 120): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
