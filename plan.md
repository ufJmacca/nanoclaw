# PLAN: Expose Deep Research Workflow Tools Inside NanoClaw Agent Containers

This plan is intended to be used with Codex CLI `/goal`.

Suggested invocation:

```txt
/goal Implement plan.md. Work milestone by milestone, add or update focused tests for each code change, restart the NanoClaw v2 service/container, and stop only when the acceptance checklist passes from inside a running Telegram agent container.
```

## 0. Current Problem

The host repository now contains the deep-research workflow implementation under:

```txt
src/deep-research-workflow/
```

The Telegram agent container has the updated skill mounted at:

```txt
/app/skills/deep-research/SKILL.md
```

However, the running Telegram container does not have the workflow implementation or callable workflow tools:

```txt
/app/src/deep-research-workflow                  # missing
/workspace/agent/src/deep-research-workflow      # missing
/workspace/agent/package.json                    # missing
```

Running this inside the container fails because `/workspace/agent` is not the host Node package:

```sh
pnpm deep-research-workflow -- describe-capabilities
```

The container MCP server currently registers NanoClaw tools such as `send_message`, `send_file`, scheduling, interactive, agents, and self-mod tools. It does not register the deep-research workflow tools. As a result, the deep-research skill can read the new instructions but cannot actually call the enforcement tools, so recent research folders such as:

```txt
groups/cli-with-pi/research/genai-techniques-week
```

can contain `tasks.yaml`, `sources.yaml`, and `final-report.html` but no tool-generated:

```txt
research/run_state.yaml
research/subquestions.yaml
research/reconciliation.yaml
research/final-audit.json
```

## 1. Goal

Expose the existing deep-research workflow tools to agents running inside NanoClaw Telegram containers as MCP tools.

The agent must be able to call these tools during a deep-research task:

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

The tools must persist their durable workflow state relative to the agent workspace:

```txt
/workspace/agent/research
```

On the host, that maps to:

```txt
groups/<agent-folder>/research
```

For the current Telegram channel, the host path is:

```txt
groups/cli-with-pi/research
```

## 2. Non-Goals

Do not reimplement the deep-research state machine in the container.

Do not depend on the host package CLI being present inside `/workspace/agent`.

Do not ask the model to self-report that tools were used. Tool use must be verifiable from files written by the workflow implementation.

Do not make a broad container image dependency change unless it is required. The current workflow implementation only needs filesystem/path functionality and should run under the existing Bun container runtime.

## 3. Preferred Implementation

Prefer sharing the existing implementation instead of duplicating logic.

### 3.1 Mount The Host Workflow Module Into Containers

Update `src/container-runner.ts` so `buildMounts()` mounts:

```txt
src/deep-research-workflow  ->  /app/deep-research-workflow  readonly
```

This is analogous to the existing source-only mounts:

```txt
container/agent-runner/src  ->  /app/src
container/skills           ->  /app/skills
```

The Dockerfile already states that source is mounted at runtime and source-only changes do not require image rebuilds. This workflow mount should follow that pattern.

### 3.2 Add A Container MCP Adapter

Add a new container-side MCP tool module:

```txt
container/agent-runner/src/mcp-tools/deep-research-workflow.ts
```

This module should:

1. Dynamically load the shared workflow module from `/app/deep-research-workflow/index.ts` inside containers.
2. Support a test fallback path that loads `src/deep-research-workflow/index.ts` from the repo when running local tests.
3. Read `TOOL_SCHEMAS` and `deepResearchWorkflowTools` from the shared implementation.
4. Convert each workflow schema into an MCP tool definition:

```ts
{
  name: schema.name,
  description: schema.description,
  inputSchema: schema.parameters
}
```

5. Register all workflow tools via the existing `registerTools([...])` pattern.
6. Call the underlying workflow function with a context root of `/workspace/agent` by default.
7. Allow tests to override the root with an environment variable such as:

```txt
DEEP_RESEARCH_WORKFLOW_ROOT
```

The adapter should return tool results as formatted JSON text through MCP:

```ts
{
  content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  isError: !result.ok
}
```

Use the existing MCP code style in:

```txt
container/agent-runner/src/mcp-tools/core.ts
container/agent-runner/src/mcp-tools/server.ts
```

### 3.3 Register The Adapter

Update:

```txt
container/agent-runner/src/mcp-tools/index.ts
```

to import the new module for side effects:

```ts
import './deep-research-workflow.js';
```

The MCP server startup log should then include the deep-research workflow tool names.

### 3.4 Preserve State-Machine Enforcement

The adapter must not bypass or soften the existing state machine.

Out-of-order calls must still fail.

Failed mutating calls must not update durable state.

The final answer is only permitted when `final_audit` returns:

```json
{
  "ok": true,
  "allowed_to_answer_user": true
}
```

### 3.5 Workspace Persistence

All workflow tools must use this root inside a running agent container:

```txt
/workspace/agent
```

Therefore the canonical artifacts for a Telegram run are:

```txt
/workspace/agent/research/run_state.yaml
/workspace/agent/research/tasks.yaml
/workspace/agent/research/subquestions.yaml
/workspace/agent/research/reconciliation.yaml
/workspace/agent/research/final-audit.json
```

On the host, for the current Telegram channel:

```txt
/home/pi/nanoclaw-v2/groups/cli-with-pi/research/run_state.yaml
/home/pi/nanoclaw-v2/groups/cli-with-pi/research/tasks.yaml
/home/pi/nanoclaw-v2/groups/cli-with-pi/research/subquestions.yaml
/home/pi/nanoclaw-v2/groups/cli-with-pi/research/reconciliation.yaml
/home/pi/nanoclaw-v2/groups/cli-with-pi/research/final-audit.json
```

## 4. Tests

Add focused tests. Keep them small and tied to the integration layer.

### 4.1 Host Workflow Tests

Keep the existing tests passing:

```sh
pnpm exec vitest run src/deep-research-workflow
```

### 4.2 Container MCP Adapter Tests

Add Bun tests under:

```txt
container/agent-runner/src/mcp-tools/deep-research-workflow.test.ts
```

The tests should verify:

1. The adapter builds/registers all expected tool names.
2. `initialize_run` can be called through the MCP handler.
3. The call writes `research/run_state.yaml` under a temporary `DEEP_RESEARCH_WORKFLOW_ROOT`.
4. A deliberately out-of-order call, such as `submit_final_report` before task planning, returns `isError: true` and does not advance state.

Run:

```sh
cd container/agent-runner && bun test src/mcp-tools/deep-research-workflow.test.ts
```

If the full container test suite is reasonably quick, also run:

```sh
cd container/agent-runner && bun test
```

### 4.3 Repo Tests

Run the relevant repo test suite:

```sh
pnpm test
```

If full tests are too slow or blocked by environment constraints, document the exact command attempted and the failure reason.

## 5. Documentation

Update:

```txt
docs/deep-research-workflow-tools.md
```

Add a section explaining:

- The workflow tools are available inside NanoClaw agent containers as MCP tools.
- The shared implementation is mounted at `/app/deep-research-workflow`.
- The tools write artifacts under `/workspace/agent/research`.
- For the current Telegram `cli-with-pi` group, host artifacts are under `groups/cli-with-pi/research`.
- The absence of `run_state.yaml` and `final-audit.json` means a research run was not tool-gated to completion.

## 6. Runtime Verification

After implementing and testing:

1. Restart the NanoClaw v2 service:

```sh
systemctl --user restart nanoclaw-v2-c17b68a9.service
```

2. Trigger or reuse a Telegram agent container.

3. Confirm the running container:

```sh
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' | grep nanoclaw
```

4. Verify the workflow module is mounted:

```sh
docker exec <container-name> bash -lc 'ls -la /app/deep-research-workflow && ls -la /app/src/mcp-tools/deep-research-workflow.ts'
```

5. Verify tool registration from the container-side adapter. The adapter should export a testable builder or list helper so this can be checked without speaking full MCP over stdio, for example:

```sh
docker exec <container-name> bash -lc 'bun -e "
  const m = await import(\"/app/src/mcp-tools/deep-research-workflow.ts\");
  const tools = await m.buildDeepResearchWorkflowMcpTools();
  console.log(tools.map(t => t.tool.name).sort().join(\"\\n\"));
"'
```

The output must include:

```txt
initialize_run
set_deliverable_contract
create_task_plan
final_audit
```

6. Smoke-test `initialize_run` from inside the container through the adapter:

```sh
docker exec <container-name> bash -lc 'rm -rf /workspace/agent/research/tool-smoke && mkdir -p /workspace/agent/research/tool-smoke && DEEP_RESEARCH_WORKFLOW_ROOT=/workspace/agent/research/tool-smoke bun -e "
  const m = await import(\"/app/src/mcp-tools/deep-research-workflow.ts\");
  const tools = await m.buildDeepResearchWorkflowMcpTools();
  const init = tools.find(t => t.tool.name === \"initialize_run\");
  const result = await init.handler({
    original_user_request: \"Research whether the deep-research workflow tools are available in the Telegram container.\",
    restated_research_question: \"Are the deep-research workflow tools callable from inside the Telegram NanoClaw agent container?\",
    quick_answer_requested: false
  });
  console.log(result.content[0].text);
" && test -f /workspace/agent/research/tool-smoke/research/run_state.yaml && cat /workspace/agent/research/tool-smoke/research/run_state.yaml'
```

The returned JSON should contain:

```json
{
  "ok": true,
  "current_state": "initialized",
  "allowed_next_tool": "set_deliverable_contract"
}
```

## 7. Acceptance Checklist

- [ ] `src/deep-research-workflow` is mounted into agent containers at `/app/deep-research-workflow`.
- [ ] `container/agent-runner/src/mcp-tools/deep-research-workflow.ts` registers all workflow tools.
- [ ] `container/agent-runner/src/mcp-tools/index.ts` imports the new module.
- [ ] Workflow tool handlers use `/workspace/agent` as the default root.
- [ ] Tests prove the adapter can call `initialize_run` and write `research/run_state.yaml`.
- [ ] Tests prove an out-of-order workflow call fails without advancing state.
- [ ] Docs explain the container MCP availability and artifact paths.
- [ ] A running Telegram agent container can list the workflow tools from the adapter.
- [ ] A running Telegram agent container can call `initialize_run` and create `run_state.yaml`.
- [ ] A completed deep-research run can produce `research/final-audit.json` with:

```json
{
  "ok": true,
  "allowed_to_answer_user": true
}
```

