# PRD: Codex Provider Skill Sync for ai-native

Status: Draft

Owner: TBD

Last updated: 2026-04-08

## Summary

NanoClaw already supports Codex as a built-in provider for chat, scheduling, sessions, and memory, but it does not currently expose repo-bundled skills to Codex the way it does for Claude Code.

This PRD proposes a small, provider-specific v1 implementation for ai-native:

1. Add a new repo source directory at `container/codex-skills/`
2. Sync that directory into each Codex group's workspace at `.agents/skills/`
3. Add tests proving the sync happens for Codex runs
4. Flip the Codex `providerSkills` capability to `true` after validation

This keeps NanoClaw's provider architecture intact, avoids coupling Codex to Claude's `.claude/skills/` layout, and aligns the Codex runtime with Codex-native skill discovery.

## Problem

Today, NanoClaw's provider skill behavior is asymmetric:

- Claude Code syncs `container/skills/` into provider state and mounts it into `/home/node/.claude`
- Codex mounts `/home/node/.codex` and materializes `AGENTS.md`, but does not sync any bundled skills
- Product docs and capability flags explicitly describe Codex provider skills as unsupported in v1

This creates three practical issues:

1. ai-native cannot ship Codex-specific helper skills in the repo and expect them to be available inside NanoClaw's Codex container flow.
2. The existing `container/skills/` directory cannot simply be reused because it is Claude-oriented and contains behavior/instructions that explicitly tell Codex to treat container skills as unsupported.
3. The provider abstraction already supports directory syncs, but Codex is not using that mechanism.

## Goals

1. Allow ai-native to bundle Codex-specific skills in the repo and make them available during Codex group runs.
2. Sync skills into a Codex-native discovery location inside each group's writable workspace.
3. Keep the implementation small and provider-scoped, without changing NanoClaw core orchestration.
4. Preserve existing group isolation, mount policy, and provider namespace boundaries.
5. Add automated test coverage that prevents regressions.

## Non-Goals

1. Converting existing Claude container skills to work for Codex.
2. Designing a shared cross-provider skill format.
3. Implementing Codex agent teams or remote control.
4. Building a dynamic marketplace, installer, or per-group skill management UI.
5. Solving every possible Codex skill discovery mode across all Codex versions in the first patch.

## Users

1. ai-native maintainers who want repo-bundled Codex skills to ship with NanoClaw.
2. Power users running groups with `providerId: codex`.
3. Future contributors who want a clear place to add Codex-specific bundled skills.

## Current-State Findings

### Provider abstraction already supports directory syncs

`PreparedSession` already exposes `directorySyncs`, and `src/container-runner.ts` already copies those directories into approved target roots before a container run.

This means the desired behavior can be implemented as a provider-level change rather than a container-runner redesign.

### Claude already uses this pattern

The Claude host provider syncs `container/skills/` into its provider state directory and the test suite asserts that those skills exist after preparation.

This is the closest implementation model to mirror for Codex, with one key difference: Codex should sync into the group workspace rather than provider state.

### Codex currently has no skill sync

The Codex host provider:

- materializes `AGENT.md` to `AGENTS.md`
- copies `auth.json` into the provider state directory
- mounts that provider state directory at `/home/node/.codex`
- reports `providerSkills: false`

It does not define `directorySyncs`, so no bundled skills are exposed to Codex today.

### Why `.agents/skills/`

NanoClaw runs Codex with the group workspace as the working directory (`/workspace/group`). Repo-scoped Codex skills are best exposed in a Codex-native workspace path rather than inside `.codex` provider state.

For this patch, the intended in-container destination is:

```text
/workspace/group/.agents/skills/
```

On the host, that corresponds to:

```text
groups/<group>/.agents/skills/
```

This choice keeps bundled Codex skills:

- local to the group workspace
- visible to Codex from its current working directory
- separate from Claude's provider-specific `.claude/skills/` behavior

## Proposed Solution

### 1. Add a Codex skill source directory

Create a new repo directory:

```text
container/
  codex-skills/
    <skill-name>/
      SKILL.md
```

Rules for this directory:

1. It contains Codex-specific bundled skills only.
2. Each skill follows Codex skill structure, with `SKILL.md` required and optional `scripts/`, `references/`, `assets/`, and `agents/openai.yaml`.
3. This directory is separate from `container/skills/`, which remains Claude-specific.

### 2. Sync Codex skills into each group's workspace

Update `src/agent/providers/codex/host.ts` so `prepareSession()` returns a `directorySyncs` entry:

```ts
{
  sourcePath: path.join(ctx.projectRoot, 'container', 'codex-skills'),
  targetPath: path.join(ctx.groupDir, '.agents', 'skills'),
}
```

This leverages the existing provider-session preparation flow and requires no new container-runner primitives.

Expected host-side result before container start:

```text
groups/<group>/.agents/skills/<skill-name>/SKILL.md
```

Expected in-container result:

```text
/workspace/group/.agents/skills/<skill-name>/SKILL.md
```

### 3. Keep capability signaling explicit

The `providerSkills` capability should remain implementation-driven.

Recommended rollout:

1. Land directory sync support first.
2. Validate Codex actually discovers and uses the synced skills in NanoClaw's runtime context.
3. Then flip `providerSkills` from `false` to `true`.

This avoids advertising support before the runtime behavior is verified end to end.

### 4. Add Codex-specific tests

Add a test mirroring the Claude compatibility test, but with Codex expectations:

1. create a Codex group
2. create `container/codex-skills/<skill>/SKILL.md` in the fixture project
3. run the provider preparation/container invocation path
4. assert that the group workspace now contains `.agents/skills/<skill>/SKILL.md`
5. assert Codex state still mounts correctly at `/home/node/.codex`

This test should prove:

- the Codex provider syncs the bundled skill source
- the sync target is the group workspace, not provider state
- the existing Codex mount/auth behavior is preserved

## Product Requirements

### Functional requirements

1. NanoClaw must support a repo-owned Codex bundled skill directory at `container/codex-skills/`.
2. For Codex groups, NanoClaw must sync that directory into `groups/<group>/.agents/skills/` before the container starts.
3. The sync must happen through the existing provider preparation lifecycle, not by ad hoc shell logic.
4. The sync target must stay within approved roots already enforced by the container runner.
5. Codex auth handling, session handling, and memory materialization must continue to work unchanged.
6. Claude behavior must remain unchanged.
7. The implementation must tolerate an empty or missing `container/codex-skills/` directory without failing the run.

### Non-functional requirements

1. The patch should be small, readable, and isolated to the Codex provider plus tests.
2. The implementation should not weaken sandbox or mount policy.
3. Group-to-group isolation must remain intact.
4. The change should use the provider abstraction already present in the codebase instead of introducing new orchestration branches.

## UX and Capability Semantics

### Before capability flip

If the initial patch lands without flipping `providerSkills`, the system behavior is:

- bundled Codex skills are physically synced
- product capability reporting still says Codex provider skills are unsupported

This is acceptable only as a short transitional state while end-to-end validation is being completed.

### After capability flip

Once `providerSkills` is set to `true`, the following must also be updated:

1. docs that currently say Codex provider skills are unsupported
2. any setup or capability messaging derived from provider capabilities
3. tests that assert unsupported status in docs or runtime output

## Implementation Plan

### Phase 1: Skill sync plumbing

1. Add `container/codex-skills/`
2. Update `src/agent/providers/codex/host.ts` to define `directorySyncs`
3. Add or update tests covering the new sync destination

### Phase 2: Validation

1. Verify synced skills are present in the group workspace during Codex runs
2. Verify Codex can discover and use a minimal bundled skill from that location
3. Confirm no regressions in auth, session persistence, or `AGENTS.md` materialization

### Phase 3: Capability and docs

1. Flip `providerSkills` to `true`
2. Update docs and provider-guidance tests
3. Update any capability surfaces that message Codex provider skill support

## Technical Notes

1. The destination should be the group workspace, not `/home/node/.codex/skills`.
   Reason: Codex skill discovery should be workspace-oriented here, and NanoClaw already mounts the group directory at `/workspace/group`.

2. This patch should not reuse `container/skills/`.
   Reason: that directory is defined and documented as Claude-only in v1.

3. The sync mechanism will inherit current `fs.cpSync()` semantics from the container runner.
   In v1, this likely means additive/overwrite behavior rather than pruning removed destination files.

4. If stale skill cleanup becomes a problem later, it should be handled as a separate follow-up rather than expanding this patch.

## Risks

1. Codex skill discovery behavior may vary by Codex version.
   Mitigation: validate with the Codex version used in NanoClaw's container runtime before flipping `providerSkills`.

2. Documentation drift may occur if sync lands before capability messaging is updated.
   Mitigation: treat the capability flip and docs updates as an explicit follow-up checkpoint.

3. Stale copied skills may remain in group workspaces if a source skill is renamed or removed.
   Mitigation: accept this in v1 and revisit with explicit prune semantics only if it becomes a real maintenance problem.

## Acceptance Criteria

1. A new `container/codex-skills/` directory exists for repo-bundled Codex skills.
2. Running a Codex group causes bundled Codex skills to be copied into `groups/<group>/.agents/skills/`.
3. Existing Codex behavior for auth cache mounting and `AGENTS.md` materialization still passes.
4. A test exists that mirrors the Claude skill sync test but asserts Codex skills land in the group workspace instead.
5. If `providerSkills` is flipped to `true`, docs and capability tests are updated accordingly.

## Open Questions

1. Should the first implementation flip `providerSkills` in the same PR, or only after a small end-to-end validation PR?
2. Should ai-native ship a minimal example Codex skill in the first patch to prove the path works?
3. Do we want future support for repo-root shared skills outside group workspaces, or is per-group `.agents/skills/` the long-term model?
