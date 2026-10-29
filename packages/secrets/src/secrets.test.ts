import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from '@nexus/database';
import { freshTestDatabase, startTestMongo } from '@nexus/database/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { generateKeyBase64, loadKeyring, parseKeyring } from './keyring.js';
import { SecretDecryptionError, SecretNotFoundError, SecretStore, type SecretScope } from './store.js';

let mongo: Awaited<ReturnType<typeof startTestMongo>>;
let db: Database;
const k1 = generateKeyBase64();
const k2 = generateKeyBase64();
const ring1 = () => parseKeyring(`k1:${k1}`, 'k1');
const scope: SecretScope = { orgId: 'org-a', connectionId: 'conn-1', name: 'password' };

beforeAll(async () => { mongo = await startTestMongo(); db = await freshTestDatabase(mongo.uri); }, 240_000);
afterAll(async () => { await db?.close(); await mongo?.stop(); });

describe('keyring', () => {
  test('parses, validates length and ids', () => {
    expect(parseKeyring(`a:${k1},b:${k2}`, 'b').currentKeyId).toBe('b');
    expect(() => parseKeyring(`a:${Buffer.from('short').toString('base64')}`, 'a')).toThrow(/32 bytes/);
    expect(() => parseKeyring(`a:${k1}`, 'zzz')).toThrow(/CURRENT_KEY_ID/);
    expect(() => parseKeyring(`a:${k1},a:${k2}`, 'a')).toThrow(/Duplicate/);
    expect(() => parseKeyring('', 'a')).toThrow(/no keys/);
  });

  test('production refuses to start without an injected key; dev generates a git-ignored local KEK once', () => {
    expect(() => loadKeyring({}, { production: true, devKeyFile: '/nonexistent/kek.json' })).toThrow(/required in production/);
    const dir = mkdtempSync(join(tmpdir(), 'nx-kek-'));
    try {
      const file = join(dir, 'kek.json');
      const a = loadKeyring({}, { production: false, devKeyFile: file });
      const b = loadKeyring({}, { production: false, devKeyFile: file });
      expect(a.keys.get(a.currentKeyId)!.equals(b.keys.get(b.currentKeyId)!)).toBe(true); // stable across restarts
      expect(JSON.parse(readFileSync(file, 'utf8')).id).toBe('dev-1');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('an explicitly provided key is used in production', () => {
    expect(loadKeyring({ SECRETS_KEYS: `p1:${k1}` }, { production: true, devKeyFile: 'x' }).currentKeyId).toBe('p1');
  });
});

describe('SecretStore', () => {
  test('round-trips and stores only ciphertext', async () => {
    const store = new SecretStore(db, ring1());
    await store.put(scope, 'hunter2-très-secret ✓', 'u1');
    expect(await store.get(scope)).toBe('hunter2-très-secret ✓');
    const raw = JSON.stringify(await db.c.secrets.findOne({ orgId: scope.orgId }));
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain(k1);
  });

  test('every secret has its own IV and data key (same plaintext -> different ciphertext)', async () => {
    const store = new SecretStore(db, ring1());
    await store.put({ ...scope, name: 'a' }, 'same-value', null);
    await store.put({ ...scope, name: 'b' }, 'same-value', null);
    const [a, b] = await Promise.all(['a', 'b'].map((n) => db.c.secrets.findOne({ orgId: scope.orgId, name: n })));
    expect(a!.ciphertext).not.toBe(b!.ciphertext);
    expect(a!.wrappedDek).not.toBe(b!.wrappedDek);
    expect(a!.iv).not.toBe(b!.iv);
  });

  test('rotation replaces the value in place and bumps the version; old value is gone', async () => {
    const store = new SecretStore(db, ring1());
    const s = { ...scope, name: 'rot' };
    expect((await store.put(s, 'old', null)).version).toBe(1);
    expect((await store.put(s, 'new', null)).version).toBe(2);
    expect(await store.get(s)).toBe('new');
    expect(await db.c.secrets.countDocuments({ orgId: s.orgId, connectionId: s.connectionId, name: 'rot' })).toBe(1);
  });

  test('a row moved to another tenant, connection or name cannot be decrypted (AAD binding)', async () => {
    const store = new SecretStore(db, ring1());
    const src = { orgId: 'org-a', connectionId: 'conn-x', name: 'password' };
    await store.put(src, 'tenant-a-secret', null);
    const row = (await db.c.secrets.findOne(src))!;
    for (const [i, target] of [
      { orgId: 'org-b', connectionId: 'conn-x', name: 'password' },
      { orgId: 'org-a', connectionId: 'conn-y', name: 'password' },
      { orgId: 'org-a', connectionId: 'conn-x', name: 'token' },
    ].entries()) {
      const { _id, ...rest } = row;
      await db.c.secrets.insertOne({ ...rest, ...target, _id: `moved-${i}` });
      await expect(store.get(target)).rejects.toBeInstanceOf(SecretDecryptionError);
    }
  });

  test('tampering with ciphertext, tag or wrapped key is detected', async () => {
    const store = new SecretStore(db, ring1());
    const s = { ...scope, name: 'tamper' };
    await store.put(s, 'value-123', null);
    for (const field of ['ciphertext', 'tag', 'wrappedDek'] as const) {
      const row = (await db.c.secrets.findOne({ orgId: s.orgId, connectionId: s.connectionId, name: s.name }))!;
      const buf = Buffer.from(row[field], 'base64');
      buf[0] = buf[0]! ^ 0xff;
      await db.c.secrets.updateOne({ _id: row._id }, { $set: { [field]: buf.toString('base64') } });
      await expect(store.get(s)).rejects.toBeInstanceOf(SecretDecryptionError);
      await db.c.secrets.updateOne({ _id: row._id }, { $set: { [field]: row[field] } });
      expect(await store.get(s)).toBe('value-123');
    }
  });

  test('the wrong KEK cannot decrypt, and the error reveals nothing', async () => {
    await new SecretStore(db, ring1()).put({ ...scope, name: 'kek' }, 'v', null);
    const other = new SecretStore(db, parseKeyring(`k1:${k2}`, 'k1'));
    await expect(other.get({ ...scope, name: 'kek' })).rejects.toThrow('Secret could not be decrypted');
  });

  test('missing secrets, has(), delete and deleteAllForConnection', async () => {
    const store = new SecretStore(db, ring1());
    await expect(store.get({ orgId: 'o', connectionId: 'c', name: 'nope' })).rejects.toBeInstanceOf(SecretNotFoundError);
    await store.put({ orgId: 'o', connectionId: 'c', name: 'a' }, 'x', null);
    await store.put({ orgId: 'o', connectionId: 'c', name: 'b' }, 'y', null);
    await store.put({ orgId: 'o', connectionId: 'other', name: 'a' }, 'z', null);
    expect(await store.has({ orgId: 'o', connectionId: 'c', name: 'a' })).toBe(true);
    expect(await store.getAll('o', 'c', ['a', 'b'])).toEqual({ a: 'x', b: 'y' });
    expect(await store.deleteAllForConnection('o', 'c')).toBe(2);
    expect(await store.has({ orgId: 'o', connectionId: 'c', name: 'a' })).toBe(false);
    expect(await store.has({ orgId: 'o', connectionId: 'other', name: 'a' })).toBe(true); // other connection untouched
  });

  test('KEK rotation: rewrap moves DEKs to the new key without touching plaintext; old key can then be retired', async () => {
    const s = { orgId: 'org-rot', connectionId: 'c', name: 'pw' };
    await new SecretStore(db, parseKeyring(`old:${k1}`, 'old')).put(s, 'rotate-me', null);
    const both = new SecretStore(db, parseKeyring(`old:${k1},new:${k2}`, 'new'));
    expect(await both.get(s)).toBe('rotate-me'); // still readable via the old key
    expect(await both.rewrapAll()).toBe(1);
    expect((await db.c.secrets.findOne({ orgId: 'org-rot' }))!.keyId).toBe('new');
    expect(await both.rewrapAll()).toBe(0);
    const onlyNew = new SecretStore(db, parseKeyring(`new:${k2}`, 'new'));
    expect(await onlyNew.get(s)).toBe('rotate-me');
  });

  test('empty secrets are rejected', async () => {
    await expect(new SecretStore(db, ring1()).put(scope, '', null)).rejects.toThrow(/empty/);
  });
});
