import fs from 'fs';
import { pathToFileURL } from 'url';

import type { WorkflowContext, WorkflowToolResult } from './models.js';
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
} from './tools.js';

type CliResult = {
  exitCode: number;
  stdout: string;
};

type ParsedArgs = {
  command: string | null;
  rootDir?: string;
  jsonPath?: string;
  runId?: string | null;
  taskId?: string;
  allowFailure: boolean;
};

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: argv[0] ?? null,
    allowFailure: false,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') parsed.rootDir = argv[++index];
    else if (arg === '--json') parsed.jsonPath = argv[++index];
    else if (arg === '--run-id') parsed.runId = argv[++index];
    else if (arg === '--task-id') parsed.taskId = argv[++index];
    else if (arg === '--allow-failure') parsed.allowFailure = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function readJsonInput(jsonPath: string | undefined): unknown {
  if (!jsonPath) throw new Error('Missing --json input.');
  const content = jsonPath === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(jsonPath, 'utf8');
  return JSON.parse(content);
}

function cliFailure(message: string): WorkflowToolResult {
  return {
    ok: false,
    run_id: null,
    current_state: 'not_started',
    allowed_next_tool: 'initialize_run',
    errors: [message],
    warnings: [],
  };
}

function invoke(parsed: ParsedArgs): WorkflowToolResult {
  const context: WorkflowContext = { rootDir: parsed.rootDir };

  switch (parsed.command) {
    case 'describe-capabilities':
      return describeWorkflowCapabilities(context);
    case 'get-state':
      return getRunState({ run_id: parsed.runId ?? null }, context);
    case 'initialize-run':
      return initializeRun(readJsonInput(parsed.jsonPath) as Parameters<typeof initializeRun>[0], context);
    case 'set-deliverable':
      return setDeliverableContract(
        readJsonInput(parsed.jsonPath) as Parameters<typeof setDeliverableContract>[0],
        context,
      );
    case 'create-task-plan':
      return createTaskPlan(readJsonInput(parsed.jsonPath) as Parameters<typeof createTaskPlan>[0], context);
    case 'set-subquestions':
      return setSubquestions(readJsonInput(parsed.jsonPath) as Parameters<typeof setSubquestions>[0], context);
    case 'set-execution-mode':
      return setExecutionMode(readJsonInput(parsed.jsonPath) as Parameters<typeof setExecutionMode>[0], context);
    case 'start-task':
      if (!parsed.runId) throw new Error('Missing --run-id.');
      if (!parsed.taskId) throw new Error('Missing --task-id.');
      return startTask({ run_id: parsed.runId, task_id: parsed.taskId }, context);
    case 'complete-task':
      return completeTask(readJsonInput(parsed.jsonPath) as Parameters<typeof completeTask>[0], context);
    case 'add-followup-tasks':
      return addFollowupTasks(readJsonInput(parsed.jsonPath) as Parameters<typeof addFollowupTasks>[0], context);
    case 'record-reconciliation':
      return recordReconciliation(
        readJsonInput(parsed.jsonPath) as Parameters<typeof recordReconciliation>[0],
        context,
      );
    case 'submit-final-report':
      return submitFinalReport(readJsonInput(parsed.jsonPath) as Parameters<typeof submitFinalReport>[0], context);
    case 'final-audit':
      if (!parsed.runId) throw new Error('Missing --run-id.');
      return finalAudit({ run_id: parsed.runId }, context);
    default:
      throw new Error(`Unknown command: ${parsed.command ?? '(none)'}`);
  }
}

export function runCli(argv: string[]): CliResult {
  let allowFailure = false;
  let result: WorkflowToolResult;
  try {
    const parsed = parseArgs(argv);
    allowFailure = parsed.allowFailure;
    result = invoke(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result = cliFailure(message);
  }

  return {
    exitCode: result.ok || allowFailure ? 0 : 1,
    stdout: `${JSON.stringify(result, null, 2)}\n`,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runCli(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.exitCode = result.exitCode;
}
