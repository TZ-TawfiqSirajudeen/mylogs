import { describe, expect, test } from 'vitest';
import { classifyAddress, pinnedLookup, resolveSafeTarget, STRICT_POLICY, TargetRejectedError, type NetworkPolicy } from './ssrf.js';

const dev: NetworkPolicy = { ...STRICT_POLICY, allowLoopback: true };
const stub = (map: Record<string, string[]>): NetworkPolicy => ({ ...STRICT_POLICY, resolver: async (h) => map[h] ?? [] });
const reject = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as TargetRejectedError; } throw new Error('expected rejection'); };

describe('classifyAddress', () => {
  test.each([
    '127.0.0.1', '127.9.9.9', '::1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1',
    '169.254.169.254', '169.254.1.1', 'fe80::1', 'fd00:ec2::254', '0.0.0.0', '::', '224.0.0.1', '255.255.255.255',
    'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe', '2002:7f00:1::1', '198.18.0.1',
  ])('blocks %s under the strict policy', (ip) => expect(classifyAddress(ip).allowed).toBe(false));

  test.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '172.32.0.1', '11.0.0.1'])('allows public %s', (ip) =>
    expect(classifyAddress(ip).allowed).toBe(true));

  test('loopback only with allowLoopback; mapped loopback follows the same rule', () => {
    expect(classifyAddress('127.0.0.1', dev).allowed).toBe(true);
    expect(classifyAddress('::1', dev).allowed).toBe(true);
    expect(classifyAddress('::ffff:127.0.0.1', dev).allowed).toBe(true);
    expect(classifyAddress('10.0.0.1', dev).allowed).toBe(false); // allowLoopback does not open private ranges
  });

  test('private ranges need an approved CIDR; metadata stays denied even if the CIDR covers it', () => {
    const p: NetworkPolicy = { ...STRICT_POLICY, allowPrivateCidrs: ['10.20.0.0/16', '169.254.0.0/16'] };
    expect(classifyAddress('10.20.1.1', p).allowed).toBe(true);
    expect(classifyAddress('10.21.1.1', p).allowed).toBe(false);
    expect(classifyAddress('169.254.169.254', p).allowed).toBe(false);
    expect(classifyAddress('169.254.5.5', p).allowed).toBe(false);
  });

  test('garbage is denied', () => expect(classifyAddress('not-an-ip').allowed).toBe(false));
});

describe('resolveSafeTarget', () => {
  test('rejects literal internal addresses', async () => {
    for (const h of ['127.0.0.1', '169.254.169.254', '10.0.0.5', '[::1]', '::ffff:127.0.0.1']) {
      expect((await reject(resolveSafeTarget(h, 443))).code).toBe('blocked_address');
    }
  });

  test('rejects numeric shorthand that getaddrinfo would treat as an IPv4 literal', async () => {
    for (const h of ['2130706433', '0x7f.1', '127.1', '0177.0.0.1', '0x7f000001']) {
      expect((await reject(resolveSafeTarget(h, 443))).code).toBe('invalid_host');
    }
  });

  test('rejects reserved names and suffixes, and hostnames with injection characters', async () => {
    for (const h of ['localhost', 'foo.localhost', 'metadata.google.internal', 'db.internal', 'x.local', 'x.cluster.local']) {
      expect((await reject(resolveSafeTarget(h, 443, stub({ [h]: ['8.8.8.8'] })))).code).toBe('blocked_address');
    }
    for (const h of ['evil.com@10.0.0.1', 'a b', 'a/b', 'a#b', 'a?b', '']) {
      expect((await reject(resolveSafeTarget(h, 443))).code).toBe('invalid_host');
    }
  });

  test('rejects a name that resolves to an internal address, including mixed answers', async () => {
    expect((await reject(resolveSafeTarget('rebind.example.com', 443, stub({ 'rebind.example.com': ['127.0.0.1'] })))).code).toBe('blocked_address');
    expect((await reject(resolveSafeTarget('mixed.example.com', 443, stub({ 'mixed.example.com': ['8.8.8.8', '10.0.0.1'] })))).code).toBe('blocked_address');
  });

  test('DNS failure is reported distinctly', async () => {
    expect((await reject(resolveSafeTarget('nope.example.com', 443, stub({})))).code).toBe('dns_failure');
  });

  test('accepts public targets and returns the validated addresses', async () => {
    const t = await resolveSafeTarget('Good.Example.com.', 443, stub({ 'good.example.com': ['93.184.216.34'] }));
    expect(t).toEqual({ host: 'good.example.com', port: 443, addresses: ['93.184.216.34'] });
  });

  test('dangerous ports are denied unless a DB connector opts in', async () => {
    expect((await reject(resolveSafeTarget('8.8.8.8', 22))).code).toBe('blocked_port');
    expect((await reject(resolveSafeTarget('8.8.8.8', 445))).code).toBe('blocked_port');
    expect((await reject(resolveSafeTarget('8.8.8.8', 0))).code).toBe('blocked_port');
    expect((await resolveSafeTarget('8.8.8.8', 5432, STRICT_POLICY, { allowPorts: [5432] })).port).toBe(5432);
    expect((await resolveSafeTarget('8.8.8.8', 27017)).port).toBe(27017);
  });

  test('operator-approved internal names require approved CIDRs and still validate the addresses', async () => {
    const p: NetworkPolicy = { ...STRICT_POLICY, allowPrivateCidrs: ['10.0.0.0/8'], resolver: async () => ['10.4.4.4'] };
    expect((await resolveSafeTarget('db.corp.internal', 27017, p)).addresses).toEqual(['10.4.4.4']);
    const wrong: NetworkPolicy = { ...p, resolver: async () => ['192.168.1.1'] };
    expect((await reject(resolveSafeTarget('db.corp.internal', 27017, wrong))).code).toBe('blocked_address');
    expect((await reject(resolveSafeTarget('metadata.google.internal', 80, { ...p, resolver: async () => ['10.4.4.4'] }))).code).toBe('blocked_address');
  });

  test('loopback host works in dev policy only', async () => {
    expect((await resolveSafeTarget('127.0.0.1', 8080, dev)).addresses).toEqual(['127.0.0.1']);
    expect((await resolveSafeTarget('localhost', 8080, { ...dev, resolver: async () => ['127.0.0.1'] })).addresses).toEqual(['127.0.0.1']);
  });

  test('invalid CIDR in the policy fails loudly rather than allowing everything', async () => {
    await expect(resolveSafeTarget('10.0.0.1', 443, { ...STRICT_POLICY, allowPrivateCidrs: ['10.0.0.0'] })).rejects.toThrow(/Invalid CIDR/);
  });
});

describe('pinnedLookup', () => {
  test('only ever returns validated addresses regardless of the name asked for', async () => {
    const lookup = pinnedLookup(['93.184.216.34']) as unknown as (h: string, o: object, cb: (...a: any[]) => void) => void;
    const single = await new Promise<any[]>((res) => lookup('anything.attacker.test', {}, (...a) => res(a)));
    expect(single).toEqual([null, '93.184.216.34', 4]);
    const all = await new Promise<any[]>((res) => lookup('x', { all: true }, (...a) => res(a)));
    expect(all[1]).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });
});
