const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const MATTERMOST_CONTRACT_EVENT_PREFIX = 'NANOCLAW_MM_CONTRACT ';

export interface MattermostContractDeliverCommand {
  id: string;
  kind: 'deliver';
  platformId: string;
  threadId: string | null;
  text: string;
}

export interface MattermostContractSnapshotCommand {
  id: string;
  kind: 'snapshot';
}

export interface MattermostContractDeactivateCommand {
  id: string;
  kind: 'deactivate';
  channelId: string;
}

export interface MattermostContractShutdownCommand {
  id: string;
  kind: 'shutdown';
}

export type MattermostContractWorkerCommand =
  | MattermostContractDeliverCommand
  | MattermostContractSnapshotCommand
  | MattermostContractDeactivateCommand
  | MattermostContractShutdownCommand;

export interface MattermostContractWorkerShutdownDependencies {
  requestShutdown(): Promise<void>;
  endInput(): void;
  readonly exit: Promise<number>;
  kill(): void;
}

export async function shutdownMattermostContractWorkerProcess(
  dependencies: MattermostContractWorkerShutdownDependencies,
  timeoutMs: number,
): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('Mattermost contract worker shutdown timeout was invalid');
  }
  await dependencies.requestShutdown().then(
    () => undefined,
    () => undefined,
  );
  dependencies.endInput();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const exitCode = await Promise.race([
    dependencies.exit,
    new Promise<number>((resolve) => {
      timeout = setTimeout(() => {
        dependencies.kill();
        resolve(1);
      }, timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (exitCode !== 0) throw new Error('Mattermost contract worker did not stop cleanly');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const expectedKeys = new Set(expected);
  return Object.keys(value).length === expectedKeys.size && Object.keys(value).every((key) => expectedKeys.has(key));
}

function containsCredentialField(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return true;
  seen.add(value);
  if (Array.isArray(value)) return value.some((child) => containsCredentialField(child, seen));
  return Object.entries(value).some(
    ([key, child]) => /token|secret|password|authorization|cookie/i.test(key) || containsCredentialField(child, seen),
  );
}

export function parseMattermostContractWorkerCommand(
  line: string,
  instanceKey: string,
): MattermostContractWorkerCommand {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw new Error('Mattermost contract worker command was invalid', { cause: err });
  }
  const platformPrefix = `mattermost:${instanceKey}:`;
  const platformChannelId =
    isRecord(value) && typeof value.platformId === 'string' && value.platformId.startsWith(platformPrefix)
      ? value.platformId.slice(platformPrefix.length)
      : '';
  if (!SAFE_ID.test(instanceKey) || !isRecord(value) || typeof value.id !== 'string' || !SAFE_ID.test(value.id)) {
    throw new Error('Mattermost contract worker command was invalid');
  }
  if (
    value.kind === 'deliver' &&
    hasOnlyKeys(value, ['id', 'kind', 'platformId', 'text', 'threadId']) &&
    typeof value.platformId === 'string' &&
    SAFE_ID.test(platformChannelId) &&
    (value.threadId === null || (typeof value.threadId === 'string' && SAFE_ID.test(value.threadId))) &&
    typeof value.text === 'string' &&
    value.text.length > 0 &&
    value.text.length <= 20_000
  ) {
    return value as unknown as MattermostContractDeliverCommand;
  }
  if (value.kind === 'snapshot' && hasOnlyKeys(value, ['id', 'kind'])) {
    return value as unknown as MattermostContractSnapshotCommand;
  }
  if (
    value.kind === 'deactivate' &&
    hasOnlyKeys(value, ['channelId', 'id', 'kind']) &&
    typeof value.channelId === 'string' &&
    SAFE_ID.test(value.channelId)
  ) {
    return value as unknown as MattermostContractDeactivateCommand;
  }
  if (value.kind === 'shutdown' && hasOnlyKeys(value, ['id', 'kind'])) {
    return value as unknown as MattermostContractShutdownCommand;
  }
  throw new Error('Mattermost contract worker command was invalid');
}

export function encodeMattermostContractWorkerEvent(event: unknown, forbiddenValues: readonly string[] = []): string {
  if (!isRecord(event) || typeof event.kind !== 'string' || containsCredentialField(event)) {
    throw new Error('Mattermost contract worker event was unsafe');
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(event);
  } catch (err) {
    if (err instanceof TypeError) throw new Error('Mattermost contract worker event was unsafe', { cause: err });
    throw err;
  }
  if (
    Buffer.byteLength(serialized, 'utf8') > 65_536 ||
    forbiddenValues.some((value) => value.length >= 4 && serialized.includes(value))
  ) {
    throw new Error('Mattermost contract worker event was unsafe');
  }
  return `${MATTERMOST_CONTRACT_EVENT_PREFIX}${serialized}`;
}

export function parseMattermostContractWorkerEventLine(
  line: string,
  forbiddenValues: readonly string[] = [],
): Record<string, unknown> | null {
  if (forbiddenValues.some((value) => value.length >= 4 && line.includes(value))) {
    throw new Error('Mattermost contract worker event was invalid');
  }
  if (!line.startsWith(MATTERMOST_CONTRACT_EVENT_PREFIX)) return null;
  const serialized = line.slice(MATTERMOST_CONTRACT_EVENT_PREFIX.length);
  if (
    Buffer.byteLength(serialized, 'utf8') > 65_536 ||
    forbiddenValues.some((value) => value.length >= 4 && serialized.includes(value))
  ) {
    throw new Error('Mattermost contract worker event was invalid');
  }
  let event: unknown;
  try {
    event = JSON.parse(serialized);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw new Error('Mattermost contract worker event was invalid', { cause: err });
  }
  if (!isRecord(event) || typeof event.kind !== 'string' || event.kind.length === 0 || containsCredentialField(event)) {
    throw new Error('Mattermost contract worker event was invalid');
  }
  return event;
}
