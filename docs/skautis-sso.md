# skautIS sign-in

skautIS uses its own SSO redirect and SOAP session protocol. The CMS verifies the
returned token with `UserManagement.LoginDetail` and identifies the user by the
server's `ID_User`; posted role/unit fields are ignored.

## Configure

1. Register an external application in test skautIS and obtain its AppID. Its
   callback is `https://YOUR-CMS-HOST/api/skautis/callback`; permit the `state`
   query parameter supplied in `ReturnUrl`. Enable `UserManagement.LoginDetail`.
   The editor name picker also uses `UserManagement.UserRoleAll` and
   `UserManagement.UserAll`.
2. Set `BASE_URL` to the canonical HTTPS CMS origin, `SKAUTIS_APP_ID` to the
   AppID, and `SKAUTIS_ENVIRONMENT=test` (the default). Use a separately approved
   production AppID with `production` when ready. Only localhost may use HTTP.
3. Configure the existing authentication secret, PostgreSQL database, GitHub App
   credentials and `CRYPTO_KEY` (base64-encoded 32-byte AES key).
4. Run `npm run db:migrate` in the intended deployment database. Migration
   `0013_skautis_identity` binds each skautIS identity to one CMS account and each
   CMS account to one skautIS identity. Migration
   `0014_skautis_directory_session` adds encrypted per-session upstream tokens
   for administrator directory searches.
5. Set `SKAUTIS_ONLY=true` and configure `SKAUTIS_REPOSITORIES`. Bootstrap
   `.admins` directly in Git as described in [folder permissions](folder-permissions.md).

## Direct sign-in and admission

A person must appear in at least one `.access` or `.admins` in a configured
repository before the CMS creates a user or session. The union of those lists
controls admission, while the two files retain their separate editor and
administrator responsibilities. No unit roles or unit permissions are queried.

A newly admitted skautIS identity gets a dedicated CMS account. It is never
implicitly matched to an existing GitHub/email account, and no email is marked
verified. A private internal email placeholder satisfies the CMS account schema;
profile controls display the skautIS identity instead. Test and production
identities are separate (`test:ID_User` versus `production:ID_User`).

In skautIS-only mode the sign-in screen offers skautIS only and alternative HTTP
authentication methods are blocked server-side. Repository requests recheck
membership, so an existing session cannot keep editing after its last grant is
removed. The CMS session retains Better Auth's usual lifetime; skautIS is
verified at login, and local logout does not log the person out of skautIS.

Leaving `SKAUTIS_APP_ID` unset disables the provider. For installations that do
not enable skautIS-only mode or configure admission repositories, the previous
explicit connection workflow remains available in Settings: first use email or
GitHub, connect skautIS, then sign in with that identity. There is no automatic
email-based account linking in either mode.

## Security and validation

The callback is a cross-site form POST. It stores an encrypted, HttpOnly handoff
cookie for one minute, then redirects to a GET where the original signed
SameSite=Lax state cookie is available. That browser state must match a
single-use, ten-minute database record, consumed by atomic `DELETE RETURNING`.
An upstream token alone cannot create a CMS session. Tokens are never stored
in URLs or permanent identity records. For the editor picker, the validated
token is encrypted in a separate CMS-session-owned row with the upstream expiry;
CMS session deletion cascades to that row. Only a current folder administrator
can use it to query the directory, and it is never returned to the browser. Only the exact POST callback bypasses
the proxy's origin check; initiation remains same-origin protected.

Verify a real browser login using a registered test AppID and a repository with
explicit test editor/admin identities before production deployment. Check both
admitted and denied users, inheritance, revocation and `.admins` immutability.
Automated checks are documented in [folder permissions](folder-permissions.md).

Sources: [official SSO documentation](https://napoveda.skaut.cz/agenda/skautis/technicke-informace/programatori/obslouzeni-prihlaseni-odhlaseni-a-prodluzovani-platnosti-prihlaseni-uzivatele/),
[official SDK login URL construction](https://github.com/skaut/Skautis/blob/2.x/src/Skautis.php),
[UserManagement WSDL](https://test-is.skaut.cz/JunakWebservice/UserManagement.asmx?WSDL).
