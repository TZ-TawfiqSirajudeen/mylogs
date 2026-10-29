import { describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { ConnectorRegistry, capabilityMatrixMarkdown } from './registry.js';
import { backoffDelay, nextCheckDelay, toConnectorError, withDeadline, withRetry } from './runtime.js';
import { runConnectorContract } from './testkit.js';
import { ConnectorError, stateForError, type Connector, type ConnectorDescriptor } from './types.js';

describe('stateForError', () => {
  test.each([
    ['authentication', false, 'misconfigured'], ['authentication', true, 'authentication_expired'],
    ['permission_denied', false, 'permission_denied'], ['unreachable', true, 'unreachable'], ['timeout', true, 'unreachable'],
    ['rate_limited', true, 'degraded'], ['misconfigured', true, 'misconfigured'], ['internal', true, 'degraded'], ['unhealthy', true, 'degraded'],
  ] as const)('%s (hadSuccess=%s) -> %s', (kind, had, state) => expect(stateForError(kind, had)).toBe(state));
});

describe('withRetry', () => {
  const noSleep = vi.fn(async () => undefined);
  test('retries transient failures with growing jittered delays, then succeeds', async () => {
    let n = 0;
    const delays: number[] = [];
    const r = await withRetry(async () => { if (++n < 3) throw new ConnectorError('unreachable', 'down'); return 'ok'; },
      { retries: 5, baseMs: 100, maxMs: 10_000, sleep: async (ms) => { delays.push(ms); }, random: () => 0.99, onRetry: () => undefined });
    expect(r).toBe('ok');
    expect(n).toBe(3);
    expect(delays).toEqual([99, 198]); // full jitter: floor(0.99 * min(max, base*2^(n-1)))
  });

  test('never retries authentication, permission or configuration errors (avoids lockouts)', async () => {
    for (const kind of ['authentication', 'permission_denied', 'misconfigured', 'unsupported'] as const) {
      const fn = vi.fn(async () => { throw new ConnectorError(kind, 'nope'); });
      await expect(withRetry(fn, { retries: 5, baseMs: 1, maxMs: 2, sleep: noSleep })).rejects.toMatchObject({ kind });
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  test('gives up after the retry budget and surfaces the last error', async () => {
    const fn = vi.fn(async () => { throw new ConnectorError('timeout', 'slow'); });
    await expect(withRetry(fn, { retries: 2, baseMs: 1, maxMs: 2, sleep: noSleep })).rejects.toMatchObject({ kind: 'timeout' });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('honours the provider Retry-After when it exceeds the computed backoff', () => {
    expect(backoffDelay(1, { baseMs: 100, maxMs: 60_000, random: () => 0 }, 5_000)).toBe(5_000);
    expect(backoffDelay(1, { baseMs: 100, maxMs: 1_000, random: () => 0 }, 5_000)).toBe(1_000); // but never above the ceiling
  });

  test('stops promptly on cancellation', async () => {
    const ctl = new AbortController();
    const fn = vi.fn(async () => { ctl.abort(); throw new ConnectorError('unreachable', 'down'); });
    await expect(withRetry(fn, { retries: 5, baseMs: 1, maxMs: 2, signal: ctl.signal })).rejects.toMatchObject({ kind: 'cancelled' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('unknown exceptions become internal errors (retryable, message preserved)', () => {
    const e = toConnectorError(new Error('boom'));
    expect(e.kind).toBe('internal');
    expect(e.message).toBe('boom');
  });
});

describe('nextCheckDelay (health scheduling)', () => {
  const policy = { intervalMs: 60_000, maxBackoffMs: 900_000 };
  test('healthy connections are checked at the normal interval', () => expect(nextCheckDelay(0, policy)).toBe(60_000));
  test('failures back off exponentially up to the ceiling', () => {
    const d = [1, 2, 3, 4, 8].map((n) => nextCheckDelay(n, policy, undefined, () => 0.5));
    expect(d).toEqual([120_000, 240_000, 480_000, 900_000, 900_000]);
  });
  test('rate-limit Retry-After wins when longer, but is capped', () => {
    expect(nextCheckDelay(1, policy, 600_000, () => 0.5)).toBe(600_000);
    expect(nextCheckDelay(1, policy, 10_000_000, () => 0.5)).toBe(900_000);
  });
  test('jitter keeps delays within ±20%', () => {
    for (const r of [0, 0.5, 0.999]) {
      const v = nextCheckDelay(1, policy, undefined, () => r);
      expect(v).toBeGreaterThanOrEqual(96_000);
      expect(v).toBeLessThanOrEqual(144_000);
    }
  });
});

describe('withDeadline', () => {
  test('aborts at the deadline and reports it; parent abort propagates', async () => {
    const d = withDeadline(undefined, 20);
    await new Promise((r) => setTimeout(r, 60));
    expect(d.signal.aborted).toBe(true);
    expect(d.timedOut()).toBe(true);
    d.dispose();
    const parent = new AbortController();
    const p = withDeadline(parent.signal, 10_000);
    parent.abort();
    expect(p.signal.aborted).toBe(true);
    expect(p.timedOut()).toBe(false);
    p.dispose();
  });
});

// ---------------------------------------------------------------- registry + contract kit with a fake connector

const descriptor = (over: Partial<ConnectorDescriptor> = {}): ConnectorDescriptor => ({
  type: 'fake', displayName: 'Fake', category: 'application', status: 'implemented', collection: 'not_implemented',
  signals: [{ signal: 'metrics', availability: 'supported' }], deploymentTypes: ['any'],
  authMethods: [{ id: 'token', label: 'Token', recommended: true, description: '', secretFields: [{ name: 'token', label: 'Token' }] }],
  requiredPermissions: [], operations: ['probe'], configRequirements: [], limitations: [], ...over,
});

const fake = (over: Partial<Connector<{ url: string }, { token: string }>> = {}): Connector<{ url: string }, { token: string }> => ({
  descriptor: descriptor(),
  configSchema: z.strictObject({ url: z.string() }),
  credentialSchema: (m) => (m === 'token' ? z.object({ token: z.string().min(1) }) : undefined),
  async test(ctx, config, creds) {
    if (ctx.signal.aborted) throw new ConnectorError('cancelled', 'cancelled');
    if (config.url === 'down') return { ok: false, failure: { kind: 'unreachable', message: 'down', remediation: 'check network' }, steps: [{ id: 'c', label: 'connect', status: 'fail', remediation: 'check network' }], capabilities: [], facts: {}, durationMs: 1 };
    if (creds.token !== 'good-token') return { ok: false, failure: { kind: 'authentication', message: 'bad token', remediation: 'rotate' }, steps: [{ id: 'a', label: 'auth', status: 'fail', remediation: 'rotate' }], capabilities: [], facts: {}, durationMs: 1 };
    return { ok: true, steps: [{ id: 'c', label: 'connect', status: 'pass' }], capabilities: [{ id: 'm', label: 'metrics', available: true, signal: 'metrics' }], facts: {}, durationMs: 1 };
  },
  async discover() { return { resources: [{ id: 'r1', type: 'x', name: 'x', attributes: {}, signals: ['metrics'] }], capabilities: [], truncated: false }; },
  ...over,
});

const fixtures = {
  valid: { config: { url: 'ok' }, creds: { token: 'good-token' }, authMethod: 'token' },
  wrongCreds: { creds: { token: 'wrong-token' } },
  unreachable: { config: { url: 'down' } },
};

describe('connector contract kit', () => {
  test('a well-behaved connector passes every check', async () => {
    const failed = (await runConnectorContract(fake(), fixtures)).filter((r) => !r.ok);
    expect(failed).toEqual([]);
  });

  test('catches a connector that claims collection but has no collect()', async () => {
    const bad = fake({ descriptor: descriptor({ collection: 'implemented' }) });
    const failed = (await runConnectorContract(bad, fixtures)).filter((r) => !r.ok).map((r) => r.check);
    expect(failed).toContain('descriptor: collection flag matches implementation');
  });

  test('catches a connector that leaks a secret into its report', async () => {
    const bad = fake({
      async test() { return { ok: true, steps: [{ id: 'x', label: 'token good-token accepted', status: 'pass' }], capabilities: [{ id: 'm', label: 'm', available: true }], facts: {}, durationMs: 1 }; },
    });
    const failed = (await runConnectorContract(bad, fixtures)).filter((r) => !r.ok).map((r) => r.check);
    expect(failed).toContain('test(): report contains no secret values');
  });

  test('catches a connector that throws for an expected failure instead of reporting it', async () => {
    const bad = fake({ async test(ctx, c, creds) { if (creds.token !== 'good-token') throw new Error('401'); return fake().test(ctx, c, creds); } });
    const failed = (await runConnectorContract(bad, fixtures)).filter((r) => !r.ok).map((r) => r.check);
    expect(failed).toContain('test(): bad credentials -> ok=false (not thrown)');
  });

  test('catches a connector that ignores cancellation and reports healthy', async () => {
    const bad = fake({ async test() { return { ok: true, steps: [{ id: 'c', label: 'c', status: 'pass' }], capabilities: [{ id: 'm', label: 'm', available: true }], facts: {}, durationMs: 1 }; } });
    const failed = (await runConnectorContract(bad, { ...fixtures, wrongCreds: undefined as never, unreachable: undefined as never })).filter((r) => !r.ok).map((r) => r.check);
    expect(failed).toContain('test(): a cancelled run is not reported as healthy');
  });
});

describe('registry', () => {
  const planned = descriptor({ type: 'future', displayName: 'Future', status: 'planned', authMethods: [], signals: [{ signal: 'logs', availability: 'planned' }] });

  test('implemented connectors are runnable; planned ones are listed but cannot run', () => {
    const r = new ConnectorRegistry().register(fake()).registerPlanned(planned);
    expect(r.runnable('fake')).toBeDefined();
    expect(r.runnable('future')).toBeUndefined();
    expect(r.get('future')?.descriptor.status).toBe('planned');
    expect(r.list().map((d) => d.type)).toEqual(['fake', 'future']);
  });

  test('rejects duplicates and mislabeled entries', () => {
    const r = new ConnectorRegistry().register(fake());
    expect(() => r.register(fake())).toThrow(/Duplicate/);
    expect(() => r.registerPlanned(descriptor())).toThrow(/not marked planned/);
    expect(() => new ConnectorRegistry().register({ ...fake(), descriptor: planned })).toThrow(/descriptor-only/);
  });

  test('capability matrix is generated from descriptors and is honest about collection', () => {
    const md = capabilityMatrixMarkdown(new ConnectorRegistry().register(fake()).registerPlanned(planned).list());
    expect(md).toContain('| Fake (`fake`) | **implemented** | not yet (health/discovery only)');
    expect(md).toContain('| Future (`future`) | **planned**');
    expect(md).toContain('logs: planned');
  });
});
