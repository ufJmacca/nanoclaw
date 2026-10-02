# Research mission configuration

S05 is still in development. The operator configuration command is implemented;
production specialist dispatch, the complete demonstration and Pi acceptance
remain pending. Keep real mission execution disabled until the required confined
live-provider smoke test has passed under a current model allowance.

The main CoS remains one NanoClaw AgentGroup with its existing shared conversation.
A research specialist receives a separate AgentGroup, session and provider context
for each admitted attempt. Mattermost reply threads only group messages visually.

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
