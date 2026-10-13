import { fileURLToPath } from 'node:url';

/** The invoking helper payload is verified before repository access. Data and
 * source installations need not contain compiled code. No caller, environment
 * variable, cwd or installation path can select another producer. */
export function backupProducerFile(): string {
  return fileURLToPath(new URL('./backup-archive-producer.js', import.meta.url));
}
