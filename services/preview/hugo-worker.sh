#!/bin/sh
set -eu
mkdir -p /tmp/site
cp -R /input/. /tmp/site/
cd /tmp/site
# Dependencies are provisioned by the operator, not downloaded or installed by branch code.
for file in package-lock.json go.mod go.sum; do
  cmp "$file" "/opt/site/$file" >/dev/null || { echo "Dependency files changed; ask an administrator to rebuild the preview image." >&2; exit 1; }
done
ln -s /opt/site/node_modules node_modules
export HOME=/tmp GOPATH=/opt/go GOMODCACHE=/opt/go/pkg/mod GOPROXY=off GOCACHE=/tmp/go-cache
export HUGO_CACHEDIR=/tmp/hugo-cache HUGO_PARAMS_METAROBOTS='noindex, nofollow' HUGO_CANONIFYURLS=true
hugo --minify --buildDrafts --buildFuture --baseURL "$PREVIEW_BASE_URL" --destination /tmp/public >&2
tar -C /tmp/public -cf - .
