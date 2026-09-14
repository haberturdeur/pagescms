# Collaborator authentication

GitHub repository writers manage collaborators. Email accounts use existing
collaborator invitations; signing in does not grant repository access.

Email login uses a six-digit one-time code, valid for five minutes, with five
verification attempts allowed. Invitations grant repository access; requesting
a login code is a separate step. Once signed in, the usual CMS session applies
(the current library defaults to seven days, refreshed during active use).
Configure a sender and SMTP or Resend for email delivery.

Collaborator editing permissions can be restricted by verified email groups in
[`.pages-access.yml`](repository-permissions.md). GitHub repository writers remain
administrators.
