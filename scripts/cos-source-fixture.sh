#!/usr/bin/env bash
# Sourced by the Mac test coordinators. No application credentials are copied into this workspace.
prepare_source_fixture() {
  local dev=$1 owner=$2 source=$3 image=$4 runner=$5
  [[ "$owner" =~ ^[a-zA-Z0-9_-]{1,100}$ && "$image" =~ ^sha256:[a-f0-9]{64}$ && "$runner" =~ ^[a-zA-Z0-9_.-]+$ ]] || return 1
  [[ "$source" == /* && -f "$source/build-info.json" && ! -e "$source/.env" && ! -e "$source/.git" ]] || return 1
  [[ "$(docker inspect --format '{{.Image}}' "$dev")" == "$image" ]] || return 1
  local dependencies
  dependencies=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/workspace/node_modules"}}{{.Name}}{{end}}{{end}}' "$dev")
  [[ "$dependencies" =~ ^[a-zA-Z0-9_.-]+$ ]] || return 1
  source_fixture_volume="cos-source-$owner"
  docker volume create --label "nanoclaw.cos-source-fixture=$owner" "$source_fixture_volume" >/dev/null
  [[ "$(docker volume inspect --format '{{index .Labels "nanoclaw.cos-source-fixture"}}' "$source_fixture_volume")" == "$owner" ]] || return 1
  source_fixture_host_root=$(docker volume inspect --format '{{.Mountpoint}}' "$source_fixture_volume")
  [[ "$source_fixture_host_root" == /* && "$source_fixture_host_root" != / ]] || return 1
  docker run --rm --pull=never --network=none --user 0:0 --mount "type=volume,src=$source_fixture_volume,dst=/fixture" \
    --entrypoint /bin/sh "$image" -c 'chown 1000:1000 /fixture; chmod 700 /fixture'
  # Docker needs empty mountpoints before overlaying dependencies on the read-only source snapshot.
  mkdir -p "$source/node_modules" "$source/container/agent-runner/node_modules"
  source_fixture_driver=(docker run --rm -i --pull=never --user 1000:1000 --group-add 0 --workdir /workspace
    --mount "type=bind,src=$source,dst=/workspace,readonly"
    --mount "type=volume,src=$dependencies,dst=/workspace/node_modules,readonly"
    --mount "type=volume,src=$runner,dst=/workspace/container/agent-runner/node_modules,readonly"
    --mount "type=volume,src=$source_fixture_volume,dst=/fixture"
    --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock
    -e COS_FIXTURE_WORK_ROOT=/fixture -e "COS_FIXTURE_WORK_HOST_ROOT=$source_fixture_host_root"
    --entrypoint node)
}
