// Unit tests for infra/scripts/oidc-staging-verify.mjs. Run:  node --test infra/scripts/oidc-staging-verify.test.mjs
// Uses a LOCAL fake identity provider on 127.0.0.1 (random port); nothing leaves the machine.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { checkDiscovery, checkIssuer, checkJwks, effectiveAuthMethod, redact, redirectHints, render, verify } from './oidc-staging-verify.mjs';

const SECRET = 'fake-client-secret-Zx81qLmN-do-not-use';
const publicJwk = { ...generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };

/** A configurable fake provider. `state` is mutated per test. */
let server, origin;
const state = { discovery: {}, jwks: { keys: [publicJwk] }, tokenError: 'invalid_grant', tokenStatus: 400, tokenSeen: [] };
before(async () => {
  server = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/.well-known/openid-configuration') return send(200, { issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, jwks_uri: `${origin}/jwks`, id_token_signing_alg_values_supported: ['RS256'], response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'], end_session_endpoint: `${origin}/logout`, ...state.discovery });
    if (req.url === '/jwks') return send(200, state.jwks);
    if (req.url === '/token' && req.method === 'POST') {
      let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => { state.tokenSeen.push({ authorization: req.headers.authorization, body }); send(state.tokenStatus, { error: state.tokenError, error_description: `leaks ${SECRET}?` }); });
      return;
    }
    send(404, { error: 'not_found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));
const reset = () => { state.discovery = {}; state.jwks = { keys: [publicJwk] }; state.tokenError = 'invalid_grant'; state.tokenStatus = 400; state.tokenSeen = []; };
const cfg = (over = {}) => ({ issuer: origin, clientId: 'nexus-staging', clientSecret: SECRET, webOrigin: 'https://nexus-staging.example.com', allowHttp: true, timeoutMs: 3000, ...over });
const failing = (results) => results.filter((r) => r.status === 'FAIL').map((r) => r.name);

describe('pure checks', () => {
  it('rejects http issuers, templates and multi-tenant endpoints', () => {
    assert.ok(failing(checkIssuer('http://idp.example.com')).length);
    assert.ok(failing(checkIssuer('https://login.microsoftonline.com/common/v2.0')).length);
    assert.ok(failing(checkIssuer('https://login.microsoftonline.com/{tenantid}/v2.0')).length);
    assert.ok(failing(checkIssuer('https://idp.example.com/?x=1')).length);
    assert.deepEqual(failing(checkIssuer('https://login.microsoftonline.com/3f2c1a9e-0000-4000-8000-000000000000/v2.0')), []);
  });
  it('requires exact issuer equality including a trailing slash', () => {
    const doc = { issuer: 'https://idp.example.com/realm/', authorization_endpoint: 'https://idp.example.com/a', token_endpoint: 'https://idp.example.com/t', jwks_uri: 'https://idp.example.com/j' };
    assert.ok(failing(checkDiscovery(doc, { issuer: 'https://idp.example.com/realm' })).some((n) => /issuer/.test(n)));
    assert.ok(!failing(checkDiscovery(doc, { issuer: 'https://idp.example.com/realm/' })).some((n) => /issuer/.test(n)));
  });
  it('knows which client authentication method Nexus uses', () => {
    assert.equal(effectiveAuthMethod({}), 'client_secret_basic');
    assert.equal(effectiveAuthMethod({ token_endpoint_auth_methods_supported: ['client_secret_post'] }), 'client_secret_post');
    assert.equal(effectiveAuthMethod({ token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'] }), 'client_secret_basic');
  });
  it('fails private_key_jwt-only providers and symmetric-only signing', () => {
    const base = { issuer: 'https://i.example', authorization_endpoint: 'https://i.example/a', token_endpoint: 'https://i.example/t', jwks_uri: 'https://i.example/j' };
    assert.ok(failing(checkDiscovery({ ...base, token_endpoint_auth_methods_supported: ['private_key_jwt'] }, { issuer: base.issuer })).length);
    assert.ok(failing(checkDiscovery({ ...base, id_token_signing_alg_values_supported: ['HS256'] }, { issuer: base.issuer })).length);
  });
  it('flags private key material in a JWKS', () => {
    assert.ok(failing(checkJwks({ keys: [{ ...publicJwk, d: 'x' }] })).some((n) => /private/.test(n)));
    assert.deepEqual(failing(checkJwks({ keys: [publicJwk] })), []);
    assert.ok(failing(checkJwks({})).length);
  });
  it('prints the exact redirect URI to register', () => {
    const r = redirectHints('https://nexus.example.com/');
    assert.ok(r.some((x) => x.detail === 'https://nexus.example.com/api/v1/auth/oidc/callback'));
    assert.ok(r.some((x) => x.status === 'MANUAL'));
  });
  it('redacts secrets', () => assert.equal(redact(`a ${SECRET} b`, [SECRET]), 'a <redacted> b'));
});

describe('against a local fake provider', () => {
  it('passes a healthy provider, probes the client, and never prints the secret', async () => {
    reset();
    const results = await verify(cfg());
    assert.deepEqual(failing(results), []);
    assert.ok(results.some((r) => r.status === 'PASS' && /client id\/secret accepted/.test(r.name)));
    const out = render(results, [SECRET]);
    assert.equal(out.failed, false);
    assert.ok(!out.lines.join('\n').includes(SECRET));
    // the probe authenticated with HTTP Basic and sent the dummy code, never a real one
    assert.match(state.tokenSeen[0].authorization, /^Basic /);
    assert.match(state.tokenSeen[0].body, /nexus-staging-verify-invalid-code/);
  });
  it('uses client_secret_post when only post is advertised', async () => {
    reset(); state.discovery = { token_endpoint_auth_methods_supported: ['client_secret_post'] };
    const results = await verify(cfg());
    assert.deepEqual(failing(results), []);
    assert.equal(state.tokenSeen[0].authorization, undefined);
    assert.match(state.tokenSeen[0].body, /client_secret=/);
  });
  it('fails on an issuer mismatch', async () => {
    reset(); state.discovery = { issuer: `${origin}/other` };
    assert.ok(failing(await verify(cfg())).some((n) => /issuer equals/.test(n)));
  });
  it('fails when the expected auth method is not offered', async () => {
    reset(); state.discovery = { token_endpoint_auth_methods_supported: ['client_secret_basic'] };
    assert.ok(failing(await verify(cfg({ authMethod: 'client_secret_post' }))).some((n) => /expected auth method/.test(n)));
  });
  it('fails when the provider rejects the client credentials, without echoing the body', async () => {
    reset(); state.tokenError = 'invalid_client'; state.tokenStatus = 401;
    const results = await verify(cfg());
    assert.ok(failing(results).some((n) => /client id\/secret accepted/.test(n)));
    assert.ok(!render(results, [SECRET]).lines.join('\n').includes('leaks'));
  });
  it('fails on a JWKS with private material and on an unreachable discovery document', async () => {
    reset(); state.jwks = { keys: [{ ...publicJwk, d: 'secret-private-part' }] };
    assert.ok(failing(await verify(cfg())).some((n) => /private/.test(n)));
    const down = await verify(cfg({ issuer: 'http://127.0.0.1:9', timeoutMs: 1500 }));
    assert.ok(failing(down).some((n) => /discovery/.test(n)));
  });
  it('skips the probe without a secret', async () => {
    reset();
    const results = await verify(cfg({ clientSecret: undefined }));
    assert.equal(state.tokenSeen.length, 0);
    assert.ok(results.some((r) => /probe skipped/.test(r.name)));
  });
  it('refuses http issuers unless explicitly allowed', async () => {
    reset();
    assert.ok(failing(await verify(cfg({ allowHttp: false }))).some((n) => /https/.test(n)));
  });
});
