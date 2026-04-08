import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const launchGatePath = path.join(
  repoRoot,
  'docs',
  'CODEX_PROVIDER_SKILLS_LAUNCH_GATE.md',
);
// Commit a stable reviewer-bundle snapshot so CI does not depend on
// developer-local `.ai-native/runs/...` artifacts.
const launchGateFixtureDir = path.join(
  repoRoot,
  'src',
  '__fixtures__',
  'codex-provider-launch-gate',
);
const codexSmokeSkillName = 'cps03-launch-gate-smoke-skill';
const smokePrompt =
  'Use the `cps03-launch-gate-smoke-skill` skill and reply with its exact confirmation payload.';

type PackageLock = {
  dependencies?: Record<string, { version?: string }>;
  packages?: Record<string, { version?: string }>;
};

type SmokeInput = {
  providerId: string;
  runtimeInput: {
    prompt: string;
    groupFolder: string;
    chatJid: string;
    isMain: boolean;
  };
};

function fixturePath(...segments: string[]): string {
  return path.join(launchGateFixtureDir, ...segments);
}

function readRepoFile(...segments: string[]): string {
  return readFileSync(path.join(repoRoot, ...segments), 'utf8');
}

function readFixture(...segments: string[]): string {
  return readFileSync(fixturePath(...segments), 'utf8').replace(/\r\n/g, '\n');
}

function listArtifactFiles(rootDir: string, relativeDir = ''): string[] {
  const absoluteDir = path.join(rootDir, relativeDir);

  return readdirSync(absoluteDir, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      return listArtifactFiles(rootDir, relativePath);
    }

    return [relativePath];
  });
}

function readInstalledCodexVersion(): string {
  const packageLock = JSON.parse(
    readRepoFile('container', 'agent-runner', 'package-lock.json'),
  ) as PackageLock;

  const version =
    packageLock.packages?.['node_modules/@openai/codex']?.version ??
    packageLock.dependencies?.['@openai/codex']?.version;

  if (!version) {
    throw new Error(
      'Expected container/agent-runner package-lock to pin @openai/codex',
    );
  }

  return version;
}

function extractVersion(versionArtifact: string): string {
  const match = versionArtifact.match(/codex-cli (\d+\.\d+\.\d+)/);

  if (!match) {
    throw new Error(
      'Expected smoke codex-version artifact to include codex-cli <semver>',
    );
  }

  return match[1];
}

describe('Codex provider launch gate', () => {
  it('keeps committed smoke fixtures proving real Codex skill discovery before any providerSkills flip', () => {
    // Arrange
    const transcriptPath = fixturePath('smoke-test-transcript.md');
    const containerOutputPath = fixturePath('smoke', 'container-output.log');
    const codexVersionPath = fixturePath('smoke', 'codex-version.txt');
    const inputPath = fixturePath('smoke', 'input.json');
    const configPath = fixturePath('smoke', 'codex-home-after', 'config.toml');
    const installedCodexVersion = readInstalledCodexVersion();

    // Act
    const transcript = readFixture('smoke-test-transcript.md');
    const containerOutput = readFixture('smoke', 'container-output.log');
    const versionArtifact = readFixture('smoke', 'codex-version.txt');
    const input = JSON.parse(readFixture('smoke', 'input.json')) as SmokeInput;
    const config = readFixture('smoke', 'codex-home-after', 'config.toml');
    const capturedCodexVersion = extractVersion(versionArtifact);

    // Assert
    for (const filePath of [
      transcriptPath,
      containerOutputPath,
      codexVersionPath,
      inputPath,
      configPath,
    ]) {
      expect(existsSync(filePath)).toBe(true);
    }
    expect(capturedCodexVersion).toBe(installedCodexVersion);
    expect(input).toEqual({
      providerId: 'codex',
      runtimeInput: {
        prompt: smokePrompt,
        groupFolder: 'cps03-smoke',
        chatJid: 'cps03-smoke@g.us',
        isMain: false,
      },
    });
    expect(transcript).toContain('Run date: 2026-04-08');
    expect(transcript).toContain(`codex-cli ${capturedCodexVersion}`);
    expect(transcript).toContain('`cwd=/workspace/group`');
    expect(transcript).toContain('`CODEX_HOME=/home/node/.codex`');
    expect(transcript).toContain('`/app/entrypoint.sh`');
    expect(transcript).toContain('`docker create -i --user root`');
    expect(transcript).toContain('`docker cp`');
    expect(transcript).toContain('`docker start -ai`');
    expect(transcript).toContain(smokePrompt);
    expect(transcript).toContain(
      `container/codex-skills/${codexSmokeSkillName}/SKILL.md`,
    );
    expect(transcript).toContain(
      `/workspace/group/.agents/skills/${codexSmokeSkillName}/SKILL.md`,
    );
    expect(transcript).toContain(
      'Credential-bearing Codex auth cache snapshots were intentionally excluded from the attachable reviewer bundle.',
    );
    expect(containerOutput).toContain(
      '[agent-runner] Received input for provider: codex',
    );
    expect(containerOutput).toContain(
      'I found a local skill definition in the workspace.',
    );
    expect(containerOutput).toContain('CPS03_SKILL_CONFIRMED');
    expect(containerOutput).toContain(
      `skill_path=/workspace/group/.agents/skills/${codexSmokeSkillName}/SKILL.md`,
    );
    expect(config).toContain('cli_auth_credentials_store = "file"');
    expect(config).toContain('[mcp_servers.nanoclaw]');
    expect(config).toContain('NANOCLAW_GROUP_FOLDER = "cps03-smoke"');
  });

  it('keeps the reviewer-facing launch gate doc aligned with the recorded smoke artifacts', () => {
    // Arrange
    const launchGate = readFileSync(launchGatePath, 'utf8').replace(
      /\r\n/g,
      '\n',
    );
    const installedCodexVersion = readInstalledCodexVersion();

    // Act
    const requiredSnippets = [
      '# Codex Provider Skills Launch Gate',
      'Run date: 2026-04-08',
      `Installed @openai/codex version: ${installedCodexVersion}`,
      '.ai-native/runs/20260408T020624697377Z-prd-codex-provider-skills/slices/CPS-03/smoke-test-transcript.md',
      '.ai-native/runs/20260408T020624697377Z-prd-codex-provider-skills/slices/CPS-03/smoke/container-output.log',
      '.ai-native/runs/20260408T020624697377Z-prd-codex-provider-skills/slices/CPS-03/smoke/codex-version.txt',
      '.ai-native/runs/20260408T020624697377Z-prd-codex-provider-skills/slices/CPS-03/smoke/codex-home-after/config.toml',
      'NanoClaw runtime boundary:',
      'cwd=/workspace/group',
      'CODEX_HOME=/home/node/.codex',
      `Temporary skill source: \`container/codex-skills/${codexSmokeSkillName}/SKILL.md\``,
      `Synced skill path: \`/workspace/group/.agents/skills/${codexSmokeSkillName}/SKILL.md\``,
      'Prompt used:',
      smokePrompt,
      'Observed evidence:',
      'CPS03_SKILL_CONFIRMED',
      'Attachable reviewer bundle intentionally excludes credential-bearing `auth.json` cache snapshots.',
      'Reviewer launch decision:',
      'keep `providerSkills: false`',
    ];

    // Assert
    for (const snippet of requiredSnippets) {
      expect(launchGate).toContain(snippet);
    }
  });

  it('keeps credential-bearing auth.json snapshots out of the committed fixture bundle', () => {
    // Act
    const authArtifacts = listArtifactFiles(launchGateFixtureDir).filter(
      (relativePath) => path.basename(relativePath) === 'auth.json',
    );

    // Assert
    expect(authArtifacts).toEqual([]);
  });
});
