import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RunState, TaskRecord, WorkflowContext } from './models.js';
import {
  completeTask,
  createTaskPlan,
  finalAudit,
  initializeRun,
  recordReconciliation,
  setDeliverableContract,
  setExecutionMode,
  setSubquestions,
  startTask,
  submitFinalReport,
} from './tools.js';
import { readRunState, readTasksFile, writeRunState, writeTasksFile } from './storage.js';

let tempDir: string;
let context: WorkflowContext;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-workflow-integration-'));
  context = { rootDir: tempDir, now: new Date('2026-05-15T00:00:00.000Z') };
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function createArtifact(relativePath: string) {
  const target = path.join(tempDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ ok: true }), 'utf8');
}

function initRun() {
  const result = initializeRun(
    {
      original_user_request: 'Compare current approaches to workflow verification for deep research skills.',
      restated_research_question:
        'What tool-enforced workflow should ensure a deep-research skill completes required steps in order?',
      quick_answer_requested: false,
    },
    context,
  );
  expect(result.ok).toBe(true);
  return result.run_id!;
}

function setDeliverable(outputMode: 'human_report' | 'printable' | 'skill_handoff' = 'human_report') {
  const runId = readRunState(context).run_id;
  const finalFormat = outputMode === 'printable' ? 'pdf' : outputMode === 'skill_handoff' ? 'markdown_handoff' : 'html';
  const result = setDeliverableContract(
    {
      run_id: runId,
      audience: 'technical implementer',
      final_format: finalFormat,
      output_mode: outputMode,
      depth: 'deep',
      source_requirements: 'Primary and official sources first.',
      time_horizon: 'current',
      key_comparison_dimensions: ['auditability', 'implementation complexity'],
      done_criteria: ['all gates pass'],
      markdown_allowed_reason: outputMode === 'skill_handoff' ? 'Skill handoff output.' : null,
    },
    context,
  );
  expect(result.ok).toBe(true);
  return runId;
}

function tasks(): TaskRecord[] {
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

function tasksForMode(outputMode: 'human_report' | 'printable' | 'skill_handoff'): TaskRecord[] {
  const taskList = tasks();
  if (outputMode === 'printable') {
    taskList[4] = {
      ...taskList[4],
      expected_output: 'Final printable PDF report after HTML is generated',
      output_artifact: 'research/final-report.pdf',
    };
  }
  if (outputMode === 'skill_handoff') {
    taskList[4] = {
      ...taskList[4],
      expected_output: 'Final Markdown handoff',
      output_artifact: 'research/handoff.md',
    };
  }
  return taskList;
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

function planAndExecuteUntilTasksClosed(outputMode: 'human_report' | 'printable' | 'skill_handoff' = 'human_report') {
  initRun();
  const runId = setDeliverable(outputMode);
  const taskList = tasksForMode(outputMode);
  expect(createTaskPlan({ run_id: runId, tasks: taskList }, context).ok).toBe(true);
  expect(
    setSubquestions(
      {
        run_id: runId,
        subquestions: [
          {
            subquestion: 'How should scope and source collection be verified?',
            task_ids: ['R1', 'R2'],
            independence_reason: 'They are prerequisite evidence gates.',
          },
          {
            subquestion: 'How should comparison and weak-evidence checks be verified?',
            task_ids: ['R3', 'R4'],
            independence_reason: 'They can be validated independently before synthesis.',
          },
        ],
      },
      context,
    ).ok,
  ).toBe(true);
  expect(
    setExecutionMode(
      {
        run_id: runId,
        execution_mode: 'sequential_passes',
        reason: 'Sequential passes keep integration tests deterministic.',
        subagent_count: 0,
        subagent_roles: [],
        verified_subagent_job_ids: [],
      },
      context,
    ).ok,
  ).toBe(true);

  for (const task of taskList) {
    expect(startTask({ run_id: runId, task_id: task.id }, context).ok).toBe(true);
    if (task.id !== 'R5') createArtifact(task.output_artifact);
    expect(
      completeTask(
        {
          run_id: runId,
          task_id: task.id,
          status: 'done',
          summary: `${task.id} completed.`,
          output_artifact: task.output_artifact,
          reason_if_not_done: null,
          evidence_count: 1,
          new_followup_tasks: [],
        },
        context,
      ).ok,
    ).toBe(true);
  }
  return runId;
}

function readyForReport(outputMode: 'human_report' | 'printable' | 'skill_handoff' = 'human_report') {
  const runId = planAndExecuteUntilTasksClosed(outputMode);
  expect(
    recordReconciliation(
      {
        run_id: runId,
        contradictions_checked: true,
        duplicates_checked: true,
        weak_evidence_checked: true,
        uncertainty_checked: true,
        conflicts: [],
        no_conflicts_reason: 'No conflicts in fixture.',
      },
      context,
    ).ok,
  ).toBe(true);
  return runId;
}

function readyForAudit() {
  const runId = readyForReport();
  createArtifact('research/final-report.html');
  expect(
    submitFinalReport(
      {
        run_id: runId,
        artifact_path: 'research/final-report.html',
        format: 'html',
        included_sections: coreSections(),
      },
      context,
    ).ok,
  ).toBe(true);
  return runId;
}

describe('deep research workflow integration rejections', () => {
  it('rejects each invalid task plan class from the plan', () => {
    initRun();
    const runId = setDeliverable();

    const cases: Array<[string, TaskRecord[], string]> = [
      [
        'duplicate IDs',
        tasks().map((task, index) => (index === 1 ? { ...task, id: 'R1' } : task)),
        'Duplicate task ID',
      ],
      [
        'missing artifact',
        tasks().map((task, index) => (index === 1 ? { ...task, output_artifact: '' } : task)),
        'missing output_artifact',
      ],
      [
        'non-todo status',
        tasks().map((task, index) => (index === 1 ? { ...task, status: 'running' } : task)),
        'must start with status todo',
      ],
      ['no source task', tasks().filter((task) => task.id !== 'R2'), 'source collection'],
      ['no reconciliation task', tasks().filter((task) => task.id !== 'R4'), 'contradiction or weak-evidence checking'],
      ['final synthesis first', [tasks()[4], ...tasks().slice(0, 4)], 'Final synthesis cannot be the first task'],
    ];

    for (const [, invalidTasks, expectedError] of cases) {
      const result = createTaskPlan({ run_id: runId, tasks: invalidTasks }, context);
      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toContain(expectedError);
      expect(readRunState(context).current_state).toBe('deliverable_defined');
    }
  });

  it('rejects invalid task starts and completions at the tool layer', () => {
    initRun();
    const runId = setDeliverable();
    expect(createTaskPlan({ run_id: runId, tasks: tasks() }, context).ok).toBe(true);
    expect(
      setSubquestions(
        {
          run_id: runId,
          subquestions: [
            {
              subquestion: 'How should scope and source collection be verified?',
              task_ids: ['R1', 'R2'],
              independence_reason: 'They are prerequisite evidence gates.',
            },
            {
              subquestion: 'How should comparison and weak-evidence checks be verified?',
              task_ids: ['R3', 'R4'],
              independence_reason: 'They can be validated independently before synthesis.',
            },
          ],
        },
        context,
      ).ok,
    ).toBe(true);
    expect(
      setExecutionMode(
        {
          run_id: runId,
          execution_mode: 'sequential_passes',
          reason: 'Sequential passes keep lifecycle tests deterministic.',
          subagent_count: 0,
          subagent_roles: [],
          verified_subagent_job_ids: [],
        },
        context,
      ).ok,
    ).toBe(true);

    expect(startTask({ run_id: runId, task_id: 'R3' }, context).errors.join('\n')).toContain(
      'Strict sequential task mode requires starting R1 before R3.',
    );
    expect(startTask({ run_id: runId, task_id: 'R1' }, context).ok).toBe(true);
    expect(startTask({ run_id: runId, task_id: 'R1' }, context).errors.join('\n')).toContain(
      'Task R1 cannot be started because status is running.',
    );
    createArtifact('research/findings/R1.yaml');
    expect(
      completeTask(
        {
          run_id: runId,
          task_id: 'R1',
          status: 'done',
          summary: 'R1 done.',
          output_artifact: 'research/findings/R1.yaml',
          reason_if_not_done: null,
          evidence_count: 1,
          new_followup_tasks: [],
        },
        context,
      ).ok,
    ).toBe(true);
    expect(startTask({ run_id: runId, task_id: 'R1' }, context).errors.join('\n')).toContain(
      'Task R1 cannot be started because status is done.',
    );
  });

  it('rejects reconciliation with false checks or no-conflict reason missing', () => {
    const runId = planAndExecuteUntilTasksClosed();

    expect(
      recordReconciliation(
        {
          run_id: runId,
          contradictions_checked: false,
          duplicates_checked: true,
          weak_evidence_checked: true,
          uncertainty_checked: true,
          conflicts: [],
          no_conflicts_reason: 'No conflicts.',
        },
        context,
      ).errors,
    ).toContain('contradictions_checked must be true.');

    expect(
      recordReconciliation(
        {
          run_id: runId,
          contradictions_checked: true,
          duplicates_checked: true,
          weak_evidence_checked: true,
          uncertainty_checked: true,
          conflicts: [],
          no_conflicts_reason: null,
        },
        context,
      ).errors,
    ).toContain('no_conflicts_reason is required when conflicts is empty.');
  });

  it('rejects final report output mode violations', () => {
    const humanRunId = readyForReport();
    expect(
      submitFinalReport(
        {
          run_id: humanRunId,
          artifact_path: 'research/final-report.html',
          format: 'html',
          included_sections: coreSections(),
        },
        context,
      ).errors.join('\n'),
    ).toContain('Final report artifact does not exist');

    createArtifact('research/final-report.html');
    expect(
      submitFinalReport(
        {
          run_id: humanRunId,
          artifact_path: 'research/final-report.html',
          format: 'html',
          included_sections: ['title'],
        },
        context,
      ).errors.join('\n'),
    ).toContain('Final report is missing required sections');
  });

  it('rejects printable PDF submission until HTML exists first', () => {
    const runId = readyForReport('printable');
    createArtifact('research/final-report.pdf');

    const result = submitFinalReport(
      {
        run_id: runId,
        artifact_path: 'research/final-report.pdf',
        format: 'pdf',
        included_sections: coreSections(),
      },
      context,
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('printable mode requires research/final-report.html before PDF submission.');
  });

  it('final_audit rejects missing reconciliation, open tasks, skipped reasons, and format mismatch', () => {
    const runId = readyForAudit();

    const missingReconciliation = readRunState(context);
    const missingReconciliationState: RunState = {
      ...missingReconciliation,
      reconciliation: undefined,
      gates: { ...missingReconciliation.gates, reconciliation_complete: false },
    };
    writeRunState(missingReconciliationState, context);
    expect(finalAudit({ run_id: runId }, context).missing_steps).toContain('record_reconciliation');

    writeRunState(missingReconciliation, context);
    const taskFile = readTasksFile(context);
    writeTasksFile(
      { ...taskFile, tasks: taskFile.tasks.map((task) => (task.id === 'R2' ? { ...task, status: 'todo' } : task)) },
      context,
    );
    expect(finalAudit({ run_id: runId }, context).open_tasks).toContain('R2');

    writeTasksFile(
      {
        ...taskFile,
        tasks: taskFile.tasks.map((task) =>
          task.id === 'R2' ? { ...task, status: 'skipped', reason_if_not_done: null } : task,
        ),
      },
      context,
    );
    expect(finalAudit({ run_id: runId }, context).format_errors).toContain(
      'Task R2 is skipped without reason_if_not_done.',
    );

    writeTasksFile(taskFile, context);
    writeRunState(
      {
        ...missingReconciliation,
        final_report: {
          artifact_path: 'research/handoff.md',
          format: 'markdown_handoff',
          included_sections: coreSections(),
        },
      },
      context,
    );
    expect(finalAudit({ run_id: runId }, context).format_errors).toEqual(
      expect.arrayContaining([
        'Final report artifact does not exist: research/handoff.md.',
        'human_report mode requires format html.',
        'human_report mode requires artifact_path research/final-report.html.',
        'Markdown final reports are not allowed in human_report mode.',
      ]),
    );
  });
});
