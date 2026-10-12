import { verifyResticRepositoryIdentity } from './restic-artifact.js';
import { assertBackupResticScopes, backupResticOutput, type BackupResticScopes } from './backup-restic-process.js';
/** Initialization does not infer ownership from a password or adopt an existing
 * repository. Its caller must hold the signed share's owned directory claim. */
export class BackupResticInitializer {
  private readonly scopes: Readonly<BackupResticScopes>;
  constructor(
    scopes: BackupResticScopes,
    private readonly check: () => Promise<void>,
  ) {
    if (
      typeof check !== 'function' ||
      (scopes.timeoutMs !== undefined &&
        (!Number.isSafeInteger(scopes.timeoutMs) || scopes.timeoutMs < 1000 || scopes.timeoutMs > 900000))
    )
      throw Error('backup_repository_initialization_unavailable');
    this.scopes = Object.freeze({ ...scopes });
  }
  private async command(args: string[]): Promise<Buffer> {
    const chunks: Buffer[] = [];
    try {
      assertBackupResticScopes(this.scopes);
      await this.check();
      assertBackupResticScopes(this.scopes);
      for await (const chunk of backupResticOutput(this.scopes, args, 65536)) chunks.push(Buffer.from(chunk));
      await this.check();
      assertBackupResticScopes(this.scopes);
      return Buffer.concat(chunks);
    } catch {
      // eslint-disable-next-line preserve-caught-error -- Repository, credential and subprocess diagnostics are private.
      throw Error('backup_repository_initialization_unavailable');
    } finally {
      for (const chunk of chunks) chunk.fill(0);
    }
  }
  async create(): Promise<void> {
    const bytes = await this.command(['init', '--repository-version', '2']);
    bytes.fill(0);
  }
  async identify(): Promise<string> {
    const bytes = await this.command(['cat', 'config']);
    let id: string;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        value: unknown = JSON.parse(text);
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        typeof (value as Record<string, unknown>).id !== 'string'
      )
        throw Error('repository_identity_required');
      id = verifyResticRepositoryIdentity(text, (value as { id: string }).id).id;
    } catch {
      // eslint-disable-next-line preserve-caught-error -- Authenticated config contents are not public errors.
      throw Error('backup_repository_initialization_unavailable');
    } finally {
      bytes.fill(0);
    }
    const checked = await this.command(['check', '--read-data']);
    checked.fill(0);
    return id;
  }
}
