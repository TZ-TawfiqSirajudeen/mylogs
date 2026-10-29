import { STRICT_POLICY, type NetworkPolicy } from '@nexus/security';
import type { Connector, ConnectorContext, ConnectorErrorKind, TestReport } from './types.js';
import { SIGNALS } from './types.js';

export interface ContractFixtures<Config, Creds> {
  /** A target where everything works. */
  valid: { config: Config; creds: Creds; authMethod: string };
  /** Credentials the target must reject (expects kind `authentication`). Optional when the connector has no auth. */
  wrongCreds?: { creds: Creds; expectKind?: ConnectorErrorKind };
  /** A config pointing at nothing (expects `unreachable` or `timeout`). */
  unreachable?: { config: Config; expectKind?: ConnectorErrorKind };
  network?: NetworkPolicy;
}

export interface ContractResult { check: string; ok: boolean; detail?: string }

export const testContext = (network: NetworkPolicy = STRICT_POLICY, signal?: AbortSignal): ConnectorContext => ({
  signal: signal ?? new AbortController().signal,
  network,
  now: () => new Date(),
  logger: { info: () => undefined, warn: () => undefined },
});

/**
 * Contract checks every connector must satisfy. Returns results instead of asserting so any test runner can use it:
 * `expect(results.filter(r => !r.ok)).toEqual([])`.
 */
export async function runConnectorContract<Config, Creds extends Record<string, string>>(
  connector: Connector<Config, Creds>, fx: ContractFixtures<Config, Creds>,
): Promise<ContractResult[]> {
  const out: ContractResult[] = [];
  const check = (name: string, ok: boolean, detail?: string) => out.push(detail === undefined ? { check: name, ok } : { check: name, ok, detail });
  const d = connector.descriptor;
  const ctx = () => testContext(fx.network);
  const secretValues = Object.values(fx.valid.creds).concat(Object.values(fx.wrongCreds?.creds ?? {}));
  const leaks = (v: unknown) => secretValues.some((s) => s.length >= 4 && JSON.stringify(v).includes(s));

  // ---- descriptor honesty
  check('descriptor: type + name present', !!d.type && !!d.displayName);
  check('descriptor: signals are unique and known', new Set(d.signals.map((s) => s.signal)).size === d.signals.length && d.signals.every((s) => SIGNALS.includes(s.signal)));
  check('descriptor: every auth method has a credential schema', d.authMethods.every((a) => connector.credentialSchema(a.id) !== undefined));
  check('descriptor: exactly one recommended auth method', d.authMethods.length === 0 || d.authMethods.filter((a) => a.recommended).length === 1);
  check('descriptor: collection flag matches implementation', d.collection === 'implemented' ? !!connector.initialSync && !!connector.collect : !connector.initialSync && !connector.collect,
    'a connector may only claim collection if initialSync/collect exist (and must not have them otherwise)');
  check('config schema rejects garbage', !connector.configSchema.safeParse({ nonsense: true }).success && !connector.configSchema.safeParse(null).success);
  check('config schema accepts the valid fixture', connector.configSchema.safeParse(fx.valid.config).success);
  const method = d.authMethods.find((a) => a.id === fx.valid.authMethod);
  check('fixture auth method is declared by the descriptor', d.authMethods.length === 0 || !!method);
  if (method && method.secretFields.length > 0) {
    check('credential schema rejects empty input', !connector.credentialSchema(fx.valid.authMethod)?.safeParse({}).success);
  }

  // ---- happy path
  let good: TestReport | undefined;
  try {
    good = await connector.test(ctx(), fx.valid.config, fx.valid.creds);
    check('test(): succeeds against a valid target', good.ok, good.failure?.message);
    check('test(): reports at least one step', good.steps.length > 0);
    check('test(): failing steps carry remediation', good.steps.every((s) => s.status !== 'fail' || !!s.remediation));
    check('test(): report contains no secret values', !leaks(good));
    check('test(): reports capabilities explicitly', good.capabilities.length > 0);
  } catch (e) {
    check('test(): must not throw for a valid target', false, String(e));
  }

  try {
    const disc = await connector.discover(ctx(), fx.valid.config, fx.valid.creds);
    const ids = disc.resources.map((r) => r.id);
    check('discover(): resource ids unique', new Set(ids).size === ids.length);
    check('discover(): resource signals are a subset of what the descriptor supports',
      disc.resources.every((r) => r.signals.every((s) => d.signals.some((x) => x.signal === s && x.availability !== 'unsupported'))));
    check('discover(): result contains no secret values', !leaks(disc));
  } catch (e) {
    check('discover(): must not throw for a valid target', false, String(e));
  }

  // ---- expected failures are reported, never thrown, and classified
  if (fx.wrongCreds) {
    const r = await connector.test(ctx(), fx.valid.config, fx.wrongCreds.creds).catch((e) => ({ threw: e }));
    const rep = r as TestReport;
    check('test(): bad credentials -> ok=false (not thrown)', !('threw' in r) && !rep.ok);
    check('test(): bad credentials classified', rep.failure?.kind === (fx.wrongCreds.expectKind ?? 'authentication'), `got ${rep.failure?.kind}`);
    check('test(): bad credentials have remediation', !!rep.failure?.remediation);
    check('test(): failure report contains no secret values', !leaks(r));
  }
  if (fx.unreachable) {
    const r = await connector.test(ctx(), fx.unreachable.config, fx.valid.creds).catch((e) => ({ threw: e }));
    const rep = r as TestReport;
    check('test(): unreachable target -> ok=false (not thrown)', !('threw' in r) && !rep.ok);
    check('test(): unreachable target classified', ['unreachable', 'timeout', fx.unreachable.expectKind].includes(rep.failure?.kind), `got ${rep.failure?.kind}`);
  }

  // ---- cancellation: an already-aborted signal must finish promptly, never hang
  const ctl = new AbortController();
  ctl.abort();
  const started = Date.now();
  const cancelled = await Promise.race([
    connector.test(testContext(fx.network, ctl.signal), fx.valid.config, fx.valid.creds).then((r) => r, (e) => ({ threw: e })),
    new Promise<'hung'>((res) => setTimeout(() => res('hung'), 10_000)),
  ]);
  check('test(): honours cancellation promptly', cancelled !== 'hung' && Date.now() - started < 5_000);
  check('test(): a cancelled run is not reported as healthy', cancelled === 'hung' || ('threw' in (cancelled as object)) || !(cancelled as TestReport).ok);

  return out;
}
