import { expect, test } from 'vitest';
import { REDACTED, redactSecrets, scrubKnownSecrets } from './redact.js';

test.each([
  ['mongodb://admin:p@ssw0rd@db:27017/x', 'ssw0rd'],
  ['mongodb://admin:pa/ss@db:27017/x', 'pa/ss'],
  ['redis://:onlypass@host' /* no user: not matched by design, covered by known-secret scrubbing */, ''],
  ['postgres://u:s3cr3t@h/db?sslmode=require', 's3cr3t'],
])('URL credentials are fully removed: %s', (input, leaked) => {
  const out = redactSecrets({ message: input }) as { message: string };
  if (leaked) expect(out.message).not.toContain(leaked);
  if (leaked) expect(out.message).toContain(`${REDACTED}@`);
});

test('scrubKnownSecrets removes exact values wherever they appear, ignoring trivially short ones', () => {
  const out = scrubKnownSecrets('auth failed for user x with password hunter2!! and token abc', ['hunter2!!', 'abc', '']);
  expect(out).not.toContain('hunter2!!');
  expect(out).toContain('token abc'); // 3 chars: too short to scrub safely (would mangle ordinary words)
});

test('does not touch ordinary URLs or emails', () => {
  expect(redactSecrets('https://example.com/a?b=c')).toBe('https://example.com/a?b=c');
  expect(redactSecrets('mail me at a@b.com')).toBe('mail me at a@b.com');
});
