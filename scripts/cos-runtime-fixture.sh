#!/usr/bin/env bash
# Internal host coordinator: authenticated SSH stays on the Mac; selected DB credentials stay in trusted fixtures.
set -euo pipefail
umask 077
[[ "$(uname -s)" == Darwin && $# == 8 ]] || {
  echo 'Usage: cos-runtime-fixture.sh owner source|packaged slice|demo host-root host-image worker-image runner-volume fixture-volume' >&2; exit 1;
}
owner=$1 execution=$2 mode=$3 host_root=$4 host_image=$5 worker_image=$6 runner_volume=$7 fixture_volume=$8
[[ "$owner" =~ ^[a-zA-Z0-9_-]{1,100}$ && "$host_image" =~ ^sha256:[a-f0-9]{64}$ && "$worker_image" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 1
[[ "$execution" == source || "$execution" == packaged ]] || exit 1
[[ "$mode" == slice || "$mode" == demo ]] || exit 1
[[ -z "${DOCKER_HOST:-}${DOCKER_CONTEXT:-}${DOCKER_TLS_VERIFY:-}${DOCKER_CERT_PATH:-}" ]] || exit 1
if [[ "$execution" == packaged ]]; then [[ "$fixture_volume" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$ && -z "$runner_volume" ]] || exit 1; fi
root=$(git rev-parse --show-toplevel)
cd "$root"
dev=${COS_DEVCONTAINER_ID:-$(docker compose -f .devcontainer/compose.yaml -p nanoclaw-cos ps -q devcontainer)}
[[ "$dev" =~ ^[a-zA-Z0-9_.-]+$ ]] || exit 1
directory="$root/.cos-plan-state/runtime-tests/$owner"
mkdir -p "$directory"
lock="$root/.cos-plan-state/runtime-fixture.lock"
mkdir "$lock" || { echo 'A runtime fixture owns the Mac lock; reconcile it before retrying.' >&2; exit 1; }
printf '%s\n' "$$" > "$lock/pid"
ssh_pid='' driver_pid=''
cleanup() {
  # Closing SSH makes the live guard fail. Let the trusted driver prove child shutdown before it releases its DB fence.
  [[ -z "$ssh_pid" ]] || kill "$ssh_pid" 2>/dev/null || true
  [[ -z "$driver_pid" ]] || wait "$driver_pid" 2>/dev/null || true
  [[ -z "$ssh_pid" ]] || wait "$ssh_pid" 2>/dev/null || true
  rm -f "$lock/pid" "$lock/request.pipe" "$lock/reply.pipe"
  rmdir "$lock"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
cli() { docker exec -w /workspace "$dev" node --import tsx src/modules/chief-of-staff/ops/mac-runtime-fixture.ts "$@"; }
deploy_cli() { docker exec -w /workspace "$dev" node --import tsx src/modules/chief-of-staff/ops/mac-deploy-cli.ts "$@"; }
alias_name=$(deploy_cli alias)
ssh_options=(-o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 -o ServerAliveInterval=5 -o ServerAliveCountMax=2)
ssh "${ssh_options[@]}" "$alias_name" "$(deploy_cli preflight-command)" > "$directory/target-observation.json"
# Refuse an unbound/protected target before staging any runtime credential profile.
command=$(cli command "$owner")
certificate=$(cli certificate)
[[ -f "$certificate" && ! -L "$certificate" ]] || exit 1
cp "$certificate" "$directory/ca.pem"
chmod 600 "$directory/ca.pem"
cli prepare "$owner" "$execution" "$mode" "$host_root" "$host_image" "$worker_image" "$runner_volume"
if [[ "$execution" == source ]]; then
  [[ "$(docker inspect --format '{{.Image}}' "$dev")" == "$host_image" && "$worker_image" == "$host_image" ]] || exit 1
  driver=(docker exec -i -w /workspace "$dev" node --import tsx src/contracts/chief-of-staff/runtime-fixture-driver.ts "/workspace/.cos-plan-state/runtime-tests/$owner/request.json")
else
  driver=(docker run --rm -i --pull=never --user 1000:1000 --group-add 0
    --mount "type=bind,src=$directory,dst=/fixture/request"
    --mount "type=volume,src=$fixture_volume,dst=/release/.cos-plan-state,volume-subpath=.cos-plan-state"
    --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock
    "$host_image" /release/dist/contracts/chief-of-staff/runtime-fixture-driver.js /fixture/request/request.json)
fi
mkfifo "$lock/request.pipe" "$lock/reply.pipe"
# Temporary read/write descriptors let both sides open without a FIFO-open deadlock. Children must not inherit them.
exec 3<>"$lock/request.pipe" 4<>"$lock/reply.pipe"
ssh "${ssh_options[@]}" "$alias_name" "$command" < "$lock/request.pipe" > "$lock/reply.pipe" 3>&- 4>&- &
ssh_pid=$!
"${driver[@]}" < "$lock/reply.pipe" > "$lock/request.pipe" 3>&- 4>&- &
driver_pid=$!
exec 3>&- 4>&-
if wait "$driver_pid"; then driver_pid=''; else exit 1; fi
if wait "$ssh_pid"; then ssh_pid=''; else exit 1; fi
printf 'Runtime fixture completed: %s\n' "$owner"
