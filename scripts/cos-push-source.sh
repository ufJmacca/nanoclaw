#!/usr/bin/env bash
# Host-only helper. The delivery caller has already verified origin is the bound fork.
set -euo pipefail
[[ $# == 2 && "$1" =~ ^[a-f0-9]{40}$ && "$2" == refs/heads/* ]] || exit 1
commit=$1
fetch_ref=$2
git check-ref-format "$fetch_ref"
[[ "$(git rev-parse --verify "$commit^{commit}")" == "$commit" ]] || exit 1
remote_source=$(git ls-remote --refs origin "$fetch_ref")
if [[ -n "$remote_source" ]]; then
  # Fetch objects without changing the checkout or a local branch. The remote may
  # contain later review/evidence commits, which must never be rewound for a retry.
  git fetch --no-tags --no-recurse-submodules origin "$fetch_ref"
  if ! git merge-base --is-ancestor "$commit" FETCH_HEAD; then
    git push origin "$commit:$fetch_ref"
  fi
else
  git push origin "$commit:$fetch_ref"
fi
# Verify reachability after publication too; the Pi still checks the exact SHA/tree.
git fetch --no-tags --no-recurse-submodules origin "$fetch_ref"
git merge-base --is-ancestor "$commit" FETCH_HEAD || {
  echo 'The tested source is not reachable from the published branch.' >&2
  exit 1
}
