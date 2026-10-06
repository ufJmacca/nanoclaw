#!/usr/bin/env bash
# Tighten the Pi-owned lifecycle after verified human merges. No model/account calls or database credentials.
set -euo pipefail
umask 077
[[ "$(uname -s)" == Darwin ]] || exit 1
[[ $# == 2 && "$1" == --release-manifest ]] || { echo 'Usage: cos-protect-programme.sh --release-manifest tested-release.json' >&2; exit 1; }
root=$(git rev-parse --show-toplevel)
cd "$root"
manifest=$2
[[ "$manifest" == "$root/.cos-plan-state/releases/"*/release.json && ! -L "$manifest" ]] || exit 1
directory=${manifest%/release.json}
id=${directory##*/}
dev=${COS_DEVCONTAINER_ID:-$(docker compose -f .devcontainer/compose.yaml -p nanoclaw-cos ps -q devcontainer)}
[[ "$dev" =~ ^[a-zA-Z0-9_.-]+$ ]] || exit 1
project() { docker exec -w /workspace "$dev" node --import tsx src/modules/chief-of-staff/ops/mac-programme-cli.ts "$@"; }
delivery() { docker exec -w /workspace "$dev" node --import tsx src/modules/chief-of-staff/ops/mac-deploy-cli.ts "$@"; }
refs=$(project references "$id")
if [[ -z "$refs" ]]; then
  printf 'Programme protection awaits the required human merges and mandatory tests.\n'
  exit 0
fi
lock="$root/.cos-plan-state/programme-protection.lock"
mkdir "$lock" || { echo 'Another programme protection check is active; reconcile its owner before retrying.' >&2; exit 1; }
printf '%s\n' "$$" > "$lock/pid"
trap 'rm -f "$lock/pid"; rmdir "$lock"' EXIT
# Recheck the exact local artifacts without replacing any existing deployment receipts.
delivery verify-protection "$id"
origin=$(git remote get-url origin)
[[ "$origin" == https://github.com/ufJmacca/nanoclaw.git || "$origin" == https://github.com/ufJmacca/nanoclaw || "$origin" == git@github.com:ufJmacca/nanoclaw.git ]] || exit 1
closure="$root/.cos-plan-state/programme-protection/$id"
gh auth status > "$closure/github-auth.log" 2>&1
commit=$(delivery field "$id" commit)
[[ "$commit" =~ ^[a-f0-9]{40}$ ]] || exit 1
printf '%s\n' "$refs" > "$closure/references.tsv"
: > "$closure/ancestry.tsv"
while IFS=$'\t' read -r index url merge; do
  [[ "$index" =~ ^([0-9]|[12][0-9]|3[01])$ && "$url" =~ ^https://github.com/ufJmacca/nanoclaw/pull/[1-9][0-9]*$ && "$merge" =~ ^[a-f0-9]{40}$ ]] || exit 1
  gh pr view "$url" --json url,state,baseRefName,mergeCommit,mergedBy,mergedAt > "$closure/review-$index.json"
  git merge-base --is-ancestor "$merge" "$commit" || { echo 'A required merge is not part of the tested source.' >&2; exit 1; }
  printf '%s\t%s\t%s\n' "$index" "$merge" "$commit" >> "$closure/ancestry.tsv"
done < "$closure/references.tsv"
project make "$id" > "$closure/verification.log"
alias_name=$(delivery alias)
command=$(project command "$id")
[[ -n "$command" ]] || exit 1
printf 'Latching the bound Pi data lifecycle to protected.\n'
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
  "$alias_name" "$command" < "$closure/proof.json" > "$closure/target-result.json"
project verify "$id" > "$closure/verified.log"
printf 'Pi-owned programme protection confirmed; account and model activation remain separate.\n'
