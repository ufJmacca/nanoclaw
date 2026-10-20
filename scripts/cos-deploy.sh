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
  [[ ( $# == 4 || ( $# == 6 && "${5:-}" == --recover-from ) ) && "$1" == --target && "$2" == pi && "$3" == --release-manifest ]] || {
    echo 'Usage: cos:deploy [status] --target pi [--release-manifest path] [--recover-from failed-release-id]' >&2; exit 1;
  }
  manifest=$4
  recovery_args=()
  if [[ $# == 6 ]]; then
    [[ "$6" =~ ^release-[a-zA-Z0-9_-]{1,120}$ ]] || exit 1
    recovery_args=("$6")
  fi
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
ssh_options=(-4 -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3)
remote() {
  [[ $# == 1 && -n "$1" ]] || { echo 'Empty remote command refused.' >&2; return 1; }
  ssh "${ssh_options[@]}" "$alias_name" "$1"
}
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
timing_helper="$root/scripts/cos-stage-timing.sh"
[[ -f "$timing_helper" && -r "$timing_helper" ]] || { echo 'Release timing helper is unavailable.' >&2; exit 1; }
source "$timing_helper"
release_timing_cli() { docker exec -w /workspace "$dev" node --import tsx src/modules/chief-of-staff/ops/mac-release-cli.ts timing "$id" "$@"; }
# Close disposal before target/migration/health repair can delay the final release.
slice=$(cli field "$id" slice)
if [[ "$slice" != G01 && "$slice" != G02 && "$slice" != G03 && "$slice" != G04 ]]; then bash scripts/cos-protect-programme.sh --release-manifest "$manifest"; fi
remote "$(cli preflight-command)" > "$directory/target-observation.json"
cli target-check "$id"
command=$(cli protected-release-command "$id")
if [[ -n "$command" ]]; then
  printf 'Verifying and completing the protected current release %s.\n' "$id"
  remote "$command" > "$directory/protected-release-result.json"
  cli protected-release-check "$id"
  cat "$directory/protected-release-result.json"
  exit 0
fi
origin=$(git remote get-url origin)
[[ "$origin" == https://github.com/ufJmacca/nanoclaw.git || "$origin" == https://github.com/ufJmacca/nanoclaw || "$origin" == git@github.com:ufJmacca/nanoclaw.git ]] || {
  echo 'The Git remote does not identify the bound fork.' >&2; exit 1;
}
gh auth status > "$directory/github-auth.log" 2>&1
commit=$(cli field "$id" commit)
tree=$(cli field "$id" tree)
fetch_ref=$(cli field "$id" fetchRef)
[[ "$(git rev-parse "$commit^{tree}")" == "$tree" ]] || exit 1
timed_release_stage source_push source-push.log bash scripts/cos-push-source.sh "$commit" "$fetch_ref" > "$directory/source-push.log" 2>&1
cli checkpoint "$id" source_pushed
stage=$(cli field "$id" stage)
remote "$(cli stage-command "$id")"
transfer() {
  local name=$1 timing_name
  timing_name=$(printf '%s' "${name//[.-]/_}" | tr '[:upper:]' '[:lower:]') || return
  timed_release_stage "transfer_$timing_name" "$name-transfer.log" scp "${ssh_options[@]}" "$directory/$name" "$alias_name:$stage/$name.partial" > "$directory/$name-transfer.log" 2>&1 || return
  local seal_command
  seal_command=$(cli seal-command "$id" "$name") || return
  timed_release_stage "seal_$timing_name" "$name-transfer.log" remote "$seal_command"
}
for name in release.json SHA256SUMS bootstrap.mjs target.json; do transfer "$name"; done
[[ ! -f "$directory/binding.json" ]] || transfer binding.json
printf 'Verifying pinned source on the Pi for %s\n' "$id"
command=$(cli bootstrap-command "$id" source)
timed_release_stage source_verify source-result.json remote "$command" > "$directory/source-result.json"
cli checkpoint "$id" source_verified
printf 'Transferring the tested image archive for %s\n' "$id"
transfer images.tar.gz
cli checkpoint "$id" transferred
command=$(cli bootstrap-command "$id" prepare)
timed_release_stage prepare_import prepare-result.json remote "$command" > "$directory/prepare-result.json"
cli checkpoint "$id" prepared
printf 'Activating %s. The existing NanoClaw service will briefly stop while protected state is backed up and migrated.\n' "$id"
command=$(cli deploy-command "$id" ${recovery_args[@]+"${recovery_args[@]}"})
[[ -n "$command" ]] || { echo 'Empty remote command refused.' >&2; exit 1; }
if [[ "$slice" == G01 || "$slice" == G02 || "$slice" == G03 || "$slice" == G04 ]]; then
  # Protect the actual credential/backup process before it reads private state.
  command="systemd-run --user --quiet --pipe --wait --collect --unit=nanoclaw-cos-deploy-$id.service --property=LimitCORE=0 --property=MemorySwapMax=0 --property=RuntimeMaxSec=1900 -- /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C LC_ALL=C $command"
fi
timed_release_stage activation deploy-result.json remote "$command" > "$directory/deploy-result.json"
cli checkpoint "$id" healthy
cat "$directory/deploy-result.json"
