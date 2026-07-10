import fs from 'fs';

import {
  SCHEMA_VERSION,
  WORKFLOW_NAME,
  WORKFLOW_VERSION,
  workflowStates,
  workflowToolNames,
  type DeliverableContract,
  type Depth,
  type ExecutionMode,
  type ExecutionModeSelection,
  type FinalAuditFile,
  type FinalFormat,
  type FinalReportSubmission,
  type MutatingToolName,
  type OutputMode,
  type ReconciliationRecord,
  type RunState,
  type SubquestionRecord,
  type TaskFile,
  type TaskRecord,
  type TaskStatus,
  type WorkflowContext,
  type WorkflowToolResult,
} from './models.js';
import { emptyTaskSummary, gatesForState, resultForState, summarizeTasks } from './models.js';
import {
  allTasksClosed,
  findTask,
  markTaskCompleted,
  markTaskStarted,
  openTasks,
  outOfOrderErrors,
  refreshRunState,
  transitionRunState,
  validateTaskCompletion,
  validateTaskStart,
} from './state-machine.js';
import {
  exists,
  readRunState,
  readTasksFile,
  reconciliationPath,
  resolveArtifactPath,
  runStateExists,
  tasksFileExists,
  writeFinalAuditFile,
  writeReconciliationFile,
  writeRunState,
  writeSubquestionsFile,
  writeTasksFile,
} from './storage.js';

export interface InitializeRunInput {
  original_user_request: string;
  restated_research_question: string;
  quick_answer_requested: boolean;
}

export interface SetDeliverableContractInput {
  run_id: string;
  audience: string;
  final_format: FinalFormat;
  output_mode: OutputMode;
  depth: Depth;
  source_requirements: string;
  time_horizon: string;
  key_comparison_dimensions: string[];
  done_criteria: string[];
  markdown_allowed_reason: string | null;
}

export interface CreateTaskPlanInput {
  run_id: string;
  tasks: TaskRecord[];
}

export interface SetSubquestionsInput {
  run_id: string;
  subquestions: SubquestionRecord[];
}

export interface SetExecutionModeInput {
  run_id: string;
  execution_mode: ExecutionMode;
  reason: string;
  subagent_count: number;
  subagent_roles: string[];
  verified_subagent_job_ids: string[];
}

export interface StartTaskInput {
  run_id: string;
  task_id: string;
}

export interface CompleteTaskInput {
  run_id: string;
  task_id: string;
  status: Exclude<TaskStatus, 'todo' | 'running'>;
  summary: string;
  output_artifact: string | null;
  reason_if_not_done: string | null;
  evidence_count: number;
  new_followup_tasks: TaskRecord[];
}

export interface AddFollowupTasksInput {
  run_id: string;
  parent_task_id: string;
  tasks: TaskRecord[];
}

export type RecordReconciliationInput = { run_id: string } & ReconciliationRecord;

export interface SubmitFinalReportInput {
  run_id: string;
  artifact_path: string;
  format: FinalFormat;
  included_sections: string[];
}

export interface FinalAuditInput {
  run_id: string;
}

export interface DescribeWorkflowCapabilitiesResult extends WorkflowToolResult {
  workflow_name: string;
  workflow_version: string;
  supported_output_modes: OutputMode[];
  ordered_states: typeof workflowStates;
  tool_names: typeof workflowToolNames;
  state_persistence_enabled: boolean;
  subagent_verification_supported: boolean;
}

export interface GetRunStateResult extends WorkflowToolResult {
  deliverable_contract: DeliverableContract | null;
  task_counts: ReturnType<typeof summarizeTasks>;
  open_tasks: string[];
  completed_gates: string[];
  blocking_errors: string[];
}

export interface FinalAuditResult extends WorkflowToolResult, FinalAuditFile {}

const requiredReportSections = [
  'title',
  'executive_summary',
  'answer_or_recommendation',
  'key_findings',
  'evidence_and_analysis',
  'contradictions_caveats_uncertainty',
  'source_list',
];

function nowIso(context: WorkflowContext): string {
  return (context.now ?? new Date()).toISOString();
}

function generatedRunId(context: WorkflowContext): string {
  const date = context.now ?? new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    'dr',
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`,
  ].join('_');
}

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}

function isGenericResearchQuestion(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized.length < 15 ||
    ['research the topic', 'look things up', 'do research', 'research this', 'find information'].includes(normalized)
  );
}

function loadStateForTool(toolName: MutatingToolName, inputRunId: string | undefined, context: WorkflowContext) {
  try {
    if (!runStateExists(context)) {
      return {
        state: null,
        errors: outOfOrderErrors('not_started', toolName),
      };
    }
    const state = readRunState(context);
    if (inputRunId && state.run_id !== inputRunId) {
      return {
        state,
        errors: [`Run ID mismatch. Expected ${state.run_id}; got ${inputRunId}.`],
      };
    }
    return { state, errors: outOfOrderErrors(state.current_state, toolName, safeReadTasks(context)) };
  } catch (error) {
    return { state: null, errors: [storageErrorMessage(error)] };
  }
}

function safeReadTasks(context: WorkflowContext): TaskRecord[] {
  try {
    return tasksFileExists(context) ? readTasksFile(context).tasks : [];
  } catch {
    return [];
  }
}

function storageErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failure(state: RunState | null, errors: string[], fallbackState: RunState['current_state'] = 'not_started') {
  return resultForState(state, false, errors, [], fallbackState);
}

function success(state: RunState, warnings: string[] = []): WorkflowToolResult {
  return resultForState(state, true, [], warnings);
}

function completedGates(state: RunState): string[] {
  return Object.entries(state.gates)
    .filter(([, complete]) => complete)
    .map(([gate]) => gate);
}

function finalArtifactFor(outputMode: OutputMode, finalFormat: FinalFormat): string {
  if (outputMode === 'skill_handoff' || finalFormat === 'markdown_handoff') return 'research/handoff.md';
  if (outputMode === 'printable' || finalFormat === 'pdf') return 'research/final-report.pdf';
  return 'research/final-report.html';
}

function taskFileDeliverable(deliverable: DeliverableContract): TaskFile['deliverable'] {
  return {
    mode: deliverable.output_mode,
    final_format: deliverable.final_format,
    final_artifact: deliverable.final_artifact,
    markdown_allowed: deliverable.markdown_allowed,
    markdown_allowed_reason: deliverable.markdown_allowed_reason,
  };
}

function includesAny(value: string, tokens: string[]): boolean {
  const lower = value.toLowerCase();
  return tokens.some((token) => lower.includes(token));
}

function taskLooksLikeFinalSynthesis(task: TaskRecord): boolean {
  return includesAny(`${task.id} ${task.task} ${task.expected_output}`, ['synth', 'final answer', 'final report']);
}

function validateTaskShape(task: TaskRecord, index: number): string[] {
  const prefix = `Task at index ${index}`;
  const errors: string[] = [];
  if (isBlank(task.id)) errors.push(`${prefix} is missing id.`);
  if (isBlank(task.task)) errors.push(`${prefix} is missing task.`);
  if (!['main', 'subagent', 'sequential'].includes(task.mode)) errors.push(`${prefix} has invalid mode ${task.mode}.`);
  if (task.status !== 'todo') errors.push(`${prefix} must start with status todo.`);
  if (isBlank(task.expected_output)) errors.push(`${prefix} is missing expected_output.`);
  if (isBlank(task.output_artifact)) errors.push(`${prefix} is missing output_artifact.`);
  return errors;
}

function validateTaskPlan(tasks: TaskRecord[], state: RunState, context: WorkflowContext): string[] {
  const errors: string[] = [];
  const depth = state.deliverable?.depth ?? 'standard';
  if ((depth === 'standard' || depth === 'deep') && tasks.length < 3) {
    errors.push(`${depth} research requires at least three tasks.`);
  }

  const ids = new Set<string>();
  for (const [index, task] of tasks.entries()) {
    errors.push(...validateTaskShape(task, index));
    if (ids.has(task.id)) errors.push(`Duplicate task ID: ${task.id}.`);
    ids.add(task.id);
  }

  const combinedTasks = tasks
    .map((task) => `${task.task} ${task.expected_output}`)
    .join('\n')
    .toLowerCase();
  const roleChecks: Array<[string, string[]]> = [
    ['scope mapping', ['scope', 'map', 'define']],
    ['source collection', ['source', 'collect']],
    ['viewpoint/option comparison', ['compare', 'comparison', 'viewpoint', 'option']],
    ['contradiction or weak-evidence checking', ['contradiction', 'weak evidence', 'caveat', 'confidence']],
    ['final synthesis', ['synth', 'final']],
  ];
  for (const [role, tokens] of roleChecks) {
    if (!tokens.some((token) => combinedTasks.includes(token))) {
      errors.push(`Task plan is missing required semantic role: ${role}.`);
    }
  }

  if (!state.quick_answer_requested && tasks[0] && taskLooksLikeFinalSynthesis(tasks[0])) {
    errors.push('Final synthesis cannot be the first task unless quick-answer mode is active.');
  }

  const artifacts = new Set<string>();
  for (const task of tasks) {
    if (artifacts.has(task.output_artifact)) {
      errors.push(`Duplicate output artifact: ${task.output_artifact}.`);
    }
    artifacts.add(task.output_artifact);
    const resolved = resolveArtifactPath(task.output_artifact, context);
    if (fs.existsSync(resolved) && !taskLooksLikeFinalSynthesis(task)) {
      errors.push(`Task output artifact already exists and would be overwritten: ${task.output_artifact}.`);
    }
  }

  return errors;
}

function validateFollowupTasks(
  newTasks: TaskRecord[],
  existingTasks: TaskRecord[],
  context: WorkflowContext,
): string[] {
  const errors: string[] = [];
  const existingIds = new Set(existingTasks.map((task) => task.id));
  const existingArtifacts = new Set(existingTasks.map((task) => task.output_artifact));
  const newIds = new Set<string>();

  for (const [index, task] of newTasks.entries()) {
    errors.push(...validateTaskShape(task, index));
    if (existingIds.has(task.id) || newIds.has(task.id)) errors.push(`Duplicate task ID: ${task.id}.`);
    newIds.add(task.id);
    if (existingArtifacts.has(task.output_artifact)) {
      errors.push(`Follow-up task artifact would overwrite an existing task artifact: ${task.output_artifact}.`);
    }
    if (exists(resolveArtifactPath(task.output_artifact, context))) {
      errors.push(`Follow-up task artifact already exists on disk: ${task.output_artifact}.`);
    }
  }
  return errors;
}

function validateSubquestions(input: SetSubquestionsInput, taskFile: TaskFile, state: RunState): string[] {
  const errors: string[] = [];
  const taskIds = new Set(taskFile.tasks.map((task) => task.id));
  const mappedTaskIds = new Set<string>();

  if (
    (state.deliverable?.depth === 'standard' || state.deliverable?.depth === 'deep') &&
    input.subquestions.length < 2
  ) {
    errors.push(`${state.deliverable.depth} research requires at least two subquestions.`);
  }

  for (const [index, subquestion] of input.subquestions.entries()) {
    if (isBlank(subquestion.subquestion)) errors.push(`Subquestion at index ${index} is missing subquestion.`);
    if (isBlank(subquestion.independence_reason)) {
      errors.push(`Subquestion at index ${index} is missing independence_reason.`);
    }
    if (
      ['research the topic', 'look things up', 'find sources', 'research this'].includes(
        subquestion.subquestion.trim().toLowerCase(),
      )
    ) {
      errors.push(`Subquestion at index ${index} is too vague.`);
    }
    if (!Array.isArray(subquestion.task_ids) || subquestion.task_ids.length === 0) {
      errors.push(`Subquestion at index ${index} must reference at least one task.`);
    }
    for (const taskId of subquestion.task_ids) {
      if (!taskIds.has(taskId)) errors.push(`Subquestion at index ${index} references unknown task ${taskId}.`);
      mappedTaskIds.add(taskId);
    }
  }

  for (const task of taskFile.tasks) {
    if (!taskLooksLikeFinalSynthesis(task) && !mappedTaskIds.has(task.id)) {
      errors.push(`Non-synthesis task ${task.id} is not mapped to any subquestion.`);
    }
  }

  return errors;
}

function validateExecutionMode(input: SetExecutionModeInput): string[] {
  const errors: string[] = [];
  if (isBlank(input.reason)) errors.push('Execution mode reason is required.');
  if (input.execution_mode === 'subagents') {
    if (input.subagent_count < 2 || input.subagent_count > 5) {
      errors.push('Subagent mode requires subagent_count between 2 and 5.');
    }
    if (!Array.isArray(input.subagent_roles) || input.subagent_roles.length === 0) {
      errors.push('Subagent mode requires non-empty subagent_roles.');
    }
    if (
      !Array.isArray(input.verified_subagent_job_ids) ||
      input.verified_subagent_job_ids.length !== input.subagent_count ||
      input.verified_subagent_job_ids.some((jobId) => isBlank(jobId))
    ) {
      errors.push('Subagent mode requires verified_subagent_job_ids for every claimed subagent.');
    }
  }
  if (input.execution_mode === 'single_main_pass' && input.reason.trim().length < 20) {
    errors.push('single_main_pass requires a reason explaining why subagents or sequential passes are unnecessary.');
  }
  return errors;
}

function validateReconciliation(input: RecordReconciliationInput, taskFile: TaskFile): string[] {
  const errors: string[] = [];
  if (!allTasksClosed(taskFile.tasks)) errors.push('Cannot reconcile until every task is done, blocked, or skipped.');
  if (!input.contradictions_checked) errors.push('contradictions_checked must be true.');
  if (!input.duplicates_checked) errors.push('duplicates_checked must be true.');
  if (!input.weak_evidence_checked) errors.push('weak_evidence_checked must be true.');
  if (!input.uncertainty_checked) errors.push('uncertainty_checked must be true.');
  if (input.conflicts.length === 0 && isBlank(input.no_conflicts_reason)) {
    errors.push('no_conflicts_reason is required when conflicts is empty.');
  }
  for (const [index, conflict] of input.conflicts.entries()) {
    if (isBlank(conflict.issue)) errors.push(`Conflict at index ${index} is missing issue.`);
    if (!Array.isArray(conflict.sources_in_disagreement) || conflict.sources_in_disagreement.length === 0) {
      errors.push(`Conflict at index ${index} must include sources_in_disagreement.`);
    }
    if (isBlank(conflict.resolution)) errors.push(`Conflict at index ${index} is missing resolution.`);
    if (!['low', 'medium', 'high'].includes(conflict.confidence)) {
      errors.push(`Conflict at index ${index} has invalid confidence ${conflict.confidence}.`);
    }
  }
  return errors;
}

function validateFinalReportSubmission(
  input: Omit<SubmitFinalReportInput, 'run_id'>,
  state: RunState,
  context: WorkflowContext,
): string[] {
  const errors: string[] = [];
  const deliverable = state.deliverable;
  if (!deliverable) return ['Deliverable contract is missing.'];

  if (!exists(resolveArtifactPath(input.artifact_path, context))) {
    errors.push(`Final report artifact does not exist: ${input.artifact_path}.`);
  }

  const missingSections = requiredReportSections.filter((section) => !input.included_sections.includes(section));
  if (missingSections.length > 0) {
    errors.push(`Final report is missing required sections: ${missingSections.join(', ')}.`);
  }

  if (deliverable.output_mode === 'human_report') {
    if (input.format !== 'html') errors.push('human_report mode requires format html.');
    if (input.artifact_path !== 'research/final-report.html') {
      errors.push('human_report mode requires artifact_path research/final-report.html.');
    }
    if (input.format === 'markdown_handoff')
      errors.push('Markdown final reports are not allowed in human_report mode.');
  }

  if (deliverable.output_mode === 'printable') {
    if (input.format !== 'pdf') errors.push('printable mode requires format pdf.');
    if (!exists(resolveArtifactPath('research/final-report.html', context))) {
      errors.push('printable mode requires research/final-report.html before PDF submission.');
    }
    if (!exists(resolveArtifactPath('research/final-report.pdf', context))) {
      errors.push('printable mode requires research/final-report.pdf.');
    }
  }

  if (deliverable.output_mode === 'skill_handoff') {
    if (input.format !== 'markdown_handoff') errors.push('skill_handoff mode requires format markdown_handoff.');
    if (input.artifact_path !== 'research/handoff.md')
      errors.push('skill_handoff mode requires artifact_path research/handoff.md.');
  }

  return errors;
}

function auditState(state: RunState, taskFile: TaskFile | null, context: WorkflowContext): FinalAuditFile {
  const missing_steps: string[] = [];
  const format_errors: string[] = [];

  for (const [gate, complete] of Object.entries(state.gates)) {
    if (gate !== 'final_audit_passed' && !complete) missing_steps.push(gate);
  }

  if (!state.reconciliation || !exists(reconciliationPath(context))) missing_steps.push('record_reconciliation');
  if (!state.final_report) missing_steps.push('submit_final_report');

  const open = taskFile ? openTasks(taskFile.tasks).map((task) => task.id) : ['tasks.yaml missing'];
  if (taskFile) {
    for (const task of taskFile.tasks) {
      if ((task.status === 'blocked' || task.status === 'skipped') && isBlank(task.reason_if_not_done)) {
        format_errors.push(`Task ${task.id} is ${task.status} without reason_if_not_done.`);
      }
    }
  }

  if (state.final_report) {
    format_errors.push(...validateFinalReportSubmission(state.final_report, state, context));
  }

  if (state.deliverable?.output_mode === 'human_report' && state.final_report?.format === 'markdown_handoff') {
    format_errors.push('Markdown must not be present as the final human report.');
  }

  const ok = missing_steps.length === 0 && open.length === 0 && format_errors.length === 0;
  return {
    ok,
    allowed_to_answer_user: ok,
    missing_steps: Array.from(new Set(missing_steps)),
    open_tasks: open,
    format_errors: Array.from(new Set(format_errors)),
    next_required_action: ok
      ? 'answer_user_with_report_link'
      : (missing_steps[0] ?? (open[0] ? 'close_open_tasks' : 'fix_final_report')),
  };
}

export function describeWorkflowCapabilities(context: WorkflowContext = {}): DescribeWorkflowCapabilitiesResult {
  let state: RunState | null = null;
  if (runStateExists(context)) {
    try {
      state = readRunState(context);
    } catch {
      state = null;
    }
  }

  return {
    ...resultForState(state, true),
    workflow_name: WORKFLOW_NAME,
    workflow_version: WORKFLOW_VERSION,
    supported_output_modes: ['human_report', 'printable', 'skill_handoff'],
    ordered_states: workflowStates,
    tool_names: workflowToolNames,
    state_persistence_enabled: true,
    subagent_verification_supported: true,
  };
}

export function getRunState(input: { run_id: string | null }, context: WorkflowContext = {}): GetRunStateResult {
  if (!runStateExists(context)) {
    return {
      ...resultForState(null, true),
      deliverable_contract: null,
      task_counts: emptyTaskSummary(),
      open_tasks: [],
      completed_gates: [],
      blocking_errors: [],
    };
  }

  try {
    const state = readRunState(context);
    const taskFile = tasksFileExists(context) ? readTasksFile(context) : { tasks: [] };
    const refreshed = refreshRunState(state, taskFile.tasks);
    if (input.run_id && input.run_id !== refreshed.run_id) {
      return {
        ...failure(refreshed, [`Run ID mismatch. Expected ${refreshed.run_id}; got ${input.run_id}.`]),
        deliverable_contract: refreshed.deliverable ?? null,
        task_counts: refreshed.task_summary,
        open_tasks: openTasks(taskFile.tasks).map((task) => task.id),
        completed_gates: completedGates(refreshed),
        blocking_errors: [`Run ID mismatch. Expected ${refreshed.run_id}; got ${input.run_id}.`],
      };
    }

    return {
      ...success(refreshed),
      deliverable_contract: refreshed.deliverable ?? null,
      task_counts: refreshed.task_summary,
      open_tasks: openTasks(taskFile.tasks).map((task) => task.id),
      completed_gates: completedGates(refreshed),
      blocking_errors: [],
    };
  } catch (error) {
    return {
      ...failure(null, [storageErrorMessage(error)]),
      deliverable_contract: null,
      task_counts: emptyTaskSummary(),
      open_tasks: [],
      completed_gates: [],
      blocking_errors: [storageErrorMessage(error)],
    };
  }
}

export function initializeRun(input: InitializeRunInput, context: WorkflowContext = {}): WorkflowToolResult {
  if (runStateExists(context)) {
    const state = readRunState(context);
    return failure(state, ['A deep research workflow run already exists. Resume it with get_run_state.']);
  }

  const errors: string[] = [];
  if (isBlank(input.original_user_request)) errors.push('original_user_request is required.');
  if (isBlank(input.restated_research_question)) errors.push('restated_research_question is required.');
  if (
    typeof input.restated_research_question === 'string' &&
    isGenericResearchQuestion(input.restated_research_question)
  ) {
    errors.push('restated_research_question is too generic.');
  }
  if (errors.length > 0) return failure(null, errors);

  const timestamp = nowIso(context);
  const state: RunState = refreshRunState({
    schema_version: SCHEMA_VERSION,
    workflow_name: WORKFLOW_NAME,
    workflow_version: WORKFLOW_VERSION,
    run_id: generatedRunId(context),
    current_state: 'initialized',
    allowed_next_tool: null,
    allowed_next_tools: [],
    original_user_request: input.original_user_request.trim(),
    restated_research_question: input.restated_research_question.trim(),
    quick_answer_requested: input.quick_answer_requested === true,
    task_summary: emptyTaskSummary(),
    gates: gatesForState('initialized'),
    created_at: timestamp,
    updated_at: timestamp,
  });
  writeRunState(state, context);
  return success(state);
}

export function setDeliverableContract(
  input: SetDeliverableContractInput,
  context: WorkflowContext = {},
): WorkflowToolResult {
  const loaded = loadStateForTool('set_deliverable_contract', input.run_id, context);
  if (!loaded.state || loaded.errors.length > 0) return failure(loaded.state, loaded.errors);
  const state = loaded.state;

  const errors: string[] = [];
  if (isBlank(input.audience)) errors.push('audience is required.');
  if (!['human_report', 'printable', 'skill_handoff'].includes(input.output_mode)) {
    errors.push(`Invalid output_mode ${input.output_mode}.`);
  }
  if (!['html', 'pdf', 'markdown_handoff', 'other'].includes(input.final_format)) {
    errors.push(`Invalid final_format ${input.final_format}.`);
  }
  if (!['brief', 'standard', 'deep'].includes(input.depth)) errors.push(`Invalid depth ${input.depth}.`);
  if (!Array.isArray(input.done_criteria) || input.done_criteria.length === 0 || input.done_criteria.some(isBlank)) {
    errors.push('At least one non-empty done criterion is required.');
  }
  if (input.output_mode === 'human_report' && input.final_format === 'markdown_handoff') {
    errors.push('human_report mode rejects markdown_handoff final_format.');
  }
  if (input.final_format === 'markdown_handoff' && input.output_mode !== 'skill_handoff') {
    errors.push('Markdown is reserved for skill_handoff mode.');
  }
  if (input.output_mode === 'printable' && input.final_format !== 'pdf') {
    errors.push('printable mode requires final_format pdf.');
  }
  if (input.output_mode === 'skill_handoff' && input.final_format !== 'markdown_handoff') {
    errors.push('skill_handoff mode requires final_format markdown_handoff.');
  }
  if (errors.length > 0) return failure(state, errors);

  const finalFormat: FinalFormat = input.output_mode === 'human_report' ? 'html' : input.final_format;
  const deliverable: DeliverableContract = {
    audience: input.audience.trim(),
    final_format: finalFormat,
    output_mode: input.output_mode,
    depth: input.depth,
    source_requirements: input.source_requirements.trim(),
    time_horizon: input.time_horizon.trim(),
    key_comparison_dimensions: input.key_comparison_dimensions,
    done_criteria: input.done_criteria,
    markdown_allowed_reason:
      input.output_mode === 'skill_handoff'
        ? (input.markdown_allowed_reason ?? 'Skill handoff mode permits Markdown.')
        : input.markdown_allowed_reason,
    final_artifact: finalArtifactFor(input.output_mode, finalFormat),
    markdown_allowed: input.output_mode === 'skill_handoff',
  };
  const timestamp = nowIso(context);
  const updated = transitionRunState({ ...state, deliverable, updated_at: timestamp }, 'deliverable_defined');
  writeRunState(updated, context);
  return success(updated);
}

export function createTaskPlan(input: CreateTaskPlanInput, context: WorkflowContext = {}): WorkflowToolResult {
  const loaded = loadStateForTool('create_task_plan', input.run_id, context);
  if (!loaded.state || loaded.errors.length > 0) return failure(loaded.state, loaded.errors);
  const state = loaded.state;
  const errors = validateTaskPlan(input.tasks, state, context);
  if (errors.length > 0) return failure(state, errors);

  const timestamp = nowIso(context);
  const taskFile: TaskFile = {
    deliverable: state.deliverable ? taskFileDeliverable(state.deliverable) : undefined,
    tasks: input.tasks.map((task) => ({ ...task })),
  };
  const updated = transitionRunState({ ...state, updated_at: timestamp }, 'task_plan_created', taskFile.tasks);
  writeTasksFile(taskFile, context);
  writeRunState(updated, context);
  return success(updated);
}

export function setSubquestions(input: SetSubquestionsInput, context: WorkflowContext = {}): WorkflowToolResult {
  const loaded = loadStateForTool('set_subquestions', input.run_id, context);
  if (!loaded.state || loaded.errors.length > 0) return failure(loaded.state, loaded.errors);
  const state = loaded.state;

  try {
    const taskFile = readTasksFile(context);
    const errors = validateSubquestions(input, taskFile, state);
    if (errors.length > 0) return failure(state, errors);

    const timestamp = nowIso(context);
    const updated = transitionRunState({ ...state, updated_at: timestamp }, 'subquestions_defined', taskFile.tasks);
    writeSubquestionsFile({ subquestions: input.subquestions }, context);
    writeRunState(updated, context);
    return success(updated);
  } catch (error) {
    return failure(state, [storageErrorMessage(error)]);
  }
}

export function setExecutionMode(input: SetExecutionModeInput, context: WorkflowContext = {}): WorkflowToolResult {
  const loaded = loadStateForTool('set_execution_mode', input.run_id, context);
  if (!loaded.state || loaded.errors.length > 0) return failure(loaded.state, loaded.errors);
  const state = loaded.state;
  const errors = validateExecutionMode(input);
  if (errors.length > 0) return failure(state, errors);

  const execution: ExecutionModeSelection = {
    ...input,
    strict_sequential_task_mode: input.execution_mode !== 'subagents',
    verified_subagent_mode: input.execution_mode === 'subagents',
  };
  const taskFile = readTasksFile(context);
  const timestamp = nowIso(context);
  const updated = transitionRunState(
    { ...state, execution, updated_at: timestamp },
    'execution_mode_selected',
    taskFile.tasks,
  );
  writeRunState(updated, context);
  return success(updated);
}

export function startTask(input: StartTaskInput, context: WorkflowContext = {}): WorkflowToolResult {
  const loaded = loadStateForTool('start_task', input.run_id, context);
  if (!loaded.state || loaded.errors.length > 0) return failure(loaded.state, loaded.errors);
  const state = loaded.state;

  try {
    const taskFile = readTasksFile(context);
    const errors = validateTaskStart(state, taskFile, input.task_id);
    if (errors.length > 0) return failure(state, errors);

    const updated = markTaskStarted(state, taskFile, input.task_id, nowIso(context));
    writeTasksFile(updated.taskFile, context);
    writeRunState(updated.state, context);
    return success(updated.state);
  } catch (error) {
    return failure(state, [storageErrorMessage(error)]);
  }
}

export function completeTask(input: CompleteTaskInput, context: WorkflowContext = {}): WorkflowToolResult {
  const loaded = loadStateForTool('complete_task', input.run_id, context);
  if (!loaded.state || loaded.errors.length > 0) return failure(loaded.state, loaded.errors);
  const state = loaded.state;

  try {
    const taskFile = readTasksFile(context);
    const task = findTask(taskFile, input.task_id);
    const errors = validateTaskCompletion(state, taskFile, input.task_id, input.status);
    if (isBlank(input.summary)) errors.push('summary is required.');
    if ((input.status === 'blocked' || input.status === 'skipped') && isBlank(input.reason_if_not_done)) {
      errors.push(`reason_if_not_done is required when status is ${input.status}.`);
    }
    if (task && input.status === 'done') {
      const artifact = input.output_artifact ?? task.output_artifact;
      const isFinalSynthesisArtifact =
        state.deliverable?.final_artifact === task.output_artifact && taskLooksLikeFinalSynthesis(task);
      if (isBlank(artifact)) errors.push('output_artifact is required when status is done.');
      if (!isBlank(artifact) && !isFinalSynthesisArtifact && !exists(resolveArtifactPath(artifact, context))) {
        errors.push(`Task output artifact does not exist: ${artifact}.`);
      }
      if (includesAny(task.task, ['source', 'collect']) && input.evidence_count < 1) {
        errors.push('Source collection tasks require evidence_count of at least 1 unless blocked.');
      }
      if (includesAny(task.task, ['contradiction', 'weak evidence', 'caveat', 'confidence']) && isBlank(artifact)) {
        errors.push('Contradiction/evidence tasks require a caveats or confidence artifact unless blocked.');
      }
    }
    if (input.new_followup_tasks.length > 0) {
      errors.push(...validateFollowupTasks(input.new_followup_tasks, taskFile.tasks, context));
    }
    if (errors.length > 0) return failure(state, errors);

    let nextTaskFile = taskFile;
    if (input.new_followup_tasks.length > 0) {
      nextTaskFile = { ...nextTaskFile, tasks: [...nextTaskFile.tasks, ...input.new_followup_tasks] };
    }
    const updated = markTaskCompleted(state, nextTaskFile, input.task_id, input.status, nowIso(context), {
      summary: input.summary.trim(),
      reason_if_not_done: input.reason_if_not_done,
      evidence_count: input.evidence_count,
    });
    writeTasksFile(updated.taskFile, context);
    writeRunState(updated.state, context);
    return success(updated.state);
  } catch (error) {
    return failure(state, [storageErrorMessage(error)]);
  }
}

export function addFollowupTasks(input: AddFollowupTasksInput, context: WorkflowContext = {}): WorkflowToolResult {
  const loaded = loadStateForTool('add_followup_tasks', input.run_id, context);
  if (!loaded.state || loaded.errors.length > 0) return failure(loaded.state, loaded.errors);
  const state = loaded.state;

  try {
    const taskFile = readTasksFile(context);
    const parent = findTask(taskFile, input.parent_task_id);
    const errors: string[] = [];
    if (!parent) errors.push(`Parent task ${input.parent_task_id} does not exist.`);
    errors.push(...validateFollowupTasks(input.tasks, taskFile.tasks, context));
    if (errors.length > 0) return failure(state, errors);

    const tasks = input.tasks.map((task) => ({ ...task, parent_task_id: input.parent_task_id }));
    const updatedTaskFile = { ...taskFile, tasks: [...taskFile.tasks, ...tasks] };
    const updated = refreshRunState(
      { ...state, current_state: 'tasks_in_progress', updated_at: nowIso(context) },
      updatedTaskFile.tasks,
    );
    writeTasksFile(updatedTaskFile, context);
    writeRunState(updated, context);
    return success(updated);
  } catch (error) {
    return failure(state, [storageErrorMessage(error)]);
  }
}

export function recordReconciliation(
  input: RecordReconciliationInput,
  context: WorkflowContext = {},
): WorkflowToolResult {
  const loaded = loadStateForTool('record_reconciliation', input.run_id, context);
  if (!loaded.state || loaded.errors.length > 0) return failure(loaded.state, loaded.errors);
  const state = loaded.state;

  try {
    const taskFile = readTasksFile(context);
    const errors = validateReconciliation(input, taskFile);
    if (errors.length > 0) return failure(state, errors);

    const reconciliation: ReconciliationRecord = {
      contradictions_checked: input.contradictions_checked,
      duplicates_checked: input.duplicates_checked,
      weak_evidence_checked: input.weak_evidence_checked,
      uncertainty_checked: input.uncertainty_checked,
      conflicts: input.conflicts,
      no_conflicts_reason: input.no_conflicts_reason,
    };
    const timestamp = nowIso(context);
    const updated = transitionRunState(
      { ...state, reconciliation, updated_at: timestamp },
      'reconciliation_complete',
      taskFile.tasks,
    );
    writeReconciliationFile(reconciliation, context);
    writeRunState(updated, context);
    return success(updated);
  } catch (error) {
    return failure(state, [storageErrorMessage(error)]);
  }
}

export function submitFinalReport(input: SubmitFinalReportInput, context: WorkflowContext = {}): WorkflowToolResult {
  const loaded = loadStateForTool('submit_final_report', input.run_id, context);
  if (!loaded.state || loaded.errors.length > 0) return failure(loaded.state, loaded.errors);
  const state = loaded.state;
  const errors = validateFinalReportSubmission(input, state, context);
  if (errors.length > 0) return failure(state, errors);

  const taskFile = tasksFileExists(context) ? readTasksFile(context) : { tasks: [] };
  const final_report: FinalReportSubmission = {
    artifact_path: input.artifact_path,
    format: input.format,
    included_sections: input.included_sections,
  };
  const timestamp = nowIso(context);
  const updated = transitionRunState(
    { ...state, final_report, updated_at: timestamp },
    'final_report_submitted',
    taskFile.tasks,
  );
  writeRunState(updated, context);
  return success(updated);
}

export function finalAudit(input: FinalAuditInput, context: WorkflowContext = {}): FinalAuditResult {
  const loaded = loadStateForTool('final_audit', input.run_id, context);
  if (!loaded.state || loaded.errors.length > 0) {
    return {
      ...failure(loaded.state, loaded.errors),
      allowed_to_answer_user: false,
      missing_steps: loaded.errors,
      open_tasks: [],
      format_errors: [],
      next_required_action: loaded.state?.allowed_next_tool ?? 'initialize_run',
    };
  }
  const state = loaded.state;

  try {
    const taskFile = tasksFileExists(context) ? readTasksFile(context) : null;
    const audit = auditState(state, taskFile, context);
    writeFinalAuditFile(audit, context);

    if (!audit.ok) {
      return {
        ...failure(state, [...audit.missing_steps, ...audit.open_tasks, ...audit.format_errors]),
        ...audit,
      };
    }

    const updated = transitionRunState(
      { ...state, gates: gatesForState('audit_passed'), updated_at: nowIso(context) },
      'audit_passed',
      taskFile?.tasks ?? [],
    );
    writeRunState(updated, context);
    return {
      ...success(updated),
      ...audit,
    };
  } catch (error) {
    return {
      ...failure(state, [storageErrorMessage(error)]),
      allowed_to_answer_user: false,
      missing_steps: [storageErrorMessage(error)],
      open_tasks: [],
      format_errors: [],
      next_required_action: 'fix_final_audit_inputs',
    };
  }
}

export const deepResearchWorkflowTools = {
  describe_workflow_capabilities: describeWorkflowCapabilities,
  get_run_state: getRunState,
  initialize_run: initializeRun,
  set_deliverable_contract: setDeliverableContract,
  create_task_plan: createTaskPlan,
  set_subquestions: setSubquestions,
  set_execution_mode: setExecutionMode,
  start_task: startTask,
  complete_task: completeTask,
  add_followup_tasks: addFollowupTasks,
  record_reconciliation: recordReconciliation,
  submit_final_report: submitFinalReport,
  final_audit: finalAudit,
};
