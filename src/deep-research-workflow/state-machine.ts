import type { MutatingToolName, RunState, TaskFile, TaskRecord, TaskStatus, WorkflowState } from './models.js';
import { gatesForState, summarizeTasks } from './models.js';

export const stateAllowedTools: Record<WorkflowState, MutatingToolName[]> = {
  not_started: ['initialize_run'],
  initialized: ['set_deliverable_contract'],
  deliverable_defined: ['create_task_plan'],
  task_plan_created: ['set_subquestions'],
  subquestions_defined: ['set_execution_mode'],
  execution_mode_selected: ['start_task'],
  tasks_in_progress: ['complete_task', 'start_task', 'add_followup_tasks'],
  tasks_closed: ['record_reconciliation'],
  reconciliation_complete: ['submit_final_report'],
  final_report_submitted: ['final_audit'],
  audit_passed: [],
};

export function deriveAllowedNextTools(state: WorkflowState, tasks: TaskRecord[] = []): MutatingToolName[] {
  if (state !== 'tasks_in_progress') return stateAllowedTools[state];

  const hasRunning = tasks.some((task) => task.status === 'running');
  const hasTodo = tasks.some((task) => task.status === 'todo');
  const tools: MutatingToolName[] = [];

  if (hasRunning) tools.push('complete_task');
  if (hasTodo) tools.push('start_task');
  if (hasRunning || hasTodo) tools.push('add_followup_tasks');
  return tools.length > 0 ? tools : ['record_reconciliation'];
}

export function allowedNextToolString(tools: MutatingToolName[]): string | null {
  if (tools.length === 0) return null;
  return tools.join('|');
}

export function isMutatingToolAllowed(
  currentState: WorkflowState,
  toolName: MutatingToolName,
  tasks: TaskRecord[] = [],
): boolean {
  return deriveAllowedNextTools(currentState, tasks).includes(toolName);
}

export function outOfOrderErrors(
  currentState: WorkflowState,
  toolName: MutatingToolName,
  tasks: TaskRecord[] = [],
): string[] {
  if (isMutatingToolAllowed(currentState, toolName, tasks)) return [];
  const expected = allowedNextToolString(deriveAllowedNextTools(currentState, tasks)) ?? 'no further workflow tool';
  return [`Out-of-order tool call. Expected ${expected} because current_state is ${currentState}; got ${toolName}.`];
}

export function refreshRunState(state: RunState, tasks: TaskRecord[] = []): RunState {
  const allowed = deriveAllowedNextTools(state.current_state, tasks);
  return {
    ...state,
    allowed_next_tool: allowedNextToolString(allowed),
    allowed_next_tools: allowed,
    task_summary: summarizeTasks(tasks),
    gates: gatesForState(state.current_state),
  };
}

export function transitionRunState(state: RunState, nextState: WorkflowState, tasks: TaskRecord[] = []): RunState {
  const updated = {
    ...state,
    current_state: nextState,
    updated_at: state.updated_at,
  };
  return refreshRunState(updated, tasks);
}

export function allTasksClosed(tasks: TaskRecord[]): boolean {
  return tasks.length > 0 && tasks.every((task) => ['done', 'blocked', 'skipped'].includes(task.status));
}

export function openTasks(tasks: TaskRecord[]): TaskRecord[] {
  return tasks.filter((task) => task.status === 'todo' || task.status === 'running');
}

export function firstTodoTask(tasks: TaskRecord[]): TaskRecord | undefined {
  return tasks.find((task) => task.status === 'todo');
}

export function findTask(taskFile: TaskFile, taskId: string): TaskRecord | undefined {
  return taskFile.tasks.find((task) => task.id === taskId);
}

export function validateTaskStart(state: RunState, taskFile: TaskFile, taskId: string): string[] {
  const errors = outOfOrderErrors(state.current_state, 'start_task', taskFile.tasks);
  if (errors.length > 0) return errors;

  const task = findTask(taskFile, taskId);
  if (!task) return [`Task ${taskId} does not exist.`];
  if (task.status !== 'todo') return [`Task ${taskId} cannot be started because status is ${task.status}.`];

  const execution = state.execution;
  const verifiedSubagentMode = execution?.verified_subagent_mode === true;
  const strictSequentialMode = execution?.strict_sequential_task_mode !== false;
  const runningTasks = taskFile.tasks.filter((candidate) => candidate.status === 'running');

  if (!verifiedSubagentMode && runningTasks.length > 0) {
    return [`Cannot start ${taskId} while ${runningTasks.map((candidate) => candidate.id).join(', ')} is running.`];
  }

  if (strictSequentialMode) {
    const firstTodo = firstTodoTask(taskFile.tasks);
    if (firstTodo && firstTodo.id !== taskId) {
      return [`Strict sequential task mode requires starting ${firstTodo.id} before ${taskId}.`];
    }
  }

  return [];
}

export function markTaskStarted(
  state: RunState,
  taskFile: TaskFile,
  taskId: string,
  timestamp: string,
): { state: RunState; taskFile: TaskFile } {
  const tasks = taskFile.tasks.map((task) =>
    task.id === taskId
      ? {
          ...task,
          status: 'running' as TaskStatus,
          started_at: timestamp,
        }
      : task,
  );
  const current_state: WorkflowState = 'tasks_in_progress';
  return {
    taskFile: { ...taskFile, tasks },
    state: refreshRunState({ ...state, current_state, updated_at: timestamp }, tasks),
  };
}

export function validateTaskCompletion(
  state: RunState,
  taskFile: TaskFile,
  taskId: string,
  nextStatus: Exclude<TaskStatus, 'todo' | 'running'>,
): string[] {
  const errors = outOfOrderErrors(state.current_state, 'complete_task', taskFile.tasks);
  if (errors.length > 0) return errors;

  const task = findTask(taskFile, taskId);
  if (!task) return [`Task ${taskId} does not exist.`];
  if (task.status !== 'running') return [`Task ${taskId} cannot be completed because status is ${task.status}.`];
  if (!['done', 'blocked', 'skipped'].includes(nextStatus)) {
    return [`Task ${taskId} cannot be completed with status ${nextStatus}.`];
  }
  return [];
}

export function markTaskCompleted(
  state: RunState,
  taskFile: TaskFile,
  taskId: string,
  nextStatus: Exclude<TaskStatus, 'todo' | 'running'>,
  timestamp: string,
  details: Pick<TaskRecord, 'summary' | 'reason_if_not_done' | 'evidence_count'>,
): { state: RunState; taskFile: TaskFile } {
  const tasks = taskFile.tasks.map((task) =>
    task.id === taskId
      ? {
          ...task,
          ...details,
          status: nextStatus,
          completed_at: timestamp,
        }
      : task,
  );
  const current_state: WorkflowState = allTasksClosed(tasks) ? 'tasks_closed' : 'tasks_in_progress';
  return {
    taskFile: { ...taskFile, tasks },
    state: refreshRunState({ ...state, current_state, updated_at: timestamp }, tasks),
  };
}
