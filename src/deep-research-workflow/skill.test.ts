import fs from 'fs';
import { describe, expect, it } from 'vitest';

const skillPath = 'container/skills/deep-research/SKILL.md';

describe('deep research skill instructions', () => {
  it('declares workflow tools authoritative', () => {
    const skill = fs.readFileSync(skillPath, 'utf8');
    expect(skill).toContain('## Tool-enforced execution');
    expect(skill).toContain(
      'A workflow step is complete only when the corresponding workflow tool returns `ok: true`.',
    );
    expect(skill).toContain(
      'the first required workflow call is the `initialize_run` tool in the `nanoclaw` namespace',
    );
    expect(skill).toContain('Use the `get_run_state` tool in the `nanoclaw` namespace');
    expect(skill).toContain(
      'Do not produce the final answer until the `final_audit` tool in the `nanoclaw` namespace returns:',
    );
  });

  it('requires send_file for final report delivery when available', () => {
    const skill = fs.readFileSync(skillPath, 'utf8');
    expect(skill).toContain('call `mcp__nanoclaw__send_file` with `path` set to the returned `workflow_report_path`');
    expect(skill).toContain('only if `mcp__nanoclaw__send_file` is unavailable');
    expect(skill).not.toContain('Prefer a final file directive');
  });

  it('makes human-report HTML the default and removes the Markdown default', () => {
    const skill = fs.readFileSync(skillPath, 'utf8');
    expect(skill).toContain('Default mode is `human_report`.');
    expect(skill).toContain('Final format is HTML.');
    expect(skill).toContain('Workflow artifact is `research/final-report.html`.');
    expect(skill).toContain('Actual file path is the `workflow_report_path` returned by `initialize_run`.');
    expect(skill).not.toContain('Default to Markdown');
  });

  it('reserves Markdown for handoff mode unless explicitly allowed by contract', () => {
    const skill = fs.readFileSync(skillPath, 'utf8');
    expect(skill).toContain('Markdown is allowed.');
    expect(skill).toContain('Final artifact is `research/handoff.md`.');
    expect(skill).toContain(
      'Use Markdown only for `skill_handoff` mode or when the deliverable contract explicitly allows it.',
    );
  });
});
