# Collaborator authentication

GitHub repository writers manage collaborators. Email and SkautIS identities use
existing collaborator invitations; signing in does not grant repository access.
This integration does not add subtree permissions or change GitHub access checks.

## Email

Email login already uses a six-digit one-time code, valid for five minutes, with
five verification attempts allowed. Invitations grant repository access; requesting
a login code is a separate step. Once signed in, the usual CMS session applies
(the current library defaults to seven days, refreshed during active use).
Configure a sender and SMTP or Resend for email delivery.

## Optional SkautIS login

Leave `SKAUTIS_APP_ID` unset to hide and disable SkautIS. No database migration is
required. Configure these variables only on the instance intended to support it:

```dotenv
SKAUTIS_APP_ID=your-registered-application-uuid
SKAUTIS_ENVIRONMENT=test
```

Use `production` for the live SkautIS environment after application approval.
Test and production identity links are separate. `BASE_URL` must be the canonical
public HTTPS URL of the CMS. Register this login callback with SkautIS:

```text
https://your-cms.example/auth/skautis/callback
```

SkautIS posts its login token to the registered callback, carrying the original
`ReturnUrl`. The integration then returns the browser to its local finish endpoint.
It uses SkautIS's redirect and SOAP protocol, not generic OAuth/OIDC.

1. Accept a repository invitation and sign in with an email code.
2. Open Settings and choose **Connect SkautIS** within 15 minutes of signing in.
3. Authenticate on SkautIS; the CMS links the verified SkautIS user ID.
4. Use **Sign in with SkautIS** on future visits. Email remains a recovery method.

A GitHub account with a verified email can also link SkautIS. Existing repository
access remains unchanged. SkautIS emails, posted role/unit values, and membership
are never used to grant access or automatically merge accounts. An unlinked
SkautIS identity must first sign in by email and explicitly connect the account.

Linking requires the same recent CMS session to complete it. Login state expires
after ten minutes, is bound to a browser cookie, and is consumed once. Callback
identity is checked against SkautIS server-side; tokens are not stored in account
records or logs. Only active, enabled accounts are accepted. The login state stores
only the verified user ID after confirmation. Disconnecting removes the identity
link but does not revoke already established CMS sessions. SkautIS logout does not
log out a CMS session; this is a sign-in integration, not continuous membership or
session synchronization.

## Validation

Run protocol tests after installing dependencies:

```sh
node --test scripts/test-skautis.mjs
```

To also run real database/authentication integration tests, provide
`TEST_DATABASE_URL` for an **empty disposable PostgreSQL database whose name ends
in `_test`**. Tests create their own tables, capture email codes in memory, and mock
SkautIS SOAP responses; they never send mail or contact SkautIS. The database is
not a production instance and must be removed after testing.

A registered SkautIS test application is still required to verify the complete
browser flow and callback configuration before enabling production login.

Protocol references:
- https://github.com/skaut/skautis (login URL and token handling)
- https://github.com/skaut/skautis-integration (registered callback with ReturnUrl)
- https://is.skaut.cz/JunakWebservice/UserManagement.asmx?WSDL (UserDetail)
