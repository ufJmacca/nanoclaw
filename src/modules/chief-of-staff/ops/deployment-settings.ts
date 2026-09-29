import path from 'node:path';
export type DeploymentSettings = {
  version: 1;
  target: 'pi';
  sshAlias: string;
  hostFingerprint: string;
  databaseFingerprint: string;
  service: string;
  userHome: string;
  installationRoot: string;
  dataRoot: string;
  stateRoot: string;
  releaseRoot: string;
  stagingRoot: string;
  sourceRoot: string;
  runtimeEnvironment: string;
  migrationEnvironment: string;
};
export function deploymentSettings(value: unknown): DeploymentSettings {
  const reject = (): never => {
    throw new Error('invalid_deployment_settings');
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reject();
  const item = value as DeploymentSettings;
  const fields = [
    'version',
    'target',
    'sshAlias',
    'hostFingerprint',
    'databaseFingerprint',
    'service',
    'userHome',
    'installationRoot',
    'dataRoot',
    'stateRoot',
    'releaseRoot',
    'stagingRoot',
    'sourceRoot',
    'runtimeEnvironment',
    'migrationEnvironment',
  ];
  if (
    Object.keys(item).some((key) => !fields.includes(key)) ||
    Object.keys(item).length !== fields.length ||
    item.version !== 1 ||
    item.target !== 'pi' ||
    typeof item.sshAlias !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(item.sshAlias) ||
    !/^[a-f0-9]{64}$/.test(item.hostFingerprint) ||
    !/^[a-f0-9]{64}$/.test(item.databaseFingerprint) ||
    typeof item.service !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,120}\.service$/.test(item.service)
  )
    return reject();
  const names = [
    'userHome',
    'installationRoot',
    'dataRoot',
    'stateRoot',
    'releaseRoot',
    'stagingRoot',
    'sourceRoot',
    'runtimeEnvironment',
    'migrationEnvironment',
  ] as const;
  for (const name of names) {
    const file = item[name];
    if (
      typeof file !== 'string' ||
      !/^\/[a-zA-Z0-9_./-]{1,299}$/.test(file) ||
      path.resolve(file) !== file ||
      file === '/'
    )
      return reject();
    if (name !== 'userHome' && !file.startsWith(item.userHome + '/')) return reject();
  }
  if (item.dataRoot !== path.join(item.installationRoot, 'data')) return reject();
  const roots = [item.installationRoot, item.stateRoot, item.releaseRoot, item.stagingRoot, item.sourceRoot];
  if (roots.some((left, i) => roots.some((right, j) => i !== j && (left === right || left.startsWith(right + '/')))))
    return reject();
  for (const file of [item.runtimeEnvironment, item.migrationEnvironment])
    if (
      !file.startsWith(item.userHome + '/.config/') ||
      roots.some((root) => file === root || file.startsWith(root + '/'))
    )
      return reject();
  if (item.runtimeEnvironment === item.migrationEnvironment) return reject();
  return item;
}
/** SSH passes one command to a remote POSIX shell; every argument remains literal. */
export function shellArgument(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error('invalid_remote_argument');
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}
