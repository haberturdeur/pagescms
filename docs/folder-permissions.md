# Folder editors and administrators

The CMS uses repository files to authorize individual people. There are no
unit-based grants. skautIS sign-in identifies the person; it does not grant
editing rights on its own.

## Permission files

For example, `content/oddily/vlcata/.access`:

```yaml
editors:
  - skautis:production:12345
  - skautis:production:67890
```

And `content/oddily/vlcata/.admins`:

```yaml
admins:
  - skautis:production:12345
```

Use `skautis:test:USER_ID` in the test environment. IDs are skautIS **user IDs**,
not person IDs, role IDs or unit IDs. Existing CMS users can copy their exact
editor identity from Settings. Lists also accept `user:CMS_USER_ID` or a verified
account email (`editor@example.org` or `email:editor@example.org`). A new direct
skautIS user has no verified email, so use their skautIS ID for initial access;
the CMS never assumes that skautIS has verified an email or joins accounts by
matching names/emails.

- A person listed in **either** `.access` **or** `.admins` in a configured
  repository can sign in and open that repository. No email invitation or GitHub
  account is required.
- `.access` grants create, update, upload, rename and delete within that folder
  and its descendants. An empty `editors: []` denies editing.
- `.admins` grants permission to manage `.access` in that folder and its
  descendants. It does not grant content-editing rights by itself. To edit
  content as well, the administrator must also be in the applicable `.access`.
- The **nearest ancestor** file applies, independently for `.access` and
  `.admins`. A nested file overrides its parent; an empty list overrides it
  with no grants. Without a matching `.access`, content editing is denied.
- **No one can create, change, delete, upload over or rename `.admins` through
  the CMS**, including GitHub repository administrators. Maintain these files
  directly in Git. Generic CMS content/media routes also block `.access`;
  administrators change it only through the dedicated Folder access screen.

Content and media use their own repository paths. If photos live under
`static/photos/vlcata`, place permission files there or inherit appropriate
ones from its parent; permission for `content/oddily/vlcata` does not grant
permission for another tree.

## Bootstrap and management

1. In Git, add a root `.admins` file listing the initial administrators' skautIS
   identities. This is sufficient for those people to sign in, even before any
   `.access` exists.
2. An administrator opens **Folder access** in the repository sidebar, selects
   or enters a folder, and adds allowed editor identities, one per line.
3. Saving creates or updates only that folder's `.access`. Saving a nested rule
   copies the displayed inherited editor list unless the administrator changes
   it. An empty list intentionally blocks content editing in that subtree.
4. Add nested `.admins` through Git whenever authority over a subtree should be
   delegated differently. That subtree's `.access` will then be controlled by
   its own administrators.

Permission files are read from the repository's **default branch**, at one
commit snapshot, and apply to edits on **every branch**. The management screen
always commits to that default branch and labels it. Writes use a non-forced
Git ref update based on the exact authorized commit. A concurrent change,
including administrator revocation, causes a conflict instead of overwriting
new permissions; reload before retrying.

The backend checks every mutation as well as showing UI hints. Moves require
permission at both source and destination. Malformed lists, symlinks,
incomplete Git trees and unavailable permission files deny access. JSON is also
valid because it is a YAML subset; duplicate keys, aliases, unknown keys,
unit selectors and invalid identities are rejected.

## Deployment

Register the skautIS AppID and callback as described in [skautIS SSO](skautis-sso.md).
Install the existing GitHub App on each content repository, then configure:

```dotenv
SKAUTIS_APP_ID="APP_ID_FOR_THIS_ENVIRONMENT"
SKAUTIS_ENVIRONMENT="production"
SKAUTIS_ONLY="true"
SKAUTIS_REPOSITORIES="skautkurim/skautkurim.cz"
```

`SKAUTIS_REPOSITORIES` is an explicit comma-separated allowlist of at most 20
`owner/repo` pairs. The GitHub App's existing installation credentials access
those repositories on behalf of admitted users. An arbitrary repository or
unlisted user cannot obtain that token. GitHub/email sign-in endpoints and
account-linking routes are unavailable in skautIS-only mode; existing sessions
without a linked skautIS identity cannot enter the CMS.

Use `test` and a test AppID for the test deployment. Configure the existing
canonical `BASE_URL`, database, authentication secret and encryption key too.
No public test account is automatically granted access to a real repository.

Membership is checked before first account creation and on later logins.
Repository access is rechecked against the current default-branch files on
requests, so removal blocks an existing session's repository access. The CMS
session can remain signed in to its profile after all repository access is
removed; it cannot continue editing with cached browser permissions.

## Scope and compatibility

These are **editor** permissions, not confidentiality boundaries between
folders. Admitted users can browse content/media exposed by the existing CMS
configuration. Direct GitHub writes follow GitHub's permissions; GitHub does not
enforce these files. Lists have the repository's own visibility.

The existing `.pages-access.yml` policy remains supported outside skautIS-only
onboarding. If both policy formats exist, content edits must pass both. GitHub
repository writers retain existing content-administrator behavior outside
skautIS-only mode, but cannot bypass the `.admins` file protection or change
`.access` without matching its effective `.admins` list.

Verification: `npm run test:skautis`, `npm run test:access`, `npx tsc --noEmit`
and a production Next.js build. Tests run the real authentication and permission
code with external services replaced; they never modify live repository grants.
