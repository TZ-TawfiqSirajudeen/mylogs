// Scripted, secret-safe pre-checks for single sign-on against a REAL identity provider (staging). Node >= 22, no dependencies.
//
//     OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0 \
//     OIDC_CLIENT_ID=<client id> \
//     OIDC_AUTH_METHOD=client_secret_basic \          # optional expectation (client_secret_basic | client_secret_post); Nexus picks Basic unless only Post is advertised
//     WEB_ORIGIN=https://nexus-staging.example.com \  # used for the redirect-URI hints
//     OIDC_CLIENT_SECRET=<secret> \                   # optional: enables the client-authentication probe
//       node infra/scripts/oidc-staging-verify.mjs
//
// It automates steps 1-2 of docs/runbooks/oidc-staging-verification.md (what can be checked without a human):
//   * issuer shape (https, no {tenantid} / /common template, no query)         * discovery document fetch + issuer equality, character for character
//   * required endpoints over https                                            * signing algorithms (asymmetric only)
//   * response_types / PKCE S256 / token-endpoint authentication method support
//   * JWKS fetch (valid keys, no private material)                             * client-authentication probe at the token endpoint (optional)
//   * redirect-URI and post-logout-URI values to register at the provider (hints: registration itself cannot be read back)
// It does NOT do the interactive browser sign-in (runbook steps 4-11): those stay MANUAL and are listed at the end.
//
// Output: PASS / FAIL / WARN / INFO / MANUAL lines. Exit 1 when any FAIL. The client secret is never printed: every output line is
// passed through redaction, the probe sends a deliberately invalid authorization code (the provider answers invalid_grant when the
// client authenticated, invalid_client when it did not) and only the OAuth `error` code is shown, never the response body.
import { pathToFileURL } from 'node:url';

const ASYMMETRIC = /^(?:RS|PS|ES)(?:256|384|512)$|^EdDSA$/;
const SUPPORTED_METHODS = ['client_secret_basic', 'client_secret_post'];

export function redact(text, secrets) {
  let out = String(text);
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('<redacted>');
  return out;
}

const res = (status, name, detail = '') => ({ status, name, detail });

/** Pure: shape of the configured issuer. */
export function checkIssuer(issuer, { allowHttp = false } = {}) {
  const out = [];
  let u;
  try { u = new URL(issuer); } catch { return [res('FAIL', 'issuer is a valid URL', 'not a URL')]; }
  out.push(u.protocol === 'https:' || (allowHttp && u.protocol === 'http:') ? res('PASS', 'issuer uses https') : res('FAIL', 'issuer uses https', `scheme is ${u.protocol} (production refuses http issuers)`));
  out.push(u.search || u.hash ? res('FAIL', 'issuer has no query or fragment') : res('PASS', 'issuer has no query or fragment'));
  const template = /\{tenantid\}|\{tenant\}/i.test(decodeURIComponent(issuer)) || /\/(?:common|organizations|consumers)(?:\/|$)/.test(u.pathname);
  out.push(template ? res('FAIL', 'issuer is tenant-specific', 'multi-tenant endpoints (/common, /organizations, /consumers, {tenantid}) put a different issuer in every token; use the single-tenant issuer') : res('PASS', 'issuer is tenant-specific'));
  if (issuer.endsWith('/') && u.pathname !== '/') out.push(res('INFO', 'issuer has a trailing slash', 'it must then appear with the slash in OIDC_ISSUER and in the discovery document'));
  return out;
}

/** Pure: checks on a parsed discovery document. */
/** What the Nexus API will actually use (apps/api/src/auth/oidc.ts): HTTP Basic, unless the provider advertises client_secret_post and NOT basic. */
export function effectiveAuthMethod(doc) {
  const m = doc?.token_endpoint_auth_methods_supported;
  return Array.isArray(m) && m.includes('client_secret_post') && !m.includes('client_secret_basic') ? 'client_secret_post' : 'client_secret_basic';
}

export function checkDiscovery(doc, { issuer, authMethod, allowHttp = false }) {
  const out = [];
  const isHttps = (v) => { try { const u = new URL(v); return u.protocol === 'https:' || (allowHttp && u.protocol === 'http:'); } catch { return false; } };
  out.push(doc.issuer === issuer ? res('PASS', 'discovery issuer equals the configured issuer exactly') : res('FAIL', 'discovery issuer equals the configured issuer exactly', `document says ${JSON.stringify(doc.issuer)}, configured ${JSON.stringify(issuer)}: set OIDC_ISSUER to the document value (character for character)`));
  for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    out.push(typeof doc[k] === 'string' && isHttps(doc[k]) ? res('PASS', `${k} present and https`) : res('FAIL', `${k} present and https`, typeof doc[k] === 'string' ? 'not https' : 'missing'));
  }
  const algs = doc.id_token_signing_alg_values_supported;
  if (!Array.isArray(algs)) out.push(res('WARN', 'id_token signing algorithms advertised', 'missing; the spec requires it, RS256 is assumed'));
  else out.push(algs.some((a) => ASYMMETRIC.test(a)) ? res('PASS', 'asymmetric id_token signing algorithm advertised', algs.join(',')) : res('FAIL', 'asymmetric id_token signing algorithm advertised', `only ${algs.join(',') || 'none'}`));
  const rts = doc.response_types_supported;
  out.push(!Array.isArray(rts) || rts.includes('code') ? res('PASS', 'authorization code flow supported') : res('FAIL', 'authorization code flow supported', `response_types_supported: ${rts.join(',')}`));
  const pkce = doc.code_challenge_methods_supported;
  out.push(Array.isArray(pkce) ? (pkce.includes('S256') ? res('PASS', 'PKCE S256 advertised') : res('FAIL', 'PKCE S256 advertised', `methods: ${pkce.join(',')}`)) : res('WARN', 'PKCE S256 advertised', 'code_challenge_methods_supported is absent; Nexus always sends S256, confirm the provider enforces/accepts it'));
  const methods = Array.isArray(doc.token_endpoint_auth_methods_supported) ? doc.token_endpoint_auth_methods_supported : ['client_secret_basic']; // RFC 8414 default
  const usable = methods.filter((m) => SUPPORTED_METHODS.includes(m));
  if (!usable.length) out.push(res('FAIL', 'token endpoint supports a client-secret method Nexus can use', `provider offers ${methods.join(',')}; Nexus supports ${SUPPORTED_METHODS.join(' / ')} (private_key_jwt-only is unsupported)`));
  else out.push(res('PASS', 'token endpoint supports a client-secret method Nexus can use', usable.join(',')));
  const eff = effectiveAuthMethod(doc);
  out.push(res('INFO', 'client authentication method Nexus will use', eff));
  if (authMethod) out.push(methods.includes(authMethod) ? res('PASS', `expected auth method ${authMethod} is supported by the provider`) : res('FAIL', `expected auth method ${authMethod} is supported by the provider`, `provider offers ${methods.join(',')}`));
  if (authMethod && authMethod !== eff) out.push(res('WARN', 'expected auth method differs from what Nexus will use', `Nexus uses ${eff}: the provider ${eff === 'client_secret_basic' ? 'also offers basic' : 'offers only post'}`));
  out.push(doc.authorization_response_iss_parameter_supported === true ? res('PASS', 'RFC 9207 iss response parameter advertised') : res('INFO', 'RFC 9207 iss response parameter', 'not advertised (Nexus validates iss when the provider sends it)'));
  out.push(typeof doc.end_session_endpoint === 'string' ? res('PASS', 'end_session_endpoint advertised (single logout at the provider possible)') : res('WARN', 'end_session_endpoint advertised', 'absent: signing out of Nexus will not end the provider session (runbook step 9)'));
  return out;
}

/** Pure: checks on a parsed JWKS. Never reports key values. */
export function checkJwks(jwks, doc = {}) {
  const keys = Array.isArray(jwks?.keys) ? jwks.keys : null;
  if (!keys) return [res('FAIL', 'JWKS is a JSON Web Key Set', 'no "keys" array')];
  const out = [];
  const sig = keys.filter((k) => (k.use === undefined || k.use === 'sig') && (k.kty === 'RSA' || k.kty === 'EC' || k.kty === 'OKP'));
  out.push(sig.length ? res('PASS', 'JWKS has signing keys', `${sig.length} of ${keys.length}`) : res('FAIL', 'JWKS has signing keys', 'no RSA/EC/OKP signature key'));
  const priv = keys.filter((k) => ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k'].some((f) => f in k));
  out.push(priv.length ? res('FAIL', 'JWKS exposes no private key material', `${priv.length} key(s) carry private members: report to the provider immediately`) : res('PASS', 'JWKS exposes no private key material'));
  const kids = sig.map((k) => k.kid).filter(Boolean);
  out.push(kids.length === sig.length && new Set(kids).size === kids.length ? res('PASS', 'signing keys have unique kid values') : res('WARN', 'signing keys have unique kid values', 'missing or duplicate kid: key selection by kid may be ambiguous'));
  const algs = Array.isArray(doc.id_token_signing_alg_values_supported) ? doc.id_token_signing_alg_values_supported : [];
  if (algs.includes('RS256') && !sig.some((k) => k.kty === 'RSA')) out.push(res('WARN', 'RS256 advertised but no RSA key published'));
  return out;
}

async function getJson(url, fetchImpl, timeoutMs) {
  const r = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  if (text.length > 2_000_000) throw new Error('response too large');
  try { return { json: JSON.parse(text), redirected: r.redirected, finalUrl: r.url }; } catch { throw new Error('response is not JSON'); }
}

/** The redirect URI and post-logout URI to register, derived the way the API does (WEB_ORIGIN + fixed paths). */
export function redirectHints(webOrigin) {
  if (!webOrigin) return [res('WARN', 'redirect URI hint', 'set WEB_ORIGIN to print the exact URIs to register')];
  let u; try { u = new URL(webOrigin); } catch { return [res('FAIL', 'WEB_ORIGIN is a valid URL')]; }
  const out = [];
  out.push(u.protocol === 'https:' ? res('PASS', 'WEB_ORIGIN is https') : res('WARN', 'WEB_ORIGIN is https', 'production refuses http origins and Secure-less cookies'));
  out.push(res('INFO', 'register this redirect URI at the provider (exact match)', `${u.origin}/api/v1/auth/oidc/callback`));
  out.push(res('INFO', 'register this post-logout redirect URI', `${u.origin}/`));
  out.push(res('MANUAL', 'redirect URI is registered at the provider', 'registration cannot be read back with a client secret; confirmed by the first interactive sign-in (runbook step 4)'));
  return out;
}

/**
 * Sends a token request with a deliberately invalid authorization code, authenticating the way Nexus will.
 * invalid_grant (or similar) = the client authenticated; invalid_client / unauthorized_client = it did not.
 */
export async function probeClientAuth(doc, { clientId, clientSecret, authMethod, redirectUri, fetchImpl = fetch, timeoutMs = 10_000 }) {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: 'nexus-staging-verify-invalid-code', redirect_uri: redirectUri || 'https://invalid.example/callback', code_verifier: 'a'.repeat(64) });
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (authMethod === 'client_secret_post') { body.set('client_id', clientId); body.set('client_secret', clientSecret); }
  else headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`;
  let r;
  try { r = await fetchImpl(doc.token_endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' }); }
  catch (e) { return [res('FAIL', 'client authentication probe', `token endpoint not reachable (${e.name})`)]; }
  let err = '';
  try { const j = await r.json(); err = typeof j?.error === 'string' ? j.error.replace(/[^\w.-]/g, '').slice(0, 64) : ''; } catch { /* not JSON */ }
  if (r.ok) return [res('WARN', 'client authentication probe', 'the provider ACCEPTED an invalid code: unexpected, investigate')];
  if (err === 'invalid_client' || err === 'unauthorized_client' || r.status === 401) return [res('FAIL', `client id/secret accepted with ${authMethod}`, `provider answered ${err || `HTTP ${r.status}`}: wrong client id, wrong or expired secret, or wrong auth method`)];
  if (err === 'invalid_grant' || err === 'invalid_request' || err === 'invalid_scope') return [res('PASS', `client id/secret accepted with ${authMethod}`, `provider rejected only the dummy code (${err})`)];
  return [res('WARN', 'client authentication probe', `inconclusive: HTTP ${r.status}${err ? ` ${err}` : ''}`)];
}

export async function verify(cfg) {
  const { issuer, clientId, clientSecret, webOrigin, allowHttp = false, fetchImpl = fetch, timeoutMs = 10_000, probe = true } = cfg;
  const authMethod = cfg.authMethod || '';
  const results = [];
  if (!issuer) return [res('FAIL', 'OIDC_ISSUER is set')];
  results.push(clientId ? res('PASS', 'OIDC_CLIENT_ID is set') : res('FAIL', 'OIDC_CLIENT_ID is set'));
  if (authMethod) results.push(SUPPORTED_METHODS.includes(authMethod) ? res('PASS', 'OIDC_AUTH_METHOD is one Nexus supports', authMethod) : res('FAIL', 'OIDC_AUTH_METHOD is one Nexus supports', `${authMethod} (use ${SUPPORTED_METHODS.join(' or ')})`));
  results.push(...checkIssuer(issuer, { allowHttp }));
  if (results.some((r) => r.status === 'FAIL' && /issuer/.test(r.name) && /valid URL/.test(r.name))) return results;

  const wellKnown = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  let doc;
  try {
    const got = await getJson(wellKnown, fetchImpl, timeoutMs);
    doc = got.json;
    results.push(res('PASS', 'discovery document fetched', wellKnown));
    if (got.redirected) results.push(res('WARN', 'discovery URL redirected', 'the final URL differs from the configured issuer URL'));
  } catch (e) { results.push(res('FAIL', 'discovery document fetched', `${wellKnown}: ${e.message}`)); return results; }
  results.push(...checkDiscovery(doc, { issuer, authMethod, allowHttp }));

  if (typeof doc.jwks_uri === 'string') {
    try { const { json } = await getJson(doc.jwks_uri, fetchImpl, timeoutMs); results.push(res('PASS', 'JWKS fetched', doc.jwks_uri), ...checkJwks(json, doc)); }
    catch (e) { results.push(res('FAIL', 'JWKS fetched', `${doc.jwks_uri}: ${e.message}`)); }
  }
  if (clientSecret && probe && typeof doc.token_endpoint === 'string') {
    const redirectUri = webOrigin ? `${new URL(webOrigin).origin}/api/v1/auth/oidc/callback` : undefined;
    results.push(...await probeClientAuth(doc, { clientId, clientSecret, authMethod: authMethod || effectiveAuthMethod(doc), redirectUri, fetchImpl, timeoutMs }));
  } else results.push(res('INFO', 'client authentication probe skipped', clientSecret ? 'disabled' : 'OIDC_CLIENT_SECRET not provided'));
  results.push(...redirectHints(webOrigin));
  return results;
}

export const MANUAL_STEPS = [
  'Runbook step 4: first sign-in as an invited user (A) in a private browser window; check cookie flags and that no token is in storage or the URL.',
  'Runbook step 5: second sign-in and a changed e-mail address (same Nexus user; identityBound false).',
  'Runbook steps 6-7: a person who was not invited (B) and an account whose token has no e-mail (C) are refused with generic pages.',
  'Runbook step 8: decode an ID token locally and compare claim NAMES (iss, aud, email, tid/oid for Entra, groups).',
  'Runbook steps 9-11: sign-out, removed user, provider outage and recovery, rollback rehearsal; then step 12 sign-off.',
];

export function render(results, secrets = []) {
  const lines = results.map((r) => redact(`${r.status.padEnd(6)} ${r.name}${r.detail ? `  -> ${r.detail}` : ''}`, secrets));
  const counts = results.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {});
  const summary = `Summary: ${['PASS', 'FAIL', 'WARN', 'INFO', 'MANUAL'].map((s) => `${counts[s] ?? 0} ${s}`).join(', ')}`;
  return { lines, summary, failed: (counts.FAIL ?? 0) > 0 };
}

async function main() {
  const env = process.env;
  const cfg = {
    issuer: env.OIDC_ISSUER, clientId: env.OIDC_CLIENT_ID, clientSecret: env.OIDC_CLIENT_SECRET, authMethod: env.OIDC_AUTH_METHOD,
    webOrigin: env.WEB_ORIGIN, allowHttp: env.OIDC_VERIFY_ALLOW_HTTP === 'true', probe: env.OIDC_VERIFY_PROBE !== 'false',
  };
  const secrets = [cfg.clientSecret];
  const out = render(await verify(cfg), secrets);
  for (const l of out.lines) console.log(l);
  console.log(out.summary);
  console.log('\nMANUAL steps this script cannot do (docs/runbooks/oidc-staging-verification.md):');
  for (const m of MANUAL_STEPS) console.log(`  - ${m}`);
  if (env.GITHUB_STEP_SUMMARY) {
    const fs = await import('node:fs');
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `### OIDC staging pre-checks\n\n\`\`\`\n${out.lines.join('\n')}\n${out.summary}\n\`\`\`\n\nInteractive browser steps remain MANUAL (see the runbook).\n`);
  }
  process.exit(out.failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(`ERROR ${redact(e.message, [process.env.OIDC_CLIENT_SECRET])}`); process.exit(2); });
