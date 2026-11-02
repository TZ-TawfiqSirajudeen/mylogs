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
| `OIDC_ISSUER` | yes | Issuer URL; discovery is read from `<issuer>/.well-known/openid-configuration`. https in production. Copy it from the provider's discovery document **exactly**: a path is used as written, trailing slash included (Azure AD B2C, Authentik and Entra v1.0 publish `https://host/tenant/v2.0/`); for a bare host the slash does not matter. It is also the issuer half of every user's `(issuer, sub)` identity, so changing it later makes existing users look like new people. |
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

   **Security notes for Entra.** Use the **tenant-specific** issuer (never `common`/`organizations`: their discovery document serves
   the literal template `https://login.microsoftonline.com/{tenantid}/v2.0`, which does not match, and Nexus refuses it).
   With `REQUIRE_EMAIL_VERIFIED=false`, e-mail is trusted for the *first* binding only, so make sure only your tenant can sign in
   (single-tenant registration; *Enterprise applications → Properties → Assignment required = Yes* limits it to assigned users).
   Entra's `email` claim is mutable by tenant admins, which is exactly why Nexus binds `(issuer, sub)` after the first sign-in
   and never trusts the e-mail again.

   * **Without the optional `email` claim an Entra user cannot sign in at all.** `preferred_username` and `upn` are used only as a
     display-name fallback and are **never** treated as an e-mail address (they are mutable and not guaranteed to be a mailbox).
   * Entra's `sub` is pairwise per application registration; Nexus keys identities on it exactly as sent. Re-registering the
     application (new client id) therefore produces new `sub` values and looks like new people to Nexus.
   * Keep `OIDC_PROVISIONING=invite-only` with `REQUIRE_EMAIL_VERIFIED=false`. Combining `jit` with `false` lets anybody whose
     directory entry carries an address in an allowed domain create an account, including any account whose address you do not
     control; Nexus accepts the combination (the domain list is mandatory) but it is only as safe as your tenant's address hygiene.
   * When a user belongs to too many groups Entra omits the `groups` claim and sends `_claim_names`/`_claim_sources` instead. Nexus
     never follows those pointers; such a user is provisioned as a plain member (or is simply signed in, if already known). Map
     groups by their **object id (GUID)**, not by name, in `OIDC_GROUP_ROLE_MAP`.
   * The ID token is validated against the issuer from the discovery document, so a v1.0-style token (`https://sts.windows.net/<tid>/`)
     is refused by an app configured with the `/v2.0` issuer. Use the v2.0 issuer shown above; this was verified only by
     simulation (a token whose `iss` is the v1.0 URL), not against a live tenant.

### Any other OpenID Connect provider (Okta, Auth0, Keycloak, Google Workspace, …)

Create a **Web / confidential** application with the redirect URI above; set `OIDC_ISSUER` to the issuer URL shown in the
provider's discovery document (it must equal the `issuer` value in `/.well-known/openid-configuration` exactly — Nexus rejects a
mismatch); set `OIDC_PROVIDER_NAME`. Leave `OIDC_REQUIRE_EMAIL_VERIFIED=true` for providers that send `email_verified`
(a boolean, or the strings `"true"`/`"false"`; any other value counts as not verified).

Interoperability details Nexus handles: the client secret is sent with HTTP Basic by default, and in the request body when the
provider's discovery document advertises `client_secret_post` and not `client_secret_basic`. Providers that only support
`private_key_jwt` / `client_secret_jwt` are **not** supported. The RFC 9207 `iss` response parameter is required only when the
provider advertises `authorization_response_iss_parameter_supported`. A provider with no `end_session_endpoint` (several have none)
still signs people out of Nexus; their provider session simply stays. Every HTTP call to the provider is capped at 10 seconds.

## Verification status

**No sign-in has ever been performed against Microsoft Entra ID or any other real identity provider.** That needs a tenant, an app
registration and a client secret that this repository's development environment does not have. What *has* been verified is the
relying party's behaviour against the in-repo mock provider (`packages/mock-idp`), including configurations that imitate what real
providers send. Treat every item under "Not verified" as a go-live check, not as a known-good.

### Verified (mock provider, automated)

| Area | Evidence |
|---|---|
| Authorization code + PKCE S256, state, nonce, RFC 9207 `iss`, one-time flow records, session fixation, logout, CSRF, RBAC and tenant isolation under SSO sessions | `apps/api/test/oidc.test.ts` (80 tests), `tests/e2e/specs/11-oidc.spec.ts` (12 browser specs) |
| Invalid ID tokens never create a session: bad signature, wrong nonce / audience / issuer, expired, not yet valid, missing `sub`, missing nonce, `alg=none`, wrong `azp`, no ID token | `oidc.test.ts` (tamper table) |
| **Key confusion:** an HS256 token signed with the client secret, and a token whose `alg` the published key does not allow, are refused | `oidc-provider-quirks.test.ts` |
| **Clock skew:** `exp`/`nbf` 20 s off are accepted and 45 s off are refused at the default 30 s tolerance; tolerance 0 is strict. (An `iat` in the future was **not** tested; from reading the libraries it is only type-checked.) | `oidc-provider-quirks.test.ts` |
| **JWKS:** an endpoint error or a hang (cut off at about 5 s) fails the sign-in cleanly and the next attempt works; after a key rotation an unknown `kid` causes at most **one** refetch per 30 s cool-down (repeated failures do not hit the provider), then sign-in recovers | `oidc-provider-quirks.test.ts` |
| **Slow providers:** discovery that hangs is cut off at about 10 s with a clean "provider not reachable" redirect and is retried next time (a failed discovery is never cached); a token endpoint that hangs is cut off at 10 s | `oidc-provider-quirks.test.ts` |
| **Entra v2.0 shape** (issuer `…/<tenant-id>/v2.0`, `tid`/`oid`/`ver` claims, no `email_verified`): refused by default, accepted with `OIDC_REQUIRE_EMAIL_VERIFIED=false`, bound to `(issuer, sub)`; **no `email` claim means no sign-in even when `preferred_username`/`upn` equal another user's address** (no binding, no session); v1.0-style `iss` refused; extra token-response fields (`ext_expires_in`, `foci`, `client_info`), a string `expires_in` and a lowercase `token_type` are tolerated; the multi-tenant `/common` template issuer `{tenantid}` is refused | `oidc-provider-quirks.test.ts` |
| **Issuer shapes:** bare host, bare host with trailing slash, path, and path with trailing slash all sign in, and the stored identity issuer is the provider's own string | `oidc-provider-quirks.test.ts` (and the unit test for configuration normalisation) |
| Discovery issuer different from the configured one is refused and does not leave a half-started flow | `oidc-provider-quirks.test.ts` |
| Multi-audience tokens (`aud` array with `azp` = this client) accepted; `azp` for another client refused; providers that do not implement RFC 9207 work; one that advertises it and omits it is refused | `oidc-provider-quirks.test.ts` |
| Provider error responses (`login_required`, `interaction_required`, `consent_required`, `temporarily_unavailable`, `server_error`, `invalid_scope`, a 5,000-character error code) all become one generic message; an unregistered redirect URI never sends the browser back | `oidc-provider-quirks.test.ts` |
| Client authentication: `client_secret_basic` and, when only that is advertised, `client_secret_post` | `oidc-provider-quirks.test.ts` |
| Hostile claim values: markup and control characters in `name` are removed and the name is capped at 100 characters; an over-long e-mail, an over-long `sub`, an e-mail with whitespace and a look-alike (Cyrillic) domain are refused; e-mail letter case still binds to the pre-created account; `email_verified` as the strings `"true"`/`"false"` is honoured; groups overage (`_claim_names`) yields a plain member; GUID groups map only when listed; a groups claim sent as a single string grants nothing | `oidc-provider-quirks.test.ts` |
| A user disabled after being bound cannot sign in and their live session stops working; logout works (session revoked, no redirect) when the provider has no `end_session_endpoint` | `oidc-provider-quirks.test.ts` |
| Configuration refusals: `http://` issuers (outside the dev flag), production with dev settings, redirect URI off the web origin, invalid role maps | `apps/api/src/config.test.ts` |

### Found and fixed by simulating real providers

1. **An issuer with a path and a trailing slash made discovery fail.** Configuration stripped the trailing slash, but the library
   compares the provider's `issuer` as a URL, in which a trailing slash after a path is significant, so a provider that publishes
   `https://host/tenant/v2.0/` (Azure AD B2C, Authentik and Entra v1.0 are documented to do so; not tested against them) could never sign anyone in. A path is now kept exactly as configured (`apps/api/src/auth/oidc-config.ts`).
2. **A hanging token endpoint was held open for the library default of 30 s** (and a 16 s stall still *succeeded*). Every call to the
   provider is now capped at 10 s (`IDP_HTTP_TIMEOUT_SECONDS` in `apps/api/src/auth/oidc.ts`).
3. **A provider that advertises only `client_secret_post` could not be used.** Nexus always sent HTTP Basic. It now follows the
   provider's advertised method (basic when basic is offered, post when only post is).

Each has a regression test in `apps/api/test/oidc-provider-quirks.test.ts` (they failed before the fix).

### Not verified (needs a real tenant; do these in staging)

* A real sign-in against Entra ID, and against any other provider you intend to use. Follow
  [docs/runbooks/oidc-staging-verification.md](runbooks/oidc-staging-verification.md).
* That the provider's real discovery document, JWKS and token endpoint behave as the mock does: TLS to the provider, real key rotation
  timing (the JWKS cache lifetime is the library default; not exercised here), real token lifetimes and clock difference.
* Which claims your tenant actually puts in the ID token (`email`, `preferred_username`, `groups`, `tid`) under your optional-claims
  and group-claims configuration.
* Entra's behaviour for `post_logout_redirect_uri`, guest and multi-tenant users, Conditional Access / MFA interrupting the flow,
  consent prompts, and group overage in a large directory.
* Provider-specific refresh, back-channel logout and session-lifetime behaviour (Nexus uses none of them; a user disabled at the
  provider keeps their Nexus session until it expires or an admin revokes it).
* Behind a real reverse proxy: `WEB_ORIGIN`, `Secure` / `__Host-` cookies in a browser over HTTPS, and `trustProxy` (the browser specs run over plain `http://localhost`).

### Staging sign-in checklist (summary)

Full steps, expected results and what to capture are in [docs/runbooks/oidc-staging-verification.md](runbooks/oidc-staging-verification.md).
Tick each before enabling SSO for anyone beyond the pilot group:

- [ ] App registered with the exact redirect URI, optional `email` claim added, secret stored in the secret store with its expiry date noted
- [ ] `OIDC_ISSUER` copied from the provider's discovery document; `curl <issuer>/.well-known/openid-configuration` returns that same `issuer`
- [ ] API starts (misconfiguration stops it with a message naming the variable)
- [ ] An invited user signs in; `auth.login` appears in the audit trail with `identityBound: true` on the first sign-in only
- [ ] A user who was **not** invited is refused with the generic "not authorized" page and no account appears
- [ ] A user whose ID token has no `email` is refused; nothing is bound
- [ ] A second sign-in after changing the user's e-mail at the provider still lands on the same Nexus user
- [ ] Sign out ends the Nexus session; the provider's own session behaves as documented for that provider
- [ ] A user removed from the organization (and disabled at the provider) cannot sign in and their open tab gets 401 on the next request
- [ ] Provider outage drill: block the provider's host; new sign-ins show "not reachable", existing sessions keep working; unblock and retry works without a restart
- [ ] Rollback rehearsed (see the runbook): the previous mode can be restored and nobody is locked out

### Rollback

SSO changes no data you cannot undo: identities are bound by adding `externalIssuer` / `externalSubject` to the user record.
To roll back, set `AUTH_MODE` back to the previous mode **only outside production** (production refuses `dev`), or keep the old
`OIDC_*` values and redeploy the previous release; to unbind one person, clear their `externalIssuer`/`externalSubject` in the
`users` collection under change control. A user locked out by a wrong issuer or tenant is recovered by correcting `OIDC_ISSUER`
(see the identity-key warning in the configuration table) or by adding a membership directly in MongoDB (see Operations).

## Operations

* **Revoke everyone / one person**: Settings → Members → *Sign out everywhere*, or `POST …/revoke-sessions`.
* **Provider outage**: existing sessions keep working; new sign-ins show "identity provider not reachable" (discovery is retried).
* **Audit events**: `auth.login` (mode, whether the account was provisioned or newly bound), `auth.login_denied` (reason, only
  when the person is known), `auth.logout`, `org.member_added|role_changed|removed|sessions_revoked`.
* **Break-glass access**: there is deliberately none through the UI. Recovering from a locked-out organization means adding a
  membership directly in MongoDB (`org_memberships`) under your normal change-control; sign-in then binds as usual.
