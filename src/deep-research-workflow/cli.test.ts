import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCli } from './cli.js';
import type { TaskRecord, WorkflowToolResult } from './models.js';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-workflow-cli-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeJson(name: string, value: unknown): string {
  const filePath = path.join(tempDir, name);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
  return filePath;
}

function createArtifact(relativePath: string) {
  const target = path.join(tempDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ ok: true }), 'utf8');
}

function cli(...args: string[]) {
  const result = runCli(args);
  return {
    ...result,
    json: JSON.parse(result.stdout) as WorkflowToolResult,
  };
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

describe('deep research workflow CLI', () => {
  it('runs a happy path from JSON files in a temporary root', () => {
    const init = cli(
      'initialize-run',
      '--root',
      tempDir,
      '--json',
      writeJson('init.json', {
        original_user_request: 'Compare workflow verification approaches for research skills.',
        restated_research_question: 'What tool-enforced gates should verify a deep research workflow?',
        quick_answer_requested: false,
      }),
    );
    expect(init.exitCode).toBe(0);
    const runId = init.json.run_id!;

    expect(
      cli(
        'set-deliverable',
        '--root',
        tempDir,
        '--json',
        writeJson('deliverable.json', {
          run_id: runId,
          audience: 'technical implementer',
          final_format: 'html',
          output_mode: 'human_report',
          depth: 'deep',
          source_requirements: 'Primary and official sources first.',
          time_horizon: 'current',
          key_comparison_dimensions: ['auditability'],
          done_criteria: ['audit passes'],
          markdown_allowed_reason: null,
        }),
      ).exitCode,
    ).toBe(0);

    expect(
      cli('create-task-plan', '--root', tempDir, '--json', writeJson('tasks.json', { run_id: runId, tasks: tasks() }))
        .exitCode,
    ).toBe(0);

    expect(
      cli(
        'set-subquestions',
        '--root',
        tempDir,
        '--json',
        writeJson('subquestions.json', {
          run_id: runId,
          subquestions: [
            {
              subquestion: 'How should scope and source collection be verified?',
              task_ids: ['R1', 'R2'],
              independence_reason: 'These gates precede comparison.',
            },
            {
              subquestion: 'How should comparison and weak-evidence checks be verified?',
              task_ids: ['R3', 'R4'],
              independence_reason: 'These gates are independent before synthesis.',
            },
          ],
        }),
      ).exitCode,
    ).toBe(0);

    expect(
      cli(
        'set-execution-mode',
        '--root',
        tempDir,
        '--json',
        writeJson('execution.json', {
          run_id: runId,
          execution_mode: 'sequential_passes',
          reason: 'Sequential passes make this CLI smoke path deterministic.',
          subagent_count: 0,
          subagent_roles: [],
          verified_subagent_job_ids: [],
        }),
      ).exitCode,
    ).toBe(0);

    for (const task of tasks()) {
      expect(cli('start-task', '--root', tempDir, '--run-id', runId, '--task-id', task.id).exitCode).toBe(0);
      if (task.id !== 'R5') createArtifact(task.output_artifact);
      expect(
        cli(
          'complete-task',
          '--root',
          tempDir,
          '--json',
          writeJson(`${task.id}.json`, {
            run_id: runId,
            task_id: task.id,
            status: 'done',
            summary: `${task.id} done.`,
            output_artifact: task.output_artifact,
            reason_if_not_done: null,
            evidence_count: 1,
            new_followup_tasks: [],
          }),
        ).exitCode,
      ).toBe(0);
    }

    expect(
      cli(
        'record-reconciliation',
        '--root',
        tempDir,
        '--json',
        writeJson('reconciliation.json', {
          run_id: runId,
          contradictions_checked: true,
          duplicates_checked: true,
          weak_evidence_checked: true,
          uncertainty_checked: true,
          conflicts: [],
          no_conflicts_reason: 'No conflicts in CLI fixture.',
        }),
      ).exitCode,
    ).toBe(0);

    createArtifact('research/final-report.html');
    expect(
      cli(
        'submit-final-report',
        '--root',
        tempDir,
        '--json',
        writeJson('submit.json', {
          run_id: runId,
          artifact_path: 'research/final-report.html',
          format: 'html',
          included_sections: [
            'title',
            'executive_summary',
            'answer_or_recommendation',
            'key_findings',
            'evidence_and_analysis',
            'contradictions_caveats_uncertainty',
            'source_list',
          ],
        }),
      ).exitCode,
    ).toBe(0);

    const audit = cli('final-audit', '--root', tempDir, '--run-id', runId);
    expect(audit.exitCode).toBe(0);
    expect(audit.json.current_state).toBe('audit_passed');
  });

  it('returns non-zero for rejected calls unless --allow-failure is present', () => {
    const init = cli(
      'initialize-run',
      '--root',
      tempDir,
      '--json',
      writeJson('init.json', {
        original_user_request: 'Compare workflow verification approaches for research skills.',
        restated_research_question: 'What tool-enforced gates should verify a deep research workflow?',
        quick_answer_requested: false,
      }),
    );
    const runId = init.json.run_id!;
    const submitPath = writeJson('submit-early.json', {
      run_id: runId,
      artifact_path: 'research/final-report.html',
      format: 'html',
      included_sections: [],
    });

    const rejected = cli('submit-final-report', '--root', tempDir, '--json', submitPath);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.json.ok).toBe(false);
    expect(rejected.json.errors[0]).toContain('Expected set_deliverable_contract');

    const allowed = cli('submit-final-report', '--root', tempDir, '--json', submitPath, '--allow-failure');
    expect(allowed.exitCode).toBe(0);
    expect(allowed.json.ok).toBe(false);
  });
});
