#!/usr/bin/env bash
# Offline checks against immutable release bytes; never mount checkout application code.
set -euo pipefail
umask 077
[[ $# == 3 && "$1" =~ ^sha256:[a-f0-9]{64}$ && "$2" =~ ^sha256:[a-f0-9]{64}$ && "$3" == /* ]] || exit 1
host_image=$1
worker_image=$2
directory=$3
mkdir "$directory"
host_source=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$host_image")
worker_source=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$worker_image")
[[ "$host_source" =~ ^[a-f0-9]{40}$ && "$host_source" == "$worker_source" ]] || exit 1
carrier=$(docker create --pull=never --network=none --entrypoint /bin/true "$host_image")
trap 'docker rm "$carrier" >/dev/null 2>&1 || true' EXIT
docker cp "$carrier:/release/container/agent-runner/fixtures/cos-subscription-capability.ts" "$directory/cos-subscription-capability.ts"
for module in subscription-egress subscription-turns conversation-access identity mattermost-facts; do
  docker cp "$carrier:/release/src/modules/chief-of-staff/bridge/$module.ts" "$directory/$module.ts"
done
# The flattened bridge fixture retains its relative runtime-contract import.
# Extract that dependency from the same carrier; no checkout source is supplied.
mkdir "$directory/contracts"
docker cp "$carrier:/release/src/modules/chief-of-staff/contracts/operations-protocol.ts" "$directory/contracts/operations-protocol.ts"
chmod 755 "$directory"
chmod 644 "$directory/"*.ts
chmod 755 "$directory/contracts"
chmod 644 "$directory/contracts/"*.ts
for scenario in restart compaction shutdown membership rpc tool-refresh mandate-refresh; do
  extra=()
  case "$scenario" in
    tool-refresh) extra+=(-e NANOCLAW_COS_FIXTURE_TOOL_REFRESH=1) ;;
    mandate-refresh) extra+=(-e NANOCLAW_COS_FIXTURE_MANDATE_REFRESH=1) ;;
    compaction) extra+=(-e NANOCLAW_COS_FIXTURE_COMPACTION=1) ;;
    shutdown|membership|rpc) extra+=(-e "NANOCLAW_COS_FIXTURE_CANCELLATION=$scenario") ;;
  esac
  printf 'Native subscription %s: %s, source %s\n' "$scenario" "$worker_image" "$host_source"
  docker run --rm --pull=never --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --tmpfs /tmp:rw,nosuid,nodev --tmpfs /home/node:rw,nosuid,nodev \
    --tmpfs /workspace:rw,nosuid,nodev,uid=1000,gid=1000 \
    --tmpfs /run/cos:rw,nosuid,nodev,uid=1000,gid=1000 \
    --tmpfs /run/nanoclaw:rw,nosuid,nodev,uid=1000,gid=1000 \
    --tmpfs /etc/ssl/certs:rw,nosuid,nodev,uid=1000,gid=1000 \
    -e HOME=/home/node -e NANOCLAW_COS_OFFLINE_FIXTURE=1 \
    -e NANOCLAW_COS_FIXTURE_SYSTEM_TRUST=1 -e NANOCLAW_COS_FIXTURE_PRODUCTION_QUERY=1 \
    -e NANOCLAW_COS_FIXTURE_RUNNER_ENTRY=1 \
    -e NANOCLAW_COS_FIXTURE_EGRESS_MODULE=file:///fixture/subscription-egress.ts \
    ${extra[@]+"${extra[@]}"} \
    --mount "type=bind,src=$directory,dst=/fixture,readonly" \
    --mount "type=bind,src=$directory/contracts,dst=/contracts,readonly" \
    --mount "type=bind,src=$directory/cos-subscription-capability.ts,dst=/app/fixtures/cos-subscription-capability.ts,readonly" \
    --workdir /workspace --entrypoint bun "$worker_image" /app/fixtures/cos-subscription-capability.ts
done
