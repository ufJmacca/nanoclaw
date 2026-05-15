# PLAN: Tool-Enforced Deep Research Workflow Adherence

This file is intended to be used with Codex CLI `/goal`.

Suggested invocation after copying this file into the repo root:

```txt
/goal Implement plan.md. Create tests for each milestone, run the relevant test suite after every milestone, and stop only when the final acceptance checklist passes.
```

## 0. Codex directive

Implement an order-enforcing workflow layer for the existing `deep-research` skill located in `~/nanoclaw-v2/contianer/skills/deep-research`.

The implementation must make step completion verifiable by code, not by prose. A model may propose that a step is complete, but a workflow tool must validate and record completion before the next step is allowed.

Work milestone-by-milestone. Do not skip milestones. After each milestone, run the relevant tests and fix failures before continuing.

If the repository already has an application language, framework, test runner, or tool-registration pattern, use the existing conventions. If the repository has no implementation structure, create a small Python reference implementation with tests.

## 1. Context from the current skill

The current skill is named `deep-research` and is intended for broad, multi-source research tasks requiring:

- A todo-driven workflow.
- Optional Codex subagents.
- Source reconciliation.
- One synthesized report.
- HTML as the normal human-readable final report.
- Markdown only for skill-handoff mode.

The skill currently defines this required workflow:

1. Restate the research question.
2. Define the exact deliverable.
3. Create a visible research task list.
4. Split the work into independent sub-questions.
5. Decide whether to use subagents or sequential passes.
6. Execute every task in the task list.
7. Update task statuses as work completes.
8. Reconcile contradictions, uncertainty, and duplicate findings.
9. Produce one synthesized final report.

The skill also says `research/tasks.yaml` should be the source of truth during Codex-style durable research runs.

There is a conflict to fix: one section says the final report defaults to Markdown, while later output-mode rules say normal human-readable research output must be HTML and Markdown is reserved for skill-handoff mode. Resolve this by making the deliverable contract authoritative:

- Default `human_report` mode uses HTML.
- `printable` mode generates HTML first, then PDF.
- `skill_handoff` mode may use Markdown.
- Markdown is never allowed for normal human-readable final reports unless the user explicitly requested Markdown and the deliverable contract records why it is allowed.

## 2. Primary goal

Build a workflow verification layer that prevents the deep-research skill from:

- Starting research before the question and deliverable are defined.
- Skipping the task plan.
- Claiming subagents were used when they were not.
- Completing tasks without artifacts or reasons.
- Producing a final report before all tasks are closed.
- Skipping contradiction and uncertainty reconciliation.
- Returning Markdown in human-report mode.
- Continuing after an out-of-order tool call.

The result should expose a small set of programmatic workflow tools that can be registered as OpenAI function tools, MCP tools, local CLI commands, or internal application functions depending on the existing repo structure.

## 3. Non-goals

Do not implement a full web research engine unless one already exists in the repo.

Do not replace the existing skill. Patch it so it delegates workflow completion to tools when the tools are available.

Do not let the model mark workflow steps complete only by writing text.

Do not add brittle prompt-only enforcement in place of state-machine checks.

Do not claim Codex subagents were spawned unless the runtime actually launched separate subagent jobs or the repo has a real equivalent.

## 4. Required deliverables

Codex must produce these deliverables:

1. A workflow state machine.
2. Persistent run state stored under `research/`.
3. Programmatic workflow tools.
4. Strict input schemas for tool registration.
5. Tests proving out-of-order and incomplete steps are rejected.
6. A patched `SKILL.md` section explaining that tools are authoritative.
7. Documentation showing how to register or invoke the tools.
8. A final verification checklist.

## 5. Preferred file layout

Use existing repo conventions where possible. If no structure exists, create this Python reference layout:

```txt
.
├── skills/
│   └── deep-research/
│       └── SKILL.md
├── deep_research_workflow/
│   ├── __init__.py
│   ├── models.py
│   ├── state_machine.py
│   ├── storage.py
│   ├── tools.py
│   ├── schemas.py
│   └── cli.py
├── tests/
│   ├── test_state_machine.py
│   ├── test_tools_happy_path.py
│   ├── test_tools_rejections.py
│   ├── test_output_modes.py
│   └── fixtures/
│       └── sample_run/
├── docs/
│   └── deep_research_workflow_tools.md
└── research/
    └── .gitkeep
```

If the repo is TypeScript/JavaScript, mirror the same structure in the existing source tree, for example:

```txt
src/deepResearchWorkflow/
  models.ts
  stateMachine.ts
  storage.ts
  tools.ts
  schemas.ts
```

Do not force Python if the repo clearly uses another stack.

## 6. Runtime artifact layout

The workflow must store durable state here:

```txt
research/
  run_state.yaml
  tasks.yaml
  sources.yaml
  subquestions.yaml
  reconciliation.yaml
  findings/
    R1.yaml
    R2.yaml
    R3.yaml
    R4.yaml
  final-report.html
  final-report.pdf         # optional, printable mode only
  handoff.md               # optional, skill-handoff mode only
  final-audit.json
```

Only workflow tools should write `run_state.yaml`, `tasks.yaml`, `subquestions.yaml`, `reconciliation.yaml`, and `final-audit.json`.

Research tools, subagents, or the main agent may create files under `research/findings/`, but task completion still requires `complete_task` to validate those files.

## 7. Source of truth

`research/run_state.yaml` is the primary source of truth for workflow order.

`research/tasks.yaml` is the primary source of truth for individual task statuses.

The model must not be treated as authoritative when it says a step is complete. A step is complete only when the corresponding tool returns `ok: true` and updates state.

## 8. State machine

Implement this ordered workflow state machine:

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

Each state must define exactly which workflow tool is allowed next.

Suggested mapping:

| Current state | Allowed next tool |
|---|---|
| `not_started` | `initialize_run` |
| `initialized` | `set_deliverable_contract` |
| `deliverable_defined` | `create_task_plan` |
| `task_plan_created` | `set_subquestions` |
| `subquestions_defined` | `set_execution_mode` |
| `execution_mode_selected` | `start_task` |
| `tasks_in_progress` | `complete_task`, `start_task`, or `add_followup_tasks` |
| `tasks_closed` | `record_reconciliation` |
| `reconciliation_complete` | `submit_final_report` |
| `final_report_submitted` | `final_audit` |
| `audit_passed` | no further workflow tool required |

`tasks_in_progress` must remain active until every task is `done`, `blocked`, or `skipped` with a reason.

If strict sequential task mode is enabled, `start_task` may only start the next `todo` task in order.

If verified subagent mode is enabled, multiple tasks may be `running` only when the runtime has explicitly recorded that subagent jobs were spawned.

## 9. Common tool result shape

Every workflow tool must return JSON with this shape:

```json
{
  "ok": true,
  "run_id": "dr_2026_05_15_001",
  "current_state": "task_plan_created",
  "allowed_next_tool": "set_subquestions",
  "errors": [],
  "warnings": []
}
```

On failure:

```json
{
  "ok": false,
  "run_id": "dr_2026_05_15_001",
  "current_state": "deliverable_defined",
  "allowed_next_tool": "create_task_plan",
  "errors": ["Out-of-order tool call. Expected create_task_plan, got submit_final_report."],
  "warnings": []
}
```

Never update durable state on a failed tool call unless the update is an explicit error log.

## 10. Tool namespace

Expose these tools under a single namespace such as:

```txt
deep_research_workflow
```

Required tools:

1. `describe_workflow_capabilities`
2. `get_run_state`
3. `initialize_run`
4. `set_deliverable_contract`
5. `create_task_plan`
6. `set_subquestions`
7. `set_execution_mode`
8. `start_task`
9. `complete_task`
10. `add_followup_tasks`
11. `record_reconciliation`
12. `submit_final_report`
13. `final_audit`

If the existing repo has a different naming convention, use that convention but keep these semantics.

## 11. Tool specifications

### 11.1 `describe_workflow_capabilities`

Purpose: allow programmatic capability discovery.

Inputs:

```json
{}
```

Returns:

- Workflow name.
- Workflow version.
- Supported output modes.
- Ordered states.
- Tool names.
- Whether state persistence is enabled.
- Whether subagent verification is supported.

Validation:

- This tool may be called at any time.
- It must not mutate state.

### 11.2 `get_run_state`

Purpose: allow the model or runtime to resume and see the next valid action.

Inputs:

```json
{
  "run_id": "string or null"
}
```

Returns:

- Current state.
- Allowed next tool.
- Deliverable contract.
- Task counts.
- Open tasks.
- Completed gates.
- Blocking errors, if any.

Validation:

- This tool may be called at any time.
- It must not mutate state.

### 11.3 `initialize_run`

Purpose: start the workflow and lock the original request.

Inputs:

```json
{
  "original_user_request": "string",
  "restated_research_question": "string",
  "quick_answer_requested": false
}
```

Validation:

- Reject if a run already exists unless the tool supports explicit resume mode.
- Reject empty `original_user_request`.
- Reject empty or generic `restated_research_question`.
- If `quick_answer_requested` is true, record that the full workflow may be bypassed only for quick-answer mode.
- Otherwise set state to `initialized` and `allowed_next_tool` to `set_deliverable_contract`.

Side effects:

- Create `research/` if missing.
- Create `research/run_state.yaml`.

### 11.4 `set_deliverable_contract`

Purpose: record exactly what final output must be produced.

Inputs:

```json
{
  "run_id": "string",
  "audience": "string",
  "final_format": "html | pdf | markdown_handoff | other",
  "output_mode": "human_report | printable | skill_handoff",
  "depth": "brief | standard | deep",
  "source_requirements": "string",
  "time_horizon": "string",
  "key_comparison_dimensions": ["string"],
  "done_criteria": ["string"],
  "markdown_allowed_reason": "string or null"
}
```

Validation:

- Must be called only after `initialize_run`.
- Reject `human_report` with `markdown_handoff`.
- Reject Markdown unless `output_mode` is `skill_handoff` or the user explicitly requested Markdown and `markdown_allowed_reason` is non-empty.
- If `output_mode` is `printable`, require `final_format` to be `pdf` and later require HTML to exist before PDF.
- If `output_mode` is `human_report`, default `final_format` to `html`.
- Require at least one done criterion.

Side effects:

- Update `research/run_state.yaml`.
- Optionally create/update the `deliverable` section in `research/tasks.yaml`.

### 11.5 `create_task_plan`

Purpose: create the research task list before any research begins.

Inputs:

```json
{
  "run_id": "string",
  "tasks": [
    {
      "id": "R1",
      "task": "Map the topic and define scope",
      "mode": "main | subagent | sequential",
      "status": "todo",
      "expected_output": "Scope, definitions, exclusions",
      "output_artifact": "research/findings/R1.yaml"
    }
  ]
}
```

Validation:

- Must be called only after `set_deliverable_contract`.
- Reject fewer than three tasks for a standard or deep research run.
- Reject duplicate task IDs.
- All initial statuses must be `todo`.
- Every task must have `id`, `task`, `mode`, `status`, `expected_output`, and `output_artifact`.
- Require the default semantic roles unless explicitly replaced with equivalent custom tasks:
  - Scope mapping.
  - Source collection.
  - Viewpoint/option comparison.
  - Contradiction or weak-evidence checking.
  - Final synthesis.
- Reject final synthesis as the first task unless quick-answer mode is active.

Side effects:

- Write `research/tasks.yaml`.
- Update `run_state.yaml` to `task_plan_created`.

### 11.6 `set_subquestions`

Purpose: verify the decomposition step.

Inputs:

```json
{
  "run_id": "string",
  "subquestions": [
    {
      "subquestion": "string",
      "task_ids": ["R1"],
      "independence_reason": "string"
    }
  ]
}
```

Validation:

- Must be called only after `create_task_plan`.
- Every referenced task ID must exist.
- Every non-synthesis research task should be mapped to at least one subquestion.
- Reject vague subquestions such as `research the topic` or `look things up`.
- Require at least two subquestions for standard or deep research unless the task is explicitly single-threaded.

Side effects:

- Write `research/subquestions.yaml`.
- Update state to `subquestions_defined`.

### 11.7 `set_execution_mode`

Purpose: decide whether to use subagents or sequential passes.

Inputs:

```json
{
  "run_id": "string",
  "execution_mode": "subagents | sequential_passes | single_main_pass",
  "reason": "string",
  "subagent_count": 0,
  "subagent_roles": ["Source mapper"],
  "verified_subagent_job_ids": []
}
```

Validation:

- Must be called only after `set_subquestions`.
- If `execution_mode` is `subagents`, require `subagent_count` between 2 and 5.
- If `execution_mode` is `subagents`, require non-empty `subagent_roles`.
- If the runtime cannot verify subagent job IDs, do not allow the workflow to claim actual subagents were used. Allow `sequential_passes` instead.
- If `single_main_pass`, require a reason explaining why subagents or sequential passes are unnecessary.

Side effects:

- Update `run_state.yaml`.
- Set state to `execution_mode_selected`.

### 11.8 `start_task`

Purpose: mark the next eligible task as running.

Inputs:

```json
{
  "run_id": "string",
  "task_id": "R1"
}
```

Validation:

- Must be called only after `set_execution_mode` or while in `tasks_in_progress`.
- Task must exist.
- Task status must be `todo`.
- In strict sequential mode, `task_id` must be the first `todo` task in order.
- No other task may be `running` unless verified subagent mode is active.

Side effects:

- Update task status to `running`.
- Set state to `tasks_in_progress`.

### 11.9 `complete_task`

Purpose: close a running task with evidence.

Inputs:

```json
{
  "run_id": "string",
  "task_id": "R1",
  "status": "done | blocked | skipped",
  "summary": "string",
  "output_artifact": "research/findings/R1.yaml or null",
  "reason_if_not_done": "string or null",
  "evidence_count": 0,
  "new_followup_tasks": []
}
```

Validation:

- Task must exist.
- Task must currently be `running`.
- `summary` must be non-empty.
- If `status` is `done`, `output_artifact` must exist on disk unless the task is final report synthesis and the output is the final report artifact.
- If `status` is `blocked` or `skipped`, `reason_if_not_done` must be non-empty.
- Source collection tasks must require at least one source unless explicitly blocked.
- Contradiction/evidence tasks must require a caveats/confidence artifact unless blocked.
- New follow-up tasks must be added as `todo` with unique IDs.

Side effects:

- Update `research/tasks.yaml`.
- If all tasks are closed, set state to `tasks_closed`; otherwise remain in `tasks_in_progress`.

### 11.10 `add_followup_tasks`

Purpose: add required follow-up tasks discovered during execution.

Inputs:

```json
{
  "run_id": "string",
  "parent_task_id": "R3",
  "tasks": [
    {
      "id": "R6",
      "task": "Resolve conflicting market-size estimates",
      "mode": "sequential",
      "status": "todo",
      "expected_output": "Resolved estimate with caveats",
      "output_artifact": "research/findings/R6.yaml"
    }
  ]
}
```

Validation:

- May be called only while tasks are being executed.
- Parent task must exist.
- New IDs must be unique.
- New task statuses must be `todo`.
- New task artifacts must not overwrite existing artifacts.

Side effects:

- Append tasks to `research/tasks.yaml`.
- Keep state in `tasks_in_progress`.

### 11.11 `record_reconciliation`

Purpose: make contradiction, uncertainty, duplicate, and weak-evidence checks impossible to skip.

Inputs:

```json
{
  "run_id": "string",
  "contradictions_checked": true,
  "duplicates_checked": true,
  "weak_evidence_checked": true,
  "uncertainty_checked": true,
  "conflicts": [
    {
      "issue": "string",
      "sources_in_disagreement": ["string"],
      "resolution": "string",
      "confidence": "low | medium | high"
    }
  ],
  "no_conflicts_reason": "string or null"
}
```

Validation:

- Must be called only after all tasks are closed.
- All four check booleans must be true.
- If `conflicts` is empty, require `no_conflicts_reason`.
- Each conflict must include issue, sources, resolution, and confidence.

Side effects:

- Write `research/reconciliation.yaml`.
- Set state to `reconciliation_complete`.

### 11.12 `submit_final_report`

Purpose: submit the final artifact only after research and reconciliation gates pass.

Inputs:

```json
{
  "run_id": "string",
  "artifact_path": "research/final-report.html",
  "format": "html | pdf | markdown_handoff | other",
  "included_sections": [
    "title",
    "executive_summary",
    "answer_or_recommendation",
    "key_findings",
    "evidence_and_analysis",
    "comparison_table",
    "contradictions_caveats_uncertainty",
    "source_list",
    "appendix"
  ]
}
```

Validation:

- Must be called only after `record_reconciliation`.
- Artifact must exist on disk.
- In `human_report` mode, require `format = html` and path `research/final-report.html` unless the deliverable contract explicitly allows another format.
- In `printable` mode, require both `research/final-report.html` and `research/final-report.pdf`.
- In `skill_handoff` mode, allow `research/handoff.md`.
- Require all core sections except `comparison_table` and `appendix`, which are optional only when irrelevant.
- Reject Markdown final reports in human-report mode.

Side effects:

- Update `run_state.yaml` to `final_report_submitted`.

### 11.13 `final_audit`

Purpose: run a final adherence check before the user-facing answer.

Inputs:

```json
{
  "run_id": "string"
}
```

Validation:

- All required gates must be complete.
- No task may be `todo` or `running`.
- Any `blocked` or `skipped` task must have a reason.
- Reconciliation must be recorded.
- Final artifact must match the deliverable contract.
- Report sections must satisfy the final-report requirements.
- Markdown must not be present as the final human report unless explicitly allowed.

Returns:

```json
{
  "ok": true,
  "allowed_to_answer_user": true,
  "missing_steps": [],
  "open_tasks": [],
  "format_errors": [],
  "next_required_action": "answer_user_with_report_link"
}
```

On failure:

```json
{
  "ok": false,
  "allowed_to_answer_user": false,
  "missing_steps": ["record_reconciliation"],
  "open_tasks": ["R4"],
  "format_errors": [],
  "next_required_action": "record_reconciliation"
}
```

Side effects:

- Write `research/final-audit.json`.
- If passing, update state to `audit_passed`.

## 12. Schema requirements

Create strict schemas for every tool.

For OpenAI function-tool registration, every schema must:

- Use `type: object`.
- Use `additionalProperties: false`.
- Mark required fields explicitly.
- Use enums for constrained fields such as status, output mode, format, and confidence.
- Avoid accepting vague free-form blobs when structured fields are known.

Provide a module that exports all schemas, for example:

```python
from deep_research_workflow.schemas import TOOL_SCHEMAS
```

or:

```ts
import { toolSchemas } from "./deepResearchWorkflow/schemas";
```

Each schema definition should be usable directly by the application’s OpenAI Responses API or MCP registration layer.

## 13. Recommended API runtime behavior

Where the application uses OpenAI tool calling, configure ordered workflow turns as follows:

- Set `parallel_tool_calls: false` for workflow-tool turns.
- Restrict available tools to the expected next tool when possible.
- Use strict schemas.
- Feed tool results back to the model.
- Do not let the model proceed to the next workflow step unless the tool result has `ok: true`.

When the workflow state says `allowed_next_tool = create_task_plan`, the application should not expose `submit_final_report` as an available tool for that turn unless the app has no mechanism for allowed-tool filtering. If filtering is unavailable, the state machine must still reject the out-of-order call.

## 14. CLI interface

If the repo supports local commands, expose a CLI for testing and Codex use.

Suggested commands:

```txt
python -m deep_research_workflow describe-capabilities
python -m deep_research_workflow get-state --run-id <id>
python -m deep_research_workflow initialize-run --json input.json
python -m deep_research_workflow set-deliverable --json input.json
python -m deep_research_workflow create-task-plan --json input.json
python -m deep_research_workflow set-subquestions --json input.json
python -m deep_research_workflow set-execution-mode --json input.json
python -m deep_research_workflow start-task --run-id <id> --task-id R1
python -m deep_research_workflow complete-task --json input.json
python -m deep_research_workflow add-followup-tasks --json input.json
python -m deep_research_workflow record-reconciliation --json input.json
python -m deep_research_workflow submit-final-report --json input.json
python -m deep_research_workflow final-audit --run-id <id>
```

For TypeScript/JavaScript, expose equivalent package scripts or a binary.

Every command must print the common JSON result shape.

## 15. Patch the skill instructions

Patch the existing `SKILL.md` to include this section near the top, after the frontmatter and before the workflow steps:

```md
## Tool-enforced execution

When workflow tools are available, they are authoritative.

Do not mark a workflow step complete in prose. A workflow step is complete only when the corresponding workflow tool returns `ok: true`.

Use `get_run_state` to determine the next required action when resuming or when uncertain.

Use only the next tool named by `run_state.allowed_next_tool`, except that `describe_workflow_capabilities` and `get_run_state` may be called at any time.

Never call a later workflow tool before the current gate passes.

Do not produce the final answer until `final_audit` returns:

- `ok: true`
- `allowed_to_answer_user: true`

If a workflow tool rejects a step, correct the missing fields or complete the required earlier step. Do not bypass the tool.
```

Also patch the output mode rules so they are consistent:

```md
## Output mode priority

Default mode is `human_report`.

In `human_report` mode:
- Final format is HTML.
- Final artifact is `research/final-report.html`.
- Markdown is not allowed.

In `printable` mode:
- Generate HTML first.
- Then generate PDF.

In `skill_handoff` mode:
- Markdown is allowed.
- Final artifact is `research/handoff.md`.

If two instructions conflict, the deliverable contract recorded by `set_deliverable_contract` wins.
```

Remove or rewrite any instruction that says Markdown is the default final report for normal deep research.

## 16. Tests

Create automated tests for these scenarios.

### 16.1 Happy path

A complete run should pass:

1. `initialize_run`.
2. `set_deliverable_contract` with human-report HTML.
3. `create_task_plan` with R1-R5.
4. `set_subquestions` mapped to tasks.
5. `set_execution_mode` as sequential or verified subagents.
6. Start and complete every task.
7. `record_reconciliation`.
8. Create a valid `research/final-report.html` fixture.
9. `submit_final_report`.
10. `final_audit`.

Expected result:

- `final_audit.ok` is true.
- `allowed_to_answer_user` is true.
- State is `audit_passed`.

### 16.2 Out-of-order rejection

Try to call `submit_final_report` immediately after `initialize_run`.

Expected result:

- Tool returns `ok: false`.
- Error includes expected next tool.
- No final-report state is recorded.

### 16.3 Missing deliverable rejection

Try to create a task plan before setting the deliverable contract.

Expected result:

- Rejected.
- State remains `initialized`.

### 16.4 Invalid task plan rejection

Reject plans with:

- Duplicate task IDs.
- Missing output artifact.
- Non-`todo` initial status.
- No source collection task.
- No reconciliation task.
- Final synthesis as first task without quick-answer mode.

### 16.5 Invalid task lifecycle rejection

Reject:

- Completing a task that was never started.
- Starting a task that is already running or done.
- Completing a `done` task without an artifact.
- Marking a task `blocked` or `skipped` without a reason.
- Starting R3 before R2 in strict sequential mode.

### 16.6 Reconciliation rejection

Reject `record_reconciliation` when:

- Any task is still `todo` or `running`.
- Check booleans are false.
- Conflicts are empty and no `no_conflicts_reason` is provided.

### 16.7 Output mode rejection

Reject:

- Markdown final report in `human_report` mode.
- PDF submission without HTML first.
- Final report missing required sections.
- Artifact paths that do not exist.

### 16.8 Audit rejection

Reject final audit when:

- Reconciliation was skipped.
- Any task remains open.
- Any skipped or blocked task lacks a reason.
- Report format does not match the deliverable contract.

## 17. Example state file

`research/run_state.yaml` should look approximately like this:

```yaml
schema_version: 1
run_id: dr_2026_05_15_001
current_state: task_plan_created
allowed_next_tool: set_subquestions

original_user_request: "Compare current approaches to workflow verification for deep research skills."
restated_research_question: "What tool-enforced workflow should ensure a deep-research skill completes required steps in order?"
quick_answer_requested: false

deliverable:
  audience: "technical implementer"
  output_mode: human_report
  final_format: html
  final_artifact: research/final-report.html
  markdown_allowed: false
  markdown_allowed_reason: null
  depth: deep
  source_requirements: "primary and official sources first"
  time_horizon: "current"
  key_comparison_dimensions:
    - enforcement strength
    - implementation complexity
    - auditability
  done_criteria:
    - all workflow gates pass
    - all tasks are closed
    - final report exists

task_summary:
  total: 5
  todo: 5
  running: 0
  done: 0
  blocked: 0
  skipped: 0

gates:
  initialized: true
  deliverable_defined: true
  task_plan_created: true
  subquestions_defined: false
  execution_mode_selected: false
  all_tasks_closed: false
  reconciliation_complete: false
  final_report_submitted: false
  final_audit_passed: false
```

## 18. Example tasks file

`research/tasks.yaml` should look approximately like this:

```yaml
deliverable:
  mode: human_report
  final_format: html
  final_artifact: research/final-report.html
  markdown_allowed: false
  markdown_allowed_reason: null

tasks:
  - id: R1
    task: Map the topic and define scope
    mode: main
    status: todo
    expected_output: Scope, definitions, exclusions
    output_artifact: research/findings/R1.yaml

  - id: R2
    task: Collect high-quality sources
    mode: sequential
    status: todo
    expected_output: Source list with notes
    output_artifact: research/findings/R2.yaml

  - id: R3
    task: Compare major viewpoints or options
    mode: sequential
    status: todo
    expected_output: Comparison matrix
    output_artifact: research/findings/R3.yaml

  - id: R4
    task: Check contradictions and weak evidence
    mode: sequential
    status: todo
    expected_output: Caveats and confidence
    output_artifact: research/findings/R4.yaml

  - id: R5
    task: Synthesize final answer
    mode: main
    status: todo
    expected_output: Final standalone HTML report
    output_artifact: research/final-report.html
```

## 19. Implementation milestones

### Milestone 1: Repository discovery and design alignment

Tasks:

- Inspect the repository structure.
- Identify the existing skill location.
- Identify the implementation language and test framework.
- Decide whether to implement the Python reference layout or adapt to the existing stack.
- Create or update documentation explaining the chosen layout.

Acceptance:

- A clear implementation location exists.
- Test command is known.
- No code generation starts before the layout decision is reflected in docs or commit notes.

### Milestone 2: Models and storage

Tasks:

- Implement typed models or schema-validated data structures for:
  - Run state.
  - Deliverable contract.
  - Task records.
  - Subquestions.
  - Execution mode.
  - Reconciliation records.
  - Final audit results.
- Implement YAML/JSON storage helpers.
- Ensure `research/` directories are created as needed.
- Ensure failed validation does not mutate state.

Acceptance:

- Unit tests can create, persist, reload, and compare run state.
- Invalid YAML or missing files produce clear errors.

### Milestone 3: State machine

Tasks:

- Implement ordered state transitions.
- Implement `allowed_next_tool` logic.
- Implement out-of-order rejection.
- Implement strict sequential task order.
- Implement verified subagent-mode allowance for multiple running tasks.

Acceptance:

- Tests prove every state allows only the correct next tool.
- Out-of-order calls return `ok: false` and preserve state.

### Milestone 4: Workflow tools

Tasks:

- Implement all required workflow tools.
- Ensure every tool returns the common JSON result shape.
- Add clear errors and warnings.
- Add docstrings or comments explaining validation rules.

Acceptance:

- Happy-path test passes through all tools.
- Rejection tests pass for invalid and out-of-order calls.

### Milestone 5: Tool schemas and registration docs

Tasks:

- Implement strict schemas for every tool.
- Export the schemas from one module.
- Document how to register them as OpenAI function tools, MCP tools, or local application functions.
- Mention ordered runtime configuration: `parallel_tool_calls: false`, strict schemas, and allowed-next-tool filtering.

Acceptance:

- Schema export can be imported without side effects.
- Tests or snapshots verify required fields, enums, and `additionalProperties: false`.

### Milestone 6: CLI

Tasks:

- Implement command-line wrappers for each tool.
- Support JSON input files or stdin.
- Print JSON results.
- Return non-zero exit code on `ok: false` unless a `--allow-failure` flag is provided for tests.

Acceptance:

- CLI happy path works from a temporary directory.
- CLI out-of-order call fails clearly.

### Milestone 7: Skill patch

Tasks:

- Patch `SKILL.md` with the tool-enforced execution section.
- Resolve the Markdown-vs-HTML contradiction.
- Update the Codex todo-list iteration mode to say state tools are authoritative when present.
- Keep the skill concise enough that routing remains clear.

Acceptance:

- Tests or text checks verify the patched skill contains `Tool-enforced execution`.
- Tests or text checks verify normal human report mode defaults to HTML.
- Tests or text checks verify Markdown is reserved for skill-handoff mode unless explicitly allowed.

### Milestone 8: Full integration tests

Tasks:

- Add an end-to-end test that simulates a full durable research run.
- Add tests for every critical failure mode.
- Add a fixture final report file for successful submission.

Acceptance:

- All tests pass.
- Final audit writes `research/final-audit.json`.
- The audit file includes `allowed_to_answer_user: true` only after all gates pass.

### Milestone 9: Final documentation and verification

Tasks:

- Update documentation with:
  - Tool list.
  - State machine.
  - Example CLI usage.
  - Example tool registration.
  - Failure behavior.
- Run the full test suite.
- Produce a final implementation summary.

Acceptance:

- Documentation is sufficient for another developer to register and use the tools.
- Full test suite passes.
- Final checklist below is complete.

## 20. Final acceptance checklist

Codex must not consider the implementation complete until every item is true:

- [ ] `describe_workflow_capabilities` exists and is non-mutating.
- [ ] `get_run_state` exists and is non-mutating.
- [ ] `initialize_run` creates durable state.
- [ ] `set_deliverable_contract` records output mode and rejects invalid Markdown use.
- [ ] `create_task_plan` rejects invalid plans.
- [ ] `set_subquestions` verifies task mapping.
- [ ] `set_execution_mode` prevents false subagent claims.
- [ ] `start_task` prevents invalid task starts.
- [ ] `complete_task` requires artifacts or reasons.
- [ ] `add_followup_tasks` safely appends new tasks.
- [ ] `record_reconciliation` cannot run until tasks are closed.
- [ ] `submit_final_report` cannot run before reconciliation.
- [ ] `final_audit` blocks the user-facing answer until all gates pass.
- [ ] All tools return the common JSON result shape.
- [ ] All mutating tools enforce state order.
- [ ] Failed tool calls do not mutate durable state.
- [ ] Strict schemas are exported for every tool.
- [ ] Human-report mode defaults to HTML.
- [ ] Markdown is reserved for skill-handoff mode unless explicitly allowed.
- [ ] PDF mode requires HTML first.
- [ ] Tests cover happy path and rejection path.
- [ ] Documentation explains registration and CLI usage.
- [ ] The full test suite passes.

## 21. Manual smoke test

After implementation, run a manual smoke test from a clean temp directory:

1. Describe capabilities.
2. Initialize a run.
3. Try to submit final report early and confirm rejection.
4. Set deliverable contract.
5. Create task plan.
6. Set subquestions.
7. Set execution mode.
8. Start and complete each task, creating minimal artifact files.
9. Record reconciliation.
10. Create `research/final-report.html`.
11. Submit final report.
12. Run final audit.
13. Confirm audit passes.

The early final-report attempt must fail. The final audit must pass only after all required steps complete.

## 22. Example failure message quality

Error messages should be specific enough for the model to repair the workflow.

Good:

```json
{
  "ok": false,
  "errors": [
    "Out-of-order tool call. Expected create_task_plan because current_state is deliverable_defined; got submit_final_report."
  ],
  "allowed_next_tool": "create_task_plan"
}
```

Bad:

```json
{
  "ok": false,
  "errors": ["Invalid"]
}
```

## 23. Notes for implementation quality

Prefer simple, auditable code over clever abstractions.

Keep validation rules centralized so API tools, CLI commands, and tests use the same logic.

Use temporary directories in tests so runtime artifacts do not pollute the repo.

Do not make tests depend on live network access.

Do not require real OpenAI API calls to test the state machine.

Where exact report-section validation is difficult, implement a conservative check using section markers or headings and document the limitation.

