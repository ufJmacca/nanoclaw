import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from '../domain/contracts.js';
import { CalendarReadError } from './reader.js';
import { withDeploymentLock } from '../ops/deployment-lock.js';

const markerName = '.cos-calendar-fences';
const marker = 'cos-calendar-access-fences/v1\n';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Denial = {
  version: 1;
  scopeDigest: string;
  bindingId: string;
  auth: 'expired' | 'revoked' | 'disconnected';
  at: string;
};
function protect<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof CalendarReadError) throw error;
    // Filesystem/JSON exceptions can include private host paths or file content.
    throw new CalendarReadError('calendar_access_fence_unavailable');
  }
}
function privateRoot(root: string): void {
  const stat = fs.lstatSync(root);
  if (
    !path.isAbsolute(root) ||
    path.resolve(root) !== root ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700 ||
    fs.realpathSync(root) !== root
  )
    throw new Error('unsafe_root');
  for (let current = root; ; current = path.dirname(current)) {
    if (fs.lstatSync(path.join(current, '.git'), { throwIfNoEntry: false })) throw new Error('repository_root');
    if (path.dirname(current) === current) break;
  }
}
function read(file: string, sync = false): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 1024
    )
      throw new Error('unsafe_file');
    const buffer = Buffer.alloc(1025);
    let count = 0;
    while (count < buffer.length) {
      const n = fs.readSync(fd, buffer, count, buffer.length - count, count);
      if (!n) break;
      count += n;
    }
    if (count !== stat.size || count > 1024 || fs.fstatSync(fd).mtimeMs !== stat.mtimeMs)
      throw new Error('unstable_file');
    if (sync) fs.fsyncSync(fd);
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count));
  } finally {
    fs.closeSync(fd);
  }
}
function create(root: string, name: string, text: string): void {
  const fd = fs.openSync(path.join(root, name), 'wx', 0o600);
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  syncDirectory(root);
}
function syncDirectory(root: string): void {
  const directory = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}

/** Host-only, append-only access denial journal. A new account link must use a new binding identity.
 * Keep outside repositories, releases and worker mounts; include it in protected host backups. */
export class CalendarAccessFences {
  readonly #active = new Map<string, string>();
  readonly #denied = new Map<string, Denial['auth']>();
  constructor(readonly root: string) {
    protect(() => this.guard());
  }
  /** Explicit operator setup only. Runtime reconstruction never creates or resets a journal. */
  static initialize(root: string): CalendarAccessFences {
    return protect(() => {
      privateRoot(root);
      if (!fs.readdirSync(root).length) create(root, markerName, marker);
      return new CalendarAccessFences(root);
    });
  }
  private guard(): void {
    privateRoot(this.root);
    if (read(path.join(this.root, markerName)) !== marker) throw new Error('unowned_journal');
  }
  private identity(scope: string, binding: string): string {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(scope) || !uuid.test(binding)) throw new Error('invalid_identity');
    return digest({ scope, binding }) + '.json';
  }
  private denial(scope: string, binding: string): Denial | null {
    this.guard();
    const file = path.join(this.root, this.identity(scope, binding));
    if (!fs.lstatSync(file, { throwIfNoEntry: false })) return null;
    const value = JSON.parse(read(file)) as Denial;
    if (
      !value ||
      value.version !== 1 ||
      value.scopeDigest !== digest(scope) ||
      value.bindingId !== binding ||
      !['expired', 'revoked', 'disconnected'].includes(value.auth) ||
      typeof value.at !== 'string' ||
      !Number.isFinite(Date.parse(value.at))
    )
      throw new Error('invalid_denial');
    return value;
  }
  deny(scope: string, binding: string, auth: Denial['auth']): void {
    protect(() => {
      if (!['expired', 'revoked', 'disconnected'].includes(auth)) throw new Error('invalid_denial');
      const name = this.identity(scope, binding),
        existing = this.denial(scope, binding);
      if (!this.#denied.has(name)) this.#denied.set(name, existing?.auth ?? auth);
      if (existing) {
        read(path.join(this.root, this.identity(scope, binding)), true);
        syncDirectory(this.root);
        return;
      }
      const value: Denial = {
        version: 1,
        scopeDigest: digest(scope),
        bindingId: binding,
        auth,
        at: new Date().toISOString(),
      };
      // Exclusive creation is monotonic across processes. A crash leaving partial bytes fails closed.
      try {
        create(this.root, name, JSON.stringify(value) + '\n');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !this.denial(scope, binding)) throw error;
        read(path.join(this.root, name), true);
        syncDirectory(this.root);
      }
    });
  }
  assertOpen(scope: string, binding: string): void {
    protect(() => {
      const name = this.identity(scope, binding),
        auth = this.#denied.get(name);
      const value = this.denial(scope, binding);
      if (value) throw new CalendarReadError('calendar_auth_' + value.auth);
      if (auth) throw new CalendarReadError('calendar_auth_' + auth);
      const pending = path.join(this.root, name + '.pending');
      if (
        fs.lstatSync(pending, { throwIfNoEntry: false }) &&
        (!this.#active.has(name) || read(pending) !== this.#active.get(name))
      )
        throw new CalendarReadError('calendar_access_check_uncertain');
    });
  }
  /** Persist before checking provider access. Unowned/interrupted checks never reopen a binding.
   * The active owner may keep using the last admitted snapshot until it observes access loss. */
  async runCheck<T>(scope: string, binding: string, operation: () => Promise<T>): Promise<T> {
    try {
      this.guard();
      const name = this.identity(scope, binding),
        pending = path.join(this.root, name + '.pending');
      return await withDeploymentLock(path.join(this.root, name + '.check.lock'), async () => {
        this.assertOpen(scope, binding);
        const record =
          JSON.stringify({ version: 1, scopeDigest: digest(scope), bindingId: binding, id: randomUUID() }) + '\n';
        create(this.root, name + '.pending', record);
        this.#active.set(name, record);
        try {
          const result = await operation();
          if (!this.#denied.has(name) && !this.denial(scope, binding)) {
            if (read(pending) !== record) throw new Error('changed_pending_check');
            fs.unlinkSync(pending);
            syncDirectory(this.root);
          }
          return result;
        } finally {
          this.#active.delete(name);
        }
      });
    } catch (error) {
      if (error instanceof CalendarReadError) throw error;
      if (error instanceof Error && error.message === 'target_deployment_locked')
        throw new CalendarReadError('calendar_access_check_busy');
      throw new CalendarReadError('calendar_access_fence_unavailable');
    }
  }
}
