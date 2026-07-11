/**
 * Container Runner v2
 * Spawns agent containers with session folder + agent group folder mounts.
 * The container runs the v2 agent-runner which polls the session DB.
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  CONTAINER_IMAGE,
  CONTAINER_IMAGE_BASE,
  CONTAINER_INSTALL_LABEL,
  DATA_DIR,
  GROUPS_DIR,
  ONECLI_API_KEY,
  ONECLI_URL,
  TIMEZONE,
} from './config.js';
import { validateMattermostSessionForExecution } from './channels/mattermost-subscription.js';
import { readContainerConfig, writeContainerConfig, type ContainerConfig } from './container-config.js';
import { CONTAINER_RUNTIME_BIN, hostGatewayArgs, readonlyMountArgs, stopContainer } from './container-runtime.js';
import { composeGroupClaudeMd } from './claude-md-compose.js';
import { getAgentGroup, getAllAgentGroups } from './db/agent-groups.js';
import { getDb, hasTable } from './db/connection.js';
import { initGroupFilesystem } from './group-init.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { validateAdditionalMounts } from './modules/mount-security/index.js';
// Provider host-side config barrel — each provider that needs host-side
// container setup self-registers on import.
import './providers/index.js';
import {
  getProviderContainerConfig,
  type ProviderContainerContribution,
  type VolumeMount,
} from './providers/provider-container-registry.js';
import {
  heartbeatPath,
  inboundDbPath,
  markContainerRunning,
  markContainerStopped,
  sessionDir,
  writeSessionRouting,
} from './session-manager.js';
import type { AgentGroup, Session } from './types.js';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

interface ContainerExecutionIdentity {
  sessionId: string;
  agentGroupId: string;
  messagingGroupId: string | null;
  threadId: string | null;
}

interface ActiveContainerEntry {
  process: ChildProcess;
  containerName: string;
  identity: ContainerExecutionIdentity;
}

function executionIdentity(session: Session): ContainerExecutionIdentity {
  return {
    sessionId: session.id,
    agentGroupId: session.agent_group_id,
    messagingGroupId: session.messaging_group_id,
    threadId: session.thread_id,
  };
}

function sameExecutionIdentity(left: ContainerExecutionIdentity, right: ContainerExecutionIdentity): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.agentGroupId === right.agentGroupId &&
    left.messagingGroupId === right.messagingGroupId &&
    left.threadId === right.threadId
  );
}

/** Active containers tracked by session ID and bound to one immutable execution identity. */
const activeContainers = new Map<string, ActiveContainerEntry>();

/**
 * In-flight wake promises, keyed by session id. Deduplicates concurrent
 * `wakeContainer` calls while the first spawn is still mid-setup (async
 * buildContainerArgs, OneCLI gateway apply, etc.) — otherwise a second
 * wake in that window passes the `activeContainers.has` check and spawns
 * a duplicate container against the same session directory, producing
 * racy double-replies.
 */
const wakePromises = new Map<string, { identity: ContainerExecutionIdentity; promise: Promise<boolean> }>();

export function getActiveContainerCount(): number {
  return activeContainers.size;
}

export function isContainerRunning(sessionId: string): boolean {
  return activeContainers.has(sessionId);
}

/**
 * Wake up a container for a session. If already running or mid-spawn, no-op
 * (the in-flight wake promise is reused).
 *
 * The container runs the v2 agent-runner which polls the session DB.
 *
 * Contract: never throws. Returns `true` on successful spawn, `false` on
 * transient spawn failure (e.g. OneCLI gateway unreachable). Callers don't
 * need to wrap — the inbound row stays pending and host-sweep retries on
 * its next tick. Callers that care (e.g. the router's typing indicator)
 * can branch on the boolean.
 */
export function wakeContainer(session: Session): Promise<boolean> {
  const identity = executionIdentity(session);
  const active = activeContainers.get(session.id);
  const mattermostBoundary = validateMattermostSessionForExecution(session);
  if (mattermostBoundary.strict && !mattermostBoundary.valid) {
    if (active && sameExecutionIdentity(active.identity, identity)) {
      killContainer(session.id, `Mattermost execution session invalid: ${mattermostBoundary.reason}`);
    }
    log.warn('Mattermost execution session rejected before wake', {
      sessionId: session.id,
      reason: mattermostBoundary.reason,
    });
    return Promise.resolve(false);
  }

  if (active) {
    if (!sameExecutionIdentity(active.identity, identity)) {
      log.error('Container session identity collision rejected', { sessionId: session.id });
      return Promise.resolve(false);
    }
    log.debug('Container already running', { sessionId: session.id });
    return Promise.resolve(true);
  }
  const existing = wakePromises.get(session.id);
  if (existing) {
    if (!sameExecutionIdentity(existing.identity, identity)) {
      log.error('In-flight container session identity collision rejected', { sessionId: session.id });
      return Promise.resolve(false);
    }
    log.debug('Container wake already in-flight — joining existing promise', { sessionId: session.id });
    return existing.promise;
  }
  const promise = spawnContainer(session)
    .then(() => true)
    .catch((err) => {
      log.warn('wakeContainer failed — host-sweep will retry', { sessionId: session.id, err });
      return false;
    })
    .finally(() => {
      wakePromises.delete(session.id);
    });
  wakePromises.set(session.id, { identity, promise });
  return promise;
}

async function spawnContainer(session: Session): Promise<void> {
  const mattermostBoundary = validateMattermostSessionForExecution(session);
  if (mattermostBoundary.strict && !mattermostBoundary.valid) {
    throw new Error(`Invalid Mattermost execution session: ${mattermostBoundary.reason}`);
  }

  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    log.error('Agent group not found', { agentGroupId: session.agent_group_id });
    return;
  }
  assertHostManagedPaths(agentGroup, session);
  assertNoAgentRootOverlap(agentGroup);
  assertNoMattermostCredentialsInContainerConfigArtifact(agentGroup.folder);

  // Refresh the destination map and default reply routing so any admin
  // changes take effect on wake. Destinations come from the agent-to-agent
  // module — skip when the module isn't installed (table absent).
  if (hasTable(getDb(), 'agent_destinations')) {
    const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');
    writeDestinations(agentGroup.id, session.id);
  }
  writeSessionRouting(agentGroup.id, session.id);

  // Read container config once — threaded through provider resolution,
  // buildMounts, and buildContainerArgs so we don't re-read the file.
  const containerConfig = readContainerConfig(agentGroup.folder);
  assertNoMattermostCredentialsInContainerConfig(containerConfig);
  assertSafeContainerSkillNames(containerConfig);
  if (mattermostBoundary.strict && containerConfig.additionalMounts.length > 0) {
    throw new Error('Mattermost containers cannot use additional host mounts');
  }

  // Populate host-derived runtime identity in memory, then scan the complete
  // downstream config before persisting or exposing it to OneCLI/container IO.
  const runtimeFieldsChanged = ensureRuntimeFields(containerConfig, agentGroup);
  assertNoMattermostCredentialsInContainerConfig(containerConfig);
  if (runtimeFieldsChanged) {
    writeContainerConfig(agentGroup.folder, containerConfig);
  }
  const containerConfigSnapshot = captureContainerConfigArtifact(agentGroup.folder);

  // Resolve the effective provider + any host-side contribution it declares
  // (extra mounts, env passthrough). Computed once and threaded through both
  // buildMounts and buildContainerArgs so side effects (mkdir, etc.) fire once.
  const { provider, contribution } = resolveProviderContribution(session, agentGroup, containerConfig);
  assertHostManagedPaths(agentGroup, session);
  assertContainerConfigArtifactUnchanged(agentGroup.folder, containerConfigSnapshot);
  assertNoMattermostContainerCredentials(contribution);
  assertProviderMountIsolation(agentGroup, session, contribution);

  const mounts = buildMounts(agentGroup, session, containerConfig, provider, contribution, mattermostBoundary.strict);
  const containerName = `nanoclaw-v2-${agentGroup.folder}-${Date.now()}`;
  // OneCLI agent identifier is always the agent group id — stable across
  // sessions and reversible via getAgentGroup() for approval routing.
  const agentIdentifier = agentGroup.id;
  const args = await buildContainerArgs(
    mounts,
    containerName,
    agentGroup,
    containerConfig,
    provider,
    contribution,
    agentIdentifier,
  );

  assertNoMattermostCredentialsInLaunchArgs(args);
  assertProviderMountIsolation(agentGroup, session, contribution);
  assertNoForeignAgentMountAccess(agentGroup, mounts);
  assertHostManagedPaths(agentGroup, session);
  assertContainerConfigArtifactUnchanged(agentGroup.folder, containerConfigSnapshot);
  assertNoMattermostCredentialsInContainerConfigArtifact(agentGroup.folder);
  const finalMattermostBoundary = validateMattermostSessionForExecution(session);
  if (finalMattermostBoundary.strict && !finalMattermostBoundary.valid) {
    throw new Error(`Mattermost execution session became invalid before spawn: ${finalMattermostBoundary.reason}`);
  }

  log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });

  // Clear any orphan heartbeat from a previous container instance — the
  // sweep's ceiling check treats a missing file as "fresh spawn, give grace"
  // (host-sweep.ts line 87). Without this, the stale mtime can trigger an
  // immediate kill before the new container touches the file itself.
  fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });

  const container = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  activeContainers.set(session.id, { process: container, containerName, identity: executionIdentity(session) });
  markContainerRunning(session.id);

  // Log stderr
  container.stderr?.on('data', (data) => {
    for (const line of data.toString().trim().split('\n')) {
      if (line) log.debug(line, { container: agentGroup.folder });
    }
  });

  // stdout is unused in v2 (all IO is via session DB)
  container.stdout?.on('data', () => {});

  // No host-side idle timeout. Stale/stuck detection is driven by the host
  // sweep reading heartbeat mtime + processing_ack claim age + container_state
  // (see src/host-sweep.ts). This avoids killing long-running legitimate work
  // on a wall-clock timer.

  container.on('close', (code) => {
    if (activeContainers.get(session.id)?.process !== container) return;
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    log.info('Container exited', { sessionId: session.id, code, containerName });
  });

  container.on('error', (err) => {
    if (activeContainers.get(session.id)?.process !== container) return;
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    log.error('Container spawn error', { sessionId: session.id, err });
  });
}

/** Kill a container for a session. */
export function killContainer(sessionId: string, reason: string): void {
  const entry = activeContainers.get(sessionId);
  if (!entry) return;

  log.info('Killing container', { sessionId, reason, containerName: entry.containerName });
  try {
    stopContainer(entry.containerName);
  } catch {
    entry.process.kill('SIGKILL');
  }
}

/**
 * Resolve the provider name for a session using the precedence documented in
 * the provider-install skills:
 *
 *   sessions.agent_provider
 *     → agent_groups.agent_provider
 *     → container.json `provider`
 *     → 'claude'
 *
 * Pure so the precedence can be unit-tested without a DB or filesystem.
 */
export function resolveProviderName(
  sessionProvider: string | null | undefined,
  agentGroupProvider: string | null | undefined,
  containerConfigProvider: string | null | undefined,
): string {
  return (sessionProvider || agentGroupProvider || containerConfigProvider || 'claude').toLowerCase();
}

function resolveProviderContribution(
  session: Session,
  agentGroup: AgentGroup,
  containerConfig: ContainerConfig,
): { provider: string; contribution: ProviderContainerContribution } {
  const provider = resolveProviderName(session.agent_provider, agentGroup.agent_provider, containerConfig.provider);
  const fn = getProviderContainerConfig(provider);
  const contribution = fn
    ? fn({
        sessionDir: sessionDir(agentGroup.id, session.id),
        agentGroupId: agentGroup.id,
        hostEnv: providerSafeHostEnv(),
      })
    : {};
  return { provider, contribution };
}

function containmentPath(candidate: string): string {
  return fs.existsSync(candidate) ? fs.realpathSync(candidate) : path.resolve(candidate);
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(containmentPath(root), containmentPath(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function pathsOverlap(left: string, right: string): boolean {
  return isPathWithin(left, right) || isPathWithin(right, left);
}

function assertNoSymlinkComponents(root: string, candidate: string): void {
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedRoot, path.resolve(candidate));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Host-managed Mattermost path escapes its owned root');
  }
  let cursor = resolvedRoot;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    const stat = fs.lstatSync(cursor, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      throw new Error('Host-managed Mattermost paths cannot contain symlinks');
    }
  }
}

function assertHostManagedPaths(agentGroup: AgentGroup, session: Session): void {
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);
  assertNoSymlinkComponents(GROUPS_DIR, groupDir);
  for (const child of ['container.json', '.claude-fragments', 'CLAUDE.md', 'CLAUDE.local.md', '.gitconfig']) {
    assertNoSymlinkComponents(groupDir, path.join(groupDir, child));
  }

  const sessionStateRoot = path.join(DATA_DIR, 'v2-sessions');
  const agentStateDir = path.join(sessionStateRoot, agentGroup.id);
  const claudeDir = path.join(agentStateDir, '.claude-shared');
  const ownedSessionDir = sessionDir(agentGroup.id, session.id);
  assertNoSymlinkComponents(sessionStateRoot, agentStateDir);
  assertNoSymlinkComponents(agentStateDir, claudeDir);
  assertNoSymlinkComponents(claudeDir, path.join(claudeDir, 'skills'));
  assertNoSymlinkComponents(claudeDir, path.join(claudeDir, 'settings.json'));
  assertNoSymlinkComponents(agentStateDir, ownedSessionDir);
  for (const child of ['inbound.db', 'outbound.db', 'codex']) {
    assertNoSymlinkComponents(ownedSessionDir, path.join(ownedSessionDir, child));
  }
  const codexDir = path.join(ownedSessionDir, 'codex');
  for (const child of ['auth.json', 'config.toml', 'skills']) {
    assertNoSymlinkComponents(codexDir, path.join(codexDir, child));
  }
}

function assertNoForeignAgentMountAccess(agentGroup: AgentGroup, mounts: VolumeMount[]): void {
  for (const identity of getAllAgentGroups()) {
    if (identity.id === agentGroup.id) continue;
    const ownedRoots = [path.resolve(GROUPS_DIR, identity.folder), path.join(DATA_DIR, 'v2-sessions', identity.id)];
    if (mounts.some((mount) => ownedRoots.some((root) => pathsOverlap(mount.hostPath, root)))) {
      throw new Error('Container mounts cannot overlap a foreign agent workspace or state root');
    }
  }
}

function agentOwnedRoots(agentGroup: AgentGroup): string[] {
  return [path.resolve(GROUPS_DIR, agentGroup.folder), path.join(DATA_DIR, 'v2-sessions', agentGroup.id)];
}

function assertNoAgentRootOverlap(agentGroup: AgentGroup): void {
  const currentRoots = agentOwnedRoots(agentGroup);
  for (const other of getAllAgentGroups()) {
    if (other.id === agentGroup.id) continue;
    if (currentRoots.some((current) => agentOwnedRoots(other).some((foreign) => pathsOverlap(current, foreign)))) {
      throw new Error('Agent workspace and state roots must not overlap');
    }
  }
}

function assertProviderMountIsolation(
  agentGroup: AgentGroup,
  session: Session,
  contribution: ProviderContainerContribution,
): void {
  const allowedRoot = sessionDir(agentGroup.id, session.id);
  const protectedInboundDb = inboundDbPath(agentGroup.id, session.id);
  for (const mount of contribution.mounts ?? []) {
    if (
      !fs.existsSync(mount.hostPath) ||
      !isPathWithin(allowedRoot, mount.hostPath) ||
      pathsOverlap(mount.hostPath, protectedInboundDb)
    ) {
      throw new Error('Provider mounts must remain inside the current session state root');
    }
  }
}

function hostMattermostCredentialValues(): Set<string> {
  return new Set(
    Object.entries(process.env)
      .filter(
        ([key, value]) => /^MATTERMOST(?:_|$)/i.test(key) && /(TOKEN|SECRET|PASSWORD|KEY)/i.test(key) && Boolean(value),
      )
      .map(([, value]) => value as string),
  );
}

function assertNoMattermostCredentialsInContainerConfigArtifact(folder: string): void {
  const artifactPath = path.join(GROUPS_DIR, folder, 'container.json');
  if (!fs.existsSync(artifactPath)) return;
  const raw = fs.readFileSync(artifactPath, 'utf8');
  if (/"MATTERMOST[^"]*(?:TOKEN|SECRET|PASSWORD|KEY)[^"]*"\s*:/i.test(raw)) {
    throw new Error('Mattermost credentials cannot enter mounted container configuration');
  }
  for (const credential of hostMattermostCredentialValues()) {
    if (raw.includes(credential)) {
      throw new Error('Mattermost credentials cannot enter mounted container configuration');
    }
  }
}

function captureContainerConfigArtifact(folder: string): string | null {
  const artifactPath = path.join(GROUPS_DIR, folder, 'container.json');
  return fs.existsSync(artifactPath) ? fs.readFileSync(artifactPath, 'utf8') : null;
}

function assertContainerConfigArtifactUnchanged(folder: string, expected: string | null): void {
  if (captureContainerConfigArtifact(folder) !== expected) {
    throw new Error('Container configuration changed during launch setup');
  }
}

function providerSafeHostEnv(): NodeJS.ProcessEnv {
  const credentials = hostMattermostCredentialValues();
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        !/^MATTERMOST(?:_|$)/i.test(key) &&
        (!value || ![...credentials].some((credential) => value.includes(credential))),
    ),
  );
}

function hasMattermostCredentialKey(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  for (const [key, child] of Object.entries(value)) {
    if (
      (/^MATTERMOST(?:_|$)/i.test(key) && /(TOKEN|SECRET|PASSWORD|KEY)/i.test(key)) ||
      hasMattermostCredentialKey(child)
    ) {
      return true;
    }
  }
  return false;
}

function assertNoMattermostCredentialsInContainerConfig(containerConfig: ContainerConfig): void {
  if (hasMattermostCredentialKey(containerConfig)) {
    throw new Error('Mattermost credentials cannot enter mounted container configuration');
  }
  const serialized = JSON.stringify(containerConfig);
  for (const credential of hostMattermostCredentialValues()) {
    if (serialized.includes(credential)) {
      throw new Error('Mattermost credentials cannot enter mounted container configuration');
    }
  }
}

function assertSafeContainerSkillNames(containerConfig: ContainerConfig): void {
  const safeName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
  if (containerConfig.skills !== 'all') {
    for (const skill of containerConfig.skills) {
      if (!safeName.test(skill)) {
        throw new Error('Container skill names must be safe path components');
      }
    }
  }
  for (const serverName of Object.keys(containerConfig.mcpServers)) {
    if (!safeName.test(serverName)) {
      throw new Error('MCP server names must be safe path components');
    }
  }
}

function assertNoMattermostContainerCredentials(contribution: ProviderContainerContribution): void {
  for (const key of Object.keys(contribution.env ?? {})) {
    if (/^MATTERMOST(?:_|$)/i.test(key)) {
      throw new Error('Mattermost credentials cannot enter provider container environments');
    }
  }
  const hostMattermostCredentials = hostMattermostCredentialValues();
  for (const value of Object.values(contribution.env ?? {})) {
    if ([...hostMattermostCredentials].some((credential) => value.includes(credential))) {
      throw new Error('Mattermost credentials cannot enter provider container environments');
    }
  }
}

function assertNoMattermostCredentialsInLaunchArgs(args: string[]): void {
  const credentials = hostMattermostCredentialValues();
  for (const arg of args) {
    if (/MATTERMOST[^=]*(?:TOKEN|SECRET|PASSWORD|KEY)/i.test(arg)) {
      throw new Error('Mattermost credentials cannot enter container launch arguments');
    }
    if ([...credentials].some((credential) => arg.includes(credential))) {
      throw new Error('Mattermost credentials cannot enter container launch arguments');
    }
  }
}

function buildMounts(
  agentGroup: AgentGroup,
  session: Session,
  containerConfig: ContainerConfig,
  provider: string,
  providerContribution: ProviderContainerContribution,
  strictMattermost: boolean,
): VolumeMount[] {
  const projectRoot = process.cwd();
  const sessDir = sessionDir(agentGroup.id, session.id);

  // Per-group filesystem state lives forever after first creation. Init is
  // idempotent: it only writes paths that don't already exist, so this call
  // is a no-op for groups that have spawned before.
  initGroupFilesystem(agentGroup);

  // Sync skill symlinks based on container.json selection before mounting.
  const claudeDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared');
  syncContainerSkillSymlinks(path.join(claudeDir, 'skills'), containerConfig);
  if (provider === 'codex') {
    syncContainerSkillSymlinks(path.join(sessDir, 'codex', 'skills'), containerConfig);
  }

  // Compose CLAUDE.md fresh every spawn from the shared base, enabled skill
  // fragments, and MCP server instructions. See `claude-md-compose.ts`.
  composeGroupClaudeMd(agentGroup);

  const mounts: VolumeMount[] = [];
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);

  // Session folder at /workspace (contains inbound.db, outbound.db, outbox/, .claude/)
  mounts.push({ hostPath: sessDir, containerPath: '/workspace', readonly: false });

  // The host is the sole writer for inbound.db. Shadow the copy visible
  // through the writable session mount with an explicit read-only bind so
  // the container cannot replace or redirect the host-owned artifact.
  const hostInboundDb = inboundDbPath(agentGroup.id, session.id);
  if (fs.existsSync(hostInboundDb)) {
    mounts.push({ hostPath: hostInboundDb, containerPath: '/workspace/inbound.db', readonly: true });
  }

  // Agent group folder at /workspace/agent (RW for working files + CLAUDE.local.md)
  mounts.push({ hostPath: groupDir, containerPath: '/workspace/agent', readonly: false });

  // container.json — nested RO mount on top of RW group dir so the agent
  // can read its config but cannot modify it.
  const containerJsonPath = path.join(groupDir, 'container.json');
  if (fs.existsSync(containerJsonPath)) {
    mounts.push({ hostPath: containerJsonPath, containerPath: '/workspace/agent/container.json', readonly: true });
  }

  // Composer-managed CLAUDE.md artifacts — nested RO mounts. These are
  // regenerated from the shared base + fragments on every spawn; any
  // agent-side writes would be clobbered, so enforce read-only. Only
  // CLAUDE.local.md (per-group memory) remains RW via the group-dir mount.
  // `.claude-shared.md` is a symlink whose target (`/app/CLAUDE.md`) is
  // already RO-mounted, so writes through it fail regardless — no need for
  // a nested mount there.
  const composedClaudeMd = path.join(groupDir, 'CLAUDE.md');
  if (fs.existsSync(composedClaudeMd)) {
    mounts.push({ hostPath: composedClaudeMd, containerPath: '/workspace/agent/CLAUDE.md', readonly: true });
  }
  const fragmentsDir = path.join(groupDir, '.claude-fragments');
  if (fs.existsSync(fragmentsDir)) {
    mounts.push({ hostPath: fragmentsDir, containerPath: '/workspace/agent/.claude-fragments', readonly: true });
  }

  // Global memory directory — always read-only.
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (!strictMattermost && fs.existsSync(globalDir)) {
    mounts.push({ hostPath: globalDir, containerPath: '/workspace/global', readonly: true });
  }

  // Shared CLAUDE.md — read-only, imported by the composed entry point via
  // the `.claude-shared.md` symlink inside the group dir.
  const sharedClaudeMd = path.join(process.cwd(), 'container', 'CLAUDE.md');
  if (fs.existsSync(sharedClaudeMd)) {
    mounts.push({ hostPath: sharedClaudeMd, containerPath: '/app/CLAUDE.md', readonly: true });
  }

  // Per-group .claude-shared at /home/node/.claude (Claude state, settings,
  // skill symlinks)
  mounts.push({ hostPath: claudeDir, containerPath: '/home/node/.claude', readonly: false });

  // Shared agent-runner source — read-only, same code for all groups.
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  mounts.push({ hostPath: agentRunnerSrc, containerPath: '/app/src', readonly: true });

  const workflowMount = buildDeepResearchWorkflowMount(projectRoot);
  if (workflowMount) {
    mounts.push(workflowMount);
  }

  // Shared skills — read-only, symlinks in .claude-shared/skills/ point here.
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  if (fs.existsSync(skillsSrc)) {
    mounts.push({ hostPath: skillsSrc, containerPath: '/app/skills', readonly: true });
  }

  // Additional mounts from container config
  if (containerConfig.additionalMounts && containerConfig.additionalMounts.length > 0) {
    const validated = validateAdditionalMounts(containerConfig.additionalMounts, agentGroup.name);
    mounts.push(...validated);
  }

  // Provider-contributed mounts (e.g. opencode-xdg)
  if (providerContribution.mounts) {
    mounts.push(...providerContribution.mounts);
  }

  assertNoForeignAgentMountAccess(agentGroup, mounts);

  return mounts;
}

export function buildDeepResearchWorkflowMount(projectRoot: string = process.cwd()): VolumeMount | null {
  const workflowSrc = path.join(projectRoot, 'src', 'deep-research-workflow');
  if (!fs.existsSync(workflowSrc)) return null;
  return { hostPath: workflowSrc, containerPath: '/app/deep-research-workflow', readonly: true };
}

export function selectedContainerSkills(containerConfig: ContainerConfig): string[] {
  const projectRoot = process.cwd();
  const sharedSkillsDir = path.join(projectRoot, 'container', 'skills');
  if (containerConfig.skills !== 'all') return containerConfig.skills;

  // Recompute from shared dir — newly-added upstream skills appear automatically
  return fs.existsSync(sharedSkillsDir)
    ? fs.readdirSync(sharedSkillsDir).filter((e) => {
        try {
          return fs.statSync(path.join(sharedSkillsDir, e)).isDirectory();
        } catch {
          return false;
        }
      })
    : [];
}

/**
 * Sync a provider's skill directory to the selected container skills.
 *
 * Symlink targets are container paths (`/app/skills/<name>`), so they look
 * dangling on the host but resolve after `/app/skills` is mounted. Non-symlink
 * entries are preserved; this keeps Codex's built-in `.system` directory.
 */
export function syncContainerSkillSymlinks(skillsDir: string, containerConfig: ContainerConfig): void {
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  const desired = selectedContainerSkills(containerConfig);
  const desiredSet = new Set(desired);

  // Remove symlinks not in the desired set
  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(entryPath).isSymbolicLink();
    } catch {
      continue;
    }
    if (isSymlink && !desiredSet.has(entry)) {
      fs.unlinkSync(entryPath);
    }
  }

  // Create or repair symlinks for desired skills (container path targets)
  for (const skill of desired) {
    const linkPath = path.join(skillsDir, skill);
    const target = `/app/skills/${skill}`;
    try {
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        if (fs.readlinkSync(linkPath) !== target) {
          fs.unlinkSync(linkPath);
          fs.symlinkSync(target, linkPath);
        }
      } else {
        log.warn('Skill entry exists and is not a symlink; leaving it unchanged', { skill, path: linkPath });
      }
    } catch {
      fs.symlinkSync(target, linkPath);
    }
  }
}

/**
 * Ensure container.json has the runtime identity fields the runner needs.
 * Written at spawn time so they're always current even if the DB values
 * change (e.g. group rename). Only writes if values differ to avoid
 * unnecessary file churn.
 */
function ensureRuntimeFields(containerConfig: ContainerConfig, agentGroup: AgentGroup): boolean {
  let dirty = false;
  if (containerConfig.agentGroupId !== agentGroup.id) {
    containerConfig.agentGroupId = agentGroup.id;
    dirty = true;
  }
  if (containerConfig.groupName !== agentGroup.name) {
    containerConfig.groupName = agentGroup.name;
    dirty = true;
  }
  if (containerConfig.assistantName !== agentGroup.name) {
    containerConfig.assistantName = agentGroup.name;
    dirty = true;
  }
  return dirty;
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentGroup: AgentGroup,
  containerConfig: ContainerConfig,
  _provider: string,
  providerContribution: ProviderContainerContribution,
  agentIdentifier?: string,
): Promise<string[]> {
  const args: string[] = ['run', '--rm', '--name', containerName, '--label', CONTAINER_INSTALL_LABEL];

  // Environment — only vars read by code we don't own.
  // Everything NanoClaw-specific is in container.json (read by runner at startup).
  args.push('-e', `TZ=${TIMEZONE}`);
  args.push('-e', 'GH_TOKEN=placeholder');
  args.push('-e', 'GITHUB_TOKEN=placeholder');
  args.push('-e', 'GH_PROMPT_DISABLED=1');
  args.push('-e', 'GIT_TERMINAL_PROMPT=0');
  args.push('-e', 'GIT_CONFIG_GLOBAL=/workspace/agent/.gitconfig');

  // Provider-contributed env vars (e.g. XDG_DATA_HOME, OPENCODE_*, NO_PROXY).
  if (providerContribution.env) {
    for (const [key, value] of Object.entries(providerContribution.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // OneCLI gateway — injects HTTPS_PROXY + certs so container API calls
  // are routed through the agent vault for credential injection. Treated as
  // a transient hard failure: if we can't wire the gateway, we don't spawn.
  // The caller (router or host-sweep) catches the throw, leaves the inbound
  // message pending, and the next sweep tick retries.
  if (agentIdentifier) {
    await onecli.ensureAgent({ name: agentGroup.name, identifier: agentIdentifier });
  }
  const onecliApplied = await onecli.applyContainerConfig(args, { addHostMapping: false, agent: agentIdentifier });
  if (!onecliApplied) {
    throw new Error('OneCLI gateway not applied — refusing to spawn container without credentials');
  }
  log.info('OneCLI gateway applied', { containerName });

  // Host gateway
  args.push(...hostGatewayArgs());

  // User mapping
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Volume mounts
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  // Override entrypoint: run v2 entry point directly via Bun (no tsc, no stdin).
  args.push('--entrypoint', 'bash');

  // Use per-agent-group image if one has been built, otherwise base image
  const imageTag = containerConfig.imageTag || CONTAINER_IMAGE;
  args.push(imageTag);

  args.push('-c', 'exec bun run /app/src/index.ts');

  return args;
}

/** Build a per-agent-group Docker image with custom packages. */
export async function buildAgentGroupImage(agentGroupId: string): Promise<void> {
  const agentGroup = getAgentGroup(agentGroupId);
  if (!agentGroup) throw new Error('Agent group not found');

  const containerConfig = readContainerConfig(agentGroup.folder);
  const aptPackages = containerConfig.packages.apt;
  const npmPackages = containerConfig.packages.npm;

  if (aptPackages.length === 0 && npmPackages.length === 0) {
    throw new Error('No packages to install. Use install_packages first.');
  }

  let dockerfile = `FROM ${CONTAINER_IMAGE}\nUSER root\n`;
  if (aptPackages.length > 0) {
    dockerfile += `RUN apt-get update && apt-get install -y ${aptPackages.join(' ')} && rm -rf /var/lib/apt/lists/*\n`;
  }
  if (npmPackages.length > 0) {
    // pnpm skips build scripts unless packages are allowlisted. Append each
    // to /root/.npmrc (base image sets it up for agent-browser) so packages
    // with postinstall — e.g. playwright, puppeteer, native addons — don't
    // install silently broken.
    const allowlist = npmPackages.map((p) => `echo 'only-built-dependencies[]=${p}' >> /root/.npmrc`).join(' && ');
    dockerfile += `RUN ${allowlist} && pnpm install -g ${npmPackages.join(' ')}\n`;
  }
  dockerfile += 'USER node\n';

  const imageTag = `${CONTAINER_IMAGE_BASE}:${agentGroupId}`;

  log.info('Building per-agent-group image', { agentGroupId, imageTag, apt: aptPackages, npm: npmPackages });

  // Write Dockerfile to temp file and build
  const tmpDockerfile = path.join(DATA_DIR, `Dockerfile.${agentGroupId}`);
  fs.writeFileSync(tmpDockerfile, dockerfile);
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} build -t ${imageTag} -f ${tmpDockerfile} .`, {
      cwd: DATA_DIR,
      stdio: 'pipe',
      timeout: 300_000,
    });
  } finally {
    fs.unlinkSync(tmpDockerfile);
  }

  // Store the image tag in groups/<folder>/container.json
  containerConfig.imageTag = imageTag;
  writeContainerConfig(agentGroup.folder, containerConfig);

  log.info('Per-agent-group image built', { agentGroupId, imageTag });
}
