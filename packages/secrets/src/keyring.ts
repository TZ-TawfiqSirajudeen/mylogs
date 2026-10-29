import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Key-encryption keys. The current key wraps new data keys; older keys stay available only to unwrap/rewrap. */
export interface Keyring {
  currentKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
}

const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * SECRETS_KEYS="id1:<base64 32 bytes>,id2:<base64 32 bytes>", SECRETS_CURRENT_KEY_ID="id1".
 * In production the KEK must be injected by the platform (managed secret / Key Vault / KMS-decrypted at boot);
 * it must never be stored in the database or image.
 */
export function parseKeyring(keysSpec: string, currentKeyId: string): Keyring {
  const keys = new Map<string, Buffer>();
  for (const part of keysSpec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf(':');
    const id = part.slice(0, i);
    const b64 = part.slice(i + 1);
    if (i < 1 || !KEY_ID.test(id)) throw new Error('Invalid SECRETS_KEYS entry (expected "id:base64")');
    const key = Buffer.from(b64, 'base64');
    if (key.length !== 32) throw new Error(`Secret key "${id}" must be exactly 32 bytes (base64 of 32 random bytes)`);
    if (keys.has(id)) throw new Error(`Duplicate secret key id "${id}"`);
    keys.set(id, key);
  }
  if (keys.size === 0) throw new Error('SECRETS_KEYS contains no keys');
  if (!keys.has(currentKeyId)) throw new Error('SECRETS_CURRENT_KEY_ID does not match any key in SECRETS_KEYS');
  return { currentKeyId, keys };
}

export interface KeyringEnv {
  SECRETS_KEYS?: string | undefined;
  SECRETS_CURRENT_KEY_ID?: string | undefined;
}

/**
 * Production: SECRETS_KEYS is mandatory (refuses to start otherwise).
 * Development: if absent, a random KEK is generated once into `devKeyFile` (git-ignored). NOT a production practice.
 */
export function loadKeyring(env: KeyringEnv, opts: { production: boolean; devKeyFile: string }): Keyring {
  if (env.SECRETS_KEYS) {
    return parseKeyring(env.SECRETS_KEYS, env.SECRETS_CURRENT_KEY_ID ?? env.SECRETS_KEYS.split(',')[0]!.split(':')[0]!.trim());
  }
  if (opts.production) {
    throw new Error('Refusing to start: SECRETS_KEYS is required in production (inject a key-encryption key from your secret manager)');
  }
  if (!existsSync(opts.devKeyFile)) {
    mkdirSync(dirname(opts.devKeyFile), { recursive: true });
    writeFileSync(opts.devKeyFile, JSON.stringify({ id: 'dev-1', key: randomBytes(32).toString('base64') }), { mode: 0o600 });
  }
  const { id, key } = JSON.parse(readFileSync(opts.devKeyFile, 'utf8')) as { id: string; key: string };
  return parseKeyring(`${id}:${key}`, id);
}

export const generateKeyBase64 = () => randomBytes(32).toString('base64');
