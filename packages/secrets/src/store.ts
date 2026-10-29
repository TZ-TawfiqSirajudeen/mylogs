import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { ClientSession, Database, SecretDoc } from '@nexus/database';
import type { Keyring } from './keyring.js';

/** Identifies one secret. The scope is part of the cipher's authenticated data, so a row can never be decrypted for another tenant/connection/name. */
export interface SecretScope { orgId: string; connectionId: string; name: string }

export class SecretNotFoundError extends Error {
  constructor() { super('Secret not found'); this.name = 'SecretNotFoundError'; }
}
export class SecretDecryptionError extends Error {
  // Deliberately generic: never reveal which part (key, scope, tamper) failed.
  constructor() { super('Secret could not be decrypted'); this.name = 'SecretDecryptionError'; }
}

const ALG = 'AES-256-GCM/v1' as const;
const aad = (s: SecretScope, version: number) => Buffer.from(`nexus.secret.v1|${s.orgId}|${s.connectionId}|${s.name}|${version}`);
const kekAad = (keyId: string, s: SecretScope) => Buffer.from(`nexus.dek.v1|${keyId}|${s.orgId}|${s.connectionId}|${s.name}`);
const b64 = (b: Buffer) => b.toString('base64');

function seal(key: Buffer, plaintext: Buffer, aadBytes: Buffer) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aadBytes);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return { iv, tag: c.getAuthTag(), ct };
}

function open(key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer, aadBytes: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(aadBytes);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

/**
 * Envelope encryption: every secret gets its own random 256-bit data key (DEK) used with AES-256-GCM; the DEK is wrapped
 * by a key-encryption key (KEK) from the platform's secret manager. The database only ever sees ciphertext + wrapped DEK.
 * We use Node's crypto primitives directly (no custom construction): AES-256-GCM, 96-bit random IVs, AAD binding.
 *
 * Not implemented: external KMS/Key Vault/Secrets Manager backends (the KEK is supplied by the platform at boot).
 */
export class SecretStore {
  constructor(private readonly db: Database, private readonly keyring: Keyring) {}

  /** Creates or replaces a secret (rotation replaces in place; old ciphertext is not retained). */
  async put(scope: SecretScope, plaintext: string, actorId: string | null, session?: ClientSession): Promise<{ version: number; updatedAt: Date }> {
    if (!plaintext) throw new Error('Secret value must not be empty');
    const existing = await this.db.c.secrets.findOne({ orgId: scope.orgId, connectionId: scope.connectionId, name: scope.name }, { session });
    const version = (existing?.version ?? 0) + 1;
    const dek = randomBytes(32);
    const kek = this.keyring.keys.get(this.keyring.currentKeyId)!;
    const data = seal(dek, Buffer.from(plaintext, 'utf8'), aad(scope, version));
    const wrapped = seal(kek, dek, kekAad(this.keyring.currentKeyId, scope));
    dek.fill(0);
    const now = new Date();
    const doc: Omit<SecretDoc, '_id' | 'createdAt'> = {
      orgId: scope.orgId, connectionId: scope.connectionId, name: scope.name, version, alg: ALG, keyId: this.keyring.currentKeyId,
      wrappedDek: b64(wrapped.ct), dekIv: b64(wrapped.iv), dekTag: b64(wrapped.tag),
      iv: b64(data.iv), tag: b64(data.tag), ciphertext: b64(data.ct), createdBy: actorId, updatedAt: now,
    };
    await this.db.c.secrets.updateOne(
      { orgId: scope.orgId, connectionId: scope.connectionId, name: scope.name },
      { $set: doc, $setOnInsert: { _id: crypto.randomUUID(), createdAt: now } },
      { upsert: true, session },
    );
    return { version, updatedAt: now };
  }

  async get(scope: SecretScope): Promise<string> {
    const doc = await this.db.c.secrets.findOne({ orgId: scope.orgId, connectionId: scope.connectionId, name: scope.name });
    if (!doc) throw new SecretNotFoundError();
    return this.decrypt(doc, scope);
  }

  /** Decrypts the named secrets for ONE connection; the caller must already have authorized access to that connection. */
  async getAll(orgId: string, connectionId: string, names: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const name of names) out[name] = await this.get({ orgId, connectionId, name });
    return out;
  }

  private decrypt(doc: SecretDoc, scope: SecretScope): string {
    try {
      // The scope used for AAD comes from the *caller*, not the row: a row moved to another tenant fails authentication.
      const kek = this.keyring.keys.get(doc.keyId);
      if (!kek) throw new Error('unknown key');
      const dek = open(kek, Buffer.from(doc.dekIv, 'base64'), Buffer.from(doc.dekTag, 'base64'), Buffer.from(doc.wrappedDek, 'base64'), kekAad(doc.keyId, scope));
      try {
        return open(dek, Buffer.from(doc.iv, 'base64'), Buffer.from(doc.tag, 'base64'), Buffer.from(doc.ciphertext, 'base64'), aad(scope, doc.version)).toString('utf8');
      } finally {
        dek.fill(0);
      }
    } catch {
      throw new SecretDecryptionError();
    }
  }

  async has(scope: SecretScope): Promise<boolean> {
    return (await this.db.c.secrets.countDocuments({ orgId: scope.orgId, connectionId: scope.connectionId, name: scope.name }, { limit: 1 })) > 0;
  }

  async delete(scope: SecretScope, session?: ClientSession): Promise<void> {
    await this.db.c.secrets.deleteOne({ orgId: scope.orgId, connectionId: scope.connectionId, name: scope.name }, { session });
  }

  async deleteAllForConnection(orgId: string, connectionId: string, session?: ClientSession): Promise<number> {
    return (await this.db.c.secrets.deleteMany({ orgId, connectionId }, { session })).deletedCount;
  }

  /** KEK rotation: re-wraps every DEK that is not under the current key. Plaintext secrets are never touched. Returns rows rewrapped. */
  async rewrapAll(): Promise<number> {
    const currentId = this.keyring.currentKeyId;
    const currentKek = this.keyring.keys.get(currentId)!;
    let n = 0;
    for await (const doc of this.db.c.secrets.find({ keyId: { $ne: currentId } })) {
      const scope = { orgId: doc.orgId, connectionId: doc.connectionId, name: doc.name };
      const oldKek = this.keyring.keys.get(doc.keyId);
      if (!oldKek) continue; // cannot unwrap without the old key: leave as is, operator must restore it
      const dek = open(oldKek, Buffer.from(doc.dekIv, 'base64'), Buffer.from(doc.dekTag, 'base64'), Buffer.from(doc.wrappedDek, 'base64'), kekAad(doc.keyId, scope));
      const w = seal(currentKek, dek, kekAad(currentId, scope));
      dek.fill(0);
      await this.db.c.secrets.updateOne({ _id: doc._id, keyId: doc.keyId }, { $set: { keyId: currentId, wrappedDek: b64(w.ct), dekIv: b64(w.iv), dekTag: b64(w.tag) } });
      n++;
    }
    return n;
  }
}
