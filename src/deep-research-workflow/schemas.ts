import type { WorkflowToolName } from './models.js';

type JsonSchema = {
  type?: string | string[];
  enum?: string[];
  const?: string | boolean | number | null;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  minItems?: number;
};

type ToolSchema = {
  type: 'function';
  name: WorkflowToolName;
  description: string;
  strict: true;
  parameters: JsonSchema;
};

const stringField = (description: string): JsonSchema => ({ type: 'string', description });
const nullableStringField = (description: string): JsonSchema => ({ type: ['string', 'null'], description });
const booleanField = (description: string): JsonSchema => ({ type: 'boolean', description });
const numberField = (description: string): JsonSchema => ({ type: 'number', description });
const stringArrayField = (description: string): JsonSchema => ({
  type: 'array',
  description,
  items: { type: 'string' },
});

function objectSchema(
  properties: Record<string, JsonSchema>,
  required: string[] = Object.keys(properties),
): JsonSchema {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

function tool(name: WorkflowToolName, description: string, parameters: JsonSchema): ToolSchema {
  return {
    type: 'function',
    name,
    description,
    strict: true,
    parameters,
  };
}

const taskStatusTodoSchema: JsonSchema = { type: 'string', enum: ['todo'] };
const taskModeSchema: JsonSchema = { type: 'string', enum: ['main', 'subagent', 'sequential'] };

const taskRecordSchema = objectSchema({
  id: stringField('Stable task ID such as R1.'),
  task: stringField('Research task description.'),
  mode: taskModeSchema,
  status: taskStatusTodoSchema,
  expected_output: stringField('Expected artifact contents.'),
  output_artifact: stringField('Relative artifact path under research/.'),
});

const subquestionSchema = objectSchema({
  subquestion: stringField('Independent research subquestion.'),
  task_ids: stringArrayField('Task IDs covered by this subquestion.'),
  independence_reason: stringField('Why this subquestion can be addressed independently.'),
});

const conflictSchema = objectSchema({
  issue: stringField('Contradiction or uncertainty issue.'),
  sources_in_disagreement: stringArrayField('Sources or artifacts in disagreement.'),
  resolution: stringField('How the conflict was resolved or preserved.'),
  confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
});

const emptyInput = objectSchema({}, []);

export const TOOL_SCHEMAS: Record<WorkflowToolName, ToolSchema> = {
  describe_workflow_capabilities: tool(
    'describe_workflow_capabilities',
    'Describe the deep research workflow tools, states, and persistence support.',
    emptyInput,
  ),
  get_run_state: tool(
    'get_run_state',
    'Read the current durable workflow state without mutating it.',
    objectSchema({
      run_id: { type: ['string', 'null'], description: 'Run ID to read, or null for the current run.' },
    }),
  ),
  initialize_run: tool(
    'initialize_run',
    'Start a durable deep research workflow run and lock the original question.',
    objectSchema({
      original_user_request: stringField('Original user research request.'),
      restated_research_question: stringField('Specific restatement of the research question.'),
      quick_answer_requested: booleanField('Whether the user explicitly requested quick-answer mode.'),
    }),
  ),
  set_deliverable_contract: tool(
    'set_deliverable_contract',
    'Record the exact final deliverable contract before task planning.',
    objectSchema({
      run_id: stringField('Workflow run ID.'),
      audience: stringField('Intended audience.'),
      final_format: { type: 'string', enum: ['html', 'pdf', 'markdown_handoff', 'other'] },
      output_mode: { type: 'string', enum: ['human_report', 'printable', 'skill_handoff'] },
      depth: { type: 'string', enum: ['brief', 'standard', 'deep'] },
      source_requirements: stringField('Source quality and source count requirements.'),
      time_horizon: stringField('Time horizon for the research.'),
      key_comparison_dimensions: stringArrayField('Comparison dimensions for the final answer.'),
      done_criteria: stringArrayField('Concrete acceptance criteria for the run.'),
      markdown_allowed_reason: nullableStringField('Required only when Markdown is explicitly allowed.'),
    }),
  ),
  create_task_plan: tool(
    'create_task_plan',
    'Create the research task plan before execution starts.',
    objectSchema({
      run_id: stringField('Workflow run ID.'),
      tasks: { type: 'array', minItems: 1, items: taskRecordSchema },
    }),
  ),
  set_subquestions: tool(
    'set_subquestions',
    'Record independent research subquestions mapped to task IDs.',
    objectSchema({
      run_id: stringField('Workflow run ID.'),
      subquestions: { type: 'array', minItems: 1, items: subquestionSchema },
    }),
  ),
  set_execution_mode: tool(
    'set_execution_mode',
    'Choose sequential, single-pass, or verified subagent execution mode.',
    objectSchema({
      run_id: stringField('Workflow run ID.'),
      execution_mode: { type: 'string', enum: ['subagents', 'sequential_passes', 'single_main_pass'] },
      reason: stringField('Why this execution mode is appropriate.'),
      subagent_count: numberField('Claimed number of subagents.'),
      subagent_roles: stringArrayField('Claimed subagent roles.'),
      verified_subagent_job_ids: stringArrayField('Runtime-verified subagent job IDs.'),
    }),
  ),
  start_task: tool(
    'start_task',
    'Mark the next eligible task as running.',
    objectSchema({
      run_id: stringField('Workflow run ID.'),
      task_id: stringField('Task ID to start.'),
    }),
  ),
  complete_task: tool(
    'complete_task',
    'Close a running task with evidence or a blocked/skipped reason.',
    objectSchema({
      run_id: stringField('Workflow run ID.'),
      task_id: stringField('Task ID to complete.'),
      status: { type: 'string', enum: ['done', 'blocked', 'skipped'] },
      summary: stringField('Task result summary.'),
      output_artifact: { type: ['string', 'null'], description: 'Task artifact path, or null when not done.' },
      reason_if_not_done: nullableStringField('Required when status is blocked or skipped.'),
      evidence_count: numberField('Number of evidence items supporting this task.'),
      new_followup_tasks: { type: 'array', items: taskRecordSchema },
    }),
  ),
  add_followup_tasks: tool(
    'add_followup_tasks',
    'Append follow-up tasks discovered during execution.',
    objectSchema({
      run_id: stringField('Workflow run ID.'),
      parent_task_id: stringField('Task ID that produced the follow-up.'),
      tasks: { type: 'array', minItems: 1, items: taskRecordSchema },
    }),
  ),
  record_reconciliation: tool(
    'record_reconciliation',
    'Record contradiction, duplicate, weak-evidence, and uncertainty reconciliation.',
    objectSchema({
      run_id: stringField('Workflow run ID.'),
      contradictions_checked: booleanField('Whether contradictions were checked.'),
      duplicates_checked: booleanField('Whether duplicates were checked.'),
      weak_evidence_checked: booleanField('Whether weak evidence was checked.'),
      uncertainty_checked: booleanField('Whether uncertainty was checked.'),
      conflicts: { type: 'array', items: conflictSchema },
      no_conflicts_reason: nullableStringField('Required when conflicts is empty.'),
    }),
  ),
  submit_final_report: tool(
    'submit_final_report',
    'Submit the final report artifact after reconciliation.',
    objectSchema({
      run_id: stringField('Workflow run ID.'),
      artifact_path: stringField('Final artifact path.'),
      format: { type: 'string', enum: ['html', 'pdf', 'markdown_handoff', 'other'] },
      included_sections: stringArrayField('Final report sections included in the artifact.'),
    }),
  ),
  final_audit: tool(
    'final_audit',
    'Run the final workflow adherence audit before answering the user.',
    objectSchema({
      run_id: stringField('Workflow run ID.'),
    }),
  ),
};

export const toolSchemas = TOOL_SCHEMAS;
