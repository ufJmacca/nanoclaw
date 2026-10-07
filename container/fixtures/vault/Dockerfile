# Trusted, offline administration fixture; never an agent image or Pi installer.
FROM node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS node
FROM debian@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f
RUN rm -f /etc/apt/sources.list.d/debian.sources && \
    printf '%s\n' 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20261007T000000Z trixie main' > /etc/apt/sources.list && \
    apt-get update && apt-get install -y --no-install-recommends \
      cryptsetup-bin=2:2.7.5-2 cifs-utils=2:7.4-1 util-linux mount e2fsprogs libstdc++6 && \
    rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY probe.sh probe.mjs probe-authority.mjs probe-provision.mjs /probe/
ENTRYPOINT ["/bin/sh", "/probe/probe.sh"]
