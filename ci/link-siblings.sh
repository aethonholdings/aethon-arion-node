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
#
# Cloned siblings are resolved to a commit first (git ls-remote). When ARION_SIBLINGS_CACHE names a directory, the
# packed sibling is kept there under a key of its commit and the commits of the siblings built before it, and reused
# while that chain is unchanged (CI restores the directory with actions/cache); stale entries are removed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${ARION_SIBLINGS_DIR:-$ROOT/.siblings}"
PACKAGES="$WORK/packages"
REF="${ARION_SIBLING_REF:-${GITHUB_HEAD_REF:-${GITHUB_REF_NAME:-$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)}}}"
CACHE="${ARION_SIBLINGS_CACHE:-}"
rm -rf "$PACKAGES" && mkdir -p "$PACKAGES"
[ -n "$CACHE" ] && mkdir -p "$CACHE"
chain=""
keep=()

# npm install without saving; retried with --legacy-peer-deps for packages whose peer ranges npm cannot reconcile
install_no_save() {
    npm install --no-save --no-audit --no-fund "$@" || npm install --no-save --no-audit --no-fund --legacy-peer-deps "$@"
}

for name in "$@"; do
    source_dir="$ROOT/../aethon-arion-$name"
    if [ "${ARION_SIBLINGS_FROM:-}" = "clone" ] || [ ! -d "$source_dir" ]; then
        source_dir="$WORK/aethon-arion-$name"
        url="https://${ARION_REPOS_TOKEN:+x-access-token:${ARION_REPOS_TOKEN}@}github.com/aethonholdings/aethon-arion-$name.git"
        sha="$(git ls-remote "$url" "refs/heads/$REF" | cut -f1)"
        [ -n "$sha" ] || sha="$(git ls-remote "$url" HEAD | cut -f1)"
        [ -n "$sha" ] || { echo "cannot resolve aethon-arion-$name" >&2; exit 1; }
        chain="$chain $name@$sha"
        key="$name-$(echo "$chain" | sha1sum | cut -c1-16)"
        keep+=("$key")
        if [ -n "$CACHE" ] && compgen -G "$CACHE/$key/*.tgz" >/dev/null; then
            echo "Reusing aethon-arion-$name at ${sha:0:12} from the cache"
            cp "$CACHE/$key"/*.tgz "$PACKAGES/"
            continue
        fi
        rm -rf "$source_dir" && mkdir -p "$source_dir"
        git -C "$source_dir" init --quiet
        git -C "$source_dir" fetch --quiet --depth 1 "$url" "$sha"
        git -C "$source_dir" checkout --quiet FETCH_HEAD
        label="${sha:0:12}"
    else
        chain="$chain $name@local"
        key=""
        label="local"
    fi
    echo "Building aethon-arion-$name from $source_dir ($label)"
    (
        cd "$source_dir"
        shopt -s nullglob
        built=("$PACKAGES"/*.tgz)
        install_no_save "${built[@]}"
        npm run build
        npm pack --silent --pack-destination "$PACKAGES" >/dev/null
    )
    if [ -n "$CACHE" ] && [ -n "$key" ]; then
        tgz="$(ls -t "$PACKAGES"/aethon-arion-"$name"-*.tgz | head -1)"
        mkdir -p "$CACHE/$key" && cp "$tgz" "$CACHE/$key/"
    fi
done

# drop cache entries of other commits of the siblings used here
if [ -n "$CACHE" ]; then
    for name in "$@"; do
        for entry in "$CACHE/$name"-*; do
            [ -e "$entry" ] || continue
            [[ " ${keep[*]:-} " == *" $(basename "$entry") "* ]] || rm -rf "$entry"
        done
    done
fi

cd "$ROOT"
install_no_save "$PACKAGES"/*.tgz
echo "Installed: $(cd "$PACKAGES" && ls *.tgz | tr '\n' ' ')"
