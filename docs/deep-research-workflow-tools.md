# Deep Research Workflow Tools

## Implementation Layout

This repository is a TypeScript project using Vitest. The workflow enforcement
layer therefore lives in the existing application stack instead of the Python
reference layout from `plan.md`.

Implementation files:

```txt
src/deep-research-workflow/
  models.ts
  storage.ts
  state-machine.ts
  tools.ts
  schemas.ts
  cli.ts
  index.ts
```

Tests live beside the rest of the repo tests:

```txt
src/deep-research-workflow/*.test.ts
```

The relevant test command is:

```sh
pnpm exec vitest run src/deep-research-workflow
```

The full repository test command is:

```sh
pnpm test
```

## Tool List

All tools are exported from `src/deep-research-workflow/tools.ts` through the
`deepResearchWorkflowTools` object:

- `describe_workflow_capabilities`
- `get_run_state`
- `initialize_run`
- `set_deliverable_contract`
- `create_task_plan`
- `set_subquestions`
- `set_execution_mode`
- `start_task`
- `complete_task`
- `add_followup_tasks`
- `record_reconciliation`
- `submit_final_report`
- `final_audit`

Strict JSON schemas are exported from
`src/deep-research-workflow/schemas.ts` and the module index:

```ts
import { TOOL_SCHEMAS, toolSchemas } from './src/deep-research-workflow/index.js';
```

Each schema uses:

- `type: "object"` parameters.
- Explicit `required` fields.
- `additionalProperties: false` on every object.
- Enums for constrained workflow fields.

## Registration

For OpenAI Responses API tool registration, pass the exported schema objects
directly as function tools:

```ts
import { TOOL_SCHEMAS } from './src/deep-research-workflow/index.js';

const tools = Object.values(TOOL_SCHEMAS);
```

For MCP or an internal application tool registry, register the matching
function from `deepResearchWorkflowTools` with the schema of the same name.

## NanoClaw Agent Container MCP Tools

NanoClaw v2 agent containers expose the workflow as MCP tools through:

```txt
container/agent-runner/src/mcp-tools/deep-research-workflow.ts
```

At container startup, the host mounts the shared implementation read-only:

```txt
src/deep-research-workflow -> /app/deep-research-workflow
```

The adapter dynamically loads `/app/deep-research-workflow/index.ts`, converts
each exported workflow schema into an MCP tool definition, and delegates calls
to the shared `deepResearchWorkflowTools` functions. This keeps all ordering
and state-machine enforcement in the shared implementation instead of copying
workflow logic into the container runner.

For the Codex provider, NanoClaw also discovers the workflow tools from the
`nanoclaw` MCP inventory and exposes them as a typed `nanoclaw` dynamic-tool
namespace when a thread starts. Codex `item/tool/call` requests are forwarded
to `mcpServer/tool/call`, so both providers reach the same MCP handlers and
durable state machine. Continuations created before this bridge are refreshed
once; bridge-aware continuations retain their existing Codex thread.

Inside a running agent container, workflow state is rooted at:

```txt
/workspace/agent
```

Each `initialize_run` call creates an isolated per-request run directory under:

```txt
/workspace/agent/research/<safe-topic-slug>/
```

The MCP adapter stores the run index at:

```txt
/workspace/agent/research/.workflow-runs.json
```

The durable artifacts for a run are written directly inside that run directory:

```txt
/workspace/agent/research/<safe-topic-slug>/run_state.yaml
/workspace/agent/research/<safe-topic-slug>/tasks.yaml
/workspace/agent/research/<safe-topic-slug>/subquestions.yaml
/workspace/agent/research/<safe-topic-slug>/reconciliation.yaml
/workspace/agent/research/<safe-topic-slug>/final-audit.json
/workspace/agent/research/<safe-topic-slug>/final-report.html
```

For the current Telegram `cli-with-pi` group, those files map on the host to:

```txt
groups/cli-with-pi/research/<safe-topic-slug>/run_state.yaml
groups/cli-with-pi/research/<safe-topic-slug>/tasks.yaml
groups/cli-with-pi/research/<safe-topic-slug>/subquestions.yaml
groups/cli-with-pi/research/<safe-topic-slug>/reconciliation.yaml
groups/cli-with-pi/research/<safe-topic-slug>/final-audit.json
groups/cli-with-pi/research/<safe-topic-slug>/final-report.html
```

Tool inputs keep the contract-relative artifact paths, such as
`research/final-report.html`. When a run directory is active, the shared storage
maps that to `<safe-topic-slug>/final-report.html`. Tool results include
`workflow_run_path`, `workflow_report_path`, and
`workflow_submit_artifact_path` so the model can write and attach the real file
while submitting the expected workflow artifact path.

If a run directory lacks `run_state.yaml` and `final-audit.json` after a
research run, the run was not tool-gated to completion by the workflow MCP
tools.

Runtime ordering guidance:

- Set `parallel_tool_calls: false` for workflow-tool turns.
- Use `get_run_state` when resuming or uncertain.
- Expose only `run_state.allowed_next_tool` when the runtime can filter tools.
- If filtering is unavailable, keep all tools registered; the state machine
  still rejects out-of-order calls.
- Feed every tool result back to the model and do not proceed unless `ok` is
  `true`.

## CLI Usage

The package script is:

```sh
pnpm deep-research-workflow -- describe-capabilities
```

The direct TypeScript entry point is:

```sh
pnpm exec tsx src/deep-research-workflow/cli.ts describe-capabilities
```

Commands that take structured input accept `--json <file>` or `--json -` for
stdin. All commands print a JSON result. Rejected workflow calls return a
non-zero exit code unless `--allow-failure` is present.

Examples:

```sh
pnpm deep-research-workflow -- initialize-run --json input.json
pnpm deep-research-workflow -- get-state --run-id dr_2026_05_15_000000
pnpm deep-research-workflow -- start-task --run-id dr_2026_05_15_000000 --task-id R1
pnpm deep-research-workflow -- final-audit --run-id dr_2026_05_15_000000
```

Use `--root <dir>` to run the workflow against a specific workspace or a clean
temporary smoke-test directory.

## Persistence

The standalone workflow stores durable files under `research/` by default:

```txt
research/run_state.yaml
research/tasks.yaml
research/subquestions.yaml
research/reconciliation.yaml
research/final-audit.json
```

When the NanoClaw MCP adapter supplies a run directory, the same files are
stored directly under the isolated run folder instead. This prevents one
completed deep-research run from blocking later `initialize_run` calls.

The `.yaml` files are written as JSON-compatible YAML so they can be parsed
without adding a runtime YAML dependency.

`research/run_state.yaml` is the source of truth for workflow order.
`research/tasks.yaml` is the source of truth for task status. Mutating workflow
tools are the only code that should update those files.

## State Machine

The ordered states are:

```txt
not_started
  -> initialized
  -> deliverable_defined
  -> task_plan_created
  -> subquestions_defined
  -> execution_mode_selected
  -> tasks_in_progress
  -> tasks_closed
  -> reconciliation_complete
  -> final_report_submitted
  -> audit_passed
```

Allowed next tools:

| Current state             | Allowed next tool                                   |
| ------------------------- | --------------------------------------------------- |
| `not_started`             | `initialize_run`                                    |
| `initialized`             | `set_deliverable_contract`                          |
| `deliverable_defined`     | `create_task_plan`                                  |
| `task_plan_created`       | `set_subquestions`                                  |
| `subquestions_defined`    | `set_execution_mode`                                |
| `execution_mode_selected` | `start_task`                                        |
| `tasks_in_progress`       | `complete_task`, `start_task`, `add_followup_tasks` |
| `tasks_closed`            | `record_reconciliation`                             |
| `reconciliation_complete` | `submit_final_report`                               |
| `final_report_submitted`  | `final_audit`                                       |
| `audit_passed`            | none                                                |

`describe_workflow_capabilities` and `get_run_state` are non-mutating and may
be called at any time.

## Failure Behavior

Every tool returns JSON with at least:

```json
{
  "ok": false,
  "run_id": "dr_2026_05_15_000000",
  "current_state": "deliverable_defined",
  "allowed_next_tool": "create_task_plan",
  "errors": [
    "Out-of-order tool call. Expected create_task_plan because current_state is deliverable_defined; got submit_final_report."
  ],
  "warnings": []
}
```

Failed mutating tool calls do not update durable state. The exception is
`final_audit`, which writes `research/final-audit.json` with the failed audit
details but only advances `run_state.yaml` when the audit passes.

## Output Modes

`human_report` is the default and uses `research/final-report.html`. Markdown
is rejected in this mode.

`printable` requires `research/final-report.html` to exist before
`research/final-report.pdf` is submitted.

`skill_handoff` allows Markdown and uses `research/handoff.md`.

## Final Verification Checklist

- [x] `describe_workflow_capabilities` exists and is non-mutating.
- [x] `get_run_state` exists and is non-mutating.
- [x] `initialize_run` creates durable state.
- [x] `set_deliverable_contract` records output mode and rejects invalid Markdown use.
- [x] `create_task_plan` rejects invalid plans.
- [x] `set_subquestions` verifies task mapping.
- [x] `set_execution_mode` prevents false subagent claims.
- [x] `start_task` prevents invalid task starts.
- [x] `complete_task` requires artifacts or reasons.
- [x] `add_followup_tasks` safely appends new tasks.
- [x] `record_reconciliation` cannot run until tasks are closed.
- [x] `submit_final_report` cannot run before reconciliation.
- [x] `final_audit` blocks the user-facing answer until all gates pass.
- [x] All tools return the common JSON result shape.
- [x] All mutating tools enforce state order.
- [x] Failed tool calls do not mutate durable state.
- [x] Strict schemas are exported for every tool.
- [x] Human-report mode defaults to HTML.
- [x] Markdown is reserved for skill-handoff mode unless explicitly allowed.
- [x] PDF mode requires HTML first.
- [x] Tests cover happy path and rejection path.
- [x] Documentation explains registration and CLI usage.
- [x] The full test suite passes.
