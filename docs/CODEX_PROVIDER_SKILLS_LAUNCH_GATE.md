# Codex Provider Skills Launch Gate

Run date: 2026-04-08

Run timestamp: 2026-04-08 04:23:23Z

Installed @openai/codex version: 0.118.0

NanoClaw runtime boundary:

- Image: `nanoclaw-agent:latest`
- Entry path: image default `/app/entrypoint.sh`
- `cwd=/workspace/group`
- `CODEX_HOME=/home/node/.codex`
- Execution path: `docker create` + `docker cp` + `docker start -ai` against the real NanoClaw agent image, not a mocked Codex binary

Temporary skill source: `container/codex-skills/cps03-launch-gate-smoke-skill/SKILL.md`

Synced skill path: `/workspace/group/.agents/skills/cps03-launch-gate-smoke-skill/SKILL.md`

Prompt used:

```text
Use the `cps03-launch-gate-smoke-skill` skill and reply with its exact confirmation payload.
```

Observed evidence:

- Codex first reported that it was checking whether `cps03-launch-gate-smoke-skill` was available in the workspace.
- Codex then reported that it found a local skill definition and was reading only that skill's instructions.
- The final agent result was:

```text
CPS03_SKILL_CONFIRMED
skill_path=/workspace/group/.agents/skills/cps03-launch-gate-smoke-skill/SKILL.md
```

- Captured smoke artifact: `.ai-native/runs/20260408T020624697377Z-prd-codex-provider-skills/slices/CPS-03/smoke/codex-version.txt`
- Captured smoke artifact: `.ai-native/runs/20260408T020624697377Z-prd-codex-provider-skills/slices/CPS-03/smoke/container-output.log`
- Captured smoke artifact: `.ai-native/runs/20260408T020624697377Z-prd-codex-provider-skills/slices/CPS-03/smoke/codex-home-after/config.toml`
- Captured smoke artifact: `.ai-native/runs/20260408T020624697377Z-prd-codex-provider-skills/slices/CPS-03/smoke-test-transcript.md`
- The post-run Codex home snapshot includes `config.toml` with `cli_auth_credentials_store = "file"` and the expected provider MCP config under `.ai-native/runs/20260408T020624697377Z-prd-codex-provider-skills/slices/CPS-03/smoke/codex-home-after/config.toml`.
- The full container transcript is recorded in `.ai-native/runs/20260408T020624697377Z-prd-codex-provider-skills/slices/CPS-03/smoke-test-transcript.md`.
- Attachable reviewer bundle intentionally excludes credential-bearing `auth.json` cache snapshots.

Reviewer launch decision:

- [x] Smoke-test artifact recorded with the exact run date, runtime boundary, installed Codex version, prompt, and observed discovery evidence.
- [x] Flip Codex host and container capability surfaces from `providerSkills: false` to `providerSkills: true` in a follow-up change after reviewer approval.

Reviewer approval complete: set `providerSkills: true` in both the host and container Codex capability surfaces.
