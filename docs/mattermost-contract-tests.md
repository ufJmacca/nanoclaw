# Disposable Mattermost contract tests

The Phase 9 suite provisions a disposable Mattermost Team Edition server and PostgreSQL database, exercises the real NanoClaw REST/WebSocket adapter boundary, and destroys every container and named volume afterward. It must never target a production or shared Mattermost instance.

## Commands

```bash
# Fast, network-free safety/client/runner tests (included in pnpm test)
pnpm test:mattermost:safety

# Full disposable server, mutation proof, and live Green suite
pnpm test:mattermost
```

`pnpm test:mattermost` accepts no Mattermost URL, token, or instance from the caller. It rejects those environment variables, a non-loopback endpoint, a non-default or remote Docker daemon, non-amd64 execution, unsafe Compose privileges, public port binding, bind mounts, Docker socket mounts, external networks, or any image other than the approved immutable pins. The test worker runs from a fresh `nanoclaw-mm-contract-*` directory under the operating-system temporary root. Its disposable bot token remains in the host test processes and is rejected from worker events and logs; no agent container is admitted.

The pinned services are:

- `mattermost/mattermost-team-edition:11.7.6@sha256:f9f59fd070b33dda9485c9e6d3249f5f0036720efecbd0c76d45f71c29291456`
- `postgres:18-alpine@sha256:54451ecb8ab38c24c3ec123f2fd501303a3a1856a5c66e98cecf2460d5e1e9d7`

PostgreSQL 18 stores versioned data below `/var/lib/postgresql`, so the disposable named volume targets that directory. Update the Compose file, exported safety constants, focused tests, and this document together when intentionally changing either pin. Consult the [official PostgreSQL image PGDATA notes](https://github.com/docker-library/docs/blob/master/postgres/README.md#pgdata) and the [official Mattermost container deployment](https://github.com/mattermost/docker) before doing so.

The Mattermost image runs as its unprivileged `mattermost` user. Bleve therefore stores indexes below the image-owned `/mattermost/data` volume at `/mattermost/data/bleve-indexes`; do not replace it with a fresh standalone mount whose root would not carry the image directory's ownership.

## Live scenario

The isolated suite:

1. waits for the disposable server and creates or reuses only its fixed test administrator;
2. creates an actor, team, channels A and B, and a disposable bot/token;
3. adds the actor and bot to the team and both channels;
4. creates trusted baselines and strict NanoClaw subscriptions;
5. sends ordinary and threaded actor posts over real Mattermost REST and receives them over the real WebSocket adapter;
6. verifies one shared session per channel plus distinct A/B messaging, agent, wiring, workspace, session, and execution identities;
7. delivers real adapter replies and verifies the exact Mattermost channel and `root_id`;
8. stops the adapter worker, starts a second process against the same SQLite/filesystem state, and verifies both subscriptions and sessions survive;
9. unsubscribes A, proves A no longer gains inbox work while B remains active, then removes the bot from B and verifies terminal deactivation.

Before the Green run, the harness temporarily clears the outbound thread root through an environment-controlled test mutation. The focused live test must fail with `CONTRACT_ROOT_ID_ASSERTION`; any other failure does not count as the mutation proof. The harness then removes the mutation and runs the complete live suite.

## CI and cleanup

`.github/workflows/mattermost-contract.yml` runs on an x86-64 `ubuntu-24.04` runner with read-only repository permissions and no repository secrets. It installs host dependencies, runs the network-free safety suite, validates the normalized Compose model, and runs `pnpm test:mattermost` within a 30-minute job deadline.

The runner executes Compose without a shell and always calls `docker compose down --volumes --remove-orphans`, including after partial startup or test failure. The GitHub runner is also ephemeral. If the host process is forcibly killed before cleanup, remove only the uniquely named `nanoclaw-mm-contract-*` Compose project shown by Docker; do not use broad container or volume deletion commands.

The official Mattermost image used here is amd64-only. On an arm64 development host the full command intentionally fails before Docker access with `Mattermost contract tests require an amd64 host`. Run the fast safety suite locally and rely on the dedicated x86-64 workflow for the live gate; do not enable privileged emulation or substitute an unofficial image.
