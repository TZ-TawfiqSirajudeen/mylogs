import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../../..');

export interface Stack {
  ingestUrl: string;
  dbUrl: string;
  /** A second API + web pair running with AUTH_MODE=oidc against the same database, and the mock identity provider. */
  oidc: { webUrl: string; apiUrl: string; idpUrl: string; clientSecret: string };
  webUrl: string; apiUrl: string; workerUrl: string; mongoUri: string; dbName: string; targetUrl: string;
  /** Secret the target accepts as a bearer token. */
  targetToken: string;
  stop(): Promise<void>;
}

export const freePort = (): Promise<number> =>
  new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });

async function waitFor(url: string, what: string, ms = 90_000) {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    if (Date.now() - t0 > ms) throw new Error(`${what} did not become ready at ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

function spawnNode(name: string, cwd: string, args: string[], env: Record<string, string>, logs: string[]): ChildProcess {
  const p = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const keep = (b: Buffer) => { logs.push(`[${name}] ${b.toString().trimEnd()}`); if (logs.length > 400) logs.shift(); };
  p.stdout?.on('data', keep);
  p.stderr?.on('data', keep);
  return p;
}

/** A tiny "customer application" whose health endpoint the tests can break and fix. */
function startTarget(token: string, port: number) {
  const state = { mode: 'ok' as 'ok' | '503' | 'reject', hits: 0, lastAuth: '' as string | undefined };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/__mode') { state.mode = (url.searchParams.get('m') as typeof state.mode) ?? 'ok'; res.end('ok'); return; }
    state.hits++;
    state.lastAuth = req.headers.authorization;
    if (state.mode === '503') { res.writeHead(503); res.end(); return; }
    if (state.mode === 'reject' || (url.pathname === '/healthz' && req.headers.authorization !== `Bearer ${token}`)) { res.writeHead(401); res.end(); return; }
    res.writeHead(200); res.end('ok');
  });
  return new Promise<{ close(): Promise<void>; state: typeof state }>((resolve) =>
    server.listen(port, '127.0.0.1', () => resolve({ state, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) })));
}

export async function startStack(): Promise<Stack & { logs: string[] }> {
  const logs: string[] = [];
  const procs: ChildProcess[] = [];
  const mongoProc = spawnNode('mongo', path.join(ROOT, 'tests/e2e'), ['support/mongo-server.mjs'], {}, logs);
  procs.push(mongoProc);
  const mongoUri = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('mongod did not start in time')), 240_000);
    mongoProc.stdout?.on('data', (b: Buffer) => { const m = /MONGO_URI=(\S+)/.exec(b.toString()); if (m) { clearTimeout(t); resolve(m[1]!); } });
    mongoProc.on('exit', (c) => reject(new Error(`mongo helper exited early (${c}): ${logs.join(' | ')}`)));
  });
  const dbName = 'nexus_e2e';
  const [apiPort, webPort, workerPort, targetPort, dbPort, ingestPort, idpPort, oidcApiPort, oidcWebPort] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort(), freePort(), freePort(), freePort(), freePort()]);
  const dbProc = spawnNode('db', path.join(ROOT, 'tests/e2e'), ['support/db-server.mjs'], { E2E_MONGO_URI: mongoUri, E2E_DB: dbName, E2E_DB_PORT: String(dbPort) }, logs);
  procs.push(dbProc);
  const targetToken = 'e2e-target-token-0123456789';
  const target = await startTarget(targetToken, targetPort);
  const webUrl = `http://localhost:${webPort}`;
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const workerUrl = `http://127.0.0.1:${workerPort}`;

  const common = {
    NODE_ENV: 'development', MONGODB_URI: mongoUri, MONGODB_DB: dbName, LOG_LEVEL: 'warn',
    NETWORK_ALLOW_LOOPBACK: 'true', NETWORK_ALLOW_INSECURE_HTTP: 'true',
    SECRETS_DEV_KEY_FILE: path.join(ROOT, '.dev-secrets', 'e2e-kek.json'),
  };
  procs.push(spawnNode('api', path.join(ROOT, 'apps/api'), ['--import', 'tsx', 'src/server.ts', '--seed'],
    { ...common, PORT: String(apiPort), HOST: '127.0.0.1', WEB_ORIGIN: webUrl, INGEST_PUBLIC_URL: `http://127.0.0.1:${ingestPort}`, AUTH_RATE_LIMIT_MAX: '1000', RATE_LIMIT_MAX: '100000' }, logs));
  await waitFor(`${apiUrl}/readyz`, 'API');
  procs.push(spawnNode('ingest', path.join(ROOT, 'apps/ingest'), ['--import', 'tsx', 'src/server.ts'],
    { ...common, INGEST_PORT: String(ingestPort), INGEST_HOST: '127.0.0.1', INGEST_TOKEN_RECORDS_PER_MINUTE: '600000', INGEST_PROJECT_RECORDS_PER_MINUTE: '1000000' }, logs));
  procs.push(spawnNode('worker', path.join(ROOT, 'apps/worker'), ['--import', 'tsx', 'src/main.ts'],
    { ...common, WORKER_HEALTH_PORT: String(workerPort), WORKER_TICK_MS: '500' }, logs));
  const viteBin = path.join(ROOT, 'apps/web/node_modules/vite/bin/vite.js');
  procs.push(spawnNode('web', path.join(ROOT, 'apps/web'), [viteBin, '--host', '127.0.0.1', '--strictPort'],
    { API_URL: apiUrl, WEB_PORT: String(webPort) }, logs));
  await Promise.all([waitFor(`${workerUrl}/readyz`, 'worker'), waitFor(`http://127.0.0.1:${webPort}/`, 'web'), waitFor(`http://127.0.0.1:${ingestPort}/readyz`, 'ingest')]);

  // ---- OIDC variant: mock IdP + a second API (AUTH_MODE=oidc) + a second web server, sharing the database seeded above.
  const oidcWebUrl = `http://localhost:${oidcWebPort}`;
  const oidcApiUrl = `http://127.0.0.1:${oidcApiPort}`;
  const idpUrl = `http://127.0.0.1:${idpPort}`;
  const clientSecret = 'e2e-idp-client-secret-0123456789';
  procs.push(spawnNode('idp', path.join(ROOT, 'packages/mock-idp'), ['--import', 'tsx', 'src/cli.ts'], {
    MOCK_IDP_PORT: String(idpPort), WEB_ORIGIN: oidcWebUrl, OIDC_CLIENT_ID: 'nexus-e2e', OIDC_CLIENT_SECRET: clientSecret,
    MOCK_IDP_USERS: JSON.stringify([
      { sub: 'e2e-owner', email: 'owner@acme.test', emailVerified: true, name: 'Olivia Owner' },
      { sub: 'e2e-engineer', email: 'engineer@acme.test', emailVerified: true, name: 'Erin Engineer' },
      { sub: 'e2e-viewer', email: 'viewer@acme.test', emailVerified: true, name: 'Victor Viewer' },
      { sub: 'e2e-auditor', email: 'auditor@acme.test', emailVerified: true, name: 'Aria Auditor' },
      { sub: 'e2e-globex', email: 'owner@globex.test', emailVerified: true, name: 'Gina Globex' },
      { sub: 'e2e-stranger', email: 'stranger@elsewhere.test', emailVerified: true, name: 'Sam Stranger' },
    ]),
  }, logs));
  await waitFor(`${idpUrl}/.well-known/openid-configuration`, 'mock IdP');
  procs.push(spawnNode('api-oidc', path.join(ROOT, 'apps/api'), ['--import', 'tsx', 'src/server.ts'], {
    ...common, PORT: String(oidcApiPort), HOST: '127.0.0.1', WEB_ORIGIN: oidcWebUrl, INGEST_PUBLIC_URL: `http://127.0.0.1:${ingestPort}`,
    AUTH_RATE_LIMIT_MAX: '1000', RATE_LIMIT_MAX: '100000',
    AUTH_MODE: 'oidc', OIDC_ISSUER: idpUrl, OIDC_CLIENT_ID: 'nexus-e2e', OIDC_CLIENT_SECRET: clientSecret, OIDC_ALLOW_INSECURE_ISSUER: 'true', OIDC_PROVIDER_NAME: 'Mock IdP',
  }, logs));
  procs.push(spawnNode('web-oidc', path.join(ROOT, 'apps/web'), [viteBin, '--host', '127.0.0.1', '--strictPort'], { API_URL: oidcApiUrl, WEB_PORT: String(oidcWebPort) }, logs));
  await Promise.all([waitFor(`${oidcApiUrl}/readyz`, 'OIDC API'), waitFor(`http://127.0.0.1:${oidcWebPort}/`, 'OIDC web')]);

  (globalThis as { __e2eTarget?: typeof target }).__e2eTarget = target;
  return {
    ingestUrl: `http://127.0.0.1:${ingestPort}`, dbUrl: `http://127.0.0.1:${dbPort}`, webUrl, apiUrl, workerUrl, mongoUri, dbName, targetToken, logs,
    targetUrl: `http://127.0.0.1:${targetPort}`,
    oidc: { webUrl: oidcWebUrl, apiUrl: oidcApiUrl, idpUrl, clientSecret },
    async stop() {
      for (const p of procs) { if (p.pid) { try { spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { p.kill(); } } }
      await target.close();
    },
  };
}
