import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  addFollowupTasks,
  completeTask,
  createTaskPlan,
  describeWorkflowCapabilities,
  finalAudit,
  getRunState,
  initializeRun,
  recordReconciliation,
  setDeliverableContract,
  setExecutionMode,
  setSubquestions,
  startTask,
  submitFinalReport,
  type SetDeliverableContractInput,
} from './tools.js';
import { finalAuditPath, readRunState, readTasksFile, runStatePath } from './storage.js';
import type { TaskRecord, WorkflowContext } from './models.js';

let tempDir: string;
let context: WorkflowContext;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-workflow-tools-'));
  context = { rootDir: tempDir, now: new Date('2026-05-15T00:00:00.000Z') };
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function initialize() {
  return initializeRun(
    {
      original_user_request: 'Compare current approaches to workflow verification for deep research skills.',
      restated_research_question:
        'What tool-enforced workflow should ensure a deep-research skill completes required steps in order?',
      quick_answer_requested: false,
    },
    context,
  );
}

function deliverableInput(overrides: Partial<SetDeliverableContractInput> = {}): SetDeliverableContractInput {
  return {
    run_id: readRunState(context).run_id,
    audience: 'technical implementer',
    final_format: 'html',
    output_mode: 'human_report',
    depth: 'deep',
    source_requirements: 'Use primary and official sources first.',
    time_horizon: 'current',
    key_comparison_dimensions: ['enforcement strength', 'implementation complexity', 'auditability'],
    done_criteria: ['all workflow gates pass', 'all tasks are closed', 'final report exists'],
    markdown_allowed_reason: null,
    ...overrides,
  };
}

function sampleTasks(): TaskRecord[] {
  return [
    {
      id: 'R1',
      task: 'Map the topic and define scope',
      mode: 'main',
      status: 'todo',
      expected_output: 'Scope, definitions, exclusions',
      output_artifact: 'research/findings/R1.yaml',
    },
    {
      id: 'R2',
      task: 'Collect high-quality sources',
      mode: 'sequential',
      status: 'todo',
      expected_output: 'Source list with notes',
      output_artifact: 'research/findings/R2.yaml',
    },
    {
      id: 'R3',
      task: 'Compare major viewpoints or options',
      mode: 'sequential',
      status: 'todo',
      expected_output: 'Comparison matrix',
      output_artifact: 'research/findings/R3.yaml',
    },
    {
      id: 'R4',
      task: 'Check contradictions and weak evidence',
      mode: 'sequential',
      status: 'todo',
      expected_output: 'Caveats and confidence',
      output_artifact: 'research/findings/R4.yaml',
    },
    {
      id: 'R5',
      task: 'Synthesize final answer',
      mode: 'main',
      status: 'todo',
      expected_output: 'Final standalone HTML report',
      output_artifact: 'research/final-report.html',
    },
  ];
}

function createArtifact(relativePath: string) {
  const target = path.join(tempDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ ok: true }), 'utf8');
}

function coreSections() {
  return [
    'title',
    'executive_summary',
    'answer_or_recommendation',
    'key_findings',
    'evidence_and_analysis',
    'contradictions_caveats_uncertainty',
    'source_list',
  ];
}

function advanceToTaskExecution() {
  const runId = advanceToSubquestions();
  expect(
    setExecutionMode(
      {
        run_id: runId,
        execution_mode: 'sequential_passes',
        reason: 'The reference workflow should be tested deterministically in task order.',
        subagent_count: 0,
        subagent_roles: [],
        verified_subagent_job_ids: [],
      },
      context,
    ).ok,
  ).toBe(true);
  return runId;
}

function advanceToSubquestions() {
  expect(initialize().ok).toBe(true);
  expect(setDeliverableContract(deliverableInput(), context).ok).toBe(true);
  const runId = readRunState(context).run_id;
  expect(createTaskPlan({ run_id: runId, tasks: sampleTasks() }, context).ok).toBe(true);
  expect(
    setSubquestions(
      {
        run_id: runId,
        subquestions: [
          {
            subquestion: 'How should the workflow define scope and source collection before research starts?',
            task_ids: ['R1', 'R2'],
            independence_reason: 'Scope and source mapping can be assessed before comparison.',
          },
          {
            subquestion: 'How should comparison and weak-evidence checks be verified before synthesis?',
            task_ids: ['R3', 'R4'],
            independence_reason: 'Comparison and evidence checks can be validated independently.',
          },
        ],
      },
      context,
    ).ok,
  ).toBe(true);
  return runId;
}

function closeAllTasks(runId: string) {
  for (const task of sampleTasks()) {
    expect(startTask({ run_id: runId, task_id: task.id }, context).ok).toBe(true);
    if (task.id !== 'R5') createArtifact(task.output_artifact);
    expect(
      completeTask(
        {
          run_id: runId,
          task_id: task.id,
          status: 'done',
          summary: `${task.id} completed with evidence.`,
          output_artifact: task.output_artifact,
          reason_if_not_done: null,
          evidence_count: 1,
          new_followup_tasks: [],
        },
        context,
      ).ok,
    ).toBe(true);
  }
}

describe('deep research workflow tools', () => {
  it('describe_workflow_capabilities and get_run_state do not mutate state', () => {
    const describe = describeWorkflowCapabilities(context);
    expect(describe.ok).toBe(true);
    expect(describe.workflow_name).toBe('deep_research_workflow');
    expect(describe.tool_names).toContain('final_audit');
    expect(fs.existsSync(path.join(tempDir, 'research'))).toBe(false);

    const state = getRunState({ run_id: null }, context);
    expect(state.ok).toBe(true);
    expect(state.current_state).toBe('not_started');
    expect(fs.existsSync(path.join(tempDir, 'research'))).toBe(false);
  });

  it('passes a complete human-report happy path and writes final audit', () => {
    const runId = advanceToTaskExecution();
    closeAllTasks(runId);

    const reconciliation = recordReconciliation(
      {
        run_id: runId,
        contradictions_checked: true,
        duplicates_checked: true,
        weak_evidence_checked: true,
        uncertainty_checked: true,
        conflicts: [],
        no_conflicts_reason: 'The fixture run has no conflicting findings.',
      },
      context,
    );
    expect(reconciliation.ok).toBe(true);

    createArtifact('research/final-report.html');
    const submit = submitFinalReport(
      {
        run_id: runId,
        artifact_path: 'research/final-report.html',
        format: 'html',
        included_sections: coreSections(),
      },
      context,
    );
    expect(submit.ok).toBe(true);

    const audit = finalAudit({ run_id: runId }, context);
    expect(audit.ok).toBe(true);
    expect(audit.allowed_to_answer_user).toBe(true);
    expect(readRunState(context).current_state).toBe('audit_passed');
    expect(JSON.parse(fs.readFileSync(finalAuditPath(context), 'utf8'))).toMatchObject({
      ok: true,
      allowed_to_answer_user: true,
    });
  });

  it('rejects an out-of-order final report without mutating durable state', () => {
    expect(initialize().ok).toBe(true);
    const before = fs.readFileSync(runStatePath(context), 'utf8');
    const runId = readRunState(context).run_id;

    const result = submitFinalReport(
      {
        run_id: runId,
        artifact_path: 'research/final-report.html',
        format: 'html',
        included_sections: coreSections(),
      },
      context,
    );

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('Expected set_deliverable_contract');
    expect(fs.readFileSync(runStatePath(context), 'utf8')).toBe(before);
    expect(readRunState(context).current_state).toBe('initialized');
  });

  it('rejects a task plan before the deliverable contract is set', () => {
    expect(initialize().ok).toBe(true);
    const runId = readRunState(context).run_id;

    const result = createTaskPlan({ run_id: runId, tasks: sampleTasks() }, context);

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('Expected set_deliverable_contract');
    expect(readRunState(context).current_state).toBe('initialized');
    expect(fs.existsSync(path.join(tempDir, 'research', 'tasks.yaml'))).toBe(false);
  });

  it('rejects invalid plans and leaves state unchanged', () => {
    expect(initialize().ok).toBe(true);
    expect(setDeliverableContract(deliverableInput(), context).ok).toBe(true);
    const before = fs.readFileSync(runStatePath(context), 'utf8');
    const runId = readRunState(context).run_id;
    const invalid = sampleTasks();
    invalid[1] = { ...invalid[0], task: 'Duplicate ID task', output_artifact: '' };

    const result = createTaskPlan({ run_id: runId, tasks: invalid }, context);

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining(['Duplicate task ID: R1.', 'Task at index 1 is missing output_artifact.']),
    );
    expect(fs.readFileSync(runStatePath(context), 'utf8')).toBe(before);
  });

  it('prevents false subagent claims without verified job IDs', () => {
    const runId = advanceToSubquestions();
    const before = fs.readFileSync(runStatePath(context), 'utf8');

    const result = setExecutionMode(
      {
        run_id: runId,
        execution_mode: 'subagents',
        reason: 'Independent work slices.',
        subagent_count: 2,
        subagent_roles: ['Source mapper', 'Evidence reviewer'],
        verified_subagent_job_ids: [],
      },
      context,
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Subagent mode requires verified_subagent_job_ids for every claimed subagent.');
    expect(fs.readFileSync(runStatePath(context), 'utf8')).toBe(before);
  });

  it('rejects invalid task lifecycle calls', () => {
    const runId = advanceToTaskExecution();

    expect(
      completeTask(
        {
          run_id: runId,
          task_id: 'R1',
          status: 'done',
          summary: 'Premature completion.',
          output_artifact: 'research/findings/R1.yaml',
          reason_if_not_done: null,
          evidence_count: 1,
          new_followup_tasks: [],
        },
        context,
      ).errors[0],
    ).toContain('Expected start_task');

    expect(startTask({ run_id: runId, task_id: 'R1' }, context).ok).toBe(true);
    const beforeTasks = fs.readFileSync(path.join(tempDir, 'research', 'tasks.yaml'), 'utf8');

    const missingArtifact = completeTask(
      {
        run_id: runId,
        task_id: 'R1',
        status: 'done',
        summary: 'No artifact.',
        output_artifact: 'research/findings/R1.yaml',
        reason_if_not_done: null,
        evidence_count: 1,
        new_followup_tasks: [],
      },
      context,
    );
    expect(missingArtifact.ok).toBe(false);
    expect(missingArtifact.errors[0]).toContain('Task output artifact does not exist');
    expect(fs.readFileSync(path.join(tempDir, 'research', 'tasks.yaml'), 'utf8')).toBe(beforeTasks);

    const missingReason = completeTask(
      {
        run_id: runId,
        task_id: 'R1',
        status: 'blocked',
        summary: 'Blocked.',
        output_artifact: null,
        reason_if_not_done: null,
        evidence_count: 0,
        new_followup_tasks: [],
      },
      context,
    );
    expect(missingReason.ok).toBe(false);
    expect(missingReason.errors).toContain('reason_if_not_done is required when status is blocked.');
  });

  it('safely appends follow-up tasks during execution', () => {
    const runId = advanceToTaskExecution();
    expect(startTask({ run_id: runId, task_id: 'R1' }, context).ok).toBe(true);

    const result = addFollowupTasks(
      {
        run_id: runId,
        parent_task_id: 'R1',
        tasks: [
          {
            id: 'R6',
            task: 'Resolve conflicting implementation details',
            mode: 'sequential',
            status: 'todo',
            expected_output: 'Resolved estimate with caveats',
            output_artifact: 'research/findings/R6.yaml',
          },
        ],
      },
      context,
    );

    expect(result.ok).toBe(true);
    expect(readTasksFile(context).tasks.map((task) => task.id)).toContain('R6');
  });

  it('rejects reconciliation before all tasks are closed', () => {
    const runId = advanceToTaskExecution();
    expect(startTask({ run_id: runId, task_id: 'R1' }, context).ok).toBe(true);

    const result = recordReconciliation(
      {
        run_id: runId,
        contradictions_checked: true,
        duplicates_checked: true,
        weak_evidence_checked: true,
        uncertainty_checked: true,
        conflicts: [],
        no_conflicts_reason: 'No conflicts.',
      },
      context,
    );

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('Expected complete_task|start_task|add_followup_tasks');
  });

  it('rejects Markdown in human-report mode', () => {
    expect(initialize().ok).toBe(true);
    const result = setDeliverableContract(
      deliverableInput({
        output_mode: 'human_report',
        final_format: 'markdown_handoff',
        markdown_allowed_reason: 'User asked for Markdown.',
      }),
      context,
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('human_report mode rejects markdown_handoff final_format.');
    expect(readRunState(context).current_state).toBe('initialized');
  });
});
