import fs from 'node:fs';
import path from 'node:path';
import { digest } from '../domain/contracts.js';
import { withDeploymentLock } from '../ops/deployment-lock.js';
import { writeAtomic } from '../ops/target-state.js';
import {
  checkedClient,
  validGoogleCalendarTokens,
  refreshGoogleCalendarToken,
  type GoogleOAuthClient,
  type GoogleCalendarTokens,
  type OAuthTransport,
} from './oauth.js';
import type { CalendarAccessFences } from './access-fences.js';
import { CalendarReadError } from './reader.js';
import { object } from './normalization.js';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const marker = '.cos-calendar-credentials';
const contract = 'cos-calendar-credentials/v1';
type State = {
  contract: typeof contract;
  identity: string;
  clientId: string;
  generation: number;
  phase: 'ready' | 'refreshing' | 'uncertain' | 'revoked';
  tokens: GoogleCalendarTokens;
};
const fail = (code: string): never => {
  throw new CalendarReadError(code);
};
function rootGuard(root: string): fs.Stats {
  const stat = fs.lstatSync(root);
  if (
    !path.isAbsolute(root) ||
    path.resolve(root) !== root ||
    fs.realpathSync(root) !== root ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new Error('unsafe_root');
  for (let current = root; ; current = path.dirname(current)) {
    if (fs.lstatSync(path.join(current, '.git'), { throwIfNoEntry: false })) throw new Error('repository_root');
    if (path.dirname(current) === current) break;
  }
  return stat;
}
function readJson(file: string, durable = false): unknown {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd),
      maximum = 65536;
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > maximum
    )
      throw new Error('unsafe_file');
    const bytes = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = fs.readSync(fd, bytes, size, bytes.length - size, size);
      if (!count) break;
      size += count;
    }
    if (size !== stat.size || size > maximum || fs.fstatSync(fd).mtimeMs !== stat.mtimeMs)
      throw new Error('unstable_file');
    if (durable) fs.fsyncSync(fd);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
  } finally {
    fs.closeSync(fd);
  }
}
function privateFailure(error: unknown): never {
  if (error instanceof CalendarReadError) throw error;
  if (error instanceof Error && error.message === 'target_deployment_locked') return fail('calendar_credentials_busy');
  return fail('calendar_credentials_unavailable');
}

/** Trusted host only. No database or worker launch receives this owner, its root, or token records.
 * Disk encryption and protected backup policy are operator configuration, not implied by file modes. */
export class CalendarCredentialOwner {
  readonly #client: GoogleOAuthClient;
  readonly #fences: CalendarAccessFences;
  readonly #transport: OAuthTransport;
  readonly #rootIdentity: { dev: number; ino: number };
  readonly #pending = new Map<string, Promise<string>>();
  constructor(
    readonly root: string,
    client: GoogleOAuthClient,
    fences: CalendarAccessFences,
    transport: OAuthTransport = {},
  ) {
    this.#client = checkedClient(client);
    this.#fences = fences;
    this.#transport = { ...transport };
    try {
      this.#rootIdentity = rootGuard(this.root);
      this.guard();
    } catch (error) {
      privateFailure(error);
    }
  }
  /** Explicit operator initialization of an existing empty private directory only. Never reset runtime state. */
  static initialize(root: string): void {
    try {
      rootGuard(root);
      if (!fs.readdirSync(root).length) writeAtomic(root, marker, { contract });
      const value = readJson(path.join(root, marker));
      if (!object(value) || value.contract !== contract || Object.keys(value).length !== 1)
        throw new Error('unowned_root');
    } catch (error) {
      privateFailure(error);
    }
  }
  private guard(): void {
    const current = rootGuard(this.root);
    if (current.dev !== this.#rootIdentity.dev || current.ino !== this.#rootIdentity.ino)
      throw new Error('credential_root_changed');
    const value = readJson(path.join(this.root, marker));
    if (!object(value) || value.contract !== contract || Object.keys(value).length !== 1)
      throw new Error('unowned_root');
  }
  private identity(scope: string, binding: string, reference: string): string {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(scope) || !uuid.test(binding) || !uuid.test(reference))
      return fail('calendar_credentials_invalid');
    return digest({ scope, binding, reference });
  }
  private async locked<T>(
    scope: string,
    binding: string,
    reference: string,
    operation: (identity: string, root: string) => Promise<T>,
  ): Promise<T> {
    try {
      const identity = this.identity(scope, binding, reference);
      this.guard();
      this.#fences.assertOpen(scope, binding);
      return await withDeploymentLock(path.join(this.root, reference + '.lock'), async () => {
        this.guard();
        this.#fences.assertOpen(scope, binding);
        const fd = fs.openSync(this.root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        try {
          const pinned = fs.fstatSync(fd);
          if (pinned.dev !== this.#rootIdentity.dev || pinned.ino !== this.#rootIdentity.ino)
            throw new Error('credential_root_changed');
          // Keep every token read/write on this verified filesystem, including across an awaited refresh.
          const result = await operation(identity, '/proc/self/fd/' + fd);
          this.guard();
          this.#fences.assertOpen(scope, binding);
          return result;
        } finally {
          fs.closeSync(fd);
        }
      });
    } catch (error) {
      return privateFailure(error);
    }
  }
  private state(root: string, reference: string, identity: string, durable = false): State {
    const value = readJson(path.join(root, reference + '.json'), durable);
    if (durable) {
      const directory = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    }
    if (
      !object(value) ||
      Object.keys(value).sort().join(',') !== 'clientId,contract,generation,identity,phase,tokens' ||
      value.contract !== contract ||
      !Number.isSafeInteger(value.generation) ||
      Number(value.generation) < 1 ||
      !['ready', 'refreshing', 'uncertain', 'revoked'].includes(String(value.phase)) ||
      !validGoogleCalendarTokens(value.tokens)
    )
      return fail('calendar_credentials_unavailable');
    if (value.identity !== identity || value.clientId !== this.#client.clientId)
      return fail('calendar_credentials_denied');
    return value as State;
  }
  private admitted(scope: string, binding: string, state: State): void {
    if (state.phase !== 'ready') {
      const auth = state.phase === 'revoked' ? 'revoked' : 'expired';
      this.#fences.deny(scope, binding, auth);
      return fail('calendar_auth_' + auth);
    }
    const now = (this.#transport.now ?? Date.now)();
    if (!Number.isFinite(now)) return fail('calendar_credentials_invalid');
    if (state.tokens.refreshExpiresAt !== null && state.tokens.refreshExpiresAt <= now) {
      this.#fences.deny(scope, binding, 'expired');
      return fail('calendar_auth_expired');
    }
  }
  async install(scope: string, binding: string, reference: string, tokens: GoogleCalendarTokens): Promise<void> {
    if (!validGoogleCalendarTokens(tokens)) return fail('calendar_credentials_invalid');
    const captured = structuredClone(tokens);
    return this.locked(scope, binding, reference, async (identity, root) => {
      const file = path.join(root, reference + '.json');
      if (fs.lstatSync(file, { throwIfNoEntry: false })) {
        const old = this.state(root, reference, identity);
        this.admitted(scope, binding, old);
        if (digest(old.tokens) !== digest(captured)) return fail('calendar_credentials_conflict');
        // Re-publish identical data to finish an interrupted directory sync before acknowledging install.
        writeAtomic(root, reference + '.json', old);
        return;
      }
      const state: State = {
        contract,
        identity,
        clientId: this.#client.clientId,
        generation: 1,
        phase: 'ready',
        tokens: captured,
      };
      this.admitted(scope, binding, state);
      writeAtomic(root, reference + '.json', state);
    });
  }
  async token(scope: string, binding: string, reference: string): Promise<string> {
    const key = this.identity(scope, binding, reference);
    const existing = this.#pending.get(key);
    if (existing) return existing;
    const work = this.locked(scope, binding, reference, async (identity, root) => {
      const state = this.state(root, reference, identity, true);
      this.admitted(scope, binding, state);
      if (state.tokens.expiresAt > (this.#transport.now ?? Date.now)() + 60000) return state.tokens.accessToken;
      writeAtomic(root, reference + '.json', { ...state, phase: 'refreshing' });
      let rotated: GoogleCalendarTokens;
      try {
        rotated = await refreshGoogleCalendarToken(this.#client, state.tokens, this.#transport);
      } catch (error) {
        const revoked = error instanceof CalendarReadError && error.code === 'calendar_oauth_revoked';
        this.#fences.deny(scope, binding, revoked ? 'revoked' : 'expired');
        writeAtomic(root, reference + '.json', { ...state, phase: revoked ? 'revoked' : 'uncertain' });
        if (revoked) return fail('calendar_auth_revoked');
        if (error instanceof CalendarReadError) throw error;
        return fail('calendar_oauth_exchange_uncertain');
      }
      // On publication failure, the durable 'refreshing' record prevents reuse after reconstruction.
      writeAtomic(root, reference + '.json', {
        ...state,
        phase: 'ready',
        generation: state.generation + 1,
        tokens: rotated,
      });
      this.#fences.assertOpen(scope, binding);
      return rotated.accessToken;
    });
    this.#pending.set(key, work);
    try {
      return await work;
    } finally {
      if (this.#pending.get(key) === work) this.#pending.delete(key);
    }
  }
  async inspect(
    scope: string,
    binding: string,
    reference: string,
  ): Promise<{ auth: 'ready'; scopes: string[]; generation: number }> {
    const key = this.identity(scope, binding, reference),
      pending = this.#pending.get(key);
    if (pending) await pending;
    return this.locked(scope, binding, reference, async (identity, root) => {
      const state = this.state(root, reference, identity, true);
      this.admitted(scope, binding, state);
      return { auth: 'ready', scopes: [...state.tokens.scopes], generation: state.generation };
    });
  }
}
