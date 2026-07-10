import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildDeepResearchWorkflowMount, resolveProviderName, syncContainerSkillSymlinks } from './container-runner.js';
import type { ContainerConfig } from './container-config.js';

const tmpDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-skills-'));
  tmpDirs.push(dir);
  return dir;
}

function testConfig(skills: string[] | 'all'): ContainerConfig {
  return {
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills,
  };
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveProviderName', () => {
  it('prefers session over group and container.json', () => {
    expect(resolveProviderName('codex', 'opencode', 'claude')).toBe('codex');
  });

  it('falls back to group when session is null', () => {
    expect(resolveProviderName(null, 'codex', 'claude')).toBe('codex');
  });

  it('falls back to container.json when session and group are null', () => {
    expect(resolveProviderName(null, null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null, null)).toBe('codex');
    expect(resolveProviderName(null, 'OpenCode', null)).toBe('opencode');
    expect(resolveProviderName(null, null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'codex', null)).toBe('codex');
    expect(resolveProviderName(null, '', 'opencode')).toBe('opencode');
  });
});

describe('syncContainerSkillSymlinks', () => {
  it('adds selected container skills and preserves non-symlink provider entries', () => {
    const skillsDir = tempDir();
    fs.mkdirSync(path.join(skillsDir, '.system'));
    fs.symlinkSync('/app/skills/old-skill', path.join(skillsDir, 'old-skill'));

    syncContainerSkillSymlinks(skillsDir, testConfig(['welcome', 'frontend-engineer']));

    expect(fs.existsSync(path.join(skillsDir, '.system'))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'old-skill'))).toBe(false);
    expect(fs.readlinkSync(path.join(skillsDir, 'welcome'))).toBe('/app/skills/welcome');
    expect(fs.readlinkSync(path.join(skillsDir, 'frontend-engineer'))).toBe('/app/skills/frontend-engineer');
  });

  it('repairs stale selected skill symlinks', () => {
    const skillsDir = tempDir();
    fs.symlinkSync('/wrong/target', path.join(skillsDir, 'welcome'));

    syncContainerSkillSymlinks(skillsDir, testConfig(['welcome']));

    expect(fs.readlinkSync(path.join(skillsDir, 'welcome'))).toBe('/app/skills/welcome');
  });
});

describe('buildDeepResearchWorkflowMount', () => {
  it('mounts the shared workflow module read-only inside agent containers', () => {
    const root = tempDir();
    const workflowDir = path.join(root, 'src', 'deep-research-workflow');
    fs.mkdirSync(workflowDir, { recursive: true });

    expect(buildDeepResearchWorkflowMount(root)).toEqual({
      hostPath: workflowDir,
      containerPath: '/app/deep-research-workflow',
      readonly: true,
    });
  });

  it('skips the mount when the shared workflow module is absent', () => {
    expect(buildDeepResearchWorkflowMount(tempDir())).toBeNull();
  });
});
