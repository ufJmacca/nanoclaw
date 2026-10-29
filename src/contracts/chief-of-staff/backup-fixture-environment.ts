import { verifyResticBinary } from '../../modules/chief-of-staff/ops/restic-artifact.js';

/** Public pinned executable only. Owner backup credentials are never fixture input. */
export function selectedBackupFixtureEnvironment(slice: string, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!['G02', 'G03', 'G04', 'G05', 'G06'].includes(slice)) return {};
  const binary = environment.COS_BACKUP_FIXTURE_BINARY;
  if (!binary) throw Error('backup_fixture_artifact_required');
  verifyResticBinary(binary);
  return { COS_BACKUP_FIXTURE_BINARY: binary };
}
