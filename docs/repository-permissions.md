# Repository permissions

Add `.pages-access.yml` to the root of the site's **default branch** to restrict
collaborator edits. Permissions apply to every branch. Without this file,
collaborators keep the existing editing behavior.

```yaml
version: 1

groups:
  common:
    - editor@example.org
  vlcata:
    - leader@example.org
  skauti:
    - another-leader@example.org

rules:
  - paths:
      - content/common/**
      - static/common/**
    groups: [common]
  - paths:
      - content/oddily/vlcata/**
      - static/oddily/vlcata/**
    groups: [vlcata]
  - paths:
      - content/oddily/skauti/**
      - static/oddily/skauti/**
    groups: [skauti]
```

Use paths matching your site's actual files, including media uploads. Groups are
lists of verified account emails, compared case-insensitively. A linked SkautIS
login uses the same account's verified email. Group membership does not itself
grant repository access: invite the collaborator through Pages CMS first.

Rules grant `create`, `update`, and `delete` by default. To allow editing existing
files only, add `operations: [update]` to a rule. Memberships and matching rules
combine additively. With a policy present, unmatched writes are denied. There
are no deny rules or ordering overrides. Renaming requires `delete` on the old
path and `create` on the destination; an existing destination cannot be replaced.

Paths are relative to the repository root. `*` matches within one segment, `?`
matches one character, and a whole-segment `**` matches zero or more segments.
For example, `content/oddily/vlcata/**` includes nested files but not
`content/oddily/vlcata-other/`. Absolute paths, traversal, YAML aliases, unknown
fields, and references to missing groups are rejected. Invalid or unreadable
policies block collaborator writes until corrected.

Users signing in with a GitHub account that has repository **write access** are
administrators and bypass the policy. A public repository being readable does
not make someone an administrator. Only administrators may edit `.pages.yml`,
`.pages-access.yml`, or `.github/**`, even if a collaborator rule matches `**`.
When a policy is present, branch creation and manual workflow dispatch, rerun,
and cancellation are also administrator-only. Workflows triggered by normal
content commits still follow the repository's GitHub configuration.

The editor disables unavailable actions, and the server checks every mutation,
including generated upload filenames. All collaborators can still browse the
content and media exposed by the CMS configuration; these are write permissions,
not read restrictions. Existing `.pages.yml` schema and operation restrictions
still apply. The permissions endpoint returns effective paths and operations,
not the email lists. The policy file itself has the repository's visibility, so
use a private repository if those email addresses should not be public.

This policy is enforced by Pages CMS. GitHub does not interpret it, and direct
GitHub pushes remain subject to GitHub's own repository rules. Keep direct write
access limited to administrators.

## Verification

With dependencies installed, run:

```sh
node --test scripts/test-repo-permissions.mjs
npm run build
```

The tests run the policy loader and actual mutation routes against simulated
GitHub responses. They do not write to GitHub or require a live SkautIS account.
