import { describe, expect, test } from 'vitest';
import { resolveMongoSrv, SrvError, type SrvResolver } from './mongodb-srv.js';

const fake = (srv: { name: string; port: number }[] | Error, txt: string[][] | Error = []): SrvResolver => ({
  resolveSrv: async () => { if (srv instanceof Error) throw srv; return srv; },
  resolveTxt: async () => { if (txt instanceof Error) throw txt; return txt; },
});

describe('resolveMongoSrv', () => {
  test('an Atlas-shaped answer: members sorted, authSource and replicaSet from TXT', async () => {
    const r = await resolveMongoSrv('Cluster0.abcde.mongodb.net', fake(
      [{ name: 'shard-00-02.abcde.mongodb.net', port: 27017 }, { name: 'shard-00-00.abcde.mongodb.net', port: 27017 }],
      [['authSource=admin&replicaSet=atlas-x-shard-0']],
    ));
    expect(r.hosts.map((h) => h.host)).toEqual(['shard-00-00.abcde.mongodb.net', 'shard-00-02.abcde.mongodb.net']);
    expect(r).toMatchObject({ authSource: 'admin', replicaSet: 'atlas-x-shard-0', truncated: false });
  });
  test('a target outside the seed\'s parent domain is refused (poisoned or hostile DNS)', async () => {
    await expect(resolveMongoSrv('c.abcde.mongodb.net', fake([{ name: 'evil.example.org', port: 27017 }]))).rejects.toThrow(/outside/);
  });
  test('a lookalike suffix is refused (notabcde.mongodb.net is not below abcde.mongodb.net)', async () => {
    await expect(resolveMongoSrv('c.abcde.mongodb.net', fake([{ name: 'x.notabcde.mongodb.net', port: 27017 }]))).rejects.toThrow(/outside/);
  });
  test.each(['localhost', 'a.b', '10.0.0.1', '1.2.3.4', 'bad_label.x.y', '-a.b.c', 'a..b.c'])('rejects the seed %s', async (seed) => {
    await expect(resolveMongoSrv(seed, fake([]))).rejects.toThrow(SrvError);
  });
  test('no SRV record is a plain-language error, not a stack trace', async () => {
    await expect(resolveMongoSrv('c.abcde.mongodb.net', fake(Object.assign(new Error('queryTxt ENODATA'), { code: 'ENODATA' })))).rejects.toThrow(/No MongoDB SRV record/);
  });
  test('an empty answer is an error', async () => {
    await expect(resolveMongoSrv('c.abcde.mongodb.net', fake([]))).rejects.toThrow(/no MongoDB members/);
  });
  test('TXT failure is ignored; unknown TXT keys are ignored; more than 7 members are truncated and flagged', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ name: `s${i}.abcde.mongodb.net`, port: 27017 }));
    const r = await resolveMongoSrv('c.abcde.mongodb.net', fake(many, new Error('boom')));
    expect(r.hosts).toHaveLength(7);
    expect(r.truncated).toBe(true);
    const r2 = await resolveMongoSrv('c.abcde.mongodb.net', fake(many.slice(0, 1), [['loadBalanced=true&authSource=x%20y&tlsInsecure=true']]));
    expect(r2.authSource).toBeNull();
  });
  test('a hanging resolver times out', async () => {
    const hang: SrvResolver = { resolveSrv: () => new Promise(() => undefined), resolveTxt: async () => [] };
    await expect(resolveMongoSrv('c.abcde.mongodb.net', hang, 50)).rejects.toThrow(/timed out/);
  });
  test('an invalid port in the answer is refused', async () => {
    await expect(resolveMongoSrv('c.abcde.mongodb.net', fake([{ name: 's.abcde.mongodb.net', port: 0 }]))).rejects.toThrow(/invalid port/);
  });
});
