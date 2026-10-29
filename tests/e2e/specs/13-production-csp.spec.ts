import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO, env, expect, test } from '../support/fixtures.js';
import { freePort } from '../support/stack.js';

// Serves the PRODUCTION web bundle (apps/web/dist) with the exact Content-Security-Policy that infra/nginx/nginx.conf sends,
// and drives it in a real browser, so a policy that would break the app is caught without needing nginx or Docker.
// (nginx itself is not run here; /api is proxied to the dev API with the Origin header rewritten to its configured web origin.)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DIST = path.join(ROOT, 'apps/web/dist');
const CSP = /add_header Content-Security-Policy "([^"]+)"/.exec(readFileSync(path.join(ROOT, 'infra/nginx/nginx.conf'), 'utf8'))?.[1];
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

test.describe('production web bundle under the production Content-Security-Policy', () => {
  test.skip(!existsSync(path.join(DIST, 'index.html')), 'apps/web/dist is missing: run `pnpm --filter @nexus/web build` first');

  test('the app loads, signs in and navigates with no CSP violations or console errors', async ({ page }) => {
    expect(CSP, 'CSP must be defined in infra/nginx/nginx.conf').toBeTruthy();
    const port = await freePort();
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const headers = { 'content-security-policy': CSP!, 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' };
      if (url.pathname.startsWith('/api/')) {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const up = http.request(`${env().api}${req.url}`, { method: req.method, headers: { ...req.headers, host: new URL(env().api).host, origin: env().web } }, (r) => {
            res.writeHead(r.statusCode ?? 502, { ...r.headers, ...headers });
            r.pipe(res);
          });
          up.on('error', () => { res.writeHead(502).end(); });
          up.end(Buffer.concat(chunks));
        });
        return;
      }
      const file = path.join(DIST, path.normalize(url.pathname).replace(/^([/\\])+/, ''));
      const target = file.startsWith(DIST) && existsSync(file) && !file.endsWith(path.sep) && url.pathname !== '/' ? file : path.join(DIST, 'index.html');
      res.writeHead(200, { 'content-type': TYPES[path.extname(target)] ?? 'application/octet-stream', ...headers });
      res.end(readFileSync(target));
    });
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
    const violations: string[] = [];
    const errors: string[] = [];
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => { (window as unknown as { __csp: string[] }).__csp = [...((window as unknown as { __csp?: string[] }).__csp ?? []), `${e.violatedDirective} ${e.blockedURI}`]; });
    });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/401|Unauthorized/.test(m.text())) errors.push(m.text()); });
    try {
      const base = `http://127.0.0.1:${port}`;
      await page.goto(base);
      await page.evaluate(() => localStorage.setItem('nx-theme', 'dark'));
      await page.reload();
      expect(await page.evaluate(() => document.documentElement.classList.contains('dark')), 'theme script must run under script-src self').toBe(true);
      await page.getByLabel('Email').fill(DEMO.owner);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
      for (const [link, heading] of [['Projects', 'Projects'], ['Logs', /^Logs/], ['Data Sources', /Data Sources/], ['Audit Logs', 'Audit Logs'], ['Settings', 'Settings']] as const) {
        await page.getByRole('link', { name: link, exact: true }).click();
        await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible();
      }
      violations.push(...(await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])));
      expect(violations, `CSP violations: ${violations.join(' | ')}`).toEqual([]);
      expect(errors, errors.join(' | ')).toEqual([]);
    } finally { server.close(); }
  });
});
