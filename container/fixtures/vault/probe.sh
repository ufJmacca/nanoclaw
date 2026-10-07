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
mkdir -m 0711 /case
mapping="cos-vault-fixture-$$"
if cryptsetup status "$mapping" >/dev/null 2>&1; then
  printf 'existing fixture mapping refused\n' >&2
  exit 1
fi
mapped=0
mounted=0
bound=0
race_pid=''
cleanup() {
  if test -n "$race_pid"; then kill "$race_pid" 2>/dev/null || true; wait "$race_pid" 2>/dev/null || true; fi
  test "$bound" = 0 || umount /case/target/calendar
  test "$mounted" = 0 || umount /case/vault
  test "$mapped" = 0 || cryptsetup close "$mapping"
}
fixture_device_metadata() {
  minor=$(dmsetup info -c --noheadings -o minor "$mapping" | tr -d ' ')
  case "$minor" in ''|*[!0-9]*) exit 1;; esac
  test -e "/dev/dm-$minor" || mknod "/dev/dm-$minor" b 253 "$minor"
  chmod 0755 /dev/mapper
  # Reproduce the host's udev metadata from this real filesystem, not from an expected UUID.
  filesystem_uuid=$(blkid --probe --match-tag UUID --output value "/dev/mapper/$mapping")
  test -n "$filesystem_uuid"
  mkdir -p /run/udev/data
  chmod 0755 /run/udev /run/udev/data
  printf 'I:1\nE:ID_FS_UUID=%s\nE:ID_FS_UUID_ENC=%s\nE:ID_FS_TYPE=ext4\n' "$filesystem_uuid" "$filesystem_uuid" > "/run/udev/data/b253:$minor"
  chmod 0644 "/run/udev/data/b253:$minor"
}
trap cleanup EXIT
for p in target application data; do
  mkdir -m 0700 "/case/$p"
  chown 1000:1000 "/case/$p"
done
node /probe/probe-authority.mjs root
mkdir -m 0000 /case/vault /case/target/calendar
head -c 64 /dev/urandom > /case/boot.key
if test "${NANOCLAW_COS_VAULT_KEYCHAIN_FIXTURE:-}" = 1; then
  head -c 65 > /case/recovery.key
  test "$(wc -c < /case/recovery.key)" -eq 64
else
  head -c 64 /dev/urandom > /case/recovery.key
fi
head -c 64 /dev/urandom > /case/wrong.key
fallocate -l 1073741824 /case/volume.luks
printf '{"stage":"luks_format"}\n'
cryptsetup luksFormat --type luks2 --batch-mode --pbkdf argon2id --pbkdf-memory 131072 --pbkdf-parallel 1 --key-file /case/boot.key /case/volume.luks
cryptsetup luksAddKey --pbkdf argon2id --pbkdf-memory 131072 --pbkdf-parallel 1 --key-file /case/boot.key /case/volume.luks /case/recovery.key
cryptsetup open --type luks2 --disable-keyring --key-file /case/boot.key /case/volume.luks "$mapping"
mapped=1
mkfs.ext4 -q "/dev/mapper/$mapping"
# This private /dev has no udev daemon. Publish only its synthetic filesystem metadata.
fixture_device_metadata
mount -t ext4 -o nosuid,nodev,noexec "/dev/mapper/$mapping" /case/vault
mounted=1
chmod 0700 /case/vault
chown 1000:1000 /case/vault
for p in google google/calendar backup-credentials journals staging cache calendar-backups; do
  mkdir -m 0700 "/case/vault/$p"
  chown 1000:1000 "/case/vault/$p"
done
mount -o bind,nosuid,nodev,noexec /case/vault/google/calendar /case/target/calendar
bound=1
prlimit --core=0:0 setpriv --reuid=1000 --regid=1000 --clear-groups node /probe/probe.mjs capture
chmod 0755 /case/vault/google
prlimit --core=0:0 setpriv --reuid=1000 --regid=1000 --clear-groups node /probe/probe.mjs denied
chmod 0700 /case/vault/google
chown 0:0 /case/vault/backup-credentials
prlimit --core=0:0 setpriv --reuid=1000 --regid=1000 --clear-groups node /probe/probe.mjs denied
chown 1000:1000 /case/vault/backup-credentials
mv /case/vault/cache /case/vault/cache-original
ln -s google /case/vault/cache
prlimit --core=0:0 setpriv --reuid=1000 --regid=1000 --clear-groups node /probe/probe.mjs denied
rm /case/vault/cache
mv /case/vault/cache-original /case/vault/cache
prlimit --core=0:0 setpriv --reuid=1000 --regid=1000 --clear-groups node /probe/probe.mjs race &
race_pid=$!
for attempt in $(seq 1 200); do
  test ! -f /case/target/race-request || break
  sleep 0.05
done
test -f /case/target/race-request
umount /case/target/calendar
bound=0
umount -l /case/vault
mounted=0
touch /case/target/race-closed
chmod 0600 /case/target/race-closed
chown 1000:1000 /case/target/race-closed
wait "$race_pid"
race_pid=''
test -z "$(find /case/vault /case/target/calendar -mindepth 1 -print)"
cryptsetup close "$mapping"
mapped=0
# Recovery must work after loss of the original boot key, without cached kernel key material.
rm /case/boot.key
if cryptsetup open --type luks2 --disable-keyring --key-file /case/wrong.key /case/volume.luks "$mapping" 2>/dev/null; then
  mapped=1
  printf 'unexpected wrong-key admission\n' >&2
  exit 1
fi
cryptsetup open --type luks2 --disable-keyring --key-file /case/recovery.key /case/volume.luks "$mapping"
mapped=1
fixture_device_metadata
mount -t ext4 -o nosuid,nodev,noexec "/dev/mapper/$mapping" /case/vault
mounted=1
mount -o bind,nosuid,nodev,noexec /case/vault/google/calendar /case/target/calendar
bound=1
prlimit --core=0:0 setpriv --reuid=1000 --regid=1000 --clear-groups node /probe/probe.mjs recovery
umount /case/target/calendar
bound=0
umount /case/vault
mounted=0
prlimit --core=0:0 setpriv --reuid=1000 --regid=1000 --clear-groups node /probe/probe.mjs unavailable
test -z "$(find /case/vault /case/target/calendar -mindepth 1 -print)"
printf '{"kernelVault":"passed","volumeBytes":1073741824,"wrongKeyDenied":true,"recoveredCanary":true,"bootKeyRemoved":true,"ownershipDenied":true,"symlinkDenied":true,"mountRaceDenied":true,"memoryProtection":"verified","plaintextFallback":false}\n'
