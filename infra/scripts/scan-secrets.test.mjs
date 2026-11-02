// Unit tests for the pure rules of infra/scripts/scan-secrets.mjs.  node --test infra/scripts/scan-secrets.test.mjs
// Fixtures are assembled at run time so this file itself contains no scannable secret.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { entropy, fingerprint, scanLine } from './scan-secrets.mjs';

const rules = (line) => scanLine(line).map((f) => f.rule);
const rnd = (n) => Array.from({ length: n }, (_, i) => 'aZ3kQ9xW7pL2mN8vB5tR1yU6cE4hJ0'[(i * 7 + (i >> 2)) % 30]).join('');

describe('scanLine', () => {
  it('finds MongoDB URIs with a real-looking password and ignores placeholders', () => {
    assert.deepEqual(rules(`uri = "mongodb+srv://svc_user:${rnd(14)}@cluster.example.net/?retryWrites=true"`), ['mongodb-uri-credentials']);
    assert.deepEqual(rules('mongodb://user:<password>@host/db'), []);
    assert.deepEqual(rules('mongodb://user:${DB_PASSWORD}@host/db'), []);
    assert.deepEqual(rules('mongodb://127.0.0.1:27017/?replicaSet=rs0'), []);
  });
  it('finds AWS keys and private key headers', () => {
    assert.deepEqual(rules(`id: ${'AKIA' + 'ABCDEFGHIJKLMNOP'}`), ['aws-access-key-id']);
    assert.deepEqual(rules(`${'-----BEGIN RSA PRIV'}${'ATE KEY-----'}`), ['private-key-block']);
    assert.deepEqual(rules('AKIAIOSFODNN7EXAMPLE'), []);
  });
  it('flags high-entropy secret assignments but not references or placeholders', () => {
    assert.ok(rules(`CLIENT_SECRET="${rnd(32)}"`).length);
    assert.deepEqual(rules('const token = process.env.SOME_VALUE_THAT_IS_LONG_ENOUGH_TO_MATCH'), []);
    assert.deepEqual(rules('OIDC_CLIENT_SECRET: ${OIDC_CLIENT_SECRET:-local-dev-secret-change-me}'), []);
    assert.deepEqual(rules('password = "aaaaaaaaaaaaaaaaaaaaaaaaaaaa"'), []);
  });
  it('never returns the value, only a fingerprint', () => {
    const v = rnd(16);
    const [f] = scanLine(`mongodb://u:${v}@h/`);
    assert.equal(f.fp, fingerprint(v));
    assert.ok(!JSON.stringify(f).includes(v));
  });
  it('entropy is sane', () => { assert.ok(entropy('aaaa') < 0.1); assert.ok(entropy(rnd(30)) > 3); });
});
