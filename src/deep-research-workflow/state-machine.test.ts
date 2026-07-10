import { describe, expect, it } from 'vitest';

import {
  defaultGates,
  emptyTaskSummary,
  gatesForState,
  SCHEMA_VERSION,
  WORKFLOW_NAME,
  WORKFLOW_VERSION,
  type ExecutionModeSelection,
  type RunState,
  type TaskFile,
} from './models.js';
import {
  allTasksClosed,
  deriveAllowedNextTools,
  markTaskCompleted,
  markTaskStarted,
  outOfOrderErrors,
  stateAllowedTools,
  validateTaskCompletion,
  validateTaskStart,
} from './state-machine.js';

function runState(current_state: RunState['current_state'], execution?: ExecutionModeSelection): RunState {
  const allowed_next_tools = deriveAllowedNextTools(current_state);
  return {
    schema_version: SCHEMA_VERSION,
    workflow_name: WORKFLOW_NAME,
    workflow_version: WORKFLOW_VERSION,
    run_id: 'dr_test_001',
    current_state,
    allowed_next_tool: allowed_next_tools.join('|') || null,
    allowed_next_tools,
    original_user_request: 'Compare workflow verification approaches.',
    restated_research_question: 'What tool-enforced gates should deep research use?',
    quick_answer_requested: false,
    task_summary: emptyTaskSummary(),
    execution,
    gates: current_state === 'not_started' ? defaultGates() : gatesForState(current_state),
    created_at: '2026-05-15T00:00:00.000Z',
    updated_at: '2026-05-15T00:00:00.000Z',
  };
}

function tasksFile(): TaskFile {
  return {
    tasks: [
      {
        id: 'R1',
        task: 'Map the topic and define scope',
        mode: 'main',
        status: 'todo',
        expected_output: 'Scope',
        output_artifact: 'research/findings/R1.yaml',
      },
      {
        id: 'R2',
        task: 'Collect high-quality sources',
        mode: 'sequential',
        status: 'todo',
        expected_output: 'Sources',
        output_artifact: 'research/findings/R2.yaml',
      },
      {
        id: 'R3',
        task: 'Compare major viewpoints or options',
        mode: 'sequential',
        status: 'todo',
        expected_output: 'Comparison',
        output_artifact: 'research/findings/R3.yaml',
      },
    ],
  };
}

describe('deep research workflow state machine', () => {
  it('defines the allowed mutating tool for every ordered state', () => {
    expect(stateAllowedTools).toMatchObject({
      not_started: ['initialize_run'],
      initialized: ['set_deliverable_contract'],
      deliverable_defined: ['create_task_plan'],
      task_plan_created: ['set_subquestions'],
      subquestions_defined: ['set_execution_mode'],
      execution_mode_selected: ['start_task'],
      tasks_closed: ['record_reconciliation'],
      reconciliation_complete: ['submit_final_report'],
      final_report_submitted: ['final_audit'],
      audit_passed: [],
    });
  });

  it('rejects out-of-order calls with the expected next tool', () => {
    expect(outOfOrderErrors('deliverable_defined', 'submit_final_report')).toEqual([
      'Out-of-order tool call. Expected create_task_plan because current_state is deliverable_defined; got submit_final_report.',
    ]);
    expect(outOfOrderErrors('deliverable_defined', 'create_task_plan')).toEqual([]);
  });

  it('prevents starting a later task before the first todo task in strict sequential mode', () => {
    const state = runState('execution_mode_selected', {
      execution_mode: 'sequential_passes',
      reason: 'Tasks depend on ordered synthesis.',
      subagent_count: 0,
      subagent_roles: [],
      verified_subagent_job_ids: [],
      strict_sequential_task_mode: true,
      verified_subagent_mode: false,
    });

    expect(validateTaskStart(state, tasksFile(), 'R3')).toEqual([
      'Strict sequential task mode requires starting R1 before R3.',
    ]);
  });

  it('prevents multiple running tasks without verified subagent mode', () => {
    const state = runState('tasks_in_progress', {
      execution_mode: 'sequential_passes',
      reason: 'Sequential verification.',
      subagent_count: 0,
      subagent_roles: [],
      verified_subagent_job_ids: [],
      strict_sequential_task_mode: false,
      verified_subagent_mode: false,
    });
    const taskFile = markTaskStarted(state, tasksFile(), 'R1', '2026-05-15T00:00:00.000Z').taskFile;

    expect(validateTaskStart({ ...state, current_state: 'tasks_in_progress' }, taskFile, 'R2')).toEqual([
      'Cannot start R2 while R1 is running.',
    ]);
  });

  it('allows multiple running tasks only for verified subagent mode', () => {
    const state = runState('tasks_in_progress', {
      execution_mode: 'subagents',
      reason: 'Independent work slices.',
      subagent_count: 2,
      subagent_roles: ['Source mapper', 'Evidence checker'],
      verified_subagent_job_ids: ['agent-1', 'agent-2'],
      strict_sequential_task_mode: false,
      verified_subagent_mode: true,
    });
    const taskFile = markTaskStarted(state, tasksFile(), 'R1', '2026-05-15T00:00:00.000Z').taskFile;

    expect(validateTaskStart(state, taskFile, 'R2')).toEqual([]);
  });

  it('moves to tasks_closed only after every task is closed', () => {
    const state = runState('tasks_in_progress');
    const started = markTaskStarted(state, { tasks: [tasksFile().tasks[0]] }, 'R1', '2026-05-15T00:00:00.000Z');

    expect(validateTaskCompletion(started.state, started.taskFile, 'R1', 'done')).toEqual([]);

    const completed = markTaskCompleted(started.state, started.taskFile, 'R1', 'done', '2026-05-15T00:01:00.000Z', {
      summary: 'Scoped.',
      reason_if_not_done: null,
      evidence_count: 1,
    });

    expect(allTasksClosed(completed.taskFile.tasks)).toBe(true);
    expect(completed.state.current_state).toBe('tasks_closed');
    expect(completed.state.allowed_next_tool).toBe('record_reconciliation');
  });
});
