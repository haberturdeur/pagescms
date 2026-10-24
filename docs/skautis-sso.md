# skautIS sign-in

This optional provider connects a skautIS identity to an existing Pages CMS user.
After connecting, that person can sign in with skautIS and retains their existing
GitHub and collaborator access. No GitHub account is required for email
collaborators.

## Configure and test

1. Register an external application in **test skautIS** and obtain its AppID.
   Register `https://YOUR-CMS-HOST/api/skautis/callback` as the login callback,
   allowing the `state` query parameter supplied through `ReturnUrl`. Enable
   `UserManagement.LoginDetail` for the application. Verify callback matching
   with the current registration rules before production use.
2. Set `BASE_URL` to the canonical HTTPS CMS origin, `SKAUTIS_APP_ID` to the
   AppID, and `SKAUTIS_ENVIRONMENT=test`. The environment defaults to `test`;
   `production` selects `https://is.skaut.cz`. Other values are rejected.
   Existing `BETTER_AUTH_SECRET`/`AUTH_SECRET` and `CRYPTO_KEY` settings are
   required. `CRYPTO_KEY` is a base64-encoded 32-byte AES key. Local development
   permits `http://localhost:3000` if allowed by the registered application.
3. Install dependencies and run `npm run db:migrate` against the intended
   development database. Migration `0013_skautis_identity` adds unique indexes
   restricting each skautIS identity to one CMS user and each CMS user to one
   skautIS identity. Other identity providers are unaffected.
4. Sign in using the existing email OTP or GitHub flow. Open **Settings →
   skautIS → Connect skautIS** and complete the upstream login. The original
   local session must remain active through completion.
5. Sign out of Pages CMS, then select **Sign in with skautIS**. Confirm that
   this opens the same user account and preserves its repository permissions.
6. Before enabling production, verify this against a registered test AppID in
   a browser, including expired login, denied login, duplicate identity linking,
   logout, and access as both an email collaborator and GitHub user. Switch to a
   separately registered production AppID only after those checks succeed.

Leaving `SKAUTIS_APP_ID` unset hides the controls and disables the provider.
Test and production identities are stored separately (`test:ID_User` versus
`production:ID_User`). A test-linked user must unlink that test identity before
connecting a production one. The existing Better Auth `/unlink-account` API can
remove provider `skautis`, subject to its account-linking restrictions; there is
currently no skautIS disconnect button. Email/GitHub recovery remains available.

## Authentication and access boundaries

- An upstream token is validated server-side using SOAP `LoginDetail`. Identity
  comes from its `ID_User`. Posted role, unit and expiration fields are ignored.
- A random, signed browser state cookie and a ten-minute database record bind
  completion to the initiating browser. Completion consumes that record using
  an atomic `DELETE RETURNING`, preventing parallel replay.
- skautIS returns a cross-site form POST. That POST alone creates no local
  session: it sets an encrypted, HttpOnly handoff cookie valid for one minute,
  then redirects to a GET that checks the original SameSite=Lax state cookie.
  The upstream token never goes into a URL or permanent account storage.
- Only the exact POST callback bypasses the proxy's same-origin guard. Starting
  login and account linking still require the CMS origin. Local linking also
  verifies that the initiating local session has not changed.
- Accounts are linked explicitly from an authenticated CMS session. There is
  no automatic email matching, email verification upgrade, or automatic CMS
  signup. An unknown identity is directed to sign in by email/GitHub first and
  connect in Settings. Existing collaborator invitations remain the onboarding
  mechanism.
- The CMS session uses the existing Better Auth lifetime. skautIS is checked at
  login, not on each edit. CMS logout does not log the person out of skautIS.
  This version does not query units/roles, revoke local sessions when upstream
  roles change, or grant editing rights based on skautIS. Those require an
  explicit unit-to-repository policy and additional approved SOAP methods.

## Validation

Run `npm run test:skautis`, `node --test scripts/test-repo-permissions.mjs`,
`npx tsc --noEmit`, and ESLint on changed files. The authentication tests run the
real Better Auth handlers with its memory adapter and the real callback,
encryption and SOAP parser. The flow/identity store and upstream SOAP server are
replaced; these tests do not substitute for a migrated PostgreSQL database and
a real skautIS browser login.

Sources: [official SDK login flow](https://github.com/skaut/Skautis/blob/2.x/docs/prihlaseni.md),
[official login URL implementation](https://github.com/skaut/Skautis/blob/2.x/src/Skautis.php),
[current UserManagement WSDL](https://is.skaut.cz/JunakWebservice/UserManagement.asmx?WSDL),
[AppID method permissions](https://github.com/skaut/skautis-integration/blob/master/APP%20ID%20-%20povolen%C3%AD%20slu%C5%BEeb.md).
