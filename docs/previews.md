# Server-built previews

Enable the preview toolbar in a repository's `.pages.yml`:

```yaml
settings:
  preview: true
```

Select a branch in Pages CMS, save your edits, then choose **Build preview**.
The toolbar polls the build status and offers **Open preview** when ready. It
shows the saved commit SHA; unsaved editor changes are not included. Hugo previews
include draft and future-dated content. Production publishing is independent.
Anyone with CMS access to the repository can preview its readable content, even
if their write permissions cover only some paths.

## Instance configuration

The CMS uses an operator-configured service, never a URL or command from repository
YAML. Configure `PREVIEW_SERVICE_URL` and `PREVIEW_SERVICE_TOKEN` on the CMS.
The server resolves the selected branch to a commit SHA and submits the repository,
commit, branch and GitHub token over the private service connection. Tokens are
used only to download that commit, are not persisted, and never enter build workers.
Use HTTPS if the service connection crosses hosts.

`services/preview/server.py` is a Python 3 controller using the Docker CLI. Set:

- `PREVIEW_SERVICE_TOKEN`: the same random secret, at least 32 characters.
- `PREVIEW_ROOT`: persistent storage, mounted at the same absolute host/container path.
- `PREVIEW_PUBLIC_URL`: the HTTPS origin serving static output, distinct from the CMS.
- `PREVIEW_REPOSITORIES`: JSON mapping exact `owner/repo` names to operator-built images.

The controller requires Docker daemon access to launch and remove workers. This
is privileged infrastructure with host-level control. Do not expose its authenticated
`/build` endpoint publicly or give repository code access to the controller or its
socket. Deployment files and credentials belong to the instance, not the CMS repo.

Publish only the controller's static paths behind the preview HTTPS hostname;
block `/build` in the public reverse proxy. The service listens on port 8080.
Output links contain a random identifier per build and expire after seven days
(cleaned during subsequent builds); at most 32 builds are retained. They are bearer links, not authenticated
private previews: anyone holding a URL can view it. Responses send `noindex`
headers and do not set CMS cookies. Never serve repository HTML on the CMS origin.

## Worker contract

An operator provisions dependencies in an image for each repository. The controller
mounts extracted source read-only at `/input`, passes `PREVIEW_BASE_URL`, and expects
a tar archive of static output on stdout. Diagnostic logs go to stderr. Workers
run as UID 1000, with no network, read-only image filesystem, a 1 GiB temporary
filesystem, 1.5 GiB memory, two CPUs, a PID limit, dropped capabilities, and a five
minute timeout. Source and output archives are bounded; symlinks, hard links,
special files and traversal are rejected. Workers receive no service credentials,
Docker socket, or writable host mount.

`services/preview/hugo-worker.sh` provides the Hugo implementation. Bake the site's
npm dependencies at `/opt/site/node_modules`, its three dependency manifests at
`/opt/site`, and downloaded Hugo/Go modules at `/opt/go/pkg/mod`. Dependency manifest
changes fail with a request to rebuild the image; untrusted branch code cannot
install new dependencies during preview builds. Build the image from an
administrator-reviewed source snapshot and use the script as its entrypoint.

The controller queues up to four builds, runs one worker at a time, and coalesces
repeated requests for an already-building branch. After a restart, interrupted
builds are marked failed and can be requested again. Build failures are shown in
the CMS; a successful build gets a new immutable URL.

## Verification

```sh
python3 -m unittest discover -s services/preview -p 'test_*.py'
node --test scripts/test-preview.mjs scripts/test-repo-permissions.mjs
```

Tests cover API authentication, branch pinning, credential boundaries, opt-in
configuration, safe extraction, queue limits, restart handling and worker resource
limits. A real Hugo build should additionally be checked with the provisioned image.
