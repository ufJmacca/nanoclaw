# PRD: Codex Provider Model and Reasoning Configuration via `.env`

Status: Draft

Owner: TBD

Last updated: 2026-04-08

## Summary

NanoClaw's built-in `codex` provider already supports authentication, sessions, memory, and bundled provider skills, but it does not currently expose model selection or reasoning effort as project configuration.

Today, changing the built-in Codex model or reasoning level effectively requires source edits inside the container-side provider runner. That is inconsistent with NanoClaw's `.env`-driven configuration style and makes Codex installs harder to tune per deployment.

This PRD proposes adding project-level Codex runtime tuning through:

- `CODEX_MODEL`
- `CODEX_REASONING_EFFORT`

The implementation should read those values from `.env` / `process.env`, pass them through the host provider into container runtime input, and apply them when building Codex runtime config for the bundled `codex` provider.

## Problem

Issue [#12](https://github.com/ufJmacca/nanoclaw/issues/12) describes a real gap in the current built-in Codex provider:

1. The host config path reads Codex auth settings and the default provider from `.env`, but not model or reasoning settings.
2. The Codex host provider forwards `providerOptions` into `providerData`, but does not add project-level defaults for model or reasoning.
3. The container-side Codex runner generates `config.toml` and CLI args without applying model or reasoning settings.
4. As a result, common runtime tuning requires hardcoding values into source rather than configuration.

This creates four practical costs:

1. Users cannot tune the built-in Codex provider from `.env`, even though that is NanoClaw's normal configuration surface.
2. Testing different Codex models or reasoning levels requires source edits and rebuilds.
3. The existing provider-options plumbing is underused because the container runner ignores model/reasoning data today.
4. Documentation gives users no supported path for Codex runtime tuning beyond auth.

## Goals

1. Make the built-in `codex` provider support project-level model selection from `.env`.
2. Make the built-in `codex` provider support project-level reasoning effort selection from `.env`.
3. Preserve existing defaults when the new env vars are unset.
4. Keep the implementation provider-scoped rather than adding special cases throughout the core runtime.
5. Align project-level `.env` defaults with the existing `providerOptions` pipe so future per-group overrides remain possible.

## Non-Goals

1. Reworking NanoClaw's provider architecture.
2. Adding a UI or slash-command flow for model selection.
3. Replacing Codex auth behavior or changing the `CODEX_AUTH_FILE` flow.
4. Guaranteeing that every arbitrary model string is valid for every Codex CLI release.
5. Designing a full provider-options schema for every current and future provider in this change.

## Users

1. NanoClaw users running the built-in `codex` provider who want to tune model quality, speed, or cost without editing source.
2. Maintainers testing different Codex runtime behaviors across environments.
3. Future contributors who want a clear, documented place for Codex runtime defaults.

## Current-State Findings

### Host config already reads some Codex env vars, but not tuning vars

`src/config.ts` reads `CODEX_AUTH_FILE` and `DEFAULT_AGENT_PROVIDER` from `.env` or `process.env`, but it does not read any Codex model or reasoning settings.

This means the repo already has the right configuration pattern, just not for Codex runtime tuning.

### The host provider forwards provider data, but does not populate defaults

`src/agent/providers/codex/host.ts` serializes `ctx.providerOptions` into `providerData`, but does not enrich that payload with project-level defaults.

As a result, the runtime input path exists, but the built-in `.env` config path does not feed it.

### The container runner does not consume model or reasoning settings

`container/agent-runner/src/providers/codex.ts` currently writes:

- auth settings
- model instructions
- MCP server config

It does not currently apply a model selection or reasoning effort setting when building `config.toml` or Codex CLI args.

### The repo already hints at future provider option overrides

NanoClaw's group model already supports `providerOptions`, and tests already round-trip example values like:

```ts
{
  profile: 'gpt-5',
  reasoning: 'high',
}
```

That makes this issue bigger than just `.env`: the PRD should ensure project-level defaults do not block future group-level overrides.

## Product Requirements

### Functional requirements

1. NanoClaw must support `CODEX_MODEL` as a project-level configuration variable for the built-in Codex provider.
2. NanoClaw must support `CODEX_REASONING_EFFORT` as a project-level configuration variable for the built-in Codex provider.
3. The host configuration path must read those values from `.env` and `process.env` using the same precedence style as other top-level config.
4. The host provider must include resolved Codex runtime defaults in `providerData` so the container runner can apply them.
5. The container-side Codex runner must apply the resolved model and reasoning settings when preparing Codex runtime configuration.
6. If the env vars are unset, current runtime defaults must remain unchanged.
7. The new behavior must be documented in user-facing setup/config docs.

### Non-functional requirements

1. The change should stay scoped to the built-in `codex` provider and its docs/tests.
2. The implementation should minimize duplication between host-side config parsing and container-side runtime config assembly.
3. The configuration path should be testable without requiring a live Codex login.
4. The implementation should be forward-compatible with future per-group provider overrides.

## Proposed Solution

### 1. Introduce project-level Codex runtime env vars

Add two new supported env vars:

```bash
CODEX_MODEL=gpt-5-codex
CODEX_REASONING_EFFORT=high
```

Resolution order should follow existing NanoClaw config conventions:

1. `process.env`
2. project `.env`
3. built-in defaults / unset behavior

The initial rollout should treat these as optional defaults, not required settings.

### 2. Thread resolved defaults through `providerData`

The built-in Codex host provider should stop treating runtime tuning as an implementation detail hidden inside the container runner.

Instead, it should resolve a normalized Codex runtime config payload and include it in `providerData`.

Suggested normalized shape:

```ts
type CodexProviderRuntimeConfig = {
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
};
```

This keeps the container-side runner simple and gives the host a single place to merge defaults and overrides.

### 3. Define precedence between `.env` defaults and `providerOptions`

To keep the implementation future-friendly, project-level `.env` settings should be treated as defaults, not as the final authority.

Recommended precedence:

1. Explicit per-group `providerOptions`
2. Project-level `.env` / `process.env` defaults
3. Codex built-in defaults

Because existing tests and DB examples already use `profile` and `reasoning`, the normalization layer should support both current and future keys:

- `providerOptions.model` or `providerOptions.profile` → normalized `model`
- `providerOptions.reasoningEffort` or `providerOptions.reasoning` → normalized `reasoningEffort`

This avoids forcing an immediate data migration while still moving the implementation toward clearer naming.

### 4. Apply the resolved settings in the container-side Codex runner

The container-side provider should apply the normalized settings when generating Codex runtime configuration.

Preferred implementation direction:

1. Use `config.toml` as the primary source of truth for persisted Codex runtime settings
2. Write the configured model and reasoning effort into that generated config when present
3. Only fall back to CLI flags if the bundled `@openai/codex` version requires it for a specific setting

This keeps runtime state auditable and consistent with the existing config generation flow.

Expected logical mapping:

- `CODEX_MODEL` → Codex model config
- `CODEX_REASONING_EFFORT` → Codex reasoning-effort config

Note:
The exact Codex config keys must be verified against the bundled Codex version used by NanoClaw at implementation time.

### 5. Validate reasoning effort values early

Reasoning effort is a constrained value set and should be validated before it reaches the runtime.

Recommended allowed values:

- `low`
- `medium`
- `high`
- `xhigh`

If `CODEX_REASONING_EFFORT` is set to anything else, NanoClaw should fail fast with a clear error or provider validation message rather than letting Codex fail with a vague downstream error.

Model values should remain pass-through strings because valid Codex model IDs can change over time.

## Detailed Design

### Host-side changes

Likely files:

1. `src/config.ts`
2. `src/agent/providers/codex/host.ts`
3. `src/agent/providers/codex/host.test.ts`

Host-side responsibilities:

1. Read `CODEX_MODEL` and `CODEX_REASONING_EFFORT`
2. Normalize `.env` defaults and `providerOptions`
3. Pass the resolved payload into `providerData`
4. Validate reasoning effort values before runtime invocation

### Container-side changes

Likely files:

1. `container/agent-runner/src/providers/codex.ts`
2. `container/agent-runner/test/codex-provider.test.js`

Container-side responsibilities:

1. Read normalized `providerData`
2. Apply model and reasoning settings when building `config.toml` and/or CLI args
3. Preserve existing auth, AGENTS memory, MCP, and session behavior

### Documentation changes

Likely files:

1. `.env.example`
2. `README.md`
3. `docs/SPEC.md`

Potentially:

4. `docs/REQUIREMENTS.md`
5. setup or verification docs where provider configuration is described

Documentation responsibilities:

1. Show example `CODEX_MODEL` and `CODEX_REASONING_EFFORT` usage
2. Explain that the vars are optional
3. Clarify that auth still uses `CODEX_AUTH_FILE` / ChatGPT login
4. Document allowed reasoning effort values

## Testing Strategy

### Unit and integration coverage

The implementation should add or update tests for all three layers:

1. Config resolution
   - `.env` and `process.env` values are read correctly
   - unset values preserve current defaults

2. Host provider serialization
   - resolved project defaults are included in `providerData`
   - `providerOptions` override `.env` defaults when present
   - reasoning validation fails cleanly on invalid values

3. Container-side runtime config
   - generated `config.toml` and/or CLI args include the configured model
   - generated `config.toml` and/or CLI args include the configured reasoning effort
   - existing auth/session/MCP behavior remains unchanged

### Candidate test files

1. `src/config.test.ts`
2. `src/agent/providers/codex/host.test.ts`
3. `container/agent-runner/test/codex-provider.test.js`

## UX and Behavior Notes

### Default behavior

If neither env var is set:

- NanoClaw should behave exactly as it does today
- no new config keys should be required

### Tuning behavior

If `CODEX_MODEL` is set:

- the built-in Codex provider should use that model for new and resumed turns

If `CODEX_REASONING_EFFORT` is set:

- the built-in Codex provider should use that reasoning level when the selected model supports it

### Override behavior

If future or existing `providerOptions` include model/reasoning values:

- those per-group values should override project-wide `.env` defaults

## Risks

1. Codex config-key drift across bundled CLI versions
   - Mitigation: implementation must verify the exact supported config or CLI keys against the bundled `@openai/codex` version.

2. Unsupported reasoning/model combinations
   - Mitigation: validate reasoning effort locally and document that model support depends on the bundled Codex/runtime version.

3. Duplicate configuration paths
   - Mitigation: normalize config in one host-side helper and pass a single resolved payload into the container runner.

4. Silent precedence confusion between `.env` and `providerOptions`
   - Mitigation: document precedence explicitly and test it.

## Acceptance Criteria

1. Setting `CODEX_MODEL` in `.env` changes the model used by the built-in Codex provider.
2. Setting `CODEX_REASONING_EFFORT` in `.env` changes the reasoning level used by the built-in Codex provider.
3. Defaults remain unchanged when the vars are unset.
4. The host provider passes the resolved settings into `providerData`.
5. The container-side Codex runner applies the resolved settings in runtime config and/or CLI invocation.
6. The new variables are documented in `.env.example`, `README.md`, and provider configuration docs.
7. Tests cover env resolution, provider-data serialization, and runtime config generation.

## Open Questions

1. Should invalid `CODEX_REASONING_EFFORT` values throw during startup config resolution, or surface as a Codex provider validation error later in the setup flow?
2. Should the implementation standardize on `providerOptions.model` / `providerOptions.reasoningEffort` immediately, or keep dual support for `profile` / `reasoning` indefinitely?
3. If the bundled Codex version supports both config-file and CLI approaches, should NanoClaw prefer `config.toml` only, or mirror the setting in CLI args for visibility?
