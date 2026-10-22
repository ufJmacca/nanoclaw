#!/usr/bin/env bash
# Mac driver: compiled host plus each immutable worker, selected test profile only.
set -euo pipefail
umask 077
[[ "$(uname -s)" == Darwin && ( $# == 5 || ( $# == 6 && "${6:-}" == --drafts ) ) ]] || exit 1
[[ -z "${DOCKER_HOST:-}${DOCKER_CONTEXT:-}${DOCKER_TLS_VERIFY:-}${DOCKER_CERT_PATH:-}" ]] || exit 1
host=$1 standard=$2 documents=$3 test_environment=$4 certificate=$5
fixture_contract=cos-g04-mail
artifact_selection=()
if [[ $# == 6 ]]; then
  fixture_contract=cos-g05-draft
  artifact_selection=(G05)
fi
for image in "$host" "$standard" "$documents"; do
  [[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 1
  [[ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")" == linux/arm64 ]] || exit 1
done
[[ "$host" != "$standard" && "$host" != "$documents" && "$standard" != "$documents" ]] || exit 1
[[ "$(docker image inspect --format '{{index .Config.Labels "nanoclaw.release-role"}}' "$host")" == host ]] || exit 1
source_commit=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$host")
assets=$(docker image inspect --format '{{index .Config.Labels "nanoclaw.worker-assets"}}' "$host")
[[ "$source_commit" =~ ^[a-f0-9]{40}$ && "$assets" =~ ^[a-f0-9]{64}$ ]] || exit 1
source_tree=$(git rev-parse "$source_commit^{tree}")
[[ "$source_tree" =~ ^[a-f0-9]{40}$ ]] || exit 1
expected=$(git show "$source_commit:scripts/cos-mail-artifact-fixture.sh" | shasum -a 256 | awk '{print $1}')
actual=$(shasum -a 256 "${BASH_SOURCE[0]}" | awk '{print $1}')
[[ "$expected" == "$actual" ]] || exit 1
for worker in "$standard" "$documents"; do
  [[ "$(docker image inspect --format '{{index .Config.Labels "nanoclaw.release-role"}}' "$worker")" == agent ]] || exit 1
  [[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$worker")" == "$source_commit" ]] || exit 1
  [[ "$(docker image inspect --format '{{index .Config.Labels "nanoclaw.worker-assets"}}' "$worker")" == "$assets" ]] || exit 1
done
test_root="$(git rev-parse --show-toplevel)/.cos-plan-state/release-tests"
relative=${test_environment#"$test_root/"}
[[ "$relative" =~ ^release-[a-f0-9]{12}-[0-9]{14}/test\.env$ && "$certificate" == "${test_environment%/*}/ca.pem" ]] || exit 1
[[ "$(cd "${test_environment%/*}" && pwd -P)" == "${test_environment%/*}" ]] || exit 1
for file in "$test_environment" "$certificate"; do
  [[ -f "$file" && ! -L "$file" && "$(stat -f %Lp "$file")" == 600 && "$(stat -f %u "$file")" == "$(id -u)" && "$(stat -f %l "$file")" == 1 ]] || exit 1
done
[[ "$(stat -f %z "$test_environment")" -le 65536 && "$(stat -f %z "$certificate")" -le 1048576 ]] || exit 1
keys=$(cut -d= -f1 "$test_environment" | LC_ALL=C sort | tr '\n' ',')
[[ "$keys" == 'COS_TEST_PGDATABASE,COS_TEST_PGHOST,COS_TEST_PGPASSWORD,COS_TEST_PGPORT,COS_TEST_PGSSLMODE,COS_TEST_PGSSLROOTCERT,COS_TEST_PGUSER,COS_TEST_PG_MIGRATION_PASSWORD,COS_TEST_PG_MIGRATION_USER,COS_TEST_TARGET_ID,' ]] || exit 1
nonce=$(uuidgen | tr '[:upper:]' '[:lower:]')
[[ "$nonce" =~ ^[a-f0-9-]{36}$ ]] || exit 1
volume="$fixture_contract-${source_commit:0:8}-$nonce"
owned_volume=false
containers=()
cleanup() {
  local item
  for item in "${containers[@]+"${containers[@]}"}"; do [[ -z "$item" ]] || docker rm -f "$item" >/dev/null; done
  if [[ "$owned_volume" == true && "$(docker volume inspect --format '{{index .Labels "nanoclaw.cos-mail-fixture"}}' "$volume")" == "$nonce" ]]; then
    docker volume rm "$volume" >/dev/null
  fi
}
trap cleanup EXIT
if docker volume inspect "$volume" >/dev/null 2>&1; then exit 1; fi
docker volume create --label "nanoclaw.cos-mail-fixture=$nonce" "$volume" >/dev/null
owned_volume=true
[[ "$(docker volume inspect --format '{{index .Labels "nanoclaw.cos-mail-fixture"}}' "$volume")" == "$nonce" ]] || exit 1
volume_root=$(docker volume inspect --format '{{.Mountpoint}}' "$volume")
[[ "$volume_root" == "/var/lib/docker/volumes/$volume/_data" ]] || exit 1
docker run --rm --pull=never --network=none --user 0:0 --mount "type=volume,src=$volume,dst=/fixture" \
  --entrypoint /release/node/bin/node "$host" -e 'const f=require("fs");for(const p of ["/fixture","/fixture/.cos-plan-state"]){f.mkdirSync(p,{recursive:true,mode:448});f.chmodSync(p,448);f.chownSync(p,1000,1000)}'
printf '{"contract":"%s-artifact-set/v1","sourceCommit":"%s","sourceTree":"%s","workerAssetsDigest":"%s","hostImage":"%s","workerImages":["%s","%s"],"fixtureVolume":"%s","fixtureRoot":"%s"}\n' \
  "$fixture_contract" "$source_commit" "$source_tree" "$assets" "$host" "$standard" "$documents" "$volume" "$volume_root"
run_suite() {
  local suite=$1 worker=$2 name="$volume-$1-${2:7:8}"
  local native=()
  if [[ "$suite" == native ]]; then
    native=(--group-add 0 --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
      -e "COS_FIXTURE_HOST_ROOT=$volume_root" -e "COS_FIXTURE_IMAGE=$worker")
  fi
  docker create --name "$name" --pull=never --network=bridge --read-only --user 1000:1000 --workdir /release \
    --cap-drop ALL --security-opt no-new-privileges --ulimit core=0 --memory 1g --memory-swap 1g --pids-limit 256 \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=128m,mode=700,uid=1000,gid=1000 \
    --env-file "$test_environment" --mount "type=bind,src=$certificate,dst=/fixture/ca.pem,readonly" \
    --mount "type=volume,src=$volume,dst=/release/.cos-plan-state,volume-subpath=.cos-plan-state" \
    -e COS_TEST_PGSSLROOTCERT=/fixture/ca.pem -e COS_FIXTURE_DATABASE_PROFILE=test \
    ${native[@]+"${native[@]}"} --entrypoint /release/node/bin/node "$host" \
    /release/dist/contracts/chief-of-staff/mail-artifact-fixture.js "$suite" "$host" "$worker" "$source_commit" "$source_tree" "$assets" ${artifact_selection[@]+"${artifact_selection[@]}"} >/dev/null
  containers+=("$name")
  docker inspect --format "{\"contract\":\"$fixture_contract-container-scope/v1\",\"image\":{{json .Image}},\"user\":{{json .Config.User}},\"workingDirectory\":{{json .Config.WorkingDir}},\"host\":{{json .HostConfig}},\"mounts\":{{json .Mounts}}}" "$name"
  docker start --attach "$name"
  [[ "$(docker inspect --format '{{.State.ExitCode}}' "$name")" == 0 ]] || return 1
}
run_suite database -
run_suite native "$standard"
run_suite native "$documents"
