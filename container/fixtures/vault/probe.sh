#!/bin/sh
set -eu
umask 077
test "${NANOCLAW_COS_VAULT_FIXTURE:-}" = 1
test "$(id -u)" = 0
ulimit -c 0
node /probe/probe.mjs memory
test ! -e /case
# Docker's private /dev needs loop nodes; the device cgroup admits only loop and mapper devices.
for n in $(seq 0 63); do
  test -e "/dev/loop$n" || mknod "/dev/loop$n" b 7 "$n"
done
exec node /probe/probe-provision.mjs
