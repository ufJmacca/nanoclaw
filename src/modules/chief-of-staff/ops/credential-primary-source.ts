import fs from 'node:fs';
import { digest } from '../domain/contracts.js';
import { checkedClient, validCalendarTokens, type OAuthScopeProfile } from '../calendar/oauth-core.js';
import { credentialRootMarker, credentialProfileMetadata } from '../calendar/credential-core.js';
import { makeCredentialEvent, type CredentialEvent, type CredentialChange } from './backup-credential-event.js';
import { BACKUP_LIMITS } from './backup-policy.js';
export type CredentialPrimarySnapshot = {
  sources: Array<{
    credentialReference: string;
    event: CredentialEvent;
    files: Array<{ name: string; bytes: Buffer }>;
  }>;
  assertCurrent(): void;
  assertPrimaryUnchanged(): void;
};
const signature = (stat: fs.Stats) =>
  digest({
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  });
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
function protect<T>(operation: () => T): T {
  try {
    return operation();
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private primary-state paths, bytes and scope diagnostics are not backup output.
    throw Error('credential_primary_snapshot_unavailable');
  }
}
/** Trusted backup reader only. The caller holds the pinned encrypted profile
 * and supplies its real current vault/memory/administration guard. No defaults,
 * provider calls, credential refresh, journal mutation or live admission.
 * Borrowed buffers describe an independently checked as-of snapshot, are wiped
 * at exit and must not be retained. Later rotation does not rewrite that snapshot. */
export async function withCredentialPrimarySnapshot<T>(
  input: {
    directoryFd: number;
    ownerDigest: string;
    clientId: string;
    profile: OAuthScopeProfile;
    assertScope(): void;
  },
  operation: (snapshot: CredentialPrimarySnapshot) => Promise<T>,
): Promise<T> {
  let directory: number | undefined,
    active = true;
  const buffers: Buffer[] = [],
    handles: number[] = [],
    files: Array<{ fd: number; name: string; signature: string }> = [];
  try {
    input = Object.freeze({ ...input });
    if (
      typeof input.assertScope !== 'function' ||
      typeof operation !== 'function' ||
      !/^[a-f0-9]{64}$/.test(input.ownerDigest)
    )
      throw Error('primary_scope_required');
    input.assertScope();
    checkedClient({ clientId: input.clientId });
    directory = fs.openSync('/proc/self/fd/' + input.directoryFd, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    const path = '/proc/self/fd/' + directory,
      before = fs.fstatSync(directory);
    const scope = () =>
      protect(() => {
        if (!active) throw Error('snapshot_released');
        input.assertScope();
        const now = fs.fstatSync(directory!);
        if (
          !now.isDirectory() ||
          now.dev !== before.dev ||
          now.ino !== before.ino ||
          now.uid !== process.getuid?.() ||
          (now.mode & 0o7777) !== 0o700
        )
          throw Error('primary_directory_changed');
      });
    scope();
    const names = () => {
      const entries = fs.readdirSync(path).sort();
      if (entries.length > 4096) throw Error('primary_inventory_bounds');
      return entries;
    };
    const selectedNames = names(),
      marker = credentialRootMarker(input.profile),
      profile = credentialProfileMetadata(input.profile);
    const primary = () =>
      protect(() => {
        scope();
        if (digest(names()) !== digest(selectedNames)) throw Error('primary_inventory_changed');
        for (const file of files)
          if (
            signature(fs.fstatSync(file.fd)) !== file.signature ||
            signature(fs.lstatSync(file.name)) !== file.signature
          )
            throw Error('primary_file_changed');
        scope();
      });
    let total = 0;
    const read = (name: string, maximum: number, empty = false) => {
      scope();
      const file = path + '/' + name,
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      handles.push(fd);
      const stat = fs.fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.dev !== before.dev ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o7777) !== 0o600 ||
        stat.nlink !== 1 ||
        stat.size > maximum ||
        (!empty && stat.size < 1)
      )
        throw Error('unsafe_primary_file');
      total += stat.size;
      if (total > BACKUP_LIMITS.credentials) throw Error('primary_byte_bounds');
      files.push({ fd, name: file, signature: signature(stat) });
      const bytes = Buffer.alloc(stat.size + 1);
      buffers.push(bytes);
      if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== stat.size) throw Error('primary_file_changed');
      scope();
      const captured = files[files.length - 1];
      if (signature(fs.fstatSync(fd)) !== captured.signature || signature(fs.lstatSync(file)) !== captured.signature)
        throw Error('primary_file_changed');
      return bytes.subarray(0, stat.size);
    };
    if (read(marker.name, 1024).toString('utf8') !== marker.contents) throw Error('foreign_primary_profile');
    const sources: CredentialPrimarySnapshot['sources'] = [];
    for (const name of selectedNames) {
      if (name === marker.name) continue;
      if (new RegExp('^' + uuid + '\\.lock$').test(name)) {
        read(name, 0, true);
        continue;
      }
      if (!new RegExp('^' + uuid + '\\.json$').test(name) || sources.length >= 1024)
        throw Error('unknown_primary_file');
      const bytes = read(name, 65536),
        state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<string, unknown>;
      if (
        !state ||
        Object.keys(state).sort().join(',') !== 'clientId,contract,generation,identity,phase,tokens' ||
        state.contract !== profile.contract ||
        state.clientId !== input.clientId ||
        typeof state.identity !== 'string' ||
        !/^[a-f0-9]{64}$/.test(state.identity) ||
        !Number.isSafeInteger(state.generation) ||
        Number(state.generation) < 1 ||
        !['ready', 'refreshing', 'uncertain', 'revoked'].includes(String(state.phase)) ||
        !validCalendarTokens(state.tokens, input.profile)
      )
        throw Error('invalid_primary_state');
      const payload = [{ name: 'credential.json', bytes }];
      const event = makeCredentialEvent(
        {
          sourceKind: profile.sourceKind,
          sourceKey: digest({ identity: state.identity, clientId: state.clientId, profile: input.profile }),
          generation: Number(state.generation),
          phase: state.phase as CredentialChange['phase'],
          files: payload,
        },
        input.ownerDigest,
      );
      sources.push({ credentialReference: name.slice(0, -5), event, files: payload });
    }
    if (new Set(sources.map((source) => source.event.sourceKey)).size !== sources.length)
      throw Error('duplicate_primary_source');
    primary();
    const result = await operation({ sources, assertCurrent: scope, assertPrimaryUnchanged: primary });
    scope();
    return result;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Source bytes and nested provider-state diagnostics stay within the trusted snapshot callback.
    throw Error('credential_primary_snapshot_unavailable');
  } finally {
    active = false;
    for (const bytes of buffers) bytes.fill(0);
    for (const fd of handles.reverse()) fs.closeSync(fd);
    if (directory !== undefined) fs.closeSync(directory);
  }
}
