#!/usr/bin/env bash
# Shared by the host release/deployment runners; the caller supplies cli and id.
release_timing_cli() { cli timing "$id" "$@"; }
timed_release_stage() {
  local timing_stage=$1 timing_evidence=$2 timing_span command_status timing_status=0
  shift 2
  timing_span=$(release_timing_cli start "$timing_stage" "$timing_evidence") || return $?
  [[ "$timing_span" =~ ^[a-f0-9-]{36}$ ]] || return 1
  if "$@"; then command_status=0; else command_status=$?; fi
  release_timing_cli end "$timing_span" "$command_status" || timing_status=$?
  # The operation's failure takes precedence over a failed diagnostic write.
  if [[ "$command_status" != 0 ]]; then return "$command_status"; fi
  return "$timing_status"
}
