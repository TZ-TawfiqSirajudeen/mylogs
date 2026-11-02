import { describe, expect, test } from 'vitest';
import { parseMongoUri } from './mongo-uri';

const ok = (s: string) => { const r = parseMongoUri(s); if (!r.ok) throw new Error(r.error); return r.value; };

describe('parseMongoUri', () => {
  test('an Atlas SRV string: user, password, srv host, tls on by default, extras ignored', () => {
    const v = ok('mongodb+srv://dbuser:p%40ss%3Aw%2Frd@cluster0.abcde.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0');
    expect(v).toMatchObject({ scheme: 'mongodb+srv', username: 'dbuser', password: 'p@ss:w/rd', srvHost: 'cluster0.abcde.mongodb.net', hosts: [], tls: true, authSource: null });
    expect(v.ignored.sort()).toEqual(['appName', 'retrywrites', 'w'].sort());
  });
  test('an explicit host list with ports, IPv6, authSource and tls=false', () => {
    const v = ok('mongodb://u:pw@a.example.com:27018,[::1]:27019,b.example.com/app?authSource=admin&tls=false&replicaSet=rs0');
    expect(v.hosts).toEqual([{ host: 'a.example.com', port: 27018 }, { host: '::1', port: 27019 }, { host: 'b.example.com', port: 27017 }]);
    expect(v).toMatchObject({ authSource: 'admin', tls: false, username: 'u', password: 'pw', srvHost: null });
    expect(v.ignored).toEqual(['replicaset']);
  });
  test('no credentials, no tls statement: tls stays undecided so the form default (on) wins', () => {
    const v = ok('mongodb://localhost:27017');
    expect(v).toMatchObject({ username: null, password: null, tls: null, hosts: [{ host: 'localhost', port: 27017 }] });
  });
  test('the database in the path is the auth database when credentials are present and authSource is absent', () => {
    expect(ok('mongodb://u:p@h.example.com/reports').authSource).toBe('reports');
  });
  test('an unescaped @ in the password is split at the LAST @ (the host cannot contain one)', () => {
    expect(ok('mongodb://user:p@ss@host.example.com').password).toBe('p@ss');
  });
  test.each([
    ['', 'not a MongoDB connection string'],
    ['https://example.com', 'not a MongoDB connection string'],
    ['mongodb+srv://a.b.c,d.e.f/', 'exactly one host'],
    ['mongodb+srv://host:27017/', 'exactly one host'],
    ['mongodb+srv://cluster.local/', 'at least three parts'],
    ['mongodb://u:%zz@h.example.com', 'valid escape'],
    ['mongodb://h.example.com:99999', 'invalid port'],
    ['mongodb://', 'no host'],
    ['mongodb://a,,b', 'empty entry'],
    ['mongodb://1,2,3,4,5,6,7,8', 'At most 7'],
  ])('rejects %j', (input, message) => {
    const r = parseMongoUri(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(message);
  });
  test('the result never echoes the password inside any other field', () => {
    const v = ok('mongodb+srv://u:SuperSecret1@x.y.example.com/?appName=x');
    expect(JSON.stringify({ ...v, password: null })).not.toContain('SuperSecret1');
  });
});
