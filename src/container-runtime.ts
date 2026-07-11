/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import os from 'os';

import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe', timeout: 10_000 });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    log.debug('Container runtime already running');
  } catch (err) {
    log.error('Failed to reach container runtime', { err });
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Container runtime failed to start                      ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without a container runtime. To fix:        ║');
    console.error('║  1. Ensure Docker is installed and running                     ║');
    console.error('║  2. Run: docker info                                           ║');
    console.error('║  3. Restart NanoClaw                                           ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/**
 * Kill orphaned NanoClaw containers from THIS install's previous runs.
 *
 * Scoped by label `nanoclaw-install=<slug>` so a crash-looping peer install
 * cannot reap our containers, and we cannot reap theirs. The label is
 * stamped onto every container at spawn time — see container-runner.ts.
 */
function listOrphanContainers(): string[] {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
    );
    return output.trim().split('\n').filter(Boolean);
  } catch (err) {
    log.error('Failed to enumerate orphaned containers', { err });
    throw new Error('Failed to enumerate orphaned containers', { cause: err });
  }
}

export function cleanupOrphans(): void {
  const orphans = listOrphanContainers();
  const failedStops: string[] = [];
  for (const name of orphans) {
    try {
      stopContainer(name);
      // Deliberately continue so every known orphan gets a stop request;
      // failedStops below still makes the overall startup gate throw.
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch {
      failedStops.push(name);
    }
  }
  const survivors = orphans.length > 0 ? listOrphanContainers() : [];
  if (survivors.length > 0) {
    log.error('Orphaned containers remain after cleanup', { names: survivors });
    throw new Error(`Orphaned containers remain after cleanup: ${survivors.join(', ')}`);
  }
  if (failedStops.length > 0) {
    log.error('Failed to stop orphaned containers', { names: failedStops });
    throw new Error(`Failed to stop orphaned containers: ${failedStops.join(', ')}`);
  }
  if (orphans.length > 0) {
    log.info('Stopped orphaned containers', { count: orphans.length, names: orphans });
  }
}
