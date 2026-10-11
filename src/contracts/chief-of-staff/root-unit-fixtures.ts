/** These administration fixtures require actual root ownership in an isolated
 * container. Never run them against an installed host or select credentials.
 */
export const ROOT_UNIT_FIXTURES = [
  'backup-nas-config-install',
  'backup-nas-initialization-inspection',
  'backup-nas-initialization-retirement-journal',
  'backup-nas-kernel',
  'backup-nas-root-initialization-recovery',
  'backup-nas-root-inspection',
  'backup-nas-root-journal',
  'backup-nas-root-recovery',
  'backup-nas-root-runtime',
  'backup-nas-root-setup',
  'backup-nas-service-install',
  'backup-nas-underlay',
].map((name) => 'src/modules/chief-of-staff/ops/' + name + '.test.ts');
