import { expect, test } from 'vitest';
import { REDACTED, redactSecrets } from './redact.js';

test('redacts credential-looking keys at any depth', () => {
  const out = redactSecrets({
    name: 'x',
    password: 'p',
    nested: { apiKey: 'k', Authorization: 'Bearer abc', list: [{ client_secret: 's', ok: 1 }] },
    mongoUri: 'mongodb://u:p@h',
  }) as any;
  expect(out.name).toBe('x');
  expect(out.password).toBe(REDACTED);
  expect(out.nested.apiKey).toBe(REDACTED);
  expect(out.nested.Authorization).toBe(REDACTED);
  expect(out.nested.list[0].client_secret).toBe(REDACTED);
  expect(out.nested.list[0].ok).toBe(1);
  expect(out.mongoUri).toBe(REDACTED);
});

test('truncates oversized strings and deep structures', () => {
  const out = redactSecrets({ big: 'a'.repeat(10_000) }) as any;
  expect(out.big.length).toBeLessThan(2_100);
  let deep: any = { v: 1 };
  for (let i = 0; i < 20; i++) deep = { n: deep };
  expect(JSON.stringify(redactSecrets(deep))).toContain('[TRUNCATED]');
});

test('scrubs credentials embedded in URL-shaped strings under innocuous keys', () => {
  const out = redactSecrets({ message: 'failed to connect to mongodb://admin:s3cr3t@db.internal:27017/x', note: 'https://example.com/path' }) as any;
  expect(out.message).not.toContain('s3cr3t');
  expect(out.message).toContain('mongodb://[REDACTED]@db.internal');
  expect(out.note).toBe('https://example.com/path');
});
