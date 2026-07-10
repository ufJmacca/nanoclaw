import fs from 'fs';
import path from 'path';

import type {
  FinalAuditFile,
  ReconciliationRecord,
  RunState,
  SubquestionsFile,
  TaskFile,
  WorkflowContext,
} from './models.js';

export class WorkflowStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowStorageError';
  }
}

export function workflowRoot(context: WorkflowContext = {}): string {
  return context.rootDir ?? process.cwd();
}

export function researchDir(context: WorkflowContext = {}): string {
  if (context.runDir) return context.runDir;
  return path.join(workflowRoot(context), 'research');
}

export function findingsDir(context: WorkflowContext = {}): string {
  return path.join(researchDir(context), 'findings');
}

export function runStatePath(context: WorkflowContext = {}): string {
  return path.join(researchDir(context), 'run_state.yaml');
}

export function tasksPath(context: WorkflowContext = {}): string {
  return path.join(researchDir(context), 'tasks.yaml');
}

export function subquestionsPath(context: WorkflowContext = {}): string {
  return path.join(researchDir(context), 'subquestions.yaml');
}

export function reconciliationPath(context: WorkflowContext = {}): string {
  return path.join(researchDir(context), 'reconciliation.yaml');
}

export function finalAuditPath(context: WorkflowContext = {}): string {
  return path.join(researchDir(context), 'final-audit.json');
}

export function ensureResearchDirs(context: WorkflowContext = {}): void {
  fs.mkdirSync(findingsDir(context), { recursive: true });
}

export function exists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

export function resolveArtifactPath(artifactPath: string, context: WorkflowContext = {}): string {
  if (path.isAbsolute(artifactPath)) return artifactPath;
  if (context.runDir) {
    const normalized = artifactPath.split(/[\\/]+/).join('/');
    const relativeToRun = normalized.startsWith('research/') ? normalized.slice('research/'.length) : normalized;
    return path.join(context.runDir, relativeToRun);
  }
  return path.join(workflowRoot(context), artifactPath);
}

export function writeStructuredFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function readStructuredFile<T>(filePath: string): T {
  if (!fs.existsSync(filePath)) {
    throw new WorkflowStorageError(`Missing workflow storage file: ${filePath}`);
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new WorkflowStorageError(`Invalid YAML/JSON workflow storage file ${filePath}: ${detail}`);
  }
}

export function writeRunState(state: RunState, context: WorkflowContext = {}): void {
  ensureResearchDirs(context);
  writeStructuredFile(runStatePath(context), state);
}

export function readRunState(context: WorkflowContext = {}): RunState {
  return readStructuredFile<RunState>(runStatePath(context));
}

export function runStateExists(context: WorkflowContext = {}): boolean {
  return fs.existsSync(runStatePath(context));
}

export function writeTasksFile(taskFile: TaskFile, context: WorkflowContext = {}): void {
  ensureResearchDirs(context);
  writeStructuredFile(tasksPath(context), taskFile);
}

export function readTasksFile(context: WorkflowContext = {}): TaskFile {
  return readStructuredFile<TaskFile>(tasksPath(context));
}

export function tasksFileExists(context: WorkflowContext = {}): boolean {
  return fs.existsSync(tasksPath(context));
}

export function writeSubquestionsFile(subquestions: SubquestionsFile, context: WorkflowContext = {}): void {
  ensureResearchDirs(context);
  writeStructuredFile(subquestionsPath(context), subquestions);
}

export function readSubquestionsFile(context: WorkflowContext = {}): SubquestionsFile {
  return readStructuredFile<SubquestionsFile>(subquestionsPath(context));
}

export function writeReconciliationFile(reconciliation: ReconciliationRecord, context: WorkflowContext = {}): void {
  ensureResearchDirs(context);
  writeStructuredFile(reconciliationPath(context), reconciliation);
}

export function readReconciliationFile(context: WorkflowContext = {}): ReconciliationRecord {
  return readStructuredFile<ReconciliationRecord>(reconciliationPath(context));
}

export function writeFinalAuditFile(audit: FinalAuditFile, context: WorkflowContext = {}): void {
  ensureResearchDirs(context);
  writeStructuredFile(finalAuditPath(context), audit);
}

export function readFinalAuditFile(context: WorkflowContext = {}): FinalAuditFile {
  return readStructuredFile<FinalAuditFile>(finalAuditPath(context));
}
