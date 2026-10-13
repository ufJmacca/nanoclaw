#!/usr/bin/env bash
# Host orchestration only. Root tests see public pinned source and dependencies,
# without host sign-ins, private profiles, Docker control or installed state.
set -euo pipefail
umask 077
[[ "$(uname -s)" == Darwin && $# == 2 ]] || exit 1
dev=$1 source_root=$2
[[ "$dev" =~ ^[a-zA-Z0-9_.-]+$ && "$source_root" == /* && -f "$source_root/build-info.json" && -f "$source_root/vitest.config.ts" ]] || exit 1
[[ ! -e "$source_root/.env" && ! -e "$source_root/.git" && ! -e "$source_root/.cos-plan-state" ]] || exit 1
[[ -z "${DOCKER_HOST:-}${DOCKER_CONTEXT:-}${DOCKER_TLS_VERIFY:-}${DOCKER_CERT_PATH:-}" ]] || exit 1
image=$(docker inspect --format '{{.Image}}' "$dev")
dependencies=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/workspace/node_modules"}}{{.Name}}{{end}}{{end}}' "$dev")
[[ "$image" =~ ^sha256:[a-f0-9]{64}$ && "$dependencies" =~ ^[a-zA-Z0-9_.-]+$ ]] || exit 1
mkdir -p "$source_root/node_modules"
exec docker run --rm --pull=never --network=none --read-only --user 0:0 \
  --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add FSETID --cap-add SETUID --cap-add SETGID \
  --security-opt no-new-privileges:true --ulimit core=0 --pids-limit 256 --memory 768m --memory-swap 768m \
  --tmpfs /tmp:rw,exec,nosuid,nodev,size=512m,mode=1777 --workdir /workspace \
  --mount "type=bind,src=$source_root,dst=/workspace,readonly" \
  --mount "type=volume,src=$dependencies,dst=/workspace/node_modules,readonly" \
  --entrypoint /usr/local/bin/node "$image" \
  /workspace/node_modules/vitest/vitest.mjs run --configLoader runner --no-cache --no-file-parallelism --maxWorkers=1
