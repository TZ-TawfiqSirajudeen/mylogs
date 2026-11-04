import { DeploymentWrite } from '@nexus/contracts';
import { describe, expect, test } from 'vitest';
import { actorText, canMintTokens, canRecord, deploySnippets, durationText, filtersFromParams, filtersToParams, hostOf, listQuery, relativeToIncident, safeHref, shortSha, statusText } from './model';

describe('filters <-> URL', () => {
  test('defaults are dropped from the URL and restored from it', () => {
    const f = filtersFromParams(new URLSearchParams(''));
    expect(f).toEqual({ service: '', status: '', env: '', range: '30d' });
    expect(filtersToParams(f, { p: 'proj' }).toString()).toBe('p=proj');
    const g = filtersFromParams(new URLSearchParams('svc=checkout&status=failed&range=7d&env=0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a'));
    expect(g).toEqual({ service: 'checkout', status: 'failed', env: '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a', range: '7d' });
    expect(filtersFromParams(filtersToParams(g, { p: 'x', id: 'dep-1' }))).toEqual(g);
    expect(filtersToParams(g, { p: 'x', id: 'dep-1' }).get('id')).toBe('dep-1');
  });
  test('hostile or invalid parameters fall back to defaults and are bounded', () => {
    const f = filtersFromParams(new URLSearchParams({ status: 'bogus', range: 'forever', env: '../../etc', svc: 'x'.repeat(500) }));
    expect(f.status).toBe('');
    expect(f.range).toBe('30d');
    expect(f.env).toBe('');
    expect(f.service).toHaveLength(128);
  });
  test('the API query carries exactly the chosen filters', () => {
    const now = Date.parse('2026-11-04T12:00:00Z');
    const q = new URLSearchParams(listQuery({ service: 'a b', status: 'failed', env: '', range: '24h' }, now, 'CUR'));
    expect(Object.fromEntries(q)).toEqual({ limit: '50', service: 'a b', status: 'failed', from: '2026-11-03T12:00:00.000Z', cursor: 'CUR' });
    expect(new URLSearchParams(listQuery({ service: '', status: '', env: '', range: 'all' }, now)).has('from')).toBe(false);
  });
});

describe('text', () => {
  test('status, sha, duration', () => {
    expect(statusText('rolled_back')).toBe('↺ rolled back');
    expect(shortSha('abcdef0123456789')).toBe('abcdef01');
    expect(shortSha(null)).toBeNull();
    expect([durationText(null), durationText(10), durationText(42_000), durationText(90_000), durationText(120_000), durationText(3_900_000)]).toEqual(['—', '< 1 s', '42 s', '1 min 30 s', '2 min', '1 h 5 min']);
  });
  test('distance from an incident, in words', () => {
    expect(relativeToIncident('2026-11-04T11:48:00Z', '2026-11-04T12:00:00Z')).toBe('12 min before');
    expect(relativeToIncident('2026-11-04T12:03:00Z', '2026-11-04T12:00:00Z')).toBe('3 min after');
    expect(relativeToIncident('2026-11-04T12:00:10Z', '2026-11-04T12:00:00Z')).toBe('at the same minute');
  });
  test('the actor of a token is named as a token', () => {
    expect(actorText({ actor: { type: 'token', name: 'ci-prod' } })).toBe('ingestion token “ci-prod”');
    expect(actorText({ actor: { type: 'user', name: 'Erin Engineer' } })).toBe('Erin Engineer');
  });
});

describe('links are only ever https (second line of defence behind the API)', () => {
  test.each(['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'http://ci.example.com', 'ftp://x', '//x.example', 'https://u:p@x.example', 'not a url', ''])('%s -> no link', (u) => {
    expect(safeHref(u || null)).toBeNull();
  });
  test('an https link is kept and its host is shown', () => {
    expect(safeHref('https://ci.example.com/runs/1')).toBe('https://ci.example.com/runs/1');
    expect(hostOf('https://ci.example.com/runs/1')).toBe('ci.example.com');
    expect(safeHref(null)).toBeNull();
  });
});

describe('copy-ready CI snippets', () => {
  const { curl, github } = deploySnippets('https://nexus.example.com/api/v1/deployments');
  test('they point at the endpoint, use a placeholder token and never mention a tenant or environment', () => {
    for (const s of [curl, github]) {
      expect(s).toContain('https://nexus.example.com/api/v1/deployments');
      expect(s).toContain('Authorization: Bearer $NEXUS_DEPLOY_TOKEN');
      expect(s).toContain('Idempotency-Key');
      expect(s).not.toMatch(/nxi_[A-Za-z0-9_-]{20,}/);
      expect(s).not.toMatch(/environmentId|projectId|orgId/);
    }
    expect(github).toContain('secrets.NEXUS_DEPLOY_TOKEN');
    expect(github).toContain('GITHUB_RUN_ATTEMPT'); // a re-run is a new deployment attempt, not a conflict with the failed one
  });
  test('the curl example body is valid for the API contract', () => {
    const body = /-d '(\{.*\})'/.exec(curl)![1]!;
    expect(DeploymentWrite.safeParse(JSON.parse(body)).success).toBe(true);
  });
  test('the GitHub body (with the shell variables filled in) is valid for the API contract', () => {
    const raw = github.split('--data @- <<EOF\n')[1]!.split('\n    EOF')[0]!.replace(/\n\s*/g, '');
    const filled = raw.replace(/\$\{GITHUB_REF_NAME\}/g, 'v1.4.2').replace(/\$\{GITHUB_SHA\}/g, '9fe8544a1b2c3d4e').replace(/\$\{DEPLOY_STATUS\}/g, 'succeeded')
      .replace(/\$\{GITHUB_ACTOR\}/g, 'octocat').replace(/\$\{GITHUB_SERVER_URL\}/g, 'https://github.com').replace(/\$\{GITHUB_REPOSITORY\}/g, 'acme/checkout').replace(/\$\{GITHUB_RUN_ID\}/g, '123');
    const parsed = DeploymentWrite.safeParse(JSON.parse(filled));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});

describe('roles', () => {
  test('anyone may read, engineers and project admins may record, only admins mint tokens', () => {
    expect([canRecord('viewer'), canRecord('engineer'), canRecord('project_admin'), canRecord(undefined)]).toEqual([false, true, true, false]);
    expect([canMintTokens('engineer'), canMintTokens('project_admin')]).toEqual([false, true]);
  });
});
