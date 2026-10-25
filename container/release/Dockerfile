# Mac-only Linux/ARM64 release build. Context is exported from an exact Git commit.
# Debian snapshot pinning: https://snapshot.debian.org/#usage
ARG RELEASE_FLAVOUR=standard
FROM docker@sha256:1c27de1f16ee894e6389586d8b58391f4b941f768cb5520cd2970c72d38a8e84 AS docker-cli

FROM node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS tooling
USER root
RUN rm -f /etc/apt/sources.list.d/debian.sources && \
    printf '%s\n' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20260928T000000Z bookworm main' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20260928T000000Z bookworm-updates main' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20260928T000000Z bookworm-security main' > /etc/apt/sources.list && \
    apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip git tini && \
    rm -rf /var/lib/apt/lists/*
RUN curl -fL --retry 3 https://github.com/oven-sh/bun/releases/download/bun-v1.3.12/bun-linux-aarch64.zip -o /tmp/bun.zip && \
    echo 'c40bc0ebca11bde7d75af497a654a874d0c7fd8d6a8d6031c173c10c9064297b  /tmp/bun.zip' | sha256sum -c - && \
    unzip -q /tmp/bun.zip -d /tmp/bun && install -m 0755 /tmp/bun/bun-linux-aarch64/bun /usr/local/bin/bun && \
    rm -rf /tmp/bun /tmp/bun.zip && npm install -g pnpm@10.33.0

FROM tooling AS host-build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential python3 pkg-config && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN HUSKY=0 pnpm install --frozen-lockfile
COPY tsconfig.json build-info.json ./
COPY src ./src
COPY container ./container
RUN pnpm build && bun build src/modules/chief-of-staff/ops/target-bootstrap.ts --target=node --format=esm --outfile=/build/bootstrap.mjs
ARG RELEASE_SLICE=S11
ARG SOURCE_COMMIT
ARG SOURCE_TREE
RUN if [ "$RELEASE_SLICE" = G01 ] || [ "$RELEASE_SLICE" = G02 ] || [ "$RELEASE_SLICE" = G03 ] || [ "$RELEASE_SLICE" = G04 ] || [ "$RELEASE_SLICE" = G05 ]; then \
      bun build src/modules/chief-of-staff/ops/vault-root-entry.ts --target=node --format=esm --packages=external --outfile=/build/vault-gateway.mjs && \
      node --input-type=module -e 'import {packageVaultRootArtifact} from "./dist/modules/chief-of-staff/ops/vault-root-package.js";packageVaultRootArtifact({sourceCommit:process.argv[1],sourceTree:process.argv[2],gateway:"/build/vault-gateway.mjs",output:"/build/vault-artifacts"})' "$SOURCE_COMMIT" "$SOURCE_TREE" && \
      rm /build/vault-gateway.mjs; \
    fi

# Backup-capable releases receive only the verified public binary/seal build context.
# Ordinary releases do not evaluate this stage or include backup credentials.
FROM scratch AS backup-artifact-input
FROM host-build AS host-build-standard
FROM host-build AS host-build-backup
COPY --from=backup-artifact-input /restic /build/libexec/restic
COPY --from=backup-artifact-input /artifact.json /build/libexec/artifact.json
RUN node --input-type=module -e 'import {verifyResticReleasePayload} from "./dist/modules/chief-of-staff/ops/restic-release-payload.js";verifyResticReleasePayload("/build/libexec")'

FROM host-build-${RELEASE_FLAVOUR} AS host-build-selected
ARG RELEASE_SLICE=S11
RUN case "$RELEASE_SLICE" in \
      G02|G03|G04|G05) node --input-type=module -e 'import {verifyResticReleasePayload} from "./dist/modules/chief-of-staff/ops/restic-release-payload.js";verifyResticReleasePayload("/build/libexec")' ;; \
      G01|S11) test ! -e /build/libexec/restic ;; \
      *) exit 1 ;; \
    esac
RUN if [ "$RELEASE_SLICE" = G04 ]; then \
      node --input-type=module -e 'import {SCHEMA_VERSION,MIGRATIONS} from "./dist/modules/chief-of-staff/store/migrations.js";import {MAIL_CHECKSUM} from "./dist/modules/chief-of-staff/store/mail-schema.js";if(SCHEMA_VERSION!==19||MIGRATIONS.length!==19||MIGRATIONS[18].version!==19||MIGRATIONS[18].checksum!==MAIL_CHECKSUM)process.exit(1)'; \
    elif [ "$RELEASE_SLICE" = G05 ]; then \
      node --input-type=module -e 'import {SCHEMA_VERSION,MIGRATIONS} from "./dist/modules/chief-of-staff/store/migrations.js";import {MAIL_DRAFT_CHECKSUM} from "./dist/modules/chief-of-staff/store/mail-draft-schema.js";if(SCHEMA_VERSION!==20||MIGRATIONS.length!==20||MIGRATIONS[19].version!==20||MIGRATIONS[19].checksum!==MAIL_DRAFT_CHECKSUM)process.exit(1)'; \
    fi

FROM tooling AS host
ARG SOURCE_COMMIT
ARG WORKER_ASSETS_DIGEST
LABEL org.opencontainers.image.revision=$SOURCE_COMMIT nanoclaw.worker-assets=$WORKER_ASSETS_DIGEST nanoclaw.release-role=host
COPY --from=host-build-selected /build /release
COPY --from=host-build /usr/local/bin/node /release/node/bin/node
# Used only by trusted Mac final-image fixtures. The extracted Pi payload uses its existing host Docker CLI.
COPY --from=docker-cli /usr/local/bin/docker /usr/bin/docker
WORKDIR /release
# Check the copied payload in the output layer as well as its builder input.
# A storage fault must not publish an empty or changed runtime as a successful image.
RUN test -s /release/node/bin/node && cmp /usr/local/bin/node /release/node/bin/node && \
    /release/node/bin/node --input-type=module -e 'if(process.platform!=="linux"||process.arch!=="arm64"||process.version!=="v22.23.2")process.exit(1);const {default:Database}=await import("./node_modules/better-sqlite3/lib/index.js");const db=new Database(":memory:");if(db.prepare("select 1 as n").get().n!==1)process.exit(1);db.close()'
ENTRYPOINT ["/release/node/bin/node"]
CMD ["/release/dist/index.js"]

FROM tooling AS agent-base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium fonts-liberation fonts-noto-color-emoji libgbm1 libnss3 libatk-bridge2.0-0 libgtk-3-0 \
    libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 libasound2 libpangocairo-1.0-0 libcups2 libdrm2 libxshmfence1 bubblewrap && \
    rm -rf /var/lib/apt/lists/*
RUN curl -fL --retry 3 https://github.com/cli/cli/releases/download/v2.101.0/gh_2.101.0_linux_arm64.tar.gz -o /tmp/gh.tar.gz && \
    echo 'b57e8063f18862647c9d22727c32e9da1b963f8bf9db648fe123a6975695640f  /tmp/gh.tar.gz' | sha256sum -c - && \
    tar -xzf /tmp/gh.tar.gz -C /tmp && install -m 0755 /tmp/gh_2.101.0_linux_arm64/bin/gh /usr/local/bin/gh && \
    rm -rf /tmp/gh.tar.gz /tmp/gh_2.101.0_linux_arm64
RUN printf '%s\n' 'only-built-dependencies[]=agent-browser' 'only-built-dependencies[]=@anthropic-ai/claude-code' > /root/.npmrc && \
    pnpm install -g vercel@52.2.1 agent-browser@0.38.1 @anthropic-ai/claude-code@2.1.116 @openai/codex@0.158.0
WORKDIR /app
COPY container/agent-runner/package.json container/agent-runner/bun.lock ./
RUN bun install --frozen-lockfile

FROM agent-base AS agent-standard
ARG SOURCE_COMMIT
ARG WORKER_ASSETS_DIGEST
LABEL org.opencontainers.image.revision=$SOURCE_COMMIT nanoclaw.worker-assets=$WORKER_ASSETS_DIGEST nanoclaw.release-role=agent
COPY container/agent-runner/src /app/src
COPY container/skills /app/skills
COPY container/CLAUDE.md /app/CLAUDE.md
COPY src/deep-research-workflow /app/deep-research-workflow
COPY build-info.json /app/build-info.json
COPY container/entrypoint.sh /app/entrypoint.sh
# Import the baked runtime dependencies before publishing the worker layer.
# This catches damaged dependency files even when the package installer exited successfully.
RUN chmod +x /app/entrypoint.sh && mkdir -p /workspace/agent && chown -R node:node /workspace && chmod 1777 /home/node && \
    cd /app && bun --eval 'await import("@modelcontextprotocol/sdk/server/mcp.js"); await import("@modelcontextprotocol/sdk/client/index.js"); await import("@anthropic-ai/claude-agent-sdk"); await import("cron-parser"); await import("zod")'
USER node
WORKDIR /workspace/agent
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]

FROM agent-standard AS agent-documents
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils python3 python3-pip python3-venv python3-reportlab python3-pypdf && rm -rf /var/lib/apt/lists/*
USER node
