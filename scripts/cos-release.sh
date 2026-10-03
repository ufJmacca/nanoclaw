#!/usr/bin/env bash
# Host-only orchestration. All project tooling and dependencies execute in the devcontainer.
set -euo pipefail
umask 077
[[ "$(uname -s)" == Darwin ]] || { echo 'cos:release requires the Mac host' >&2; exit 1; }
[[ ( $# == 6 || ( $# == 7 && "${7:-}" == --local-only ) ) && "$1" == --slice && ( "$2" == S06 || "$2" == S07 ) && "$3" == --target && "$4" == pi && "$5" == --db-profile ]] || {
  echo 'Usage: cos:release --slice S06|S07 --target pi --db-profile test|runtime-disposable [--local-only]' >&2; exit 1;
}
slice=$2 profile=$6
[[ "$profile" == test || "$profile" == runtime-disposable ]] || exit 1
[[ -z "${DOCKER_HOST:-}${DOCKER_CONTEXT:-}${DOCKER_TLS_VERIFY:-}${DOCKER_CERT_PATH:-}${BUILDX_BUILDER:-}" ]] || {
  echo 'Explicit Docker endpoint overrides are not accepted for releases.' >&2; exit 1;
}
root=$(git rev-parse --show-toplevel)
cd "$root"
[[ -z "$(git status --porcelain)" ]] || { echo 'Commit the candidate changes before releasing.' >&2; exit 1; }
commit=$(git rev-parse HEAD)
branch=$(git symbolic-ref HEAD)
[[ "$branch" == refs/heads/* ]] || exit 1
mkdir -p .cos-plan-state/releases .cos-plan-state/release-tests
lock="$root/.cos-plan-state/release.lock"
mkdir "$lock" || { echo 'Another release owns the Mac lock; reconcile it before retrying.' >&2; exit 1; }
printf '%s\n' "$$" > "$lock/pid"
carrier=''
cleanup() {
  [[ -z "$carrier" ]] || docker rm "$carrier" >/dev/null 2>&1 || true
  rm -f "$lock/pid"
  rmdir "$lock"
}
trap cleanup EXIT
stamp=$(date -u +%Y%m%d%H%M%S)
id="release-${commit:0:12}-$stamp"
directory="$root/.cos-plan-state/releases/$id"
mkdir "$directory"
dev=${COS_DEVCONTAINER_ID:-$(docker compose -f .devcontainer/compose.yaml -p nanoclaw-cos ps -q devcontainer)}
[[ "$dev" =~ ^[a-zA-Z0-9_.-]+$ ]] || { echo 'The repository devcontainer must be running.' >&2; exit 1; }
docker inspect "$dev" > "$directory/devcontainer.json"
cli() { docker exec -w /workspace "$dev" node --import tsx src/modules/chief-of-staff/ops/mac-release-cli.ts "$@"; }
cli init "$id" "$commit" "$branch" "$slice"
docker context inspect --format '{{json .}}' > "$directory/context.json"
docker info --format '{{json .}}' > "$directory/engine.json"
docker buildx ls --format '{{json .}}' > "$directory/builders.jsonl"
cli builder "$id"
deploy_cli() { docker exec -w /workspace "$dev" node --import tsx src/modules/chief-of-staff/ops/mac-deploy-cli.ts "$@"; }
alias_name=$(deploy_cli alias)
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 "$alias_name" "$(deploy_cli preflight-command)" > "$directory/target-observation.json"
cli target "$id"
builder=$(cli field "$id" builder)
context=$(cli field "$id" context)
assets=$(cli field "$id" assets)
test_directory="$root/.cos-plan-state/release-tests/$id"
if [[ "$profile" == test ]]; then
  certificate=$(cli certificate)
  [[ -f "$certificate" && ! -L "$certificate" ]] || { echo 'The selected test CA file is unavailable.' >&2; exit 1; }
  cp "$certificate" "$test_directory/ca.pem"
  chmod 600 "$test_directory/ca.pem"
  cli profile "$id"
fi
fixture_image=$(docker inspect --format '{{.Image}}' "$dev")
runner_volume=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/workspace/container/agent-runner/node_modules"}}{{.Name}}{{end}}{{end}}' "$dev")
[[ "$fixture_image" =~ ^sha256:[a-f0-9]{64}$ && "$runner_volume" =~ ^[a-zA-Z0-9_.-]+$ ]] || exit 1
check() {
  local name=$1
  shift
  printf 'Running %s checks for %s\n' "$name" "$id"
  if "$@" > "$directory/$name.log" 2>&1; then
    cli record "$id" "$name" 0
  else
    cli record "$id" "$name" 1
    printf 'Check failed: %s. Private log: %s/%s.log\n' "$name" "$directory" "$name" >&2
    exit 1
  fi
}
root_checks() {
  docker exec "$dev" pnpm test &&
  docker exec "$dev" pnpm typecheck &&
  docker exec "$dev" pnpm build &&
  docker exec "$dev" pnpm lint &&
  docker exec "$dev" pnpm format:check
}
runner_checks() {
  docker exec "$dev" pnpm --dir container/agent-runner typecheck &&
  docker exec -w /workspace/container/agent-runner "$dev" bun test
}
check root root_checks
check runner runner_checks
source scripts/cos-source-fixture.sh
source_fixture() {
  local mode=$1
  if [[ "$mode" == demo ]]; then set -- --demo --fixture; else set --; fi
  if [[ "$profile" == test ]]; then
    prepare_source_fixture "$dev" "$id-$mode" "$directory/context" "$fixture_image" "$runner_volume" || return
    "${source_fixture_driver[@]}" --env-file "$test_directory/test.env" \
      --mount "type=bind,src=$test_directory/ca.pem,dst=/selected-ca.pem,readonly" \
      -e COS_TEST_PGSSLROOTCERT=/selected-ca.pem \
      -e "COS_FIXTURE_IMAGE=$fixture_image" -e "COS_FIXTURE_RUNNER_VOLUME=$runner_volume" \
      -e "COS_FIXTURE_SOURCE_ROOT=$directory/context" -e "COS_FIXTURE_HOST_ROOT=$source_fixture_host_root" \
      "$fixture_image" --import tsx src/contracts/chief-of-staff/run.ts --slice "$slice" --db-profile test \
      "$@"
  else
    bash scripts/cos-runtime-fixture.sh "$id-$mode" source "$mode" "$root" "$fixture_image" "$fixture_image" "$runner_volume" ''
  fi
}
check slice source_fixture slice
check demo source_fixture demo
for target in host agent-standard agent-documents; do
  tag=$(cli field "$id" "$target-tag")
  printf 'Building Linux/ARM64 %s\n' "$target"
  docker --context "$context" buildx build --builder "$builder" --platform linux/arm64 --provenance=false \
    --load --target "$target" --build-arg "SOURCE_COMMIT=$commit" --build-arg "WORKER_ASSETS_DIGEST=$assets" \
    -f "$directory/context/container/release/Dockerfile" -t "$tag" "$directory/context" \
    > "$directory/$target-build.log" 2>&1
  docker --context "$context" image inspect "$tag" > "$directory/$target-inspect.json"
done
cli images "$id"
host_image=$(cli field "$id" host-id)
standard_image=$(cli field "$id" agent-standard-id)
documents_image=$(cli field "$id" agent-documents-id)
# Daemon-native paths are required for worker Unix sockets. Only this release's synthetic volume is used.
volume="cos-${commit:0:8}-$stamp"
docker volume create --label "nanoclaw.cos-fixture=$id" "$volume" > "$directory/fixture-volume.txt"
volume_root=$(docker volume inspect --format '{{.Mountpoint}}' "$volume")
docker run --rm --pull=never --network=none --user 0:0 --mount "type=volume,src=$volume,dst=/fixture" \
  --entrypoint node "$fixture_image" -e 'const f=require("fs");for(const p of ["/fixture","/fixture/.cos-plan-state","/fixture/s"]){f.mkdirSync(p,{recursive:true,mode:448});f.chmodSync(p,448);f.chownSync(p,1000,1000)}'
host_checks() {
  docker run --rm --pull=never --network=none --entrypoint /release/node/bin/node "$host_image" \
    --input-type=module -e 'await import("/release/bootstrap.mjs"); const {default:D}=await import("/release/node_modules/better-sqlite3/lib/index.js");const d=new D(":memory:");if(d.prepare("select 1 as n").get().n!==1)process.exit(1);d.close()' || return
  docker run --rm --pull=never --network=none --read-only --user 1000:1000 \
    --tmpfs /tmp:rw,nosuid,nodev -w /tmp "$host_image" --test \
    /release/src/contracts/chief-of-staff/subscription-operator.integration.mjs || return
  local worker
  for worker in "$standard_image" "$documents_image"; do
    if [[ "$profile" == runtime-disposable ]]; then
      bash scripts/cos-runtime-fixture.sh "$id-host-${worker:7:12}" packaged slice "$volume_root" "$host_image" "$worker" '' "$volume" || return
      continue
    fi
    docker run --rm --pull=never --user 1000:1000 --group-add 0 \
      --env-file "$test_directory/test.env" \
      --mount "type=bind,src=$test_directory/ca.pem,dst=/fixture/ca.pem,readonly" \
      --mount "type=volume,src=$volume,dst=/release/.cos-plan-state,volume-subpath=.cos-plan-state" \
      --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
      -e "COS_FIXTURE_IMAGE=$worker" -e "COS_FIXTURE_HOST_ROOT=$volume_root" \
      "$host_image" /release/dist/contracts/chief-of-staff/run.js --slice "$slice" --db-profile test || return
  done
  docker run --rm --pull=never --network=none "$host_image" --input-type=module \
    -e 'import {payloadDigest} from "/release/dist/modules/chief-of-staff/ops/payload.js";console.log(await payloadDigest("/release"))' > "$directory/payload.sha256"
}
agent_checks() {
  local worker
  for worker in "$standard_image" "$documents_image"; do
    docker run --rm --pull=never --network=none -w /app --entrypoint bun "$worker" test /app/src || return
    docker run --rm --pull=never --network=none --entrypoint /bin/sh "$worker" -c \
      'codex --version && claude --version && gh --version && agent-browser --version && vercel --version' || return
  done
  docker run --rm --pull=never --network=none --entrypoint python3 "$documents_image" \
    -c 'import reportlab, pypdf; print("document-profile-passed")'
}
isolation_checks() {
  local worker
  for worker in "$standard_image" "$documents_image"; do
    docker run --rm --pull=never --network=none --user 1000:1000 --group-add 0 \
      --mount "type=volume,src=$volume,dst=/fixture" \
      --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
      -e "COS_FIXTURE_IMAGE=$worker" -e "COS_FIXTURE_HOST_ROOT=$volume_root" \
      -e COS_SMOKE_ROOT=/fixture/s -e "COS_SMOKE_HOST_ROOT=$volume_root/s" \
      -e COS_SUBSCRIPTION_ROOT=/fixture/s -e "COS_SUBSCRIPTION_HOST_ROOT=$volume_root/s" \
      "$host_image" --test --test-concurrency=1 \
      /release/dist/contracts/chief-of-staff/native-smoke.integration.js \
      /release/dist/contracts/chief-of-staff/subscription-native.integration.js || return
    bash scripts/cos-subscription-image-check.sh "$host_image" "$worker" "$directory/native-${worker:7:12}" || return
  done
}
check image_isolation isolation_checks
check agent_image agent_checks
check host_image host_checks
# Export the existing tested identities, without rebuilding. Configuration IDs are hashed from this archive.
docker save -o "$directory/images.tar" \
  "$(cli field "$id" host-tag)" "$(cli field "$id" agent-standard-tag)" "$(cli field "$id" agent-documents-tag)"
gzip -n "$directory/images.tar"
carrier=$(docker create --pull=never --network=none --entrypoint /bin/true "$host_image")
docker cp "$carrier:/release/bootstrap.mjs" "$directory/bootstrap.mjs"
chmod 600 "$directory/bootstrap.mjs"
docker rm "$carrier" > /dev/null
carrier=''
cli finish "$id" > "$directory/manifest.sha256"
printf 'Transferable release: %s/release.json\n' "$directory"
if [[ "${7:-}" == --local-only ]]; then
  printf 'Local verification complete; source sync, transfer and deployment have not run.\n'
  exit 0
fi
bash "$root/scripts/cos-deploy.sh" --target pi --release-manifest "$directory/release.json"
