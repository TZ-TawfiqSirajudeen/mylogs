import { parseNetworkPolicy, type NetworkPolicy } from '@nexus/security';
import { z } from 'zod';
import { parseOidcConfig, type OidcConfig } from './auth/oidc-config.js';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default('127.0.0.1'),
  MONGODB_URI: z.string().min(1),
  MONGODB_DB: z.string().default('nexus'),
  /** `dev` = passwordless local login for seeded demo users. Refused in production. */
  AUTH_MODE: z.enum(['dev', 'oidc']).default('dev'),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  SESSION_ABSOLUTE_TTL_MINUTES: z.coerce.number().int().positive().default(8 * 60),
  SESSION_IDLE_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  COOKIE_SECURE: bool.optional(),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  /** Envelope-encryption keys: "id:base64(32 bytes),id2:..."; the platform injects them (never commit/bake them). */
  SECRETS_KEYS: z.string().optional(),
  SECRETS_CURRENT_KEY_ID: z.string().optional(),
  SECRETS_DEV_KEY_FILE: z.string().default('.dev-secrets/kek.json'),
  /** Outbound network policy for connectors (SSRF protection). */
  NETWORK_ALLOW_LOOPBACK: bool.optional(),
  NETWORK_ALLOW_PRIVATE_CIDRS: z.string().default(''),
  NETWORK_ALLOW_INSECURE_HTTP: bool.optional(),
  /** Where senders reach the ingestion service (shown in the UI setup instructions). */
  INGEST_PUBLIC_URL: z.string().url().default('http://localhost:4318'),
  CONNECTION_TEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  // --- OpenID Connect (AUTH_MODE=oidc). The client secret comes from the environment / a mounted secret file, never from code or the repo.
  OIDC_ISSUER: z.string().optional(), OIDC_CLIENT_ID: z.string().optional(), OIDC_CLIENT_SECRET: z.string().optional(), OIDC_CLIENT_SECRET_FILE: z.string().optional(),
  OIDC_REDIRECT_URI: z.string().optional(), OIDC_POST_LOGOUT_REDIRECT_URI: z.string().optional(), OIDC_SCOPES: z.string().optional(), OIDC_PROVIDER_NAME: z.string().optional(),
  OIDC_PROVISIONING: z.string().optional(), OIDC_DEFAULT_ORG_SLUG: z.string().optional(), OIDC_ALLOWED_EMAIL_DOMAINS: z.string().optional(),
  OIDC_REQUIRE_EMAIL_VERIFIED: z.string().optional(), OIDC_GROUPS_CLAIM: z.string().optional(), OIDC_GROUP_ROLE_MAP: z.string().optional(),
  OIDC_ALLOW_INSECURE_ISSUER: z.string().optional(), OIDC_CLOCK_TOLERANCE_SECONDS: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export interface Config {
  env: 'development' | 'test' | 'production';
  port: number;
  host: string;
  mongoUri: string;
  mongoDb: string;
  authMode: 'dev' | 'oidc';
  webOrigin: string;
  /** Origins accepted on state-changing requests (normalized). Dev also accepts the localhost/127.0.0.1 alias. */
  allowedOrigins: string[];
  sessionAbsoluteTtlMs: number;
  sessionIdleTtlMs: number;
  cookieSecure: boolean;
  rateLimitMax: number;
  authRateLimitMax: number;
  logLevel: string;
  secretsKeys: string | undefined;
  secretsCurrentKeyId: string | undefined;
  secretsDevKeyFile: string;
  network: NetworkPolicy;
  connectionTestTimeoutMs: number;
  ingestPublicUrl: string;
  /** Present only when AUTH_MODE=oidc. */
  oidc: OidcConfig | null;
}

export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  const parsed = Env.safeParse(source);
  if (!parsed.success) {
    // Report variable names only, never values (they may be secrets such as MONGODB_URI).
    const names = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(', ');
    throw new Error(`Invalid configuration: ${names}`);
  }
  const e = parsed.data;
  const prod = e.NODE_ENV === 'production';
  const cookieSecure = e.COOKIE_SECURE ?? prod;
  // Normalize: a trailing slash or upper-case host in WEB_ORIGIN must not silently break every POST.
  const webUrl = new URL(e.WEB_ORIGIN);
  if (webUrl.pathname !== '/' || webUrl.search || webUrl.hash) throw new Error('Invalid configuration: WEB_ORIGIN must be an origin without a path');
  const webOrigin = webUrl.origin;
  const allowedOrigins = [webOrigin];
  if (!prod) {
    for (const [a, b] of [['localhost', '127.0.0.1'], ['127.0.0.1', 'localhost']] as const) {
      if (webUrl.hostname === a) allowedOrigins.push(`${webUrl.protocol}//${b}${webUrl.port ? `:${webUrl.port}` : ''}`);
    }
  }

  const network = parseNetworkPolicy(
    { NETWORK_ALLOW_LOOPBACK: e.NETWORK_ALLOW_LOOPBACK === undefined ? undefined : String(e.NETWORK_ALLOW_LOOPBACK), NETWORK_ALLOW_PRIVATE_CIDRS: e.NETWORK_ALLOW_PRIVATE_CIDRS, NETWORK_ALLOW_INSECURE_HTTP: e.NETWORK_ALLOW_INSECURE_HTTP === undefined ? undefined : String(e.NETWORK_ALLOW_INSECURE_HTTP) },
    prod,
  );

  // Refuse insecure production configurations instead of silently enabling them.
  if (prod) {
    const problems: string[] = [];
    if (e.AUTH_MODE === 'dev') problems.push('AUTH_MODE=dev is not allowed in production');
    if (!cookieSecure) problems.push('COOKIE_SECURE must be true in production');
    if (!webOrigin.startsWith('https://')) problems.push('WEB_ORIGIN must be https:// in production');
    if (!e.SECRETS_KEYS) problems.push('SECRETS_KEYS (key-encryption keys) must be provided in production');
    if (problems.length) throw new Error(`Refusing insecure production configuration: ${problems.join('; ')}`);
  }

  return {
    env: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    mongoUri: e.MONGODB_URI,
    mongoDb: e.MONGODB_DB,
    authMode: e.AUTH_MODE,
    webOrigin,
    allowedOrigins,
    sessionAbsoluteTtlMs: e.SESSION_ABSOLUTE_TTL_MINUTES * 60_000,
    sessionIdleTtlMs: e.SESSION_IDLE_TTL_MINUTES * 60_000,
    cookieSecure,
    rateLimitMax: e.RATE_LIMIT_MAX,
    authRateLimitMax: e.AUTH_RATE_LIMIT_MAX,
    logLevel: e.LOG_LEVEL,
    secretsKeys: e.SECRETS_KEYS,
    secretsCurrentKeyId: e.SECRETS_CURRENT_KEY_ID,
    secretsDevKeyFile: e.SECRETS_DEV_KEY_FILE,
    network,
    connectionTestTimeoutMs: e.CONNECTION_TEST_TIMEOUT_MS,
    ingestPublicUrl: new URL(e.INGEST_PUBLIC_URL).origin,
    oidc: e.AUTH_MODE === 'oidc' ? parseOidcConfig(e, { webOrigin, production: prod }) : null,
  };
}
