#!/usr/bin/env bash
# Mac-only orchestration of a disposable, source-bound user service manager.
set -euo pipefail
umask 077
[[ "$(uname -s)" == Darwin && $# == 2 ]] || exit 1
[[ -z "${DOCKER_HOST:-}${DOCKER_CONTEXT:-}${DOCKER_TLS_VERIFY:-}${DOCKER_CERT_PATH:-}" ]] || exit 1
image=$1
slice=$2
[[ "$slice" == G02 || "$slice" == G03 || "$slice" == G04 || "$slice" == G05 || "$slice" == G06 ]] || exit 1
[[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 1
[[ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")" == linux/arm64 ]] || exit 1
[[ "$(docker image inspect --format '{{index .Config.Labels "nanoclaw.release-role"}}' "$image")" == backup-job-manager-fixture ]] || exit 1
[[ "$(docker image inspect --format '{{index .Config.Labels "nanoclaw.final-artifact"}}' "$image")" == false ]] || exit 1
source_commit=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
source_tree=$(docker image inspect --format '{{index .Config.Labels "nanoclaw.source-tree"}}' "$image")
host_image=$(docker image inspect --format '{{index .Config.Labels "nanoclaw.tested-host"}}' "$image")
[[ "$source_commit" =~ ^[a-f0-9]{40}$ && "$source_tree" =~ ^[a-f0-9]{40}$ && "$host_image" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 1
[[ "$(git rev-parse "$source_commit^{tree}")" == "$source_tree" ]] || exit 1
[[ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$host_image")" == linux/arm64 ]] || exit 1
[[ "$(docker image inspect --format '{{index .Config.Labels "nanoclaw.release-role"}}' "$host_image")" == host ]] || exit 1
[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$host_image")" == "$source_commit" ]] || exit 1
expected=$(git show "$source_commit:scripts/cos-backup-jobs-fixture.sh" | shasum -a 256 | awk '{print $1}')
actual=$(shasum -a 256 "${BASH_SOURCE[0]}" | awk '{print $1}')
[[ "$expected" == "$actual" ]] || exit 1
runtime=$(docker run --rm --pull=never --network=none --read-only --entrypoint /release/node/bin/node "$image" \
  --input-type=module -e 'if(process.platform!=="linux"||process.arch!=="arm64"||process.version!=="v22.23.2")process.exit(1);const fs=await import("node:fs");const source=JSON.parse(fs.readFileSync("/release/build-info.json","utf8"));if(source.commit!==process.argv[1]||source.tree!==process.argv[2])process.exit(1);const {verifyResticReleasePayload}=await import("/release/dist/modules/chief-of-staff/ops/restic-release-payload.js");verifyResticReleasePayload("/release/libexec");const {default:Database}=await import("/release/node_modules/better-sqlite3/lib/index.js");const db=new Database(":memory:");if(db.prepare("select 1 as n").get().n!==1)process.exit(1);db.close();process.stdout.write("backup-job-runtime-verified")' \
  "$source_commit" "$source_tree")
[[ "$runtime" == backup-job-runtime-verified ]] || exit 1
scope="cos-backup-jobs-${source_commit:0:8}-$$"
owned=false
cleanup() { [[ "$owned" != true ]] || docker rm -f "$scope" >/dev/null; }
trap cleanup EXIT
docker create --name "$scope" --pull=never --network=none --privileged --cgroupns=private \
  --ulimit core=0 --memory 1g --memory-swap 1g --pids-limit 256 \
  --tmpfs /run:rw,nosuid,nodev,size=64m --tmpfs /tmp:rw,nosuid,nodev,size=128m "$image" >/dev/null
owned=true
docker start "$scope" >/dev/null
ready=false
for ((attempt=0;attempt<30;attempt++)); do
  if docker exec "$scope" /usr/bin/test -S /run/user/1000/bus; then ready=true; break; fi
  [[ "$(docker inspect --format '{{.State.Running}}' "$scope")" == true ]] || exit 1
  sleep 1
done
[[ "$ready" == true ]] || exit 1
printf '{"jobFixtureImage":"%s","testedHost":"%s","sourceCommit":"%s","sourceTree":"%s","releaseSlice":"%s","privateCgroupNamespace":true,"hostDataMounted":false,"ownerCredentialsUsed":false}\n' \
  "$image" "$host_image" "$source_commit" "$source_tree" "$slice"
docker inspect --format '{{json .HostConfig}}' "$scope"
docker exec --user 1000:1000 --workdir /home/fixture \
  -e "COS_BACKUP_FIXTURE_SOURCE_COMMIT=$source_commit" -e "COS_BACKUP_FIXTURE_SOURCE_TREE=$source_tree" \
  -e "COS_BACKUP_FIXTURE_SLICE=$slice" \
  "$scope" /release/node/bin/node /fixture/probe-release.mjs
