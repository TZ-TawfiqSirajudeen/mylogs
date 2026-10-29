import { startMockIdp, type MockIdp, type MockUser } from '@nexus/mock-idp';
import { harness, type Harness } from './helpers.js';

export const CLIENT_ID = 'nexus-test';
export const CLIENT_SECRET = 'idp-client-secret-DO-NOT-LOG';
export const WEB = 'http://localhost:5173';
export const SECURE_WEB = 'https://nexus.test';

export interface OidcHarness extends Harness {
  idp: MockIdp;
  /** Runs a complete browser-equivalent sign-in: /login -> IdP authorize -> callback. */
  signIn(email: string, opts?: SignInOpts): Promise<SignInResult>;
  /** Signs in and returns a ready-to-use API client (cookie + CSRF). */
  session(email: string, opts?: SignInOpts): Promise<SessionClient>;
}
export interface SignInOpts {
  /** Overrides the login_hint sent to the mock IdP (an e-mail or a subject), to pick a specific identity. */
  loginHint?: string;
  returnTo?: string;
  /** Cookies the browser already had (e.g. a stale/planted session cookie). */
  cookies?: string;
  /** Mutates the callback URL (path+query) before it is delivered. */
  mutateCallback?: (pathAndQuery: string) => string;
  /** Skips sending the flow cookie (a different browser / blocked cookies). */
  dropFlowCookie?: boolean;
}
export interface SignInResult {
  status: number;
  /** Where the browser is sent after the callback. */
  location: string;
  setCookies: string[];
  cookieHeader: string;
  flowCookie: string | null;
  sessionCookie: string | null;
  loginLocation: string;
  callbackUrl: string;
  /** auth_error code, when the sign-in failed. */
  authError: string | null;
}
export interface SessionClient {
  cookie: string;
  csrf: string;
  userId: string;
  req(method: string, url: string, body?: unknown): Promise<{ status: number; json: any; headers: Record<string, unknown> }>;
}

const cookiePair = (setCookie: string) => setCookie.split(';')[0]!;
const asArray = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : []);

export async function oidcHarness(
  mongoUri: string,
  opts: { users?: MockUser[]; env?: Record<string, string>; secure?: boolean; logStream?: { write(msg: string): void }; idp?: MockIdp } = {},
): Promise<OidcHarness> {
  const web = opts.secure ? SECURE_WEB : WEB;
  const idp = opts.idp ?? await startMockIdp({
    users: opts.users ?? [],
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUris: [`${WEB}/api/v1/auth/oidc/callback`, `${SECURE_WEB}/api/v1/auth/oidc/callback`],
    postLogoutRedirectUris: [`${WEB}/`, `${SECURE_WEB}/`],
  });
  const h = await harness(mongoUri, {
    AUTH_MODE: 'oidc', WEB_ORIGIN: web, OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: CLIENT_ID, OIDC_CLIENT_SECRET: CLIENT_SECRET,
    OIDC_ALLOW_INSECURE_ISSUER: 'true', OIDC_PROVIDER_NAME: 'Mock IdP',
    ...(opts.secure ? { COOKIE_SECURE: 'true' } : {}),
    ...(opts.logStream ? { LOG_LEVEL: 'debug' } : {}),
    ...opts.env,
  }, opts.logStream ? { logStream: opts.logStream } : {});

  const signIn = async (email: string, o: SignInOpts = {}): Promise<SignInResult> => {
    const q = o.returnTo !== undefined ? `?returnTo=${encodeURIComponent(o.returnTo)}` : '';
    const login = await h.app.inject({ method: 'GET', url: `/api/v1/auth/oidc/login${q}`, headers: o.cookies ? { cookie: o.cookies } : {} });
    const loginLocation = String(login.headers.location ?? '');
    const flowSet = asArray(login.headers['set-cookie']).find((c) => /nx_flow=/.test(c)) ?? null;
    // The "browser" follows the redirect to the IdP, which (with login_hint) approves immediately.
    const authz = new URL(loginLocation);
    if (authz.origin === idp.url) authz.searchParams.set('login_hint', o.loginHint ?? email);
    const approved = await fetch(authz, { redirect: 'manual' });
    const callbackUrl = approved.headers.get('location') ?? '';
    const cb = new URL(callbackUrl, web);
    let pathAndQuery = `${cb.pathname}${cb.search}`;
    if (o.mutateCallback) pathAndQuery = o.mutateCallback(pathAndQuery);
    const cookies = [o.cookies, flowSet && !o.dropFlowCookie ? cookiePair(flowSet) : null].filter(Boolean).join('; ');
    const res = await h.app.inject({ method: 'GET', url: pathAndQuery, headers: cookies ? { cookie: cookies } : {} });
    const setCookies = asArray(res.headers['set-cookie']);
    const location = String(res.headers.location ?? '');
    const sessionSet = setCookies.find((c) => /nx_sid=[^;]+/.test(c) && !/nx_sid=;/.test(c)) ?? null;
    let authError: string | null = null;
    try { authError = new URL(location).searchParams.get('auth_error'); } catch { /* not a URL */ }
    return {
      status: res.statusCode, location, setCookies, cookieHeader: cookies, flowCookie: flowSet, sessionCookie: sessionSet ? cookiePair(sessionSet) : null,
      loginLocation, callbackUrl, authError,
    };
  };

  const session = async (email: string, o: SignInOpts = {}): Promise<SessionClient> => {
    const r = await signIn(email, o);
    if (!r.sessionCookie) throw new Error(`sign-in failed for ${email}: ${r.authError ?? r.status}`);
    const cookie = r.sessionCookie;
    const me = await h.app.inject({ method: 'GET', url: '/api/v1/auth/session', headers: { cookie } });
    const body = me.json();
    const client: SessionClient = {
      cookie, csrf: body.csrfToken, userId: body.user.id,
      async req(method, url, payload) {
        const unsafe = !['GET', 'HEAD'].includes(method);
        const res = await h.app.inject({
          method: method as 'GET', url, payload: payload as object | undefined,
          headers: { cookie, ...(unsafe ? { 'x-csrf-token': client.csrf, origin: h.cfg.webOrigin } : {}) },
        });
        let json: unknown = null;
        try { json = res.body ? JSON.parse(res.body) : null; } catch { json = res.body; }
        return { status: res.statusCode, json, headers: res.headers };
      },
    };
    return client;
  };

  return { ...h, idp, signIn, session };
}
