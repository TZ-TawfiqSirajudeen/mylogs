import { expect, test } from 'vitest';
import { createDefaultRegistry } from './registry.js';

test('pull connectors are runnable; push sources are implemented but not connectable; planned ones are listed honestly and cannot run', () => {
  const r = createDefaultRegistry();
  const pull = r.list().filter((d) => d.status === 'implemented' && d.mode !== 'push').map((d) => d.type).sort();
  const push = r.list().filter((d) => d.mode === 'push').map((d) => d.type).sort();
  expect(pull).toEqual(['http-health', 'mongodb', 'redis']);
  expect(push).toEqual(['json-logs', 'otlp']);
  for (const d of r.list()) {
    expect(Boolean(r.runnable(d.type)), d.type).toBe(d.status === 'implemented' && d.mode !== 'push');
    // push sources deliver telemetry; of the pull connectors only the database ones sample metrics (and must then implement collect())
    const collects = d.mode === 'push' || d.type === 'mongodb' || d.type === 'redis';
    expect(d.collection, d.type).toBe(collects ? 'implemented' : 'not_implemented');
    if (d.mode !== 'push') expect(Boolean(r.runnable(d.type)?.collect), d.type).toBe(collects && d.status === 'implemented');
    if (d.status === 'planned') {
      expect(d.limitations.join(' '), d.type).toMatch(/Not implemented/);
      expect(d.signals.every((s) => s.availability !== 'supported'), d.type).toBe(true);
    }
  }
  // The ingestion service accepts OTLP traces and metrics (Phase 4) and nothing else besides logs: only the OTLP source may claim them,
  // and the plain JSON log source must not.
  for (const d of r.list().filter((x) => x.mode === 'push')) {
    for (const sig of d.signals.filter((x) => x.signal === 'traces' || x.signal === 'metrics')) {
      if (d.type === 'otlp') expect(sig.availability, `${d.type}:${sig.signal}`).toBe('supported');
      else expect(sig.availability, `${d.type}:${sig.signal}`).not.toBe('supported');
    }
  }
});

test('every implemented connector documents least-privilege permissions and limitations', () => {
  for (const d of createDefaultRegistry().list().filter((x) => x.status === 'implemented' && x.mode !== 'push')) {
    expect(d.requiredPermissions.length, d.type).toBeGreaterThan(0);
    expect(d.limitations.length, d.type).toBeGreaterThan(0);
    expect(d.leastPrivilegeGuide, d.type).toBeTruthy();
    expect(d.authMethods.filter((a) => a.recommended), d.type).toHaveLength(1);
  }
});
