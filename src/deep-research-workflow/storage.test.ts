import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  defaultGates,
  emptyTaskSummary,
  gatesForState,
  SCHEMA_VERSION,
  summarizeTasks,
  WORKFLOW_NAME,
  WORKFLOW_VERSION,
  type RunState,
  type TaskRecord,
} from './models.js';
import {
  readRunState,
  readStructuredFile,
  readTasksFile,
  resolveArtifactPath,
  researchDir,
  runStatePath,
  tasksPath,
  WorkflowStorageError,
  writeRunState,
  writeTasksFile,
} from './storage.js';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-workflow-storage-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function sampleRunState(): RunState {
  return {
    schema_version: SCHEMA_VERSION,
    workflow_name: WORKFLOW_NAME,
    workflow_version: WORKFLOW_VERSION,
    run_id: 'dr_test_001',
    current_state: 'initialized',
    allowed_next_tool: 'set_deliverable_contract',
    allowed_next_tools: ['set_deliverable_contract'],
    original_user_request: 'Compare approaches to workflow verification.',
    restated_research_question: 'What workflow gates should verify a deep research run?',
    quick_answer_requested: false,
    task_summary: emptyTaskSummary(),
    gates: gatesForState('initialized'),
    created_at: '2026-05-15T00:00:00.000Z',
    updated_at: '2026-05-15T00:00:00.000Z',
  };
}

describe('deep research workflow storage', () => {
  it('creates research directories and round-trips run state', () => {
    const state = sampleRunState();

    writeRunState(state, { rootDir: tempDir });

    expect(fs.existsSync(path.join(tempDir, 'research', 'findings'))).toBe(true);
    expect(readRunState({ rootDir: tempDir })).toEqual(state);
  });

  it('round-trips task files and task summaries', () => {
    const tasks: TaskRecord[] = [
      {
        id: 'R1',
        task: 'Map the topic and define scope',
        mode: 'main',
        status: 'done',
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
    ];

    writeTasksFile({ tasks }, { rootDir: tempDir });

    expect(readTasksFile({ rootDir: tempDir })).toEqual({ tasks });
    expect(summarizeTasks(tasks)).toEqual({
      total: 2,
      todo: 1,
      running: 0,
      done: 1,
      blocked: 0,
      skipped: 0,
    });
  });

  it('reports missing files clearly', () => {
    expect(() => readRunState({ rootDir: tempDir })).toThrow(WorkflowStorageError);
    expect(() => readRunState({ rootDir: tempDir })).toThrow('Missing workflow storage file');
  });

  it('reports invalid YAML/JSON clearly', () => {
    fs.mkdirSync(path.dirname(tasksPath({ rootDir: tempDir })), { recursive: true });
    fs.writeFileSync(tasksPath({ rootDir: tempDir }), '{ not valid', 'utf8');

    expect(() => readStructuredFile(tasksPath({ rootDir: tempDir }))).toThrow(WorkflowStorageError);
    expect(() => readTasksFile({ rootDir: tempDir })).toThrow('Invalid YAML/JSON workflow storage file');
  });

  it('maps workflow states to completed gates', () => {
    expect(defaultGates().initialized).toBe(false);
    expect(gatesForState('task_plan_created')).toMatchObject({
      initialized: true,
      deliverable_defined: true,
      task_plan_created: true,
      subquestions_defined: false,
    });
    expect(gatesForState('audit_passed').final_audit_passed).toBe(true);
  });

  it('uses the required run state path under research/', () => {
    expect(runStatePath({ rootDir: tempDir })).toBe(path.join(tempDir, 'research', 'run_state.yaml'));
  });

  it('uses runDir as an isolated workflow storage directory when supplied', () => {
    const runDir = path.join(tempDir, 'research', 'obsidian-ai-systems');

    expect(researchDir({ rootDir: tempDir, runDir })).toBe(runDir);
    expect(runStatePath({ rootDir: tempDir, runDir })).toBe(path.join(runDir, 'run_state.yaml'));
    expect(tasksPath({ rootDir: tempDir, runDir })).toBe(path.join(runDir, 'tasks.yaml'));
  });

  it('maps model-facing research artifact paths into runDir when supplied', () => {
    const runDir = path.join(tempDir, 'research', 'obsidian-ai-systems');

    expect(resolveArtifactPath('research/final-report.html', { rootDir: tempDir, runDir })).toBe(
      path.join(runDir, 'final-report.html'),
    );
    expect(resolveArtifactPath('research/findings/R1.yaml', { rootDir: tempDir, runDir })).toBe(
      path.join(runDir, 'findings', 'R1.yaml'),
    );
  });
});
