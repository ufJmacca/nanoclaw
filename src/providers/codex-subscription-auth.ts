/** Trusted native-auth owner. No OAuth request or token-refresh algorithm is implemented here. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

type NativeAuth = {
  auth_mode: 'chatgpt';
  OPENAI_API_KEY?: null;
  tokens: { id_token: string; access_token: string; refresh_token: string; account_id: string };
  last_refresh: string;
};
export type SubscriptionCredentialSnapshot = { authJson: string; generation: string };
type Journal = {
  version: 1;
  sourcePathHash: string;
  sourceDigest: string;
  operation: string;
  phase: 'checking' | 'ready';
  candidateDigest?: string;
};
type Options = {
  sourceFile: string;
  stateDirectory: string;
  /** Must assert NanoClaw's exclusive host execution lease; this store is not an agent RPC. */
  assertAuthority(): void;
  /** Runs pinned native Codex account/read, waits for process exit, and writes only this staged HOME. */
  nativeCheck(directory: string, mode: 'check' | 'refresh'): Promise<void>;
};

const queues = new Map<string, Promise<unknown>>();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const error = (code: string): never => {
  throw new Error(code);
};

function privateDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    fs.realpathSync(directory) !== path.resolve(directory)
  )
    error('subscription_auth_unsafe');
}
function readPrivate(file: string): string {
  privateDirectory(path.dirname(file));
  if (fs.lstatSync(file).isSymbolicLink()) error('subscription_auth_unsafe');
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 1048576)
      error('subscription_auth_unsafe');
    return fs.readFileSync(descriptor, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}
function atomicPrivate(file: string, content: string): void {
  privateDirectory(path.dirname(file));
  const temporary = path.join(path.dirname(file), `.auth-${randomUUID()}`);
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(temporary, file);
    const parent = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(parent);
    } finally {
      fs.closeSync(parent);
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
function parseAuth(raw: string): NativeAuth {
  let value: NativeAuth;
  try {
    value = JSON.parse(raw) as NativeAuth;
  } catch (cause) {
    if (cause instanceof SyntaxError) return error('subscription_auth_invalid');
    throw cause;
  }
  const token = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 65536;
  if (
    !value ||
    value.auth_mode !== 'chatgpt' ||
    value.OPENAI_API_KEY != null ||
    !value.tokens ||
    !token(value.tokens.id_token) ||
    !token(value.tokens.access_token) ||
    !token(value.tokens.refresh_token) ||
    !token(value.tokens.account_id) ||
    typeof value.last_refresh !== 'string' ||
    !Number.isFinite(Date.parse(value.last_refresh))
  )
    return error('subscription_auth_invalid');
  return value;
}
function snapshot(raw: string): SubscriptionCredentialSnapshot {
  const native = parseAuth(raw);
  // Keep the native cache shape, but only the trusted owner retains refresh capability.
  // Do not invent a new timestamp or parse/refresh JWTs here. Native Codex owns freshness.
  return {
    generation: hash(raw),
    authJson: JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: native.tokens.id_token,
        access_token: native.tokens.access_token,
        refresh_token: '',
        account_id: native.tokens.account_id,
      },
      last_refresh: native.last_refresh,
    }),
  };
}

export function createSubscriptionAuthStore(options: Options) {
  const root = path.resolve(options.stateDirectory);
  const source = path.resolve(options.sourceFile);
  const journalFile = path.join(root, 'operation.json');
  const sourcePathHash = hash(source);
  const authority = () => {
    options.assertAuthority();
    privateDirectory(root);
  };
  const cached = () => {
    authority();
    return snapshot(readPrivate(source));
  };

  const clearJournal = (journal: Journal) => {
    fs.unlinkSync(journalFile);
    const descriptor = fs.openSync(root, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.rmSync(path.join(root, journal.operation), { recursive: true, force: true });
  };
  const commit = (journal: Journal): SubscriptionCredentialSnapshot => {
    if (journal.phase !== 'ready') return error('subscription_refresh_uncertain');
    const directory = path.join(root, journal.operation);
    const original = readPrivate(path.join(directory, 'original.json'));
    const candidate = readPrivate(path.join(directory, 'candidate.json'));
    if (
      hash(original) !== journal.sourceDigest ||
      hash(candidate) !== journal.candidateDigest ||
      parseAuth(original).tokens.account_id !== parseAuth(candidate).tokens.account_id
    )
      return error('subscription_refresh_uncertain');
    const result = snapshot(candidate);
    authority();
    const current = readPrivate(source);
    if (hash(current) !== journal.sourceDigest && hash(current) !== journal.candidateDigest)
      return error('subscription_auth_changed');
    if (hash(current) !== journal.candidateDigest) atomicPrivate(source, candidate);
    clearJournal(journal);
    return result;
  };
  const recover = (): SubscriptionCredentialSnapshot | undefined => {
    if (!fs.existsSync(journalFile)) return;
    let journal: Journal;
    const raw = readPrivate(journalFile);
    try {
      journal = JSON.parse(raw) as Journal;
    } catch (cause) {
      if (cause instanceof SyntaxError) return error('subscription_refresh_uncertain');
      throw cause;
    }
    if (
      !journal ||
      journal.version !== 1 ||
      journal.sourcePathHash !== sourcePathHash ||
      !/^operation-[a-zA-Z0-9]+$/.test(journal.operation) ||
      !/^[a-f0-9]{64}$/.test(journal.sourceDigest)
    )
      return error('subscription_refresh_uncertain');
    return commit(journal);
  };
  const run = (mode: 'check' | 'refresh', expectedGeneration?: string): Promise<SubscriptionCredentialSnapshot> => {
    // All stores for this source share the process queue. Cross-process exclusion
    // belongs to the required native host lease, not a stealable timestamp lock.
    const previous = queues.get(source) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        authority();
        const recovered = recover();
        if (recovered) return recovered;
        const original = readPrivate(source);
        const native = parseAuth(original);
        if (mode === 'refresh' && hash(original) !== expectedGeneration) return snapshot(original);
        const directory = fs.mkdtempSync(path.join(root, 'operation-'));
        atomicPrivate(path.join(directory, 'original.json'), original);
        atomicPrivate(path.join(directory, 'auth.json'), original);
        const journal: Journal = {
          version: 1,
          sourcePathHash,
          sourceDigest: hash(original),
          operation: path.basename(directory),
          phase: 'checking',
        };
        atomicPrivate(journalFile, JSON.stringify(journal));
        try {
          await options.nativeCheck(directory, mode);
          const candidate = readPrivate(path.join(directory, 'auth.json'));
          const checked = parseAuth(candidate);
          if (
            checked.tokens.account_id !== native.tokens.account_id ||
            (mode === 'refresh' &&
              checked.tokens.access_token === native.tokens.access_token &&
              checked.tokens.refresh_token === native.tokens.refresh_token)
          )
            return error('subscription_refresh_uncertain');
          // Native file persistence is not atomic; only a completed, validated check
          // can advance this durable journal to a recoverable publication phase.
          atomicPrivate(path.join(directory, 'candidate.json'), candidate);
          journal.phase = 'ready';
          journal.candidateDigest = hash(candidate);
          atomicPrivate(journalFile, JSON.stringify(journal));
          // eslint-disable-next-line no-catch-all/no-catch-all -- Native credential errors may contain secrets; retain the journal and expose only this stable code.
        } catch {
          return error('subscription_refresh_uncertain');
        }
        return commit(journal);
      });
    queues.set(source, operation);
    void operation
      .finally(() => {
        if (queues.get(source) === operation) queues.delete(source);
      })
      .catch(() => undefined);
    return operation;
  };
  return { cached, prepare: () => run('check'), refresh: (generation: string) => run('refresh', generation) };
}
