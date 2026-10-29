# ADR-0004: Single sign-on with OpenID Connect

Status: accepted. Implementation notes and operator guide: [docs/auth-oidc.md](../auth-oidc.md).

## Decision
* **Authorization Code flow with PKCE (S256), confidential client**, in the API process, using the certified `openid-client` library for the protocol
  (discovery, PKCE, state, nonce, RFC 9207 `iss` check, `iss`/`aud`/`exp`/`iat` checks) **plus** explicit ID-token signature/`azp` verification with `jose`
  against the provider's JWKS (asymmetric algorithms only) — because the library does not verify the signature for the code flow.
* **Server-side sessions only.** The browser holds an opaque HttpOnly cookie; no OIDC token is stored or sent to the browser. A new session is minted at
  sign-in (no fixation); every request re-checks the user and organization membership, so removal/disabling is immediate.
* **Identity = (issuer, sub).** E-mail is used once, to attach a provider account to an account an administrator created, and only if verified.
* **Authorization stays in Nexus.** Token claims never grant roles. Invite-only provisioning is the default; JIT is opt-in with a mandatory domain allow-list
  and creates a member with no project access; an optional group map applies only at first provisioning and can never yield `owner`.
* **CSRF:** sign-in is protected by a one-time `state` bound to the browser by a flow cookie; API writes keep Origin + synchronizer-token checks.
* Telemetry ingestion keeps its own token authentication and is unaffected by the sign-in mode.

## Alternatives rejected
* Hand-rolled OIDC/JWT handling (high risk of subtle validation bugs). * Storing refresh tokens to extend sessions (a long-lived credential at rest, not needed).
* Trusting the `email` claim as identity or `roles`/`groups` claims as authorization (mutable by the provider's tenant admins; account-takeover risk).
* Session JWTs in the browser (not revocable).

## Consequences / residual risk
* Verified against a mock provider and in a real browser; **not** against Entra ID or another live provider (needs credentials). Provider-specific behaviour
  (optional claims, end-session, group claims) must be checked in staging.
* No MFA in Nexus itself: enforce it at the identity provider.
* Session lifetime is fixed server-side (idle + absolute); there is no back-channel logout, so a user disabled at the IdP keeps their Nexus session until it
  expires or an admin revokes it (Settings → Members → *Sign out everywhere*).
