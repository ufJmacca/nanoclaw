import type { Readable, Writable } from 'node:stream';
import { verifyVaultMemory } from './vault-memory.js';
export type BackupNasPrivateFrameControls = { assertMemory?(): void; deadlineMs?: number };
const maximum = 4096;
/** Metadata only: an exact length-prefixed frame followed by EOF on a private pipe.
 * Every input/frame buffer is cleared. No credentials or root selectors are admitted.
 */
export async function readBackupNasPrivateFrame<T>(
  stream: Readable,
  prepare: () => (value: unknown) => T,
  unavailable: string,
  controls: BackupNasPrivateFrameControls = {},
): Promise<T> {
  let staging: Buffer | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const memory = controls.assertMemory ?? verifyVaultMemory;
    memory();
    const parse = prepare(),
      deadline = controls.deadlineMs ?? 15000;
    if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 15000) throw Error('invalid_deadline');
    staging = Buffer.alloc(4 + maximum);
    timer = setTimeout(() => stream.destroy(Error(unavailable)), deadline);
    let length = 0,
      headerLength: number | undefined;
    for await (const bytes of stream) {
      try {
        memory();
        if (!Buffer.isBuffer(bytes) || length + bytes.length > staging.length) throw Error('frame_bounds');
        bytes.copy(staging, length);
        length += bytes.length;
        if (length >= 4 && headerLength === undefined) {
          headerLength = staging.readUInt32BE(0);
          if (headerLength < 1 || headerLength > maximum) throw Error('metadata_bounds');
        }
        if (headerLength !== undefined && length > 4 + headerLength) throw Error('extra_metadata');
        memory();
      } finally {
        if (Buffer.isBuffer(bytes)) bytes.fill(0);
      }
    }
    memory();
    if (headerLength === undefined || length !== 4 + headerLength) throw Error('truncated_metadata');
    const result = parse(JSON.parse(staging.subarray(4, length).toString('utf8')));
    memory();
    return result;
  } catch {
    stream.destroy();
    // eslint-disable-next-line preserve-caught-error -- Private capabilities and selected NAS metadata are never transport diagnostics.
    throw Error(unavailable);
  } finally {
    staging?.fill(0);
    if (timer) clearTimeout(timer);
  }
}
export async function writeBackupNasPrivateFrame(
  stream: Writable,
  prepare: () => unknown,
  unavailable: string,
  controls: BackupNasPrivateFrameControls = {},
): Promise<void> {
  let frame: Buffer | undefined;
  try {
    const memory = controls.assertMemory ?? verifyVaultMemory;
    memory();
    const value = prepare(),
      metadata = Buffer.from(JSON.stringify(value));
    try {
      if (metadata.length < 1 || metadata.length > maximum) throw Error('metadata_bounds');
      frame = Buffer.alloc(4 + metadata.length);
      frame.writeUInt32BE(metadata.length);
      metadata.copy(frame, 4);
    } finally {
      metadata.fill(0);
    }
    memory();
    await new Promise<void>((resolve, reject) => stream.write(frame!, (error) => (error ? reject(error) : resolve())));
    memory();
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Neither pipe errors nor private request bytes enter diagnostics.
    throw Error(unavailable);
  } finally {
    frame?.fill(0);
  }
}
