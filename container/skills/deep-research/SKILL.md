---
name: deep-research
description: Use for broad, multi-source research tasks that require a todo-driven workflow, optional Codex subagents, source reconciliation, and one synthesized HTML report. Markdown is only for skill-handoff mode when supporting another skill or downstream agent workflow. Do not use for simple lookups, short answers, single-source summaries, or ordinary coding tasks.
---

# Deep Research

## Tool-enforced execution

When workflow tools are available, they are authoritative.

Do not mark a workflow step complete in prose. A workflow step is complete only when the corresponding workflow tool returns `ok: true`.

For a new deep-research run, the first required workflow call is the `initialize_run` tool in the `nanoclaw` namespace.

After `initialize_run` succeeds, use the returned `workflow_run_path` as the actual filesystem folder for all artifacts in this run. This is a per-request folder such as `research/obsidian-ai-systems-20260515-152650`.

For workflow tool inputs, keep artifact fields in the contract form such as `research/findings/R1.yaml` and `research/final-report.html`. On disk, create those files under `workflow_run_path` by removing the leading `research/`. For example, `research/final-report.html` is written at the returned `workflow_report_path`.

When calling `submit_final_report`, pass `artifact_path` as the returned `workflow_submit_artifact_path`, normally `research/final-report.html`.

Use the `get_run_state` tool in the `nanoclaw` namespace to determine the next required action when resuming or when uncertain.

Use only the next tool named by `run_state.allowed_next_tool`, called from the `nanoclaw` namespace, except that `describe_workflow_capabilities` and `get_run_state` in the `nanoclaw` namespace may be called at any time.

Never call a later workflow tool before the current gate passes.

Do not produce the final answer until the `final_audit` tool in the `nanoclaw` namespace returns:

- `ok: true`
- `allowed_to_answer_user: true`

If a workflow tool rejects a step, correct the missing fields or complete the required earlier step. Do not bypass the tool.

After `final_audit` returns `ok: true` and `allowed_to_answer_user: true`, call `mcp__nanoclaw__send_file` with `path` set to the returned `workflow_report_path` and a short `text` caption. Use a final-response file directive such as `<file path="research/<run-slug>/final-report.html" text="HTML report." />` only if `mcp__nanoclaw__send_file` is unavailable.

## Non-negotiable workflow

When this skill is invoked, follow this workflow in order. Do not skip directly to the final answer unless the user explicitly asks for a quick answer.

1. Restate the research question.
2. Define the exact deliverable.
3. Create a visible research task list.
4. Split the work into independent sub-questions.
5. Decide whether to use subagents or sequential passes.
6. Execute every task in the task list.
7. Update task statuses as work completes.
8. Reconcile contradictions, uncertainty, and duplicate findings.
9. Produce one synthesized final report.

Before writing the final report, verify that every task is marked `done`, `blocked`, or `skipped with reason`.

## Deliverable contract

At the start, define:

- Audience:
- Final format:
- Depth:
- Source requirements:
- Time horizon:
- Key comparison dimensions:
- What would count as “done”:

If the user does not specify these, infer reasonable defaults and state them briefly.

## Output mode priority

Default mode is `human_report`.

In `human_report` mode:
- Final format is HTML.
- Workflow artifact is `research/final-report.html`.
- Actual file path is the `workflow_report_path` returned by `initialize_run`.
- Markdown is not allowed.

In `printable` mode:
- Generate HTML first.
- Then generate PDF.

In `skill_handoff` mode:
- Markdown is allowed.
- Final artifact is `research/handoff.md`.

If two instructions conflict, the deliverable contract recorded by `set_deliverable_contract` wins.

## Research task list protocol

Always create a task list before researching.

Use this format:

| ID | Task | Mode | Status | Expected output |
|---|---|---|---|---|
| R1 | Map the topic and define scope | main | todo | Scope, definitions, exclusions |
| R2 | Collect high-quality sources | subagent or sequential | todo | Source list with notes |
| R3 | Compare major viewpoints/options | subagent or sequential | todo | Comparison matrix |
| R4 | Check contradictions and weak evidence | subagent or sequential | todo | Caveats and confidence |
| R5 | Synthesize final answer | main | todo | Final report |

Statuses are: `todo`, `running`, `done`, `blocked`, `skipped`.

During the work, update the task list whenever a task is completed or a new follow-up task is discovered.

## Codex subagent rule

If running in Codex and the task has 2 or more independent slices, explicitly use subagents.

Use this pattern:

“Spawn N subagents, one per task below. Give each subagent only its assigned task. Wait for all subagents to finish. Each subagent must return the required output schema. Then synthesize the results in the main thread.”

Prefer 2–5 subagents.

Good subagent roles:

- Source mapper
- Timeline builder
- Comparative analyst
- Skeptical fact-checker
- Counterargument reviewer
- Recommendation analyst
- Evidence quality reviewer

Do not use subagents for tiny tasks, single-source summaries, or questions that require one continuous chain of reasoning.

If subagents are unavailable, perform the same tasks sequentially and label them as sequential research passes. Do not claim that subagents were used unless actual Codex subagent threads were spawned.

## Subagent prompt template

Each subagent must receive:

- Narrow task:
- In scope:
- Out of scope:
- Required sources:
- Required output format:
- Confidence standard:
- Stop condition:

Each subagent must return:

```md
## Task ID

## Bottom line

## Key findings

## Evidence table

| Claim | Evidence | Source | Confidence |
|---|---|---|---|

## Contradictions or uncertainty

## What the main agent should use

## What the main agent should ignore
```

Subagents should not write the final report. The main agent owns synthesis.

## Source rules

Use high-quality sources first:

1. Primary sources
2. Official documentation
3. Peer-reviewed or technical sources
4. Reputable industry analysis
5. Credible journalism
6. Community sources only when clearly labeled as anecdotal

For live, recent, legal, medical, financial, product, API, or policy information, verify with current sources.

Separate:

- Verified facts
- Source claims
- Inferences
- Recommendations
- Open uncertainties

## Conflict reconciliation

When sources disagree:

1. Identify the disagreement.
2. Compare source quality, date, incentives, and specificity.
3. Prefer primary/current/specific sources over secondary/older/general sources.
4. Explain why one source is stronger.
5. Preserve uncertainty if the evidence is genuinely mixed.

## Final report format

Default to HTML for normal human-readable deep research reports. Use Markdown only for `skill_handoff` mode or when the deliverable contract explicitly allows it.

The final report must include:

1. Title
2. Executive summary
3. Answer or recommendation
4. Key findings
5. Evidence and analysis
6. Comparison table if relevant
7. Contradictions, caveats, and uncertainty
8. Source list
9. Appendix if useful

Keep the final report decisive. Say what matters, what is uncertain, and what the next best step is.

## Codex todo-list iteration mode

When running in a Codex repo or workspace and the user asks for a durable research process, create:

```txt
research/<run-slug>/
  tasks.yaml
  sources.yaml
  findings/
    R1.yaml
    R2.yaml
    R3.yaml
  final-report.html
```

Use the `workflow_run_path` returned by `initialize_run` as the source folder for this run.

When workflow tools are available, use the state tools as the source of truth for workflow completion. Only a successful tool result may advance `run_state.yaml` or task status in `tasks.yaml` inside `workflow_run_path`.

Do not use research/TODO.md unless the skill is operating in skill-handoff mode and another skill explicitly expects Markdown.

### Task schema

Use this YAML structure:

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
    mode: subagent
    status: todo
    expected_output: Source list with notes
    output_artifact: research/findings/R2.yaml

  - id: R3
    task: Compare major viewpoints or options
    mode: subagent
    status: todo
    expected_output: Comparison matrix
    output_artifact: research/findings/R3.yaml

  - id: R4
    task: Check contradictions and weak evidence
    mode: subagent
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

Statuses are:

```
todo
running
done
blocked
skipped
```

Use this loop:

1. Read the `tasks.yaml` inside `workflow_run_path`.
2. Pick the next `todo` task.
3. Mark it `running`.
4. Execute it directly or delegate it to a subagent.
5. Save the result in the task’s `output_artifact`.
6. Mark the task `done`, `blocked`, or `skipped`.
7. Add follow-up tasks for conflicts, missing evidence, or unanswered questions.
8. Continue until no `todo` or `running` tasks remain.
9. Write the final report at `workflow_report_path`.

Never leave unfinished tasks without a reason.

## Format guardrails

Before producing the final deliverable, check the output mode.

Use this decision tree:

1. Is this output intended for a human reader?
   - Yes: use HTML.
   - No: continue.

2. Did the user explicitly ask for PDF or printable output?
   - Yes: produce HTML first, then PDF.
   - No: continue.

3. Is this skill being used to support another skill or downstream agent workflow?
   - Yes: Markdown is allowed.
   - No: Markdown is not allowed.

4. Has the user explicitly requested Markdown?
   - Yes: Markdown is allowed.
   - No: do not use Markdown.

For normal deep research, the final artifact must be:
```txt
workflow_report_path
```

not:
```txt
workflow_run_path/final-report.md
```

## Output modes

This skill has three output modes.

### 1. Human report mode

This is the default mode.

Use HTML for all human-readable final deliverables unless the user explicitly requests another format.

Default final artifact:

```txt
research/final-report.html
```

The HTML report must include:

- Title
- Executive summary
- Answer or recommendation
- Key findings
- Evidence and analysis
- Comparison table if relevant
- Contradictions, caveats, and uncertainty
- Source list
- Appendix if useful

The HTML must be readable as a standalone document and suitable for sharing as an attachment.

Do not produce a Markdown final report in human report mode.

### 2. Printable mode

Use PDF only when the user explicitly asks for:

- PDF
- printable report
- formal report packet
- client-ready PDF
- attachment intended for printing

When producing PDF, generate the HTML report first, then convert or render it to PDF.

Default printable artifacts:

```
research/final-report.html
research/final-report.pdf
```

### 3. Skill-handoff mode

Use Markdown only when this skill is being used to support another skill, agent, or downstream workflow.

Examples:

- Another skill asks for research notes.
- The user asks this skill to prepare context for another skill.
- The output is intended for a coding, writing, planning, or analysis skill to consume.
- The output is an intermediate handoff, not the final human-readable deliverable.

Default skill-handoff artifact:

```
research/handoff.md
```

Markdown handoff output should be concise, structured, and optimized for downstream agent use.

Do not use Markdown merely because it is easier. Markdown is reserved for skill-handoff mode.
