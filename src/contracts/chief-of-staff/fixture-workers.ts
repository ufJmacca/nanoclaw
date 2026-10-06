import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { safeHostEnvironment } from '../../host-environment.js';
const execute = (args: string[]) =>
  execFileSync('docker', args, {
    env: safeHostEnvironment('docker'),
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
/** Native workers outlive their Docker client. Fence release requires their independently verified stop. */
export async function stopFixtureWorkers(
  hostRoot: string,
  image: string,
  run: (args: string[]) => string = execute,
): Promise<void> {
  if (
    !path.isAbsolute(hostRoot) ||
    hostRoot === '/' ||
    path.resolve(hostRoot) !== hostRoot ||
    /[\r\n\0]/.test(hostRoot) ||
    !/^sha256:[a-f0-9]{64}$/.test(image)
  )
    throw Error('invalid_fixture_worker_root');
  const prefix = hostRoot + '/.cos-plan-state/fixtures/';
  const listed = () => {
    const ids = run([
      'ps',
      '-a',
      '--no-trunc',
      '--filter',
      'label=nanoclaw.cos-protocol=cos-mission-rpc/v1',
      '--format',
      '{{.ID}}',
    ])
      .trim()
      .split('\n')
      .filter(Boolean);
    if (ids.length > 256 || new Set(ids).size !== ids.length || ids.some((id) => !/^[a-f0-9]{64}$/.test(id)))
      throw Error('fixture_worker_inventory_unknown');
    return ids;
  };
  const inventory = () => {
    let ids = listed(),
      inspected: string | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!ids.length) return [];
      try {
        inspected = run([
          'inspect',
          '--format',
          '{"Id":{{json .Id}},"Image":{{json .Image}},"State":{{json .State.Status}},"Mounts":{{json .Mounts}}}',
          ...ids,
        ]);
        break;
      } catch (error) {
        // Auto-remove can race inspection. Only a successful fresh inventory can prove disappearance.
        const current = listed();
        if (!ids.some((id) => !current.includes(id)) || attempt === 2) throw error;
        ids = current;
      }
    }
    if (inspected === undefined) throw Error('fixture_worker_inventory_unknown');
    const rows = inspected
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            Id: string;
            Image: string;
            State: string;
            Mounts: Array<{ Type: string; Source: string; Destination: string }>;
          },
      );
    if (rows.length !== ids.length || new Set(rows.map((row) => row.Id)).size !== ids.length)
      throw Error('fixture_worker_inventory_unknown');
    return rows
      .filter((row) => {
        if (
          !ids.includes(row.Id) ||
          !Array.isArray(row.Mounts) ||
          !['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead'].includes(row.State)
        )
          throw Error('fixture_worker_inventory_unknown');
        const owned = row.Mounts.some(
          (m) =>
            m.Type === 'bind' &&
            m.Destination === '/workspace' &&
            typeof m.Source === 'string' &&
            m.Source.startsWith(prefix) &&
            /^flow-[a-zA-Z0-9_-]+\//.test(m.Source.slice(prefix.length)) &&
            path.resolve(m.Source) === m.Source &&
            path.basename(m.Source) === 'cos-v1',
        );
        if (owned && row.Image !== image) throw Error('fixture_worker_identity_changed');
        return owned && !['exited', 'dead'].includes(row.State);
      })
      .map((row) => row.Id);
  };
  for (const id of inventory()) {
    try {
      run(['stop', '-t', '1', id]);
    } catch (error) {
      if (listed().includes(id)) throw error;
    }
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!inventory().length) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error('fixture_worker_shutdown_unverified');
}
