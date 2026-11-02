import type { Database } from '@nexus/database';
import { freshTestDatabase } from '@nexus/database/testing';
import { generateKeyBase64 } from '@nexus/secrets';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { seedDemo } from '../src/seed.js';

export interface Harness {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: Database;
  cfg: Config;
  login(email: string, orgSlug?: string): Promise<Client>;
}
export interface Client {
  cookie: string;
  csrf: string;
  userId: string;
  req(method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; json: any; headers: Record<string, unknown> }>;
}

export async function harness(mongoUri: string, env: Record<string, string> = {}, deps: Parameters<typeof buildApp>[2] = {}): Promise<Harness> {
  const cfg = loadConfig({
    NODE_ENV: 'test', MONGODB_URI: mongoUri, AUTH_MODE: 'dev', LOG_LEVEL: 'silent',
    RATE_LIMIT_MAX: '10000', AUTH_RATE_LIMIT_MAX: '10000',
    SECRETS_KEYS: `test-1:${generateKeyBase64()}`, NETWORK_ALLOW_LOOPBACK: 'true', NETWORK_ALLOW_INSECURE_HTTP: 'true',
    ...env,
  });
  const db = await freshTestDatabase(mongoUri);
  await seedDemo(db);
  const app = await buildApp(cfg, db, deps);
  await app.ready();

  const login = async (email: string, orgSlug?: string): Promise<Client> => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/dev-login', headers: { origin: cfg.webOrigin },
      payload: orgSlug ? { email, orgSlug } : { email },
    });
    if (res.statusCode !== 200) throw new Error(`login failed ${res.statusCode} ${res.body}`);
    const setCookie = String(res.headers['set-cookie']);
    const cookie = setCookie.split(';')[0]!;
    const body = res.json();
    const client: Client = {
      cookie, csrf: body.csrfToken, userId: body.user.id,
      async req(method, url, payload, headers = {}) {
        const unsafe = !['GET', 'HEAD'].includes(method);
        const r = await app.inject({
          method: method as 'GET', url, payload: payload as object | undefined,
          headers: { cookie, ...(unsafe ? { 'x-csrf-token': client.csrf, origin: cfg.webOrigin } : {}), ...headers },
        });
        return { status: r.statusCode, json: r.body ? safeJson(r.body) : null, headers: r.headers };
      },
    };
    return client;
  };
  return { app, db, cfg, login };
}

const safeJson = (s: string) => { try { return JSON.parse(s); } catch { return s; } };

