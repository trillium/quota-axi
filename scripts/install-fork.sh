#!/bin/sh
# Install this checkout as the global `quota-axi`, reversibly.
#
#   scripts/install-fork.sh            build, stamp a fork version, install globally
#   npm install -g quota-axi@<ver>     roll back to the published stock build
#
# The installed package.json carries `<base>-fork.<short sha>` so
# `quota-axi --version` shows it is the fork. The stamp is applied to a staging
# copy only; the checkout's package.json is never edited.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd -P)
base=$(node -p "require('$root/package.json').version")
sha=$(git -C "$root" rev-parse --short=7 HEAD)
version="$base-fork.$sha"

( cd "$root" && pnpm install --frozen-lockfile && pnpm run build )

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir "$stage/quota-axi"
for item in dist skills LICENSE README.md package.json; do
  cp -R "$root/$item" "$stage/quota-axi/$item"
done
( cd "$stage/quota-axi" && npm pkg set "version=$version" >/dev/null && npm pack --pack-destination "$stage" >/dev/null )

npm install -g "$stage/quota-axi-$version.tgz"
echo "installed quota-axi $version; roll back with: npm install -g quota-axi@$base"
