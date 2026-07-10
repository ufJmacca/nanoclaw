export const WORKFLOW_NAME = 'deep_research_workflow';
export const WORKFLOW_VERSION = '1.0.0';
export const SCHEMA_VERSION = 1;

export const workflowStates = [
  'not_started',
  'initialized',
  'deliverable_defined',
  'task_plan_created',
  'subquestions_defined',
  'execution_mode_selected',
  'tasks_in_progress',
  'tasks_closed',
  'reconciliation_complete',
  'final_report_submitted',
  'audit_passed',
] as const;

export type WorkflowState = (typeof workflowStates)[number];

export const mutatingToolNames = [
  'initialize_run',
  'set_deliverable_contract',
  'create_task_plan',
  'set_subquestions',
  'set_execution_mode',
  'start_task',
  'complete_task',
  'add_followup_tasks',
  'record_reconciliation',
  'submit_final_report',
  'final_audit',
] as const;

export const nonMutatingToolNames = ['describe_workflow_capabilities', 'get_run_state'] as const;

export const workflowToolNames = [...nonMutatingToolNames, ...mutatingToolNames] as const;

export type MutatingToolName = (typeof mutatingToolNames)[number];
export type WorkflowToolName = (typeof workflowToolNames)[number];

export type OutputMode = 'human_report' | 'printable' | 'skill_handoff';
export type FinalFormat = 'html' | 'pdf' | 'markdown_handoff' | 'other';
export type Depth = 'brief' | 'standard' | 'deep';
export type TaskMode = 'main' | 'subagent' | 'sequential';
export type TaskStatus = 'todo' | 'running' | 'done' | 'blocked' | 'skipped';
export type ExecutionMode = 'subagents' | 'sequential_passes' | 'single_main_pass';
export type Confidence = 'low' | 'medium' | 'high';

export interface DeliverableContract {
  audience: string;
  final_format: FinalFormat;
  output_mode: OutputMode;
  depth: Depth;
  source_requirements: string;
  time_horizon: string;
  key_comparison_dimensions: string[];
  done_criteria: string[];
  markdown_allowed_reason: string | null;
  final_artifact: string;
  markdown_allowed: boolean;
}

export interface TaskRecord {
  id: string;
  task: string;
  mode: TaskMode;
  status: TaskStatus;
  expected_output: string;
  output_artifact: string;
  summary?: string;
  reason_if_not_done?: string | null;
  evidence_count?: number;
  parent_task_id?: string;
  started_at?: string;
  completed_at?: string;
}

export interface TaskFile {
  deliverable?: {
    mode: OutputMode;
    final_format: FinalFormat;
    final_artifact: string;
    markdown_allowed: boolean;
    markdown_allowed_reason: string | null;
  };
  tasks: TaskRecord[];
}

export interface TaskSummary {
  total: number;
  todo: number;
  running: number;
  done: number;
  blocked: number;
  skipped: number;
}

export interface SubquestionRecord {
  subquestion: string;
  task_ids: string[];
  independence_reason: string;
}

export interface SubquestionsFile {
  subquestions: SubquestionRecord[];
}

export interface ExecutionModeSelection {
  execution_mode: ExecutionMode;
  reason: string;
  subagent_count: number;
  subagent_roles: string[];
  verified_subagent_job_ids: string[];
  strict_sequential_task_mode: boolean;
  verified_subagent_mode: boolean;
}

export interface ConflictRecord {
  issue: string;
  sources_in_disagreement: string[];
  resolution: string;
  confidence: Confidence;
}

export interface ReconciliationRecord {
  contradictions_checked: boolean;
  duplicates_checked: boolean;
  weak_evidence_checked: boolean;
  uncertainty_checked: boolean;
  conflicts: ConflictRecord[];
  no_conflicts_reason: string | null;
}

export interface FinalReportSubmission {
  artifact_path: string;
  format: FinalFormat;
  included_sections: string[];
}

export interface Gates {
  initialized: boolean;
  deliverable_defined: boolean;
  task_plan_created: boolean;
  subquestions_defined: boolean;
  execution_mode_selected: boolean;
  all_tasks_closed: boolean;
  reconciliation_complete: boolean;
  final_report_submitted: boolean;
  final_audit_passed: boolean;
}

export interface RunState {
  schema_version: number;
  workflow_name: string;
  workflow_version: string;
  run_id: string;
  current_state: WorkflowState;
  allowed_next_tool: string | null;
  allowed_next_tools: MutatingToolName[];
  original_user_request: string;
  restated_research_question: string;
  quick_answer_requested: boolean;
  deliverable?: DeliverableContract;
  task_summary: TaskSummary;
  execution?: ExecutionModeSelection;
  reconciliation?: ReconciliationRecord;
  final_report?: FinalReportSubmission;
  gates: Gates;
  created_at: string;
  updated_at: string;
}

export interface WorkflowToolResult {
  ok: boolean;
  run_id: string | null;
  current_state: WorkflowState;
  allowed_next_tool: string | null;
  errors: string[];
  warnings: string[];
}

export interface WorkflowContext {
  rootDir?: string;
  runDir?: string;
  now?: Date;
}

export interface FinalAuditFile {
  ok: boolean;
  allowed_to_answer_user: boolean;
  missing_steps: string[];
  open_tasks: string[];
  format_errors: string[];
  next_required_action: string;
}

export function emptyTaskSummary(): TaskSummary {
  return {
    total: 0,
    todo: 0,
    running: 0,
    done: 0,
    blocked: 0,
    skipped: 0,
  };
}

export function summarizeTasks(tasks: TaskRecord[]): TaskSummary {
  const summary = emptyTaskSummary();
  summary.total = tasks.length;
  for (const task of tasks) {
    summary[task.status] += 1;
  }
  return summary;
}

export function defaultGates(): Gates {
  return {
    initialized: false,
    deliverable_defined: false,
    task_plan_created: false,
    subquestions_defined: false,
    execution_mode_selected: false,
    all_tasks_closed: false,
    reconciliation_complete: false,
    final_report_submitted: false,
    final_audit_passed: false,
  };
}

export function gatesForState(state: WorkflowState): Gates {
  const gates = defaultGates();
  const order: Array<keyof Gates> = [
    'initialized',
    'deliverable_defined',
    'task_plan_created',
    'subquestions_defined',
    'execution_mode_selected',
    'all_tasks_closed',
    'reconciliation_complete',
    'final_report_submitted',
    'final_audit_passed',
  ];
  const byState: Partial<Record<WorkflowState, number>> = {
    initialized: 0,
    deliverable_defined: 1,
    task_plan_created: 2,
    subquestions_defined: 3,
    execution_mode_selected: 4,
    tasks_in_progress: 4,
    tasks_closed: 5,
    reconciliation_complete: 6,
    final_report_submitted: 7,
    audit_passed: 8,
  };
  const lastGate = byState[state];
  if (lastGate === undefined) return gates;
  for (let i = 0; i <= lastGate; i += 1) {
    gates[order[i]] = true;
  }
  return gates;
}

export function resultForState(
  state: RunState | null,
  ok: boolean,
  errors: string[] = [],
  warnings: string[] = [],
  fallbackState: WorkflowState = 'not_started',
): WorkflowToolResult {
  return {
    ok,
    run_id: state?.run_id ?? null,
    current_state: state?.current_state ?? fallbackState,
    allowed_next_tool: state?.allowed_next_tool ?? (fallbackState === 'not_started' ? 'initialize_run' : null),
    errors,
    warnings,
  };
}
