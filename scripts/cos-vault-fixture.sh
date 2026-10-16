#!/usr/bin/env bash
# Host Docker and Keychain orchestration only; all project code is baked into the exact ARM64 fixture image.
set -euo pipefail
umask 077
[[ "$(uname -s)" == Darwin && ( $# == 2 || $# == 3 || $# == 5 ) ]] || exit 1
mode=$1 image=$2
[[ "$mode" == kernel || "$mode" == backup-kernel || "$mode" == backup-capture-kernel || "$mode" == mail-credentials-kernel || "$mode" == helper || "$mode" == units ]] || exit 1
[[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 1
[[ -z "${DOCKER_HOST:-}${DOCKER_CONTEXT:-}${DOCKER_TLS_VERIFY:-}${DOCKER_CERT_PATH:-}" ]] || exit 1
role=$(docker image inspect --format '{{index .Config.Labels "nanoclaw.release-role"}}' "$image")
source_commit=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
[[ "$role" == vault-fixture && "$source_commit" =~ ^[a-f0-9]{40}$ ]] || exit 1
[[ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")" == linux/arm64 ]] || exit 1
expected_driver=$(git show "$source_commit:scripts/cos-vault-fixture.sh" | shasum -a256 | awk '{print $1}')
actual_driver=$(shasum -a256 "${BASH_SOURCE[0]}" | awk '{print $1}')
[[ "$actual_driver" == "$expected_driver" ]] || exit 1
printf '{"vaultFixtureImage":"%s","sourceCommit":"%s","mode":"%s"}\n' "$image" "$source_commit" "$mode"
if [[ "$mode" == helper || "$mode" == units ]]; then
  [[ $# == 2 ]] || exit 1
  probe=probe-artifact.mjs
  [[ "$mode" != units ]] || probe=verify-units.mjs
  fixture_memory=256m
  # The sealed installer runs concurrent Node processes and materializes runtime copies.
  [[ "$mode" != helper ]] || fixture_memory=512m
  exec docker run --rm --pull=never --network=none --ulimit core=0 --memory "$fixture_memory" --memory-swap "$fixture_memory" \
    -e NANOCLAW_COS_VAULT_FIXTURE=1 --entrypoint /usr/local/bin/node "$image" "/probe/$probe"
fi
[[ ( $# == 3 || ( "$mode" == backup-capture-kernel && $# == 5 ) ) && -f "$3" && ! -L "$3" ]] || exit 1
expected_keychain=$(git show "$source_commit:scripts/cos-vault-keychain.swift" | shasum -a256 | awk '{print $1}')
actual_keychain=$(shasum -a256 "$3" | awk '{print $1}')
[[ "$actual_keychain" == "$expected_keychain" ]] || exit 1
dm_major=$(docker run --rm --pull=never --network=none --entrypoint /usr/local/bin/node "$image" \
  -e 'const f=require("fs");const m=f.readFileSync("/proc/devices","utf8").match(/^\s*(\d+)\s+device-mapper\s*$/m);if(!m)process.exit(1);process.stdout.write(m[1])')
[[ "$dm_major" =~ ^[0-9]{1,4}$ ]] || exit 1
backup_options=()
capture_options=()
fixture_network=none
if [[ "$mode" == backup-kernel ]]; then
  # Inspect only a helper spawned inside this disposable container's private PID namespace.
  backup_options=(--cap-add SYS_PTRACE -e NANOCLAW_COS_BACKUP_FIXTURE=1)
fi
if [[ "$mode" == mail-credentials-kernel ]]; then
  backup_options=(-e NANOCLAW_COS_MAIL_CREDENTIAL_FIXTURE=1)
fi
if [[ "$mode" == backup-capture-kernel ]]; then
  [[ $# == 5 ]] || exit 1
  test_root="$(git rev-parse --show-toplevel)/.cos-plan-state/release-tests"
  relative=${4#"$test_root/"}
  [[ "$relative" =~ ^release-[a-f0-9]{12}-[0-9]{14}/test\.env$ && "$5" == "${4%/*}/ca.pem" ]] || exit 1
  [[ "$(cd "${4%/*}" && pwd -P)" == "${4%/*}" ]] || exit 1
  for file in "$4" "$5"; do
    [[ -f "$file" && ! -L "$file" && "$(stat -f %Lp "$file")" == 600 && "$(stat -f %u "$file")" == "$(id -u)" && "$(stat -f %l "$file")" == 1 ]] || exit 1
  done
  [[ "$(stat -f %z "$4")" -le 65536 && "$(stat -f %z "$5")" -le 1048576 ]] || exit 1
  keys=$(cut -d= -f1 "$4" | LC_ALL=C sort | tr '\n' ',')
  [[ "$keys" == 'COS_TEST_PGDATABASE,COS_TEST_PGHOST,COS_TEST_PGPASSWORD,COS_TEST_PGPORT,COS_TEST_PGSSLMODE,COS_TEST_PGSSLROOTCERT,COS_TEST_PGUSER,COS_TEST_PG_MIGRATION_PASSWORD,COS_TEST_PG_MIGRATION_USER,COS_TEST_TARGET_ID,' ]] || exit 1
  fixture_network=bridge
  capture_options=(--env-file "$4" --mount "type=bind,src=$5,dst=/selected-ca.pem,readonly" \
    -e COS_TEST_PGSSLROOTCERT=/selected-ca.pem -e COS_FIXTURE_DATABASE_PROFILE=test -e NANOCLAW_COS_BACKUP_POSTGRES_FIXTURE=1)
else
  [[ $# == 3 ]] || exit 1
fi
# A fresh disposable Keychain item feeds the private pipe. Neither stream is logged or written to a key file.
swift "$3" fixture-stream | docker run --rm -i --pull=never --network="$fixture_network" --cap-add SYS_ADMIN \
  ${backup_options[@]+"${backup_options[@]}"} \
  ${capture_options[@]+"${capture_options[@]}"} \
  --device /dev/loop-control \
  --device-cgroup-rule 'b 7:* rwm' --device-cgroup-rule "b $dm_major:* rwm" \
  --device-cgroup-rule 'c 10:236 rwm' --device-cgroup-rule 'c 10:237 rwm' \
  --ulimit core=0 --memory 768m --memory-swap 768m \
  -e NANOCLAW_COS_VAULT_FIXTURE=1 -e NANOCLAW_COS_VAULT_KEYCHAIN_FIXTURE=1 "$image"
