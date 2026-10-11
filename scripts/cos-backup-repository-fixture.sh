#!/usr/bin/env bash
# Mac-only driver of the selected immutable host's real repository regressions.
set -euo pipefail
umask 077
[[ "$(uname -s)" == Darwin && $# == 1 ]] || exit 1
[[ -z "${DOCKER_HOST:-}${DOCKER_CONTEXT:-}${DOCKER_TLS_VERIFY:-}${DOCKER_CERT_PATH:-}" ]] || exit 1
image=$1
[[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 1
[[ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")" == linux/arm64 ]] || exit 1
[[ "$(docker image inspect --format '{{index .Config.Labels "nanoclaw.release-role"}}' "$image")" == host ]] || exit 1
source_commit=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
[[ "$source_commit" =~ ^[a-f0-9]{40}$ ]] || exit 1
source_tree=$(git rev-parse "$source_commit^{tree}")
[[ "$source_tree" =~ ^[a-f0-9]{40}$ ]] || exit 1
expected=$(git show "$source_commit:scripts/cos-backup-repository-fixture.sh" | shasum -a 256 | awk '{print $1}')
actual=$(shasum -a 256 "${BASH_SOURCE[0]}" | awk '{print $1}')
[[ "$expected" == "$actual" ]] || exit 1
# Execute the copied runtime before admitting its test output. A build exit alone
# is insufficient after an export fault; no credential environment is forwarded.
docker run --rm --pull=never --network=none --read-only --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
  --ulimit core=0 --memory 256m --memory-swap 256m "$image" --input-type=module -e '
  import fs from "node:fs";import assert from "node:assert/strict";
  assert.equal(process.platform,"linux");assert.equal(process.arch,"arm64");assert.equal(process.version,"v22.23.2");assert.equal(process.getuid(),1000);
  const source=JSON.parse(fs.readFileSync("/release/build-info.json","utf8"));assert.equal(source.commit,process.argv[2]);assert.equal(source.tree,process.argv[3]);
  const {verifyResticReleasePayload}=await import("/release/dist/modules/chief-of-staff/ops/restic-release-payload.js");verifyResticReleasePayload("/release/libexec");
  const {default:Database}=await import("/release/node_modules/better-sqlite3/lib/index.js");const db=new Database(":memory:");assert.equal(db.prepare("select 1 as n").get().n,1);db.close();
  console.log(JSON.stringify({contract:"cos-g02-backup-repository-host/v1",hostImage:process.argv[1],sourceCommit:source.commit,sourceTree:source.tree,actualRuntime:true,actualPinnedPayload:true,actualNativeSqlite:true,sourceOverrides:false,ownerCredentialsUsed:false,databaseCredentialsUsed:false,liveNasAcceptance:false,vaultAndNasAdmission:"fixture",installedAcceptance:false}))
  ' "$image" "$source_commit" "$source_tree"
scope="cos-g02-repository-${source_commit:0:8}-$$"
owned=false
cleanup() { [[ "$owned" != true ]] || docker rm -f "$scope" >/dev/null; }
trap cleanup EXIT
docker create --name "$scope" --pull=never --network=none --read-only --user 1000:1000 \
  --cap-drop ALL --security-opt no-new-privileges --ulimit core=0 --memory 768m --memory-swap 768m --pids-limit 128 \
  --tmpfs /tmp:rw,nosuid,nodev,size=256m,mode=700,uid=1000,gid=1000 --workdir /tmp \
  -e HOME=/tmp -e COS_BACKUP_FIXTURE_BINARY=/release/libexec/restic "$image" --test --test-reporter=tap \
  /release/dist/contracts/chief-of-staff/backup-release-artifact.integration.js \
  /release/dist/contracts/chief-of-staff/backup-publication.integration.js \
  /release/dist/contracts/chief-of-staff/backup-restic.integration.js >/dev/null
owned=true
docker inspect --format '{{json .HostConfig}}' "$scope"
docker start --attach "$scope"
[[ "$(docker inspect --format '{{.State.ExitCode}}' "$scope")" == 0 ]] || exit 1
