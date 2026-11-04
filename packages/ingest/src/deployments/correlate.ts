import { DEPLOYMENT_LIMITS } from '@nexus/contracts';

/**
 * Read-only correlation between deployments and incidents (ADR-0011 #12). Pure functions: no I/O, no clock.
 * A match is a coincidence in time and in service name. Nothing here says, or may be used to say, that a deployment caused an incident.
 */

/** The services an incident is about: the rule's own service filter(s) and the incident group's `service` label. Empty when the rule names none. */
export function affectedServices(query: Record<string, unknown> | null | undefined, groupLabels: Record<string, string> | null | undefined): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => { if (typeof v === 'string' && v.trim()) out.add(v); };
  if (query?.kind === 'metric') add(query.service);
  if (query?.kind === 'logs' && Array.isArray(query.services)) query.services.forEach(add);
  add(groupLabels?.service);
  return [...out].sort();
}

/**
 * True when the deployment had started by the time the incident opened and ended (or, if it has not ended, started) at most `windowMs` before it.
 * Both bounds are inclusive. A deployment that finished AFTER the incident opened still matches when it started before (it was in flight).
 */
export function deploymentPrecedesIncident(
  dep: { startedAt: Date; finishedAt: Date | null }, openedAt: Date, windowMs: number = DEPLOYMENT_LIMITS.correlationWindowMs,
): boolean {
  const started = dep.startedAt.getTime(), opened = openedAt.getTime();
  if (started > opened) return false;
  return (dep.finishedAt?.getTime() ?? started) >= opened - windowMs;
}
