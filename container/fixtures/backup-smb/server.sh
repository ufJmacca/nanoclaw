#!/bin/sh
set -eu
umask 077
# /run/fixture is private disposable RAM. This well-known password has synthetic authority only.
root=/run/fixture
chmod 0711 "$root"
mkdir "$root/allowed" "$root/denied" "$root/private" "$root/state" "$root/cache" "$root/lock" "$root/run" "$root/ncalrpc"
chown 1000:1000 "$root/allowed"
chmod 0700 "$root/allowed" "$root/denied" "$root/private"
cat > "$root/smb.conf" <<'CONF'
[global]
workgroup = FIXTURE
server role = standalone server
security = user
map to guest = Never
server min protocol = SMB2_10
server max protocol = SMB2_10
server signing = mandatory
smb ports = 445
interfaces = eth0
bind interfaces only = yes
disable netbios = yes
load printers = no
printing = bsd
printcap name = /dev/null
log file = /run/fixture/log.smbd
logging = file
log level = 0
private dir = /run/fixture/private
state directory = /run/fixture/state
cache directory = /run/fixture/cache
lock directory = /run/fixture/lock
pid directory = /run/fixture/run
ncalrpc dir = /run/fixture/ncalrpc
[nanoclaw-cos-backups]
path = /run/fixture/allowed
valid users = nanoclaw-cos-backup
guest ok = no
read only = no
create mask = 0600
directory mask = 0700
[unrelated-denied]
path = /run/fixture/denied
valid users = root
guest ok = no
read only = yes
CONF
printf '%s\n%s\n' 'public-synthetic-smb-fixture-password' 'public-synthetic-smb-fixture-password' |
  /usr/bin/smbpasswd -c "$root/smb.conf" -s -a nanoclaw-cos-backup > /dev/null
/usr/bin/testparm -s "$root/smb.conf" > "$root/effective.conf" 2> "$root/config-diagnostics"
touch "$root/ready"
exec /usr/sbin/smbd --foreground --no-process-group --configfile="$root/smb.conf" > "$root/daemon-output" 2>&1
