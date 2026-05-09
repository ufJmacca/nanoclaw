import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentGroup } from './types.js';

let originalCwd: string;
let tmpDir: string;

function groupFixture(): AgentGroup {
  return {
    id: 'ag-test',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: '2026-05-08T00:00:00.000Z',
  };
}

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-group-init-'));
  process.chdir(tmpDir);
  vi.resetModules();
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

describe('initGroupFilesystem', () => {
  it('writes placeholder-only GitHub git credentials for container git operations', async () => {
    const { initGroupFilesystem } = await import('./group-init.js');

    initGroupFilesystem(groupFixture());

    const body = fs.readFileSync(path.join(tmpDir, 'groups', 'test-agent', '.gitconfig'), 'utf8');
    expect(body).toContain('[credential "https://github.com"]');
    expect(body).toContain('username=x-access-token');
    expect(body).toContain('password=placeholder');
    expect(body).not.toContain('github_pat_');
    expect(body).not.toContain('ghp_');
  });

  it('does not overwrite an existing group gitconfig', async () => {
    const groupDir = path.join(tmpDir, 'groups', 'test-agent');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, '.gitconfig'), '[user]\n  name = Existing\n');
    const { initGroupFilesystem } = await import('./group-init.js');

    initGroupFilesystem(groupFixture());

    expect(fs.readFileSync(path.join(groupDir, '.gitconfig'), 'utf8')).toBe('[user]\n  name = Existing\n');
  });
});
