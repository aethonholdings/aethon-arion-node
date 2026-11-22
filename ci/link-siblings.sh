#!/usr/bin/env bash
# Builds the Arion sibling packages this repository depends on and installs them here without saving, so that it is
# tested against the matching branch of its dependencies rather than the versions published on npm.
#
# Usage: ci/link-siblings.sh <sibling>...   in dependency order, e.g. ci/link-siblings.sh core pipeline c1
#
# Each sibling comes from ../aethon-arion-<sibling> when that directory exists (local development; its dist and
# node_modules are rebuilt, its package.json is not changed), otherwise from a shallow clone of
# github.com/aethonholdings/aethon-arion-<sibling> at the branch being built (ARION_SIBLING_REF, else the CI branch,
# else the current branch), falling back to main. Private repositories need ARION_REPOS_TOKEN (a token with read
# access to them). ARION_SIBLINGS_FROM=clone forces cloning even when a local directory exists.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${ARION_SIBLINGS_DIR:-$ROOT/.siblings}"
PACKAGES="$WORK/packages"
REF="${ARION_SIBLING_REF:-${GITHUB_HEAD_REF:-${GITHUB_REF_NAME:-$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)}}}"
rm -rf "$PACKAGES" && mkdir -p "$PACKAGES"

# npm install without saving; retried with --legacy-peer-deps for packages whose peer ranges npm cannot reconcile
install_no_save() {
    npm install --no-save --no-audit --no-fund "$@" || npm install --no-save --no-audit --no-fund --legacy-peer-deps "$@"
}

for name in "$@"; do
    source_dir="$ROOT/../aethon-arion-$name"
    if [ "${ARION_SIBLINGS_FROM:-}" = "clone" ] || [ ! -d "$source_dir" ]; then
        source_dir="$WORK/aethon-arion-$name"
        url="https://${ARION_REPOS_TOKEN:+x-access-token:${ARION_REPOS_TOKEN}@}github.com/aethonholdings/aethon-arion-$name.git"
        rm -rf "$source_dir"
        git clone --quiet --depth 1 --branch "$REF" "$url" "$source_dir" 2>/dev/null ||
            git clone --quiet --depth 1 "$url" "$source_dir"
    fi
    echo "Building aethon-arion-$name from $source_dir ($(git -C "$source_dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo local))"
    (
        cd "$source_dir"
        shopt -s nullglob
        built=("$PACKAGES"/*.tgz)
        install_no_save "${built[@]}"
        npm run build
        npm pack --silent --pack-destination "$PACKAGES" >/dev/null
    )
done

cd "$ROOT"
install_no_save "$PACKAGES"/*.tgz
echo "Installed: $(cd "$PACKAGES" && ls *.tgz | tr '\n' ' ')"
