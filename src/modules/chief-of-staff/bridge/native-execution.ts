import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { safeHostEnvironment } from '../../../host-environment.js';

type Container = {
  Id: string;
  Labels: Record<string, string>;
  State: { Status: string };
  Mounts: Array<{ Type: string; Source: string; Destination: string }>;
};
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const states = ['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead'];
const command = (args: string[]) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: safeHostEnvironment('docker'),
  });

/** Trusted host probe. Never exports environment/credentials or treats a failed inspection as absence. */
export class RestrictedExecutionProbe {
  constructor(
    readonly installation: string,
    readonly execute: (args: string[]) => string = command,
  ) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(installation)) throw Error('cos_execution_installation_invalid');
  }
  private matching(directory: string): Container[] {
    if (!path.isAbsolute(directory) || path.resolve(directory) !== directory || /[\r\n\0]/.test(directory))
      throw Error('cos_execution_path_invalid');
    const ids = this.execute([
      'ps',
      '-a',
      '--no-trunc',
      '--filter',
      'label=nanoclaw-install=' + this.installation,
      '--format',
      '{{.ID}}',
    ])
      .trim()
      .split('\n')
      .filter(Boolean);
    if (ids.length > 256 || new Set(ids).size !== ids.length || !ids.every(id))
      throw Error('cos_execution_inventory_unknown');
    if (!ids.length) return [];
    const rows: Container[] = [];
    // Bounded batches avoid argument limits. Request only ownership/state/mount metadata.
    for (let offset = 0; offset < ids.length; offset += 32) {
      const selected = ids.slice(offset, offset + 32);
      const text = this.execute([
        'inspect',
        '--format',
        '{"Id":{{json .Id}},"Labels":{{json .Config.Labels}},"State":{{json .State}},"Mounts":{{json .Mounts}}}',
        ...selected,
      ]);
      const inspected: Container[] = text
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      if (inspected.length !== selected.length || new Set(inspected.map((r) => r?.Id)).size !== selected.length)
        throw Error('cos_execution_inventory_unknown');
      for (const row of inspected) {
        if (
          !row ||
          !selected.includes(row.Id) ||
          row.Labels?.['nanoclaw-install'] !== this.installation ||
          !states.includes(row.State?.Status) ||
          !Array.isArray(row.Mounts) ||
          row.Mounts.some(
            (m) =>
              !m || typeof m.Type !== 'string' || typeof m.Source !== 'string' || typeof m.Destination !== 'string',
          )
        )
          throw Error('cos_execution_inventory_unknown');
        if (
          !['exited', 'dead'].includes(row.State.Status) &&
          row.Mounts.some((m) => m.Type === 'bind' && m.Source === directory && m.Destination === '/workspace')
        )
          rows.push(row);
      }
    }
    return rows;
  }
  present(directory: string): boolean {
    try {
      return this.matching(directory).length > 0;
    } catch {
      return true;
    }
  }
  stop(directory: string): void {
    const matches = this.matching(directory);
    let failed = false;
    for (const row of matches) {
      try {
        this.execute(['stop', '-t', '1', row.Id]);
      } catch {
        failed = true;
      }
    }
    if (failed) throw Error('cos_execution_stop_uncertain');
  }
}
