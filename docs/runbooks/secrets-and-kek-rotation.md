# Runbook: credential storage and key rotation

## How secrets are stored
- Each credential gets its own random 256-bit data key (DEK); the value is sealed with AES-256-GCM.
- The DEK is wrapped by a **key-encryption key (KEK)** that comes from the platform (`SECRETS_KEYS`), never from the database.
- Both seals are bound (AAD) to `orgId | connectionId | secretName | version`, so a stolen or copied row cannot be decrypted in another tenant/connection.
- The API never returns a secret. Connection responses list only which fields are set and when.
- Production **refuses to start** without `SECRETS_KEYS`. In development a throwaway KEK is generated once into `.dev-secrets/kek.json` (git-ignored).

## Configure
```
# 32 random bytes, base64 — generate with:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
SECRETS_KEYS="2026-10:<base64>"
SECRETS_CURRENT_KEY_ID="2026-10"
```
Inject through your secret manager / platform identity (Key Vault reference, AWS Secrets Manager, Kubernetes secret from an external operator). Do not bake into images or commit.

## Rotate the KEK (no downtime, no plaintext exposure)
1. Generate a new key and **add** it, keeping the old one: `SECRETS_KEYS="2026-10:<old>,2027-04:<new>"`, `SECRETS_CURRENT_KEY_ID="2027-04"`. Deploy API and worker.
2. New and updated secrets now use the new KEK; old rows still decrypt with the old one.
3. Re-wrap existing rows: run `SecretStore.rewrapAll()` (idempotent; returns the number of rows moved). Only wrapped data keys change; values are never decrypted.
4. Verify `db.secrets.countDocuments({ keyId: { $ne: "2027-04" } })` is `0`, then remove the old key from `SECRETS_KEYS`.
5. If a row cannot be unwrapped because the old key was removed too early, the connection reports "stored credentials could not be decrypted"; restore the old key or have an admin rotate that connection's credentials.

## Rotate a connection credential
UI: Data Sources → *Rotate credentials*, or `POST /api/v1/projects/:id/connections/:cid/rotate`. The new value replaces the old one atomically, the connection is **re-tested immediately**, and the result (including failures) is shown. Audit records the field names, never values.

## Revoke
*Disconnect* stops monitoring and **deletes** the stored credentials. *Delete* removes the connection and its credentials. Abandoned wizard drafts are purged after 24 h by the worker.

## Backups and exports
Backups contain ciphertext and wrapped keys only; without the KEK they are useless. Back up the KEK separately in your secret manager. Losing every copy of the KEK makes stored credentials unrecoverable (users must re-enter them).
