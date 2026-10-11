#!/usr/bin/env bash
# Host-only Docker orchestration. All code and public synthetic data stay in isolated fixtures.
set -euo pipefail
umask 077
[[ "$(uname -s)" == Darwin && $# == 2 ]] || exit 1
[[ -z "${DOCKER_HOST:-}${DOCKER_CONTEXT:-}${DOCKER_TLS_VERIFY:-}${DOCKER_CERT_PATH:-}" ]] || exit 1
server_image=$1 client_image=$2
[[ "$server_image" =~ ^sha256:[a-f0-9]{64}$ && "$client_image" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 1
[[ "$(docker image inspect --format '{{index .Config.Labels "nanoclaw.release-role"}}' "$server_image")" == backup-smb-server-fixture ]] || exit 1
[[ "$(docker image inspect --format '{{index .Config.Labels "nanoclaw.release-role"}}' "$client_image")" == backup-smb-client-fixture ]] || exit 1
source_commit=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$client_image")
source_tree=$(docker image inspect --format '{{index .Config.Labels "nanoclaw.source-tree"}}' "$client_image")
host_image=$(docker image inspect --format '{{index .Config.Labels "nanoclaw.tested-host"}}' "$client_image")
[[ "$source_commit" =~ ^[a-f0-9]{40}$ && "$source_tree" =~ ^[a-f0-9]{40}$ && "$host_image" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 1
for image in "$server_image" "$client_image"; do
  [[ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")" == linux/arm64 ]] || exit 1
  [[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" == "$source_commit" ]] || exit 1
  [[ "$(docker image inspect --format '{{index .Config.Labels "nanoclaw.source-tree"}}' "$image")" == "$source_tree" ]] || exit 1
  [[ "$(docker image inspect --format '{{index .Config.Labels "nanoclaw.final-artifact"}}' "$image")" == false ]] || exit 1
done
[[ "$(docker image inspect --format '{{index .Config.Labels "nanoclaw.release-role"}}' "$host_image")" == host ]] || exit 1
[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$host_image")" == "$source_commit" ]] || exit 1
[[ "$(git rev-parse "$source_commit^{tree}")" == "$source_tree" ]] || exit 1
expected=$(git show "$source_commit:scripts/cos-backup-smb-fixture.sh" | shasum -a 256 | awk '{print $1}')
actual=$(shasum -a 256 "${BASH_SOURCE[0]}" | awk '{print $1}')
[[ "$expected" == "$actual" ]] || exit 1
scope="cos-g02-smb-${source_commit:0:8}-$$"
network="$scope-network" server="$scope-server" client="$scope-client"
network_owned=false server_owned=false client_owned=false
cleanup() {
  [[ "$client_owned" != true ]] || docker rm -f "$client" >/dev/null 2>&1 || true
  [[ "$server_owned" != true ]] || docker rm -f "$server" >/dev/null 2>&1 || true
  [[ "$network_owned" != true ]] || docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create --internal --driver bridge --label "nanoclaw.cos-fixture=$scope" "$network" >/dev/null
network_owned=true
[[ "$(docker network inspect --format '{{.Internal}}' "$network")" == true ]] || exit 1
docker create --name "$server" --pull=never --network "$network" --network-alias cos-backup-smb-server \
  --read-only --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add FSETID \
  --cap-add SETUID --cap-add SETGID --cap-add NET_BIND_SERVICE --security-opt no-new-privileges \
  --ulimit core=0 --pids-limit 128 --memory 384m --memory-swap 384m \
  --tmpfs /run/fixture:rw,nosuid,nodev,noexec,size=256m,mode=700 \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=8m,mode=700 "$server_image" >/dev/null
server_owned=true
docker start "$server" >/dev/null
ready=false
for ((attempt=0;attempt<30;attempt++)); do
  if docker exec "$server" /usr/bin/test -f /run/fixture/ready; then ready=true; break; fi
  [[ "$(docker inspect --format '{{.State.Running}}' "$server")" == true ]] || exit 1
  sleep 1
done
[[ "$ready" == true ]] || exit 1
docker create --name "$client" --pull=never --network "$network" \
  --read-only --cap-drop ALL --cap-add SYS_ADMIN --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --cap-add SETUID --cap-add SETGID --security-opt no-new-privileges \
  --ulimit core=0 --pids-limit 128 --memory 768m --memory-swap 768m \
  --tmpfs /run/fixture:rw,nosuid,nodev,noexec,size=128m,mode=700 \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=8m,mode=700 \
  --tmpfs /var/lib/nanoclaw-cos:rw,nosuid,nodev,noexec,size=8m,mode=711 "$client_image" >/dev/null
client_owned=true
printf '{"serverImage":"%s","clientImage":"%s","testedHost":"%s","sourceCommit":"%s","sourceTree":"%s","internalNetwork":true,"hostPortsPublished":false,"hostDataMounted":false,"ownerCredentialsUsed":false}\n' \
  "$server_image" "$client_image" "$host_image" "$source_commit" "$source_tree"
docker inspect --format '{{json .HostConfig}}' "$client"
docker start --attach "$client"
[[ "$(docker inspect --format '{{.State.ExitCode}}' "$client")" == 0 ]] || exit 1
docker exec "$server" /bin/sh -c '
  set -eu
  test -f /run/fixture/allowed/restic/config
  test "$(find /run/fixture/allowed/restic/snapshots -type f | wc -l)" -eq 1
  test "$(find /run/fixture/denied -mindepth 1 | wc -l)" -eq 0
  result=0
  grep -r -a -l -F COS_G02_SIGNED_SMB_ENCRYPTION_CANARY_997dbc41 /run/fixture/allowed >/dev/null || result=$?
  test "$result" -eq 1
  printf "%s\n" "{\"contract\":\"cos-g02-smb-ciphertext-inspection/v1\",\"status\":\"passed\",\"snapshotFiles\":1,\"plaintextCanaryAbsent\":true,\"deniedShareUnchanged\":true}"
'
