#!/usr/bin/env bash
# Host Docker and Keychain orchestration only; all project code is baked into the exact ARM64 fixture image.
set -euo pipefail
umask 077
[[ "$(uname -s)" == Darwin && ( $# == 2 || $# == 3 ) ]] || exit 1
mode=$1 image=$2
[[ "$mode" == kernel || "$mode" == helper || "$mode" == units ]] || exit 1
[[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 1
[[ -z "${DOCKER_HOST:-}${DOCKER_CONTEXT:-}${DOCKER_TLS_VERIFY:-}${DOCKER_CERT_PATH:-}" ]] || exit 1
role=$(docker image inspect --format '{{index .Config.Labels "nanoclaw.release-role"}}' "$image")
source_commit=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
[[ "$role" == vault-fixture && "$source_commit" =~ ^[a-f0-9]{40}$ ]] || exit 1
printf '{"vaultFixtureImage":"%s","sourceCommit":"%s","mode":"%s"}\n' "$image" "$source_commit" "$mode"
if [[ "$mode" == helper || "$mode" == units ]]; then
  [[ $# == 2 ]] || exit 1
  probe=probe-artifact.mjs
  [[ "$mode" != units ]] || probe=verify-units.mjs
  exec docker run --rm --pull=never --network=none --ulimit core=0 --memory 256m --memory-swap 256m \
    -e NANOCLAW_COS_VAULT_FIXTURE=1 --entrypoint /usr/local/bin/node "$image" "/probe/$probe"
fi
[[ $# == 3 && -f "$3" && ! -L "$3" ]] || exit 1
expected_keychain=$(git show "$source_commit:scripts/cos-vault-keychain.swift" | shasum -a256 | awk '{print $1}')
actual_keychain=$(shasum -a256 "$3" | awk '{print $1}')
[[ "$actual_keychain" == "$expected_keychain" ]] || exit 1
dm_major=$(docker run --rm --pull=never --network=none --entrypoint /usr/local/bin/node "$image" \
  -e 'const f=require("fs");const m=f.readFileSync("/proc/devices","utf8").match(/^\s*(\d+)\s+device-mapper\s*$/m);if(!m)process.exit(1);process.stdout.write(m[1])')
[[ "$dm_major" =~ ^[0-9]{1,4}$ ]] || exit 1
# A fresh disposable Keychain item feeds the private pipe. Neither stream is logged or written to a key file.
swift "$3" fixture-stream | docker run --rm -i --pull=never --network=none --cap-add SYS_ADMIN \
  --device /dev/loop-control \
  --device-cgroup-rule 'b 7:* rwm' --device-cgroup-rule "b $dm_major:* rwm" \
  --device-cgroup-rule 'c 10:236 rwm' --device-cgroup-rule 'c 10:237 rwm' \
  --ulimit core=0 --memory 768m --memory-swap 768m -e NANOCLAW_COS_VAULT_FIXTURE=1 "$image"
