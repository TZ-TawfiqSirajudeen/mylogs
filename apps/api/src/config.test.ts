import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadConfig } from './config.js';

const base = { MONGODB_URI: 'mongodb+srv://hariharanrpandi:Admin123@thetazero.urw0lat.mongodb.net/?retryWrites=true&w=majority' };
const oidcEnv = { AUTH_MODE: 'oidc', OIDC_ISSUER: 'https://idp.example.com', OIDC_CLIENT_ID: 'nexus', OIDC_CLIENT_SECRET: 'super-secret-value' };

describe('loadConfig', () => {
  test('dev defaults are allowed outside production', () => {
    const c = loadConfig({ ...base, NODE_ENV: 'development' });
    expect(c.authMode).toBe('dev');
    expect(c.cookieSecure).toBe(false);
  });

  test('production refuses dev auth, insecure cookies and http origins', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', WEB_ORIGIN: 'https://x.example' })).toThrow(/AUTH_MODE=dev/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', ...oidcEnv, COOKIE_SECURE: 'false', WEB_ORIGIN: 'https://x.example' })).toThrow(/COOKIE_SECURE/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', ...oidcEnv, WEB_ORIGIN: 'http://x.example' })).toThrow(/https/);
    expect(loadConfig({ ...base, NODE_ENV: 'production', ...oidcEnv, WEB_ORIGIN: 'https://x.example', SECRETS_KEYS: 'k:' + Buffer.alloc(32).toString('base64') }).cookieSecure).toBe(true);
  });

  test('production also requires a key-encryption key and refuses loopback egress', () => {
    const prod = { ...base, NODE_ENV: 'production', ...oidcEnv, WEB_ORIGIN: 'https://x.example' };
    expect(() => loadConfig(prod)).toThrow(/SECRETS_KEYS/);
    expect(() => loadConfig({ ...prod, SECRETS_KEYS: 'k:' + Buffer.alloc(32).toString('base64'), NETWORK_ALLOW_LOOPBACK: 'true' })).toThrow(/NETWORK_ALLOW_LOOPBACK/);
    const ok = loadConfig({ ...prod, SECRETS_KEYS: 'k:' + Buffer.alloc(32).toString('base64'), NETWORK_ALLOW_PRIVATE_CIDRS: '10.20.0.0/16, 192.168.5.0/24' });
    expect(ok.network).toEqual({ allowLoopback: false, allowPrivateCidrs: ['10.20.0.0/16', '192.168.5.0/24'], allowInsecureHttp: false });
  });

  test('network policy defaults are strict and CIDRs are validated', () => {
    expect(loadConfig(base).network).toEqual({ allowLoopback: false, allowPrivateCidrs: [], allowInsecureHttp: false });
    expect(() => loadConfig({ ...base, NETWORK_ALLOW_PRIVATE_CIDRS: '10.0.0.0' })).toThrow(/NETWORK_ALLOW_PRIVATE_CIDRS/);
    expect(() => loadConfig({ ...base, NETWORK_ALLOW_PRIVATE_CIDRS: 'not-a-cidr/8' })).toThrow(/NETWORK_ALLOW_PRIVATE_CIDRS/);
  });

  test('validation errors never echo values (the Mongo URI contains credentials)', () => {
    try {
      loadConfig({ ...base, PORT: 'abc' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(String(e)).toContain('PORT');
      expect(String(e)).not.toContain('secret-pass');
    }
  });

  describe('OIDC', () => {
    const web = { ...base, NODE_ENV: 'development', WEB_ORIGIN: 'http://localhost:5173' };
    const oidc = (extra: Record<string, string> = {}) => ({ ...web, ...oidcEnv, ...extra });

    test('AUTH_MODE=oidc requires an issuer and a client id, and names only the variables', () => {
      expect(() => loadConfig({ ...web, AUTH_MODE: 'oidc' })).toThrow(/OIDC_ISSUER.*OIDC_CLIENT_ID/s);
    });

    test('a client secret never appears in errors, JSON or inspected config', () => {
      const cfg = loadConfig(oidc());
      expect(cfg.oidc?.clientSecret).toBe('super-secret-value'); // available to the backend…
      expect(JSON.stringify(cfg)).not.toContain('super-secret-value'); // …but invisible to serialization / structured logging
      expect(JSON.stringify(cfg.oidc)).not.toContain('super-secret-value');
      try { loadConfig(oidc({ OIDC_PROVISIONING: 'bogus' })); throw new Error('should have thrown'); } catch (e) { expect(String(e)).not.toContain('super-secret-value'); }
    });

    test('the client secret can be read from a mounted file', () => {
      const dir = mkdtempSync(join(tmpdir(), 'oidc-'));
      writeFileSync(join(dir, 'secret'), 'file-secret\n');
      const { OIDC_CLIENT_SECRET: _omit, ...rest } = oidcEnv;
      expect(loadConfig({ ...web, ...rest, OIDC_CLIENT_SECRET_FILE: join(dir, 'secret') }).oidc?.clientSecret).toBe('file-secret');
      expect(() => loadConfig({ ...web, ...rest, OIDC_CLIENT_SECRET_FILE: join(dir, 'missing') })).toThrow(/OIDC_CLIENT_SECRET_FILE/);
    });

    test('non-https issuers are refused unless explicitly allowed for local development, and never in production', () => {
      expect(() => loadConfig(oidc({ OIDC_ISSUER: 'http://localhost:9000' }))).toThrow(/OIDC_ISSUER/);
      expect(loadConfig(oidc({ OIDC_ISSUER: 'http://localhost:9000', OIDC_ALLOW_INSECURE_ISSUER: 'true' })).oidc?.allowInsecureIssuer).toBe(true);
      const prod = { ...base, ...oidcEnv, NODE_ENV: 'production', WEB_ORIGIN: 'https://x.example', SECRETS_KEYS: 'k:' + Buffer.alloc(32).toString('base64') };
      expect(() => loadConfig({ ...prod, OIDC_ISSUER: 'http://idp.example.com' })).toThrow(/OIDC_ISSUER/);
      expect(() => loadConfig({ ...prod, OIDC_ALLOW_INSECURE_ISSUER: 'true' })).toThrow(/OIDC_ALLOW_INSECURE_ISSUER/);
    });

    test('the redirect URI must live on the web origin (the callback sets the session cookie)', () => {
      expect(() => loadConfig(oidc({ OIDC_REDIRECT_URI: 'https://evil.example/cb' }))).toThrow(/OIDC_REDIRECT_URI/);
      expect(loadConfig(oidc()).oidc?.redirectUri).toBe('http://localhost:5173/api/v1/auth/oidc/callback');
    });

    test('no open registration by default: JIT provisioning needs an org and an e-mail domain allow-list', () => {
      expect(loadConfig(oidc()).oidc?.provisioning).toBe('invite-only');
      expect(() => loadConfig(oidc({ OIDC_PROVISIONING: 'jit' }))).toThrow(/OIDC_DEFAULT_ORG_SLUG/);
      expect(() => loadConfig(oidc({ OIDC_PROVISIONING: 'jit', OIDC_DEFAULT_ORG_SLUG: 'acme' }))).toThrow(/OIDC_ALLOWED_EMAIL_DOMAINS/);
      expect(loadConfig(oidc({ OIDC_PROVISIONING: 'jit', OIDC_DEFAULT_ORG_SLUG: 'acme', OIDC_ALLOWED_EMAIL_DOMAINS: 'acme.test' })).oidc?.provisioning).toBe('jit');
    });

    test('group role maps can never grant owner', () => {
      expect(() => loadConfig(oidc({ OIDC_GROUP_ROLE_MAP: '{"admins":"owner"}' }))).toThrow(/OIDC_GROUP_ROLE_MAP/);
      expect(() => loadConfig(oidc({ OIDC_GROUP_ROLE_MAP: '["admin"]' }))).toThrow(/OIDC_GROUP_ROLE_MAP/);
      expect(loadConfig(oidc({ OIDC_GROUP_ROLE_MAP: '{"sre":"admin","qa":"auditor"}' })).oidc?.groupRoleMap).toEqual({ sre: 'admin', qa: 'auditor' });
    });

    test('dev mode carries no OIDC settings at all', () => {
      expect(loadConfig({ ...base, NODE_ENV: 'development' }).oidc).toBeNull();
    });
  });
});
