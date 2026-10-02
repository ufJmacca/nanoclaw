# Research missions

S05 adds bounded research over admitted notes: propose a work order, approve it,
follow or cancel the specialist, and receive a reviewed answer. The complete
fixture demonstration, final ARM64 image checks and Pi acceptance pass. The
S05 merge and its exact merged-source release are accepted. Keep real mission execution disabled
until the required confined live-provider smoke test has passed under a current
model allowance.

The main CoS remains one NanoClaw AgentGroup with its existing shared conversation.
A research specialist receives a separate AgentGroup, session and provider context
for each admitted attempt. Mattermost reply threads only group messages visually.

## What to try after live activation

Use the existing private CoS channel and notes already admitted through the
knowledge setup. Ask: “Compare the alternatives in these notes and recommend an
approach for Pilot Alpha.” Review the proposed sources, deliverable, acceptance
criteria and limits before approving the exact work order.

CoS returns a mission ID promptly. You can ask for its progress or cancel it while
continuing the main conversation. The specialist can read only the approved note
revisions and submit a result. The main CoS reviews the cited answer before
returning it to the originating context. A blocked, partial or cancelled mission
must remain visibly distinct from successful completion.

Deployment alone does not activate this flow. It needs admitted notes, reviewed
delegation configuration, current private membership and a current subscription
allowance. The earlier live allowance has expired; fixture success does not renew
it or count as a live-provider smoke test.

## Fixture verification

The S05 demonstration covers approval through reviewed notification, then repeats
with cancellation, a host database connection interruption and a host-process
crash. Separate overlapping-specialist tests inspect actual prompts, mounts,
provider state and tool access for cross-attempt leakage. These use synthetic
messages and provider responses, with authenticated external test PostgreSQL.

On the Mac, with the repository development container running, a clean committed
candidate and the private test database profile configured, run:

```sh
bash scripts/cos-release.sh --slice S05 --target pi --db-profile test --local-only
```

This runs the registered S05 tests and demo, builds Linux/ARM64 images locally,
tests both worker profiles and exports the exact tested images. It performs
read-only Pi preflight but does not deploy, send messages or call a live model.
Project dependencies and tooling stay in containers.

## Operator setup

`cos:admin mission-configure` uses the existing protected administration path. It
requires the bound installation to be quiescent under maintenance, the CoS binding
to be paused, and current private-channel membership to match the owner and bot.
It checks the external database identity and schema before installing the exact
checked-in research template. Existing template bytes or a different reviewer
cannot be overwritten through this command.

Run project tooling in the development container; the deployed Pi uses the
prebuilt admin entry point. Supply the selected trusted runtime database profile
and its migration login only to that admin process. Runtime workers retain
read-only template access and receive no database credentials.

The command takes these arguments:

```text
cos:admin mission-configure --scope <bound-scope> --request-id <uuid> --manifest <absolute-private-file>
```

The manifest must be an owner-only regular file (mode `0600`, no symbolic or hard
links) containing exactly:

```json
{
  "expectedRevision": 0,
  "enabled": false,
  "templateDigest": "<SHA-256 digest of the reviewed RESEARCH_TEMPLATE>",
  "reviewRef": "<operator review reference>"
}
```

The digest uses NanoClaw's canonical `digest` function and must match the installed
release's `RESEARCH_TEMPLATE`; hashing the TypeScript file is not equivalent.
The first configuration uses revision zero. Each change supplies the last returned
revision and a new request UUID. Repeating the exact most recent request returns
the same revision. Changed requests, stale revisions and unsafe existing state
are rejected. Preserve the private request manifest to reconcile an interrupted
operation.

Configuration leaves CoS paused. It does not create model consent, replenish a
model budget, reset the main conversation or launch a mission. Model policy,
current source access, exact owner approval and the verified execution profile
remain separate requirements. Each work order pins its delegation configuration;
disabling and re-enabling delegation cannot restore authority to an older mission.

The host now derives mission authority from the exact native CoS binding, current
delegation revision, retained main conversation and current Codex subscription
policy. These checks do not prepare, recover or reset a conversation. A completed
scheduled-brief renewal may supply the current generation through its recorded
consent lineage; an interrupted renewal closes mission admission until recovered.
The specialist launcher rechecks these pins before launch and on every credential
or model callback. Actual model invocations still require fresh budget reservations.

## Specialist team configuration

The S06 operator command is implemented and fixture-tested; S06 deployment and
acceptance are still pending. Teams require the existing single-worker delegation
and a separate reviewed team configuration. A simple request keeps the single-worker
route. Team roles get fresh specialist contexts; the main CoS keeps its shared
conversation.

Use the same paused, private-owner, maintenance and database checks described above:

```text
cos:admin team-configure --scope <bound-scope> --request-id <uuid> --manifest <absolute-private-file>
```

The private manifest has exactly these fields:

```json
{
  "expectedRevision": 0,
  "enabled": false,
  "templateBundleDigest": "<canonical digest of the installed TEAM_TEMPLATES>",
  "policyDigest": "<canonical digest of the installed TEAM_ADMISSION_POLICY>",
  "reviewRef": "<operator review reference>"
}
```

The command verifies all four canonical analyst, writer and reviewer templates
before inserting any missing entry. It cannot overwrite conflicting templates or
reviewers. The policy caps graphs at six steps and two workers, keeps public
retrieval disabled, and permits only approved rework within the original limits.
Native capacity may impose a lower worker limit to preserve the coordinator.

The coordinator now has `cos_team_request`, `cos_team_get` and `cos_team_cancel`.
Requests create a proposal for exact owner approval. Status shows bounded step
states and original budget history without copying source prose or worker history.
Cancellation fences every retained child and stays pending until native absence
is independently confirmed. Cancelling before approval launches nothing and
creates no fictitious budget release. Scheduled and automatic review tasks cannot
use owner team controls. Specialist tools remain context-read and result-submit.

The returned revision belongs to team configuration alone. Exact request replay,
file permissions and stale-revision rules match single-worker configuration.
Permission is saved only after acknowledged template installation and renewed
host checks. Configuration leaves CoS paused and does not authorise model usage,
reset context, replenish budgets, send a message or launch a worker. Each team
pins this revision; re-enabling teams cannot revive an older graph's permission.

## Source deletion and retained specialist data

Approved source deletion tracks every specialist context that received the source,
including sources the specialist did not cite. The existing `source-purge` command
now resolves those contexts against the owned mission records before cleaning
their local data. It runs under the same paused binding, private-membership,
maintenance and whole-installation quiescence checks as main-context purge.

The command permanently fences each affected attempt, reconciles its stopped
state, and removes its prepared context, provider history, scratch directories and
tagged CoS response cache. It preserves native messages, session and allocation
records, other agents, master credentials and backups. An uncertain stop or
ownership mismatch leaves deletion unfinished. Interrupted deletion can be retried;
data recreated after a completed purge is treated as a conflict.

Main-conversation history still requires the existing explicit context recovery
before its retired generation can be purged. Already-delivered messages, native
message history, provider disclosures and backup retention are separate boundaries;
source purge does not claim to retract them.

## Deployment preservation

Before migration, the deployment helper snapshots specialist context and provider
history, delegation records and source-purge receipts alongside native SQLite and
main-conversation history. It requires the existing maintenance lease and a stopped
installation, checks the completed snapshot, and verifies it again before migration.
A changed or corrupt snapshot prevents migration.

These private backups stay on the Pi. Provider access credentials, interrupted
credential writes and temporary launch controls are excluded. A retry verifies the
original backup rather than replacing it with later history. Backups do not grant
mission authority and are never automatically restored over newer messages or data.
