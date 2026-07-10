import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

export const DEEP_RESEARCH_WORKFLOW_ROOT_ENV = 'DEEP_RESEARCH_WORKFLOW_ROOT';
export const DEFAULT_DEEP_RESEARCH_WORKFLOW_ROOT = '/workspace/agent';

type WorkflowContext = {
  rootDir?: string;
  runDir?: string;
  now?: Date;
};

type WorkflowToolResult = {
  ok: boolean;
  run_id: string | null;
  current_state: string;
  allowed_next_tool: string | null;
  errors: string[];
  warnings: string[];
  [key: string]: unknown;
};

type WorkflowToolSchema = {
  name: string;
  description: string;
  parameters: Tool['inputSchema'];
};

type WorkflowToolFunction = (
  inputOrContext?: Record<string, unknown> | WorkflowContext,
  context?: WorkflowContext,
) => WorkflowToolResult | Promise<WorkflowToolResult>;

type SharedWorkflowModule = {
  TOOL_SCHEMAS: Record<string, WorkflowToolSchema>;
  deepResearchWorkflowTools: Record<string, WorkflowToolFunction>;
};

interface RunIndexEntry {
  run_id: string;
  slug: string;
  runDir: string;
  created_at: string;
  updated_at: string;
  original_user_request: string;
  current_state: string;
}

interface RunIndexFile {
  schema_version: 1;
  runs: RunIndexEntry[];
}

interface ResolvedWorkflowContext {
  context: WorkflowContext;
  entry?: RunIndexEntry;
  legacySingleton?: boolean;
}

const RUN_INDEX_SCHEMA_VERSION = 1;
const RUN_INDEX_FILENAME = '.workflow-runs.json';
const COMPLETED_STATE = 'audit_passed';

function workflowRoot(rootDir?: string): string {
  return rootDir ?? process.env[DEEP_RESEARCH_WORKFLOW_ROOT_ENV] ?? DEFAULT_DEEP_RESEARCH_WORKFLOW_ROOT;
}

function researchRoot(rootDir: string): string {
  return path.join(rootDir, 'research');
}

function runIndexPath(rootDir: string): string {
  return path.join(researchRoot(rootDir), RUN_INDEX_FILENAME);
}

function readRunIndex(rootDir: string): RunIndexFile {
  const indexPath = runIndexPath(rootDir);
  if (!fs.existsSync(indexPath)) return { schema_version: RUN_INDEX_SCHEMA_VERSION, runs: [] };
  const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as Partial<RunIndexFile>;
  if (!Array.isArray(parsed.runs)) return { schema_version: RUN_INDEX_SCHEMA_VERSION, runs: [] };
  return {
    schema_version: RUN_INDEX_SCHEMA_VERSION,
    runs: parsed.runs.filter((entry): entry is RunIndexEntry => {
      return (
        typeof entry.run_id === 'string' &&
        typeof entry.slug === 'string' &&
        typeof entry.runDir === 'string' &&
        typeof entry.created_at === 'string' &&
        typeof entry.updated_at === 'string' &&
        typeof entry.original_user_request === 'string' &&
        typeof entry.current_state === 'string'
      );
    }),
  };
}

function writeRunIndex(rootDir: string, index: RunIndexFile): void {
  const indexPath = runIndexPath(rootDir);
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
}

function toPosixRelative(rootDir: string, target: string): string {
  return path.relative(rootDir, target).split(path.sep).join('/');
}

function isPathInside(parent: string, child: string): boolean {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  return resolvedChild === resolvedParent || resolvedChild.startsWith(`${resolvedParent}${path.sep}`);
}

function assertIndexedRunDir(rootDir: string, runDir: string): string {
  const resolved = path.resolve(runDir);
  const research = path.resolve(researchRoot(rootDir));
  if (!isPathInside(research, resolved)) {
    throw new Error(`Indexed workflow run directory escapes research root: ${runDir}`);
  }
  return resolved;
}

function slugify(text: string): string {
  const normalized = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72)
    .replace(/-+$/g, '');
  return normalized || 'deep-research';
}

function timestampSlug(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function generatedRunIdFor(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return [
    'dr',
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`,
  ].join('_');
}

function uniqueRunDate(rootDir: string): Date {
  const existingRunIds = new Set(readRunIndex(rootDir).runs.map((run) => run.run_id));
  const legacyState = readRunStateAt(legacySingletonRunDir(rootDir));
  if (legacyState?.run_id) existingRunIds.add(legacyState.run_id);

  let candidate = new Date();
  for (let attempts = 0; attempts < 1000; attempts++) {
    if (!existingRunIds.has(generatedRunIdFor(candidate))) return candidate;
    candidate = new Date(candidate.getTime() + 1000);
  }
  return candidate;
}

function uniqueRunSlug(rootDir: string, args: Record<string, unknown>, date: Date): string {
  const source =
    (typeof args.restated_research_question === 'string' && args.restated_research_question) ||
    (typeof args.original_user_request === 'string' && args.original_user_request) ||
    'deep research';
  const base = `${slugify(source)}-${timestampSlug(date)}`;
  let slug = base;
  let suffix = 2;
  while (fs.existsSync(path.join(researchRoot(rootDir), slug))) {
    slug = `${base}-${suffix++}`;
  }
  return slug;
}

function readRunStateAt(runDir: string): {
  run_id?: string;
  current_state?: string;
  deliverable?: { final_artifact?: unknown };
} | null {
  const statePath = path.join(runDir, 'run_state.yaml');
  if (!fs.existsSync(statePath)) return null;
  return JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
    run_id?: string;
    current_state?: string;
    deliverable?: { final_artifact?: unknown };
  };
}

function legacySingletonRunDir(rootDir: string): string {
  return researchRoot(rootDir);
}

function resolveContextForRunId(rootDir: string, runId: string): ResolvedWorkflowContext | { error: string } {
  const index = readRunIndex(rootDir);
  const entry = index.runs.find((run) => run.run_id === runId);
  if (entry) {
    const runDir = assertIndexedRunDir(rootDir, entry.runDir);
    return { context: { rootDir, runDir }, entry: { ...entry, runDir } };
  }

  const legacyState = readRunStateAt(legacySingletonRunDir(rootDir));
  if (legacyState?.run_id === runId) {
    return { context: { rootDir }, legacySingleton: true };
  }

  return { error: `Unknown deep-research workflow run_id: ${runId}. Start a new run with initialize_run.` };
}

function latestIncompleteRun(rootDir: string): ResolvedWorkflowContext | null {
  const index = readRunIndex(rootDir);
  for (const entry of [...index.runs].reverse()) {
    const runDir = assertIndexedRunDir(rootDir, entry.runDir);
    const state = readRunStateAt(runDir);
    const currentState = state?.current_state ?? entry.current_state;
    if (currentState && currentState !== COMPLETED_STATE) {
      return { context: { rootDir, runDir }, entry: { ...entry, runDir, current_state: currentState } };
    }
  }

  const legacyState = readRunStateAt(legacySingletonRunDir(rootDir));
  if (legacyState?.current_state && legacyState.current_state !== COMPLETED_STATE) {
    return { context: { rootDir }, legacySingleton: true };
  }

  return null;
}

function updateRunIndex(rootDir: string, entry: RunIndexEntry, result: WorkflowToolResult): void {
  const index = readRunIndex(rootDir);
  const nextEntry: RunIndexEntry = {
    ...entry,
    current_state: result.current_state,
    updated_at: new Date().toISOString(),
  };
  const nextRuns = index.runs.filter((run) => run.run_id !== entry.run_id);
  nextRuns.push(nextEntry);
  writeRunIndex(rootDir, { schema_version: RUN_INDEX_SCHEMA_VERSION, runs: nextRuns });
}

function adapterDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function workflowModuleCandidates(): string[] {
  return [
    '/app/deep-research-workflow/index.ts',
    path.resolve(adapterDir(), '../../../../src/deep-research-workflow/index.ts'),
  ];
}

export function resolveDeepResearchWorkflowModulePath(): string {
  const modulePath = workflowModuleCandidates().find((candidate) => fs.existsSync(candidate));
  if (!modulePath) {
    throw new Error(`Deep research workflow module not found. Checked: ${workflowModuleCandidates().join(', ')}`);
  }
  return modulePath;
}

async function loadSharedWorkflowModule(): Promise<SharedWorkflowModule> {
  const modulePath = resolveDeepResearchWorkflowModulePath();
  const loaded = (await import(pathToFileURL(modulePath).href)) as Partial<SharedWorkflowModule>;
  if (!loaded.TOOL_SCHEMAS || !loaded.deepResearchWorkflowTools) {
    throw new Error(
      `Deep research workflow module at ${modulePath} does not export TOOL_SCHEMAS and deepResearchWorkflowTools.`,
    );
  }
  return loaded as SharedWorkflowModule;
}

function invokeWorkflowTool(
  name: string,
  fn: WorkflowToolFunction,
  args: Record<string, unknown>,
  context: WorkflowContext,
): WorkflowToolResult | Promise<WorkflowToolResult> {
  if (name === 'describe_workflow_capabilities') {
    return fn(context);
  }
  return fn(args, context);
}

function errorResult(error: unknown): WorkflowToolResult {
  return {
    ok: false,
    run_id: null,
    current_state: 'not_started',
    allowed_next_tool: 'initialize_run',
    errors: [error instanceof Error ? error.message : String(error)],
    warnings: [],
  };
}

function notStartedResult(): WorkflowToolResult {
  return {
    ok: true,
    run_id: null,
    current_state: 'not_started',
    allowed_next_tool: 'initialize_run',
    errors: [],
    warnings: [],
    deliverable_contract: null,
    task_counts: { total: 0, todo: 0, running: 0, done: 0, blocked: 0, skipped: 0 },
    open_tasks: [],
    completed_gates: [],
    blocking_errors: [],
  };
}

function enrichResult(result: WorkflowToolResult, rootDir: string, entry?: RunIndexEntry): WorkflowToolResult {
  if (!entry) return result;
  const runPath = toPosixRelative(rootDir, entry.runDir);
  const finalArtifact = readRunStateAt(entry.runDir)?.deliverable?.final_artifact;
  return {
    ...result,
    workflow_run_slug: entry.slug,
    workflow_run_path: runPath,
    workflow_report_path: `${runPath}/final-report.html`,
    workflow_handoff_path: `${runPath}/handoff.md`,
    workflow_pdf_path: `${runPath}/final-report.pdf`,
    workflow_submit_artifact_path: typeof finalArtifact === 'string' ? finalArtifact : 'research/final-report.html',
  };
}

function normalizeArtifactPathForRun(value: string, rootDir: string, entry: RunIndexEntry): string {
  const runPath = toPosixRelative(rootDir, entry.runDir);
  if (value === runPath) return 'research';
  if (value.startsWith(`${runPath}/`)) return `research/${value.slice(runPath.length + 1)}`;
  return value;
}

function normalizeWorkflowArgsForRun(value: unknown, rootDir: string, entry: RunIndexEntry): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeWorkflowArgsForRun(item, rootDir, entry));
  if (!value || typeof value !== 'object') return value;

  const normalized: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if ((key === 'artifact_path' || key === 'output_artifact') && typeof entryValue === 'string') {
      normalized[key] = normalizeArtifactPathForRun(entryValue, rootDir, entry);
    } else {
      normalized[key] = normalizeWorkflowArgsForRun(entryValue, rootDir, entry);
    }
  }
  return normalized;
}

function toMcpResult(result: WorkflowToolResult, rootDir: string, entry?: RunIndexEntry): CallToolResult {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(enrichResult(result, rootDir, entry), null, 2) }],
    isError: !result.ok,
  };
}

export async function buildDeepResearchWorkflowMcpTools(rootDir?: string): Promise<McpToolDefinition[]> {
  const shared = await loadSharedWorkflowModule();
  const root = workflowRoot(rootDir);
  return Object.values(shared.TOOL_SCHEMAS).map((schema) => {
    const workflowTool = shared.deepResearchWorkflowTools[schema.name];
    if (!workflowTool) {
      throw new Error(`Deep research workflow function missing for schema ${schema.name}.`);
    }

    return {
      tool: {
        name: schema.name,
        description: schema.description,
        inputSchema: schema.parameters,
      },
      async handler(args) {
        try {
          const toolArgs = args ?? {};

          if (schema.name === 'initialize_run') {
            const now = uniqueRunDate(root);
            const slug = uniqueRunSlug(root, toolArgs, now);
            const runDir = path.join(researchRoot(root), slug);
            const result = await invokeWorkflowTool(schema.name, workflowTool, toolArgs, {
              rootDir: root,
              runDir,
              now,
            });
            if (!result.ok || !result.run_id) return toMcpResult(result, root);

            const entry: RunIndexEntry = {
              run_id: result.run_id,
              slug,
              runDir,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              original_user_request:
                typeof toolArgs.original_user_request === 'string' ? toolArgs.original_user_request : '',
              current_state: result.current_state,
            };
            const index = readRunIndex(root);
            writeRunIndex(root, {
              schema_version: RUN_INDEX_SCHEMA_VERSION,
              runs: [...index.runs.filter((run) => run.run_id !== entry.run_id), entry],
            });
            return toMcpResult(result, root, entry);
          }

          if (schema.name === 'get_run_state') {
            const requestedRunId = typeof toolArgs.run_id === 'string' ? toolArgs.run_id : null;
            const resolved = requestedRunId ? resolveContextForRunId(root, requestedRunId) : latestIncompleteRun(root);
            if (!resolved) return toMcpResult(notStartedResult(), root);
            if ('error' in resolved) return toMcpResult(errorResult(resolved.error), root);

            const result = await invokeWorkflowTool(schema.name, workflowTool, toolArgs, resolved.context);
            return toMcpResult(result, root, resolved.entry);
          }

          if (schema.name === 'describe_workflow_capabilities') {
            const result = await invokeWorkflowTool(schema.name, workflowTool, toolArgs, { rootDir: root });
            return toMcpResult(result, root);
          }

          const runId = typeof toolArgs.run_id === 'string' ? toolArgs.run_id : '';
          if (!runId) {
            return toMcpResult(errorResult(`${schema.name} requires run_id from initialize_run.`), root);
          }

          const resolved = resolveContextForRunId(root, runId);
          if ('error' in resolved) return toMcpResult(errorResult(resolved.error), root);

          const normalizedArgs = resolved.entry
            ? (normalizeWorkflowArgsForRun(toolArgs, root, resolved.entry) as Record<string, unknown>)
            : toolArgs;
          const result = await invokeWorkflowTool(schema.name, workflowTool, normalizedArgs, resolved.context);
          if (result.ok && resolved.entry) updateRunIndex(root, resolved.entry, result);
          return toMcpResult(result, root, resolved.entry);
        } catch (error) {
          return toMcpResult(errorResult(error), root);
        }
      },
    };
  });
}

export const deepResearchWorkflowMcpTools = await buildDeepResearchWorkflowMcpTools();

registerTools(deepResearchWorkflowMcpTools);
