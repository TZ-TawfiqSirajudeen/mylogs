// Production smoke test WITHOUT Docker: runs the BUILT bundles (apps/*/dist) with NODE_ENV=production, the way the container
// images run them, and checks the production guard-rails. Usage (after `pnpm build`):
//
//     node infra/scripts/prod-smoke.mjs                       # starts a throw-away MongoDB replica set itself
//     SMOKE_MONGODB_URI=mongodb://... node infra/scripts/prod-smoke.mjs
//     SMOKE_DEPLOY_DIR=/path node infra/scripts/prod-smoke.mjs    # run from `pnpm deploy --prod` trees (<dir>/api|worker|ingest, each with dist/)
//                                                                  exactly as the Docker images lay them out
//
// What it proves:  the bundles start from dist/ alone; production refuses dev auth / missing KEK / http origin / http issuer;
// health + readiness; OIDC mode is advertised and dev login does not exist; every protected route needs a session; the API
// documentation UI is not exposed; security headers are present; the ingestion service rejects unauthenticated telemetry.
// What it does NOT prove: container packaging (no Docker here), TLS, a real identity provider.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`); };
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const appDir = (name, repoPath) => (process.env.SMOKE_DEPLOY_DIR ? path.join(process.env.SMOKE_DEPLOY_DIR, name) : path.join(ROOT, repoPath));
const procs = [];
const spawnNode = (cwd, args, env) => {
  const out = [];
  const p = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  p.stdout.on('data', (b) => out.push(b.toString())); p.stderr.on('data', (b) => out.push(b.toString()));
  procs.push(p);
  return { p, out: () => out.join(''), exited: new Promise((r) => p.on('exit', (code) => r(code))) };
};
const waitFor = async (url, ms = 30_000) => {
  const t0 = Date.now();
  for (;;) { try { const r = await fetch(url); if (r.ok) return; } catch { /* not up */ } if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${url}`); await new Promise((r) => setTimeout(r, 250)); }
};

async function main() {
  let mongoUri = process.env.SMOKE_MONGODB_URI;
  if (!mongoUri) {
    const m = spawnNode(path.join(ROOT, 'tests/e2e'), ['support/mongo-server.mjs'], {});
    mongoUri = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('mongod did not start')), 240_000);
      m.p.stdout.on('data', (b) => { const x = /MONGO_URI=(\S+)/.exec(b.toString()); if (x) { clearTimeout(t); resolve(x[1]); } });
    });
  }
  const kek = `smoke-1:${randomBytes(32).toString('base64')}`;
  const apiDist = appDir('api', 'apps/api'), api = ['dist/server.js'];
  const base = { NODE_ENV: 'production', MONGODB_URI: mongoUri, MONGODB_DB: 'nexus_smoke', LOG_LEVEL: 'warn' };
  const oidc = { AUTH_MODE: 'oidc', OIDC_ISSUER: 'https://idp.smoke.invalid', OIDC_CLIENT_ID: 'smoke', OIDC_CLIENT_SECRET: 'smoke-secret-value' };
  const web = 'https://nexus.smoke.invalid';

  // ---- 1. production must REFUSE unsafe configurations (non-zero exit, clear message, no value echoed)
  const refusals = [
    ['dev auth', { AUTH_MODE: 'dev', WEB_ORIGIN: web, SECRETS_KEYS: kek }, /AUTH_MODE/],
    ['missing key-encryption key', { ...oidc, WEB_ORIGIN: web }, /SECRETS_KEYS/],
    ['http web origin', { ...oidc, WEB_ORIGIN: 'http://nexus.smoke.invalid', SECRETS_KEYS: kek }, /https/],
    ['http identity provider', { ...oidc, OIDC_ISSUER: 'http://idp.smoke.invalid', WEB_ORIGIN: web, SECRETS_KEYS: kek }, /OIDC_ISSUER/],
    ['insecure-issuer escape hatch', { ...oidc, OIDC_ALLOW_INSECURE_ISSUER: 'true', WEB_ORIGIN: web, SECRETS_KEYS: kek }, /OIDC_ALLOW_INSECURE_ISSUER/],
    ['open JIT registration', { ...oidc, OIDC_PROVISIONING: 'jit', WEB_ORIGIN: web, SECRETS_KEYS: kek }, /OIDC_DEFAULT_ORG_SLUG/],
  ];
  for (const [name, env, re] of refusals) {
    const r = spawnNode(apiDist, api, { ...base, PORT: String(await freePort()), ...env });
    const code = await Promise.race([r.exited, new Promise((x) => setTimeout(() => x('still running'), 20_000))]);
    check(`production refuses: ${name}`, code !== 0 && code !== 'still running' && re.test(r.out()) && !r.out().includes('smoke-secret-value'), `exit=${code} out=${r.out().slice(0, 200)}`);
  }

  // ---- 2. a valid production configuration starts
  const [apiPort, ingestPort, workerPort] = [await freePort(), await freePort(), await freePort()];
  const good = { ...base, ...oidc, WEB_ORIGIN: web, SECRETS_KEYS: kek, HOST: '127.0.0.1', PORT: String(apiPort), INGEST_PUBLIC_URL: 'https://ingest.smoke.invalid' };
  const a = spawnNode(apiDist, api, good);
  const i = spawnNode(appDir('ingest', 'apps/ingest'), ['dist/server.js'], { ...base, SECRETS_KEYS: kek, INGEST_HOST: '127.0.0.1', INGEST_PORT: String(ingestPort) });
  const w = spawnNode(appDir('worker', 'apps/worker'), ['dist/main.js'], { ...base, SECRETS_KEYS: kek, WORKER_HEALTH_PORT: String(workerPort) });
  const A = `http://127.0.0.1:${apiPort}`, I = `http://127.0.0.1:${ingestPort}`, W = `http://127.0.0.1:${workerPort}`;
  try { await Promise.all([waitFor(`${A}/readyz`), waitFor(`${I}/readyz`), waitFor(`${W}/readyz`)]); check('api, ingest and worker bundles start in production and report ready', true); }
  catch (e) { check('api, ingest and worker bundles start in production and report ready', false, `${e.message}\n${a.out()}\n${i.out()}\n${w.out()}`); throw e; }

  // ---- 3. behaviour of the production API
  const cfg = await (await fetch(`${A}/api/v1/auth/config`)).json();
  check('auth config advertises OIDC and no secret', cfg.mode === 'oidc' && !JSON.stringify(cfg).includes('smoke-secret-value'), JSON.stringify(cfg));
  const dev = await fetch(`${A}/api/v1/auth/dev-login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: web }, body: '{"email":"owner@acme.test"}' });
  check('dev login does not exist', dev.status === 404, String(dev.status));
  const prot = await Promise.all(['/api/v1/projects', '/api/v1/auth/session', '/api/v1/org/members', '/api/v1/audit'].map(async (p) => (await fetch(`${A}${p}`)).status));
  check('protected routes answer 401 without a session', prot.every((s) => s === 401), prot.join(','));
  check('API documentation UI is not exposed in production', (await fetch(`${A}/docs`)).status === 404);
  const h = (await fetch(`${A}/healthz`)).headers;
  check('security headers are set (nosniff, frame protection, CSP, no x-powered-by)',
    h.get('x-content-type-options') === 'nosniff' && !!h.get('content-security-policy') && !!(h.get('x-frame-options') || /frame-ancestors/.test(h.get('content-security-policy') ?? '')) && !h.get('x-powered-by'));
  const login = await fetch(`${A}/api/v1/auth/oidc/login`, { redirect: 'manual' });
  check('an unreachable identity provider yields a clean redirect (no stack trace, no 500)', login.status === 302 && (login.headers.get('location') ?? '').endsWith('/?auth_error=idp_unavailable'), `${login.status} ${login.headers.get('location')}`);

  // ---- 4. ingestion service in production
  const noAuth = await fetch(`${I}/v1/logs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"resourceLogs":[]}' });
  const badAuth = await fetch(`${I}/v1/logs`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer nxi_not_a_real_token' }, body: '{"resourceLogs":[]}' });
  check('ingestion rejects missing and unknown tokens', noAuth.status === 401 && badAuth.status === 401, `${noAuth.status}/${badAuth.status}`);
  const sessionCookieAsToken = await fetch(`${I}/v1/logs`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'nx_sid=x', authorization: 'Bearer x' }, body: '{}' });
  check('browser credentials do not authenticate telemetry senders', sessionCookieAsToken.status === 401);
}

main().catch((e) => { console.error(e); check('smoke run completed', false, String(e)); }).finally(() => {
  for (const p of procs) {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else p.kill('SIGTERM');
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  setTimeout(() => process.exit(failed ? 1 : 0), 500);
});
