import { DEPLOYMENT_STATUSES, normalizeHttpsUrl, type DeploymentDto, type DeploymentStatusName } from '@nexus/contracts';
import { STATUS_STYLE } from '../../chart-markers';

/** Pure helpers of the Deployments page (ADR-0011): URL <-> filters, text formatting, and the copy-ready CI snippets. */

export const RANGES = [
  { key: '24h', label: 'Last 24 hours', ms: 24 * 3600_000 },
  { key: '7d', label: 'Last 7 days', ms: 7 * 24 * 3600_000 },
  { key: '30d', label: 'Last 30 days', ms: 30 * 24 * 3600_000 },
  { key: '90d', label: 'Last 90 days', ms: 90 * 24 * 3600_000 },
  { key: 'all', label: 'All retained (1 year)', ms: 0 },
] as const;

export interface DeploymentFilters { service: string; status: DeploymentStatusName | ''; env: string; range: (typeof RANGES)[number]['key'] }
export const DEFAULT_FILTERS: DeploymentFilters = { service: '', status: '', env: '', range: '30d' };

export function filtersFromParams(sp: URLSearchParams): DeploymentFilters {
  const status = sp.get('status');
  const range = sp.get('range');
  const env = sp.get('env') ?? '';
  return {
    service: (sp.get('svc') ?? '').slice(0, 128),
    status: status && (DEPLOYMENT_STATUSES as readonly string[]).includes(status) ? (status as DeploymentStatusName) : '',
    env: /^[0-9a-f-]{36}$/i.test(env) ? env : '',
    range: RANGES.find((r) => r.key === range)?.key ?? DEFAULT_FILTERS.range,
  };
}

/** Keeps the project and the open deployment; drops defaults so shared links stay short. */
export function filtersToParams(f: DeploymentFilters, keep: { p: string | null; id?: string | null }): URLSearchParams {
  const n = new URLSearchParams();
  if (keep.p) n.set('p', keep.p);
  if (f.service) n.set('svc', f.service);
  if (f.status) n.set('status', f.status);
  if (f.env) n.set('env', f.env);
  if (f.range !== DEFAULT_FILTERS.range) n.set('range', f.range);
  if (keep.id) n.set('id', keep.id);
  return n;
}

/** The API query string for the filters (`from` is relative to `now`, which the caller rounds so the request is stable). */
export function listQuery(f: DeploymentFilters, now: number, cursor?: string | null): string {
  const q = new URLSearchParams({ limit: '50' });
  if (f.service) q.set('service', f.service);
  if (f.status) q.set('status', f.status);
  if (f.env) q.set('environmentId', f.env);
  const r = RANGES.find((x) => x.key === f.range)!;
  if (r.ms) q.set('from', new Date(now - r.ms).toISOString());
  if (cursor) q.set('cursor', cursor);
  return q.toString();
}

export const statusText = (s: DeploymentStatusName) => `${STATUS_STYLE[s].glyph} ${STATUS_STYLE[s].word}`;
export const shortSha = (sha: string | null) => (sha ? sha.slice(0, 8) : null);
export const stamp = (iso: string | null) => (iso ? iso.slice(0, 19).replace('T', ' ') : '—');

export function durationText(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return '< 1 s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${s % 60 ? `${s % 60} s` : ''}`.trim() : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** "12 min before" / "3 min after": the distance of a deployment's start from an incident's opening, in words. */
export function relativeToIncident(startedAt: string, openedAt: string): string {
  const min = Math.round((Date.parse(openedAt) - Date.parse(startedAt)) / 60_000);
  if (min === 0) return 'at the same minute';
  return min > 0 ? `${min} min before` : `${-min} min after`;
}

/** A link is only ever offered when it is https with a host and no credentials (the API refuses everything else; this is the second check). */
export const safeHref = (url: string | null): string | null => (url ? normalizeHttpsUrl(url) : null);

export const hostOf = (href: string): string => { try { return new URL(href).host; } catch { return ''; } };

export const actorText = (d: Pick<DeploymentDto, 'actor'>) => (d.actor.type === 'token' ? `ingestion token “${d.actor.name}”` : d.actor.name);

/** Copy-ready CI examples. They contain a placeholder, never a real token, and no tenant or environment: the token decides those. */
export function deploySnippets(endpoint: string): { curl: string; github: string } {
  const curl = [
    `curl --fail-with-body -sS -X POST "${endpoint}" \\`,
    '  -H "Authorization: Bearer $NEXUS_DEPLOY_TOKEN" \\',
    '  -H "Content-Type: application/json" \\',
    '  -H "Idempotency-Key: build-1234-checkout" \\',
    `  -d '{"service":"checkout","version":"1.4.2","commitSha":"9fe8544","status":"succeeded","linkUrl":"https://ci.example.com/runs/1234","triggeredBy":"ci"}'`,
  ].join('\n');
  const github = [
    '- name: Record deployment in Nexus',
    '  if: always()',
    '  env:',
    '    NEXUS_DEPLOY_TOKEN: ${{ secrets.NEXUS_DEPLOY_TOKEN }}',
    "    DEPLOY_STATUS: ${{ job.status == 'success' && 'succeeded' || 'failed' }}",
    '  run: |',
    `    curl --fail-with-body -sS -X POST "${endpoint}" \\`,
    '      -H "Authorization: Bearer $NEXUS_DEPLOY_TOKEN" \\',
    '      -H "Content-Type: application/json" \\',
    '      -H "Idempotency-Key: gh-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-checkout" \\',
    '      --data @- <<EOF',
    '    {"service":"checkout","version":"${GITHUB_REF_NAME}","commitSha":"${GITHUB_SHA}","status":"${DEPLOY_STATUS}",',
    '     "triggeredBy":"${GITHUB_ACTOR}","linkUrl":"${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"}',
    '    EOF',
  ].join('\n');
  return { curl, github };
}

/** What a role may do on this page (the server enforces the same rules): reading is open to every project role. */
export const canRecord = (role: string | undefined) => role === 'project_admin' || role === 'engineer';
export const canMintTokens = (role: string | undefined) => role === 'project_admin';
