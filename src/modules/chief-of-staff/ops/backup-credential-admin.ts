import type { Readable } from 'node:stream';
import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import { consumeBackupCredentialStream } from './backup-credential-stream.js';
import { installBackupCredentials } from './backup-credential-install.js';
import { verifyVaultMemory } from './vault-memory.js';

export type BackupCredentialInstallArguments = {
  command: 'backup-credentials-install';
  scopeId: string;
  requestId: string;
  credentialReference: string;
};
export function parseBackupCredentialInstallArguments(args: string[]): BackupCredentialInstallArguments {
  const values: Record<string, string> = {};
  if (args[0] !== 'backup-credentials-install' || args.length !== 7) throw Error('invalid_admin_arguments');
  for (let index = 1; index < args.length; index += 2) {
    if (
      !['--scope', '--request-id', '--credential-reference'].includes(args[index]) ||
      values[args[index]] !== undefined ||
      !args[index + 1]
    )
      throw Error('invalid_admin_arguments');
    values[args[index]] = args[index + 1];
  }
  const uuid = (value: string) =>
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
  if (
    !/^[a-zA-Z0-9_-]{1,128}$/.test(values['--scope'] ?? '') ||
    !uuid(values['--request-id'] ?? '') ||
    !uuid(values['--credential-reference'] ?? '')
  )
    throw Error('invalid_admin_arguments');
  return {
    command: 'backup-credentials-install',
    scopeId: values['--scope'],
    requestId: values['--request-id'],
    credentialReference: values['--credential-reference'],
  };
}

/** Installed owner path only. The outer context holds target/maintenance/native leases;
 * credentials arrive on stdin, never command arguments or the selected environment.
 */
export async function runBackupCredentialInstallAdmin(input: {
  args: BackupCredentialInstallArguments;
  roots: CalendarStorageRoots;
  check(): Promise<void>;
  assertAuthority(): void;
  stream?: Readable;
}): Promise<Record<string, unknown>> {
  const stream = input.stream ?? process.stdin;
  try {
    const assertAuthority = () => {
      verifyVaultMemory();
      input.assertAuthority();
    };
    const check = async () => {
      assertAuthority();
      await input.check();
      assertAuthority();
    };
    await check();
    const args = parseBackupCredentialInstallArguments([
      input.args.command,
      '--scope',
      input.args.scopeId,
      '--request-id',
      input.args.requestId,
      '--credential-reference',
      input.args.credentialReference,
    ]);
    let receipt: Awaited<ReturnType<typeof installBackupCredentials>> | undefined;
    await consumeBackupCredentialStream(stream, async (credentials) => {
      await check();
      const bytes = Buffer.concat([
        Buffer.from([0x43, 0x4f, 0x53, 0x42, 1, credentials.smbPassword.length, credentials.resticPassword.length]),
        credentials.smbPassword,
        credentials.resticPassword,
      ]);
      try {
        receipt = await installBackupCredentials({
          roots: input.roots,
          operationId: args.requestId,
          credentialReference: args.credentialReference,
          bytes,
          check,
          assertAuthority,
        });
        await check();
      } finally {
        bytes.fill(0);
      }
    });
    if (!receipt) throw Error('credential_installation_missing');
    return receipt;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private pipe, owner and installer diagnostics stay outside the administrative result.
    throw Error('backup_credential_setup_unavailable');
  } finally {
    stream.destroy();
  }
}
