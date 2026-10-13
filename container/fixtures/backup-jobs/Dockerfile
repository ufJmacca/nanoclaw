# Isolated service-manager fixture, never an application or transferable release.
FROM nanoclaw-g02-vault-base:e9bcdbcf012c
RUN apt-get update && apt-get install -y --no-install-recommends \
      dbus-daemon=1.16.2-2 dbus-user-session=1.16.2-2 systemd-sysv=257.13-1~deb13u1 && \
    useradd --uid 1000 --create-home --shell /bin/sh fixture && \
    mkdir -p /var/lib/systemd/linger && touch /var/lib/systemd/linger/fixture && \
    rm -rf /code /probe /opt/nanoclaw-cos/vault
COPY --chown=0:0 code/ /code/
COPY --chown=0:0 probe.mjs manifest.json /fixture/
RUN find /code -type d -exec chmod 0755 {} + && \
    find /code -type f -exec chmod 0444 {} + && \
    chmod 0755 /fixture && chmod 0444 /fixture/*
ENV container=docker
LABEL nanoclaw.release-role="g02-backup-job-manager-component-fixture" nanoclaw.final-artifact="false"
STOPSIGNAL SIGRTMIN+3
ENTRYPOINT ["/usr/lib/systemd/systemd", "--log-target=console", "--log-level=warning"]
