# Runbook: verify single sign-on against a real identity provider (staging)

Why this exists: Nexus's OpenID Connect sign-in has been verified only against the in-repo mock provider and simulations of real-provider
behaviour (`docs/auth-oidc.md` → "Verification status"). **No real provider has been used.** Do this in a staging deployment, with a
test tenant or a small pilot group, before enabling SSO for everyone. It takes about an hour.

Do not paste secrets, tokens, authorization codes or full ID tokens into tickets, chat or screenshots. The steps below say what to capture instead.

## 0. Prerequisites
* A staging deployment of Nexus on **https** (production refuses `http://` issuers and `Secure`-less cookies), reachable at `WEB_ORIGIN`, with `AUTH_MODE=oidc`.
* Two test people in the provider: **A** (will be invited) and **B** (will not). A third person **C** whose ID token will not carry an `email`
  (for Entra: do not give C a mailbox / leave the optional `email` claim unconfigured for a second app registration, or use a service account).
* An owner account in Nexus able to open **Settings → Members** and the audit log. Rollback access to the deployment configuration (step 11).
* Rollback plan read (step 11) **before** starting.

## 1. Register the application at the provider
Follow the provider's section in `docs/auth-oidc.md` ("Registering the application at a real provider"). Record, **without secret values**:
redirect URI, post-logout redirect URI, client id, tenant / issuer, secret expiry date, who owns the registration.
Expected: the redirect URI is exactly `https://<WEB_ORIGIN host>/api/v1/auth/oidc/callback`.

## 2. Check the discovery document against what you will configure
```bash
curl -s https://<issuer>/.well-known/openid-configuration | jq '{issuer, jwks_uri, token_endpoint, end_session_endpoint, id_token_signing_alg_values_supported, token_endpoint_auth_methods_supported, authorization_response_iss_parameter_supported}'
```
Expected:
* `issuer` equals what you will put in `OIDC_ISSUER`, character for character (trailing slash on a path included). For Entra it is
  `https://login.microsoftonline.com/<tenant-id>/v2.0`; for `/common` it contains `{tenantid}` and **must not be used**.
* `id_token_signing_alg_values_supported` includes an asymmetric algorithm (typically `RS256`).
* `token_endpoint_auth_methods_supported` lists `client_secret_basic` or `client_secret_post` (`private_key_jwt`-only is unsupported).
Capture: the JSON above (it contains no secrets).

## 3. Configure Nexus and start it
Set the `OIDC_*` variables (see the Entra example in `docs/auth-oidc.md`; secret via `OIDC_CLIENT_SECRET_FILE`). Keep `OIDC_PROVISIONING=invite-only`.
Expected: the API starts. A misconfiguration stops it with a message naming the variable (never the value). Open `https://<host>/` — a
"Sign in with <provider>" button appears.
Capture: the start-up log lines (no secret appears in them; if one does, stop and report it).

## 4. First sign-in as an invited user (A)
1. In Nexus, **Settings → Members → Add** A's e-mail (the address the provider will put in the token).
2. In a private browser window open `https://<host>/` and sign in as A.
Expected: you land on the app, signed in as A. Settings → Members shows A. The audit trail has `auth.login` with `mode: oidc` and
`identityBound: true` (first sign-in only).
Capture: a screenshot of the signed-in header (A's name only), the audit entry. In the browser dev tools confirm the cookie is
`__Host-…`, `HttpOnly`, `Secure`, `SameSite=Lax` and that **no** token appears in local/session storage or in the URL after sign-in.

## 5. Second sign-in, and a changed e-mail
Sign out, sign in as A again. Then change A's e-mail (display address) at the provider, sign in once more.
Expected: both land on the **same** Nexus user (identity is `(issuer, sub)`). `auth.login` now shows `identityBound: false`.
Capture: the audit entries.

## 6. A person who was not invited (B)
Sign in as B.
Expected: the generic "not authorized" page; **no** account appears under Members; the audit trail shows no new user (a
`auth.login_denied` may appear only when B matched an existing record).
Capture: a screenshot of the message, the Members list before and after.

## 7. A token without an e-mail (C)
Sign in as C (an account whose ID token has no `email`).
Expected: the generic "sign-in failed" page; nothing is bound, even if C's `preferred_username` / `upn` equals someone else's address.
Capture: the screenshot and the server log line `oidc login failed` with `reason: identity_unusable` (reasons only, no claims).

## 8. Claims you rely on
Decode the ID token **locally** for one test sign-in (browser network tab → callback is not enough; use the provider's token viewer or a test client
you control, never a public decoder with a real token). Check: `iss` equals `OIDC_ISSUER`; `aud` is the client id; `email` present; and for Entra
`tid`, `oid`, `ver: "2.0"`. If you use `OIDC_GROUP_ROLE_MAP`, confirm `groups` carries the identifiers you mapped (GUIDs for Entra) and not an overage pointer.
Expected: matches your configuration. Capture: the **names** of the claims present (not their values).

## 9. Sign-out, disabled users, and session end
1. Sign out in Nexus. Expected: the Nexus session ends (back button / API call = 401). Note whether the provider's session also ended
   (it does only if the provider advertises `end_session_endpoint` and honours the registered post-logout URI); record which.
2. While A has a tab open, **Remove** A under Settings → Members (Nexus has no separate "disable" screen; a `disabledAt` flag on the
   user record exists and is honoured at sign-in, but is set only directly in the database). Expected: the next click in that tab
   returns to the sign-in page, and signing in again is refused with the generic "not authorized" page.
3. Add A again. Expected: A can sign in again and is the **same** user (the earlier binding is kept).
Capture: the audit entries (`auth.logout`, `org.member_removed`, `org.member_added`).

## 10. Provider outage and recovery
Block the provider's host from the Nexus servers (security group / hosts entry) for two minutes.
Expected: people already signed in keep working; a new sign-in shows "identity provider not reachable" within about 10 seconds and no stack trace;
after unblocking, a new sign-in works **without restarting** Nexus.
Capture: the screenshot of the message and the corresponding log line.

## 11. Rollback (rehearse it)
* Application: redeploy the previous release or restore the previous configuration (`AUTH_MODE` and `OIDC_*`). Production does not allow `AUTH_MODE=dev`; in
  production the fallback is the previous SSO configuration, not passwordless access.
* A single person: clear their `externalIssuer` / `externalSubject` in the `users` collection (change-controlled) and they bind again at next sign-in.
* Locked-out organization: add a membership directly in `org_memberships` (see Operations in `docs/auth-oidc.md`).
* Wrong issuer configured after people had signed in: restore the original `OIDC_ISSUER` exactly. A different value makes everyone look new.
Expected: after rolling back and forward again, A still signs in as the same user.

## 12. Sign-off
Record: date, who ran it, provider and tenant (non-secret identifiers), Nexus version, results for steps 4–11, anything that differed from the
"Expected" lines, and the secret expiry date with an owner and a reminder. File it with your change record. Only then update
`docs/auth-oidc.md` to say which provider was verified, and when.

## If something fails
| Symptom | Check first |
|---|---|
| API will not start | the variable named in the message; `OIDC_ISSUER` https; redirect URI on `WEB_ORIGIN` |
| "identity provider not reachable" for everyone | discovery URL from the Nexus host (step 2); `issuer` in the document equals `OIDC_ISSUER` exactly; a path issuer's trailing slash |
| "sign-in failed" right after the provider page | server log `oidc login failed` reason: `token_invalid` (issuer/audience/signature/clock — compare server time with NTP), `flow_missing`/`flow_invalid` (cookies blocked, a different browser, or the flow expired after 10 minutes) |
| "not authorized" for a person who should be allowed | invited? same e-mail as in the token? `email_verified` absent and `OIDC_REQUIRE_EMAIL_VERIFIED` still true? domain allow-list? |
| works for A, fails for everyone after a provider change | the client secret expired or was rotated; the issuer / tenant changed |
