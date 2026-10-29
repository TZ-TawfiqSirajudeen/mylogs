# Single sign-on (OpenID Connect)

Nexus authenticates people with **OpenID Connect, Authorization Code flow with PKCE**, in the API process (a confidential
client: the token exchange happens server to server). The browser only ever holds an opaque, HttpOnly session cookie.
Telemetry senders are unaffected: they use per-environment **ingestion tokens** on the separate ingestion service
(`apps/ingest`), which has no dependency on the sign-in mode.

Mode is selected with `AUTH_MODE`:

| `AUTH_MODE` | Meaning |
|---|---|
| `dev` | Passwordless sign-in as seeded demo users. **Refused when `NODE_ENV=production`.** The dev endpoint does not exist in `oidc` mode. |
| `oidc` | Single sign-on as described here. Required in production. |

## How a sign-in works

```
Browser                    Nexus API                          Identity provider
  | GET /api/v1/auth/oidc/login?returnTo=/logs?x=1                    |
  |--------------------------->|  create one-time flow record         |
  |                            |  {state hash, nonce, PKCE verifier}  |
  |<--- 302 to IdP + flow cookie (HttpOnly, 10 min)                   |
  |------------------------------------------------------------------>| authenticate user
  |<-- 302 /api/v1/auth/oidc/callback?code&state&iss -----------------|
  |--------------------------->|  consume flow record (single use)    |
  |                            |  POST /token  (code + PKCE verifier + client secret)
  |                            |<-------------------------------------| id_token
  |                            |  verify signature (JWKS), iss, aud, azp, exp/nbf, nonce, state, iss param
  |                            |  resolve identity -> org membership (server-side only)
  |<--- 302 to returnTo + NEW session cookie (old session revoked)    |
```

### What is validated, and where

| Check | Done by |
|---|---|
| `state` (CSRF on the callback) and binding of the flow to the browser that started it | server-side flow record keyed by a one-time `state`, plus the flow cookie; single use, 10-minute lifetime |
| PKCE (`S256`) | `openid-client` (certified library) |
| Authorization response `iss` parameter (RFC 9207, mix-up attacks) | `openid-client` |
| `redirect_uri` | built from `OIDC_REDIRECT_URI`, never from request headers; must be on `WEB_ORIGIN`; the provider must have it registered exactly |
| ID token **signature** against the provider's JWKS | `jose` (`jwtVerify`) — `openid-client` does *not* verify the signature for the code flow, so this is explicit. Asymmetric algorithms only (`none` and HMAC are refused) |
| `iss`, `aud`, `azp`, `exp`, `nbf`, `iat` | `openid-client` and `jose` (with `OIDC_CLOCK_TOLERANCE_SECONDS`, default 30, max 120) |
| `nonce` | checked twice (library + our verification) against the value stored for this browser's flow |
| Replay of a captured callback URL | flow record is deleted on first use; the authorization code is also single-use at the provider |

Failures show the user one of four generic messages (`idp_denied`, `not_authorized`, `login_failed`, `idp_unavailable`). The
precise reason (`state mismatch`, `bad signature`, `not_provisioned`, …) goes to the server log only — never the e-mail address,
token, authorization code or claims.

## Who is allowed in, and what they may do

Authentication proves *who someone is*. **Authorization always comes from Nexus's own tables** (organization membership,
project grants, environment scoping). Claims in the token never grant a role: `role`, `roles`, `admin`, `groups` and
admin-looking e-mail addresses are ignored unless you configure the optional group map below.

* **Identity** = `(issuer, sub)`. An e-mail address is only used the *first* time, to attach a provider account to an account an
  administrator already created — and only when the provider says `email_verified` (`OIDC_REQUIRE_EMAIL_VERIFIED=true`, the
  default). A different `sub` presenting the e-mail of an already-bound account is refused (no takeover by e-mail reuse).
* **`OIDC_PROVISIONING=invite-only` (default)** — nobody can register themselves. An owner/admin adds people under
  **Settings → Members** (or `POST /api/v1/org/members`); that person can then sign in.
* **`OIDC_PROVISIONING=jit`** (opt-in) — first sign-in creates a plain **member** with *no project access*. It is refused unless
  you also set `OIDC_DEFAULT_ORG_SLUG` and `OIDC_ALLOWED_EMAIL_DOMAINS` (no open registration).
* **`OIDC_GROUP_ROLE_MAP`** (opt-in, JSON, e.g. `{"nexus-admins":"admin","auditors":"auditor"}`) — applied **only when an account
  is first provisioned**, never later, and it can never produce `owner`. Ownership is granted inside Nexus.
* Disabled users, users removed from the organization and users with no membership cannot sign in; their live sessions stop
  working immediately (every request re-checks membership).

Member management API (owner/admin; see the OpenAPI document at `/docs` outside production): `GET|POST /api/v1/org/members`,
`PATCH|DELETE /api/v1/org/members/:userId`, `POST /api/v1/org/members/:userId/revoke-sessions`. Rules enforced server-side:
admins manage only member/auditor accounts; only owners create/modify/remove admins and owners; nobody changes their own role or
removes themselves; an organization always keeps at least one owner (race-safe); removals and role changes revoke sessions;
everything is audited.

## Sessions, cookies and CSRF

* Server-side sessions: only the SHA-256 of the cookie token is stored. Idle timeout and absolute lifetime are enforced on every
  request. A new session is minted at every sign-in and any session present before sign-in is revoked (**no session fixation**).
* Cookie: `HttpOnly`, `SameSite=Lax`, `Path=/`, and in production `Secure` with the `__Host-` prefix (host-only, no `Domain`).
  The short-lived sign-in flow cookie has the same attributes.
* CSRF: sign-in itself is a top-level GET, so login CSRF is prevented by the one-time `state` + flow-cookie binding. Every
  state-changing API request additionally needs the per-session `x-csrf-token` header and an allowed `Origin`.
* No access, refresh or ID token is stored or sent to the browser; nothing sensitive lives in `localStorage`.
* Sign out revokes the Nexus session, clears the cookie and (when the provider advertises `end_session_endpoint`) sends the
  browser to the provider's logout so the single-sign-on session ends too.

## Configuration

| Variable | Required | Notes |
|---|---|---|
| `AUTH_MODE=oidc` | yes | |
| `WEB_ORIGIN` | yes | Public origin users type, e.g. `https://nexus.example.com` (https in production). Also the CSRF `Origin` allow-list. |
| `OIDC_ISSUER` | yes | Issuer URL; discovery is read from `<issuer>/.well-known/openid-configuration`. https in production. |
| `OIDC_CLIENT_ID` | yes | |
| `OIDC_CLIENT_SECRET` **or** `OIDC_CLIENT_SECRET_FILE` | recommended | Confidential client. Prefer the file form (mounted secret). Never baked into images, logged, or returned by any endpoint. Omit only for a public client with PKCE (not recommended). |
| `OIDC_REDIRECT_URI` | no | Default `<WEB_ORIGIN>/api/v1/auth/oidc/callback`. Must be on `WEB_ORIGIN`. |
| `OIDC_POST_LOGOUT_REDIRECT_URI` | no | Default `<WEB_ORIGIN>/`. Register it at the provider. |
| `OIDC_SCOPES` | no | Default `openid profile email`. |
| `OIDC_PROVIDER_NAME` | no | Label on the button, e.g. `Microsoft`. |
| `OIDC_PROVISIONING` | no | `invite-only` (default) or `jit` — see above. |
| `OIDC_DEFAULT_ORG_SLUG` | jit | Organization new users join; also the organization chosen at sign-in for users in several. |
| `OIDC_ALLOWED_EMAIL_DOMAINS` | jit | Comma-separated, e.g. `acme.com`. Also enforced for first sign-in of invited users when set. |
| `OIDC_REQUIRE_EMAIL_VERIFIED` | no | Default `true`. See the Entra note below. |
| `OIDC_GROUPS_CLAIM`, `OIDC_GROUP_ROLE_MAP` | no | Optional role seeding (first provisioning only, never owner). |
| `OIDC_CLOCK_TOLERANCE_SECONDS` | no | Default 30. |
| `OIDC_ALLOW_INSECURE_ISSUER` | dev only | Allows an `http://` issuer for a local provider. **Refused in production.** |

Misconfiguration stops the API at startup with a message that names the variables involved and never prints values.

The client secret is stored only where you put it: an environment variable or a mounted secret file read at start-up. The config
object keeps it non-enumerable, so serializing or logging the configuration cannot leak it, and request logs strip the callback
query string (which carries the one-time code). **Rotating it:** create a second secret at the provider, deploy it, then delete
the old one — sign-ins in flight at restart simply start again.

## Local development (no real provider needed)

A standards-compliant mock OpenID provider ships in `packages/mock-idp` (**a test double — never deploy it**).

```bash
pnpm dev:mongo                                    # terminal 1 (prints the MongoDB URI)
pnpm dev:idp                                      # terminal 2: mock IdP on http://127.0.0.1:9000
AUTH_MODE=oidc OIDC_ISSUER=http://127.0.0.1:9000 OIDC_ALLOW_INSECURE_ISSUER=true \
OIDC_CLIENT_ID=nexus-local OIDC_CLIENT_SECRET=local-dev-secret-change-me \
  pnpm --filter @nexus/api dev -- --seed          # terminal 3  (seeds the demo organizations; users are bound on first sign-in)
pnpm dev:web                                      # terminal 4 -> http://localhost:5173, click "Sign in with …"
```

The mock lists three identities (`owner@acme.test`, `viewer@acme.test`, `newhire@acme.test`); the first two match seeded
users, `newhire` is refused until an owner adds them under Settings → Members. `docker compose --profile oidc` runs the same
thing in containers.

## Registering the application at a real provider

All providers need: **redirect URI** `https://<your host>/api/v1/auth/oidc/callback`, optional **post-logout redirect URI**
`https://<your host>/`, flow = **authorization code**, a **client secret** (confidential/web client), scopes `openid profile email`.

### Microsoft Entra ID

1. *Entra admin centre → App registrations → New registration.* Name `Nexus Observability`; supported account types: *single
   tenant* unless you deliberately want multi-tenant. Redirect URI platform **Web**: the callback URL above.
2. *Authentication*: leave the implicit-grant / hybrid-flow boxes **off**. For single sign-out, also add the post-logout URL
   (`https://<your host>/`) as a Web redirect URI — Entra only honours a `post_logout_redirect_uri` that is registered (not verified here).
3. *Certificates & secrets → New client secret* (note the expiry date; put the **value** in your secret store).
4. *Token configuration → Add optional claim → ID → `email`* (and `preferred_username`); grant the consent prompt for Microsoft Graph
   `email`/`profile` if asked. Optionally add the `groups` claim if you will use `OIDC_GROUP_ROLE_MAP`.
5. *Overview*: copy **Application (client) ID** and **Directory (tenant) ID**.
6. Configure Nexus:

```
AUTH_MODE=oidc
OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
OIDC_CLIENT_ID=<application-client-id>
OIDC_CLIENT_SECRET_FILE=/run/secrets/nexus_oidc_client_secret
OIDC_PROVIDER_NAME=Microsoft
# Entra v2.0 ID tokens usually carry no email_verified claim. Because the tenant itself vouches for its members' addresses
# in a single-tenant app, this is the one case for turning the check off:
OIDC_REQUIRE_EMAIL_VERIFIED=false
```

   **Security notes for Entra.** Use the **tenant-specific** issuer (never `common`/`organizations`, whose issuer varies per tenant).
   With `REQUIRE_EMAIL_VERIFIED=false`, e-mail is trusted for the *first* binding only, so make sure only your tenant can sign in
   (single-tenant registration; *Enterprise applications → Properties → Assignment required = Yes* limits it to assigned users).
   Entra's `email` claim is mutable by tenant admins, which is exactly why Nexus binds `(issuer, sub)` after the first sign-in
   and never trusts the e-mail again.

### Any other OpenID Connect provider (Okta, Auth0, Keycloak, Google Workspace, …)

Create a **Web / confidential** application with the redirect URI above; set `OIDC_ISSUER` to the issuer URL shown in the
provider's discovery document (it must equal the `issuer` value in `/.well-known/openid-configuration` exactly — Nexus rejects a
mismatch); set `OIDC_PROVIDER_NAME`. Leave `OIDC_REQUIRE_EMAIL_VERIFIED=true` for providers that send `email_verified`.

### What could not be verified here

Everything above is exercised against the **mock provider only** (tests/e2e/specs/11-oidc.spec.ts, apps/api/test/oidc.test.ts).
No sign-in has been performed against Entra ID or any real provider, because that needs a tenant, an app registration and a
client secret that this repository's development environment does not have. Provider-specific details (Entra optional claims,
end-session behaviour, group claims, token lifetimes) are therefore **unverified against the live service** and should be
checked in a staging tenant before go-live.

## Operations

* **Revoke everyone / one person**: Settings → Members → *Sign out everywhere*, or `POST …/revoke-sessions`.
* **Provider outage**: existing sessions keep working; new sign-ins show "identity provider not reachable" (discovery is retried).
* **Audit events**: `auth.login` (mode, whether the account was provisioned or newly bound), `auth.login_denied` (reason, only
  when the person is known), `auth.logout`, `org.member_added|role_changed|removed|sessions_revoked`.
* **Break-glass access**: there is deliberately none through the UI. Recovering from a locked-out organization means adding a
  membership directly in MongoDB (`org_memberships`) under your normal change-control; sign-in then binds as usual.
