#!/usr/bin/env bash
# Native host tools handle SSH/Git/Docker. Project metadata is checked inside the devcontainer.
set -euo pipefail
umask 077
[[ "$(uname -s)" == Darwin ]] || { echo 'cos:deploy requires the Mac host' >&2; exit 1; }
mode=deploy
if [[ "${1:-}" == status || "${1:-}" == rollback ]]; then mode=$1; shift; fi
if [[ "$mode" == status ]]; then
  [[ $# == 2 && "$1" == --target && "$2" == pi ]] || exit 1
elif [[ "$mode" == rollback ]]; then
  [[ $# == 4 && "$1" == --target && "$2" == pi && "$3" == --release-id ]] || exit 1
  rollback_id=$4
else
  [[ $# == 4 && "$1" == --target && "$2" == pi && "$3" == --release-manifest ]] || {
    echo 'Usage: cos:deploy [status] --target pi [--release-manifest path]' >&2; exit 1;
  }
  manifest=$4
fi
root=$(git rev-parse --show-toplevel)
cd "$root"
dev=${COS_DEVCONTAINER_ID:-$(docker compose -f .devcontainer/compose.yaml -p nanoclaw-cos ps -q devcontainer)}
[[ "$dev" =~ ^[a-zA-Z0-9_.-]+$ ]] || { echo 'The repository devcontainer must be running.' >&2; exit 1; }
cli() { docker exec -w /workspace "$dev" node --import tsx src/modules/chief-of-staff/ops/mac-deploy-cli.ts "$@"; }
alias_name=$(cli alias)
lock="$root/.cos-plan-state/delivery.lock"
mkdir "$lock" || { echo 'Another delivery owns the Mac lock; reconcile it before retrying.' >&2; exit 1; }
printf '%s\n' "$$" > "$lock/pid"
trap 'rm -f "$lock/pid"; rmdir "$lock"' EXIT
ssh_options=(-o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3)
remote() { ssh "${ssh_options[@]}" "$alias_name" "$1"; }
if [[ "$mode" == status || "$mode" == rollback ]]; then
  id=status
  directory="$root/.cos-plan-state/deployment-status"
  mkdir -p "$directory"
  remote "$(cli preflight-command)" > "$directory/target-observation.json"
  cli target-check "$id"
  if [[ "$mode" == rollback ]]; then
    command=$(cli rollback-command "$id" "$rollback_id")
    printf 'Restoring the recorded compatible release; CoS will remain paused.\n'
    remote "$command" > "$directory/rollback-result.json"
    cli rollback-check "$id"
    cat "$directory/rollback-result.json"
    exit 0
  fi
  command=$(cli status-command "$id")
  if [[ -n "$command" ]]; then remote "$command"; else cli unbound-status "$id"; fi
  exit 0
fi
[[ "$manifest" == "$root/.cos-plan-state/releases/"*/release.json && ! -L "$manifest" ]] || {
  echo 'Use the absolute path to a tested local release manifest.' >&2; exit 1;
}
directory=${manifest%/release.json}
id=${directory##*/}
cli verify "$id"
remote "$(cli preflight-command)" > "$directory/target-observation.json"
cli target-check "$id"
origin=$(git remote get-url origin)
[[ "$origin" == https://github.com/ufJmacca/nanoclaw.git || "$origin" == https://github.com/ufJmacca/nanoclaw || "$origin" == git@github.com:ufJmacca/nanoclaw.git ]] || {
  echo 'The Git remote does not identify the bound fork.' >&2; exit 1;
}
gh auth status > "$directory/github-auth.log" 2>&1
commit=$(cli field "$id" commit)
tree=$(cli field "$id" tree)
fetch_ref=$(cli field "$id" fetchRef)
[[ "$(git rev-parse "$commit^{tree}")" == "$tree" ]] || exit 1
git push origin "$commit:$fetch_ref" > "$directory/source-push.log" 2>&1
remote_source=$(git ls-remote --exit-code origin "$fetch_ref")
[[ "${remote_source%%[[:space:]]*}" == "$commit" ]] || { echo 'Pushed source identity could not be verified.' >&2; exit 1; }
cli checkpoint "$id" source_pushed
stage=$(cli field "$id" stage)
remote "$(cli stage-command "$id")"
transfer() {
  local name=$1
  scp "${ssh_options[@]}" "$directory/$name" "$alias_name:$stage/$name.partial" > "$directory/$name-transfer.log" 2>&1
  remote "$(cli seal-command "$id" "$name")"
}
for name in release.json SHA256SUMS bootstrap.mjs target.json; do transfer "$name"; done
[[ ! -f "$directory/binding.json" ]] || transfer binding.json
printf 'Verifying pinned source on the Pi for %s\n' "$id"
remote "$(cli bootstrap-command "$id" source)" > "$directory/source-result.json"
cli checkpoint "$id" source_verified
printf 'Transferring the tested image archive for %s\n' "$id"
transfer images.tar.gz
cli checkpoint "$id" transferred
remote "$(cli bootstrap-command "$id" prepare)" > "$directory/prepare-result.json"
cli checkpoint "$id" prepared
printf 'Activating %s. The existing NanoClaw service will briefly stop while protected state is backed up and migrated.\n' "$id"
remote "$(cli deploy-command "$id")" > "$directory/deploy-result.json"
cli checkpoint "$id" healthy
cat "$directory/deploy-result.json"
