import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'bun:test';

import {
  buildDeepResearchWorkflowMcpTools,
  deepResearchWorkflowMcpTools,
  resolveDeepResearchWorkflowModulePath,
} from './deep-research-workflow.js';
import type { McpToolDefinition } from './types.js';

const expectedToolNames = [
  'describe_workflow_capabilities',
  'get_run_state',
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
];

const tmpDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-deep-research-'));
  tmpDirs.push(dir);
  return dir;
}

function toolByName(tools: McpToolDefinition[], name: string): McpToolDefinition {
  const tool = tools.find((candidate) => candidate.tool.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

function parseMcpJson(result: Awaited<ReturnType<McpToolDefinition['handler']>>): Record<string, unknown> {
  const first = result.content[0];
  if (first.type !== 'text') throw new Error('Expected text result');
  return JSON.parse(first.text) as Record<string, unknown>;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('deep research workflow MCP adapter', () => {
  it('loads the shared workflow module from the container mount or local test fallback', () => {
    expect(resolveDeepResearchWorkflowModulePath().endsWith('/deep-research-workflow/index.ts')).toBe(true);
  });

  it('builds and registers all expected workflow tool names', () => {
    expect(deepResearchWorkflowMcpTools.map((entry) => entry.tool.name).sort()).toEqual([...expectedToolNames].sort());
  });

  it('calls initialize_run through the MCP handler and writes durable state under the configured root', async () => {
    const root = tempDir();
    const tools = await buildDeepResearchWorkflowMcpTools(root);
    const initializeRun = toolByName(tools, 'initialize_run');

    const result = await initializeRun.handler({
      original_user_request: 'Research whether deep-research workflow tools are available in the Telegram container.',
      restated_research_question:
        'Are deep-research workflow tools callable from inside the Telegram NanoClaw agent container?',
      quick_answer_requested: false,
    });

    const parsed = parseMcpJson(result);
    expect(result.isError).toBe(false);
    expect(parsed.ok).toBe(true);
    expect(parsed.current_state).toBe('initialized');
    expect(parsed.allowed_next_tool).toBe('set_deliverable_contract');
    expect(typeof parsed.workflow_run_path).toBe('string');
    expect(fs.existsSync(path.join(root, parsed.workflow_run_path as string, 'run_state.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'research', '.workflow-runs.json'))).toBe(true);
    expect(parsed.workflow_report_path).toBe(`${parsed.workflow_run_path}/final-report.html`);
    expect(parsed.workflow_submit_artifact_path).toBe('research/final-report.html');
  });

  it('creates a separate run directory for each initialize_run call', async () => {
    const root = tempDir();
    const tools = await buildDeepResearchWorkflowMcpTools(root);
    const initializeRun = toolByName(tools, 'initialize_run');

    const first = parseMcpJson(
      await initializeRun.handler({
        original_user_request: 'Research Obsidian support for AI systems.',
        restated_research_question: 'How can Obsidian support AI systems?',
        quick_answer_requested: false,
      }),
    );
    const second = parseMcpJson(
      await initializeRun.handler({
        original_user_request: 'Research groundedness verification methods.',
        restated_research_question: 'How can groundedness verification work without raw provider sources?',
        quick_answer_requested: false,
      }),
    );

    expect(first.run_id).not.toBe(second.run_id);
    expect(first.workflow_run_path).not.toBe(second.workflow_run_path);
    expect(fs.existsSync(path.join(root, first.workflow_run_path as string, 'run_state.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(root, second.workflow_run_path as string, 'run_state.yaml'))).toBe(true);

    const index = JSON.parse(fs.readFileSync(path.join(root, 'research', '.workflow-runs.json'), 'utf8')) as {
      runs: Array<{ run_id: string }>;
    };
    expect(index.runs.map((run) => run.run_id).sort()).toEqual([first.run_id, second.run_id].sort());
  });

  it('routes later calls by run_id into the indexed run directory', async () => {
    const root = tempDir();
    const tools = await buildDeepResearchWorkflowMcpTools(root);
    const initializeRun = toolByName(tools, 'initialize_run');
    const getRunState = toolByName(tools, 'get_run_state');
    const setDeliverable = toolByName(tools, 'set_deliverable_contract');

    const initialized = parseMcpJson(
      await initializeRun.handler({
        original_user_request: 'Research Obsidian support for AI systems.',
        restated_research_question: 'How can Obsidian support AI systems?',
        quick_answer_requested: false,
      }),
    );

    const delivered = parseMcpJson(
      await setDeliverable.handler({
        run_id: initialized.run_id,
        audience: 'technical reader',
        final_format: 'markdown_handoff',
        output_mode: 'skill_handoff',
        depth: 'standard',
        source_requirements: 'Use high-quality sources.',
        time_horizon: 'current',
        key_comparison_dimensions: ['workflow fit'],
        done_criteria: ['report generated'],
        markdown_allowed_reason: 'This run produces a downstream skill handoff.',
      }),
    );

    const state = parseMcpJson(await getRunState.handler({ run_id: initialized.run_id }));
    expect(delivered.ok).toBe(true);
    expect(delivered.workflow_submit_artifact_path).toBe('research/handoff.md');
    expect(state.current_state).toBe('deliverable_defined');
    expect(state.workflow_run_path).toBe(initialized.workflow_run_path);
    expect(fs.existsSync(path.join(root, initialized.workflow_run_path as string, 'run_state.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'research', 'run_state.yaml'))).toBe(false);
  });

  it('returns an MCP error for out-of-order calls without advancing durable state', async () => {
    const root = tempDir();
    const tools = await buildDeepResearchWorkflowMcpTools(root);
    const initializeRun = toolByName(tools, 'initialize_run');
    const submitFinalReport = toolByName(tools, 'submit_final_report');

    const initialized = parseMcpJson(
      await initializeRun.handler({
        original_user_request: 'Research the runtime workflow adapter registration behavior.',
        restated_research_question: 'Does the runtime workflow adapter reject out-of-order final report submission?',
        quick_answer_requested: false,
      }),
    );

    const rejected = await submitFinalReport.handler({
      run_id: initialized.run_id,
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
    });

    const parsed = parseMcpJson(rejected);
    const state = JSON.parse(
      fs.readFileSync(path.join(root, initialized.workflow_run_path as string, 'run_state.yaml'), 'utf8'),
    ) as {
      current_state: string;
      final_report?: unknown;
    };

    expect(rejected.isError).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.current_state).toBe('initialized');
    expect(state.current_state).toBe('initialized');
    expect(state.final_report).toBeUndefined();
  });

  it('returns not_started for get_run_state(null) when only completed indexed runs exist', async () => {
    const root = tempDir();
    const research = path.join(root, 'research');
    const runDir = path.join(research, 'completed-run');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'run_state.yaml'),
      JSON.stringify({ run_id: 'dr_done', current_state: 'audit_passed' }),
    );
    fs.writeFileSync(
      path.join(research, '.workflow-runs.json'),
      JSON.stringify({
        schema_version: 1,
        runs: [
          {
            run_id: 'dr_done',
            slug: 'completed-run',
            runDir,
            created_at: '2026-05-15T00:00:00.000Z',
            updated_at: '2026-05-15T00:00:00.000Z',
            original_user_request: 'done',
            current_state: 'audit_passed',
          },
        ],
      }),
    );

    const tools = await buildDeepResearchWorkflowMcpTools(root);
    const state = parseMcpJson(await toolByName(tools, 'get_run_state').handler({ run_id: null }));

    expect(state.ok).toBe(true);
    expect(state.current_state).toBe('not_started');
    expect(state.allowed_next_tool).toBe('initialize_run');
  });
});
