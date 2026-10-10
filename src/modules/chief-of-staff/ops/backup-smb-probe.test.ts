import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import type { BackupSmbCredentialLease } from './backup-smb-credentials.js';
import { runtimeTestMessages, writeRuntimeTestMessage } from './runtime-test-wire.js';
const f = vi.hoisted(() => ({ credentials: vi.fn(), memory: vi.fn() }));
vi.mock('./backup-smb-credentials.js', () => ({ withVaultSmbCredentials: f.credentials }));
vi.mock('./vault-memory.js', () => ({ verifyVaultMemory: f.memory }));
import { runBackupSmbCredentialProbe } from './backup-smb-probe.js';
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  f.credentials.mockReset();
  f.memory.mockReset();
});
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-smb-probe-'));
  const file = path.join(directory, 'credential');
  fs.writeFileSync(file, 'synthetic-password-never-on-pipe', { mode: 0o600 });
  const fd = fs.openSync(file, fs.constants.O_RDONLY);
  const input = new PassThrough(),
    output = new PassThrough();
  const messages = runtimeTestMessages(output);
  const checks = vi.fn();
  const roots = {
    targetRoot: '/home/fixture/state',
    installationRoot: '/home/fixture/app',
    dataRoot: '/home/fixture/app/data',
  };
  const expected = {
    filesystemUuid: randomUUID(),
    credentialReference: randomUUID(),
    targetDigest: 'a'.repeat(64),
    minimumGeneration: 3,
  };
  const open = { contract: 'cos-backup-smb-open/v1', roots, expected, owner: { uid: 1000, gid: 1000 } };
  const controls = { assertParent: vi.fn(), assertOwner: vi.fn(), deadlineMs: 1000 };
  let active = false;
  f.credentials.mockImplementation(
    async (_roots, _scope, callback: (lease: BackupSmbCredentialLease) => Promise<void>) => {
      active = true;
      try {
        await callback(
          Object.freeze({
            fd,
            filesystemUuid: expected.filesystemUuid,
            installationDigest: 'b'.repeat(64),
            assertCurrent: checks,
          }),
        );
      } finally {
        active = false;
      }
    },
  );
  cleanups.push(() => {
    input.destroy();
    output.destroy();
    fs.closeSync(fd);
    fs.rmSync(directory, { recursive: true });
  });
  return { fd, file, input, output, messages, checks, roots, expected, open, controls, active: () => active };
}
const challenge = (action: 'check' | 'release', sequence: number) => ({
  contract: 'cos-backup-smb-challenge/v1',
  action,
  sequence,
  nonce: randomUUID() as string,
});
it('keeps the live owner credential lease through fresh private challenges and confirmed EOF', async () => {
  const s = fixture();
  const observed: Buffer[] = [];
  s.output.on('data', (bytes: Buffer) => observed.push(bytes));
  const running = runBackupSmbCredentialProbe(s.input, s.output, s.controls);
  await writeRuntimeTestMessage(s.input, s.open);
  const ready = (await s.messages.next()).value;
  expect(ready).toMatchObject({
    contract: 'cos-backup-smb-ready/v1',
    fd: s.fd,
    filesystemUuid: s.expected.filesystemUuid,
    installationDigest: 'b'.repeat(64),
    file: { uid: process.getuid?.(), mode: fs.fstatSync(s.fd).mode, nlink: 1 },
  });
  expect(s.active()).toBe(true);
  const check = challenge('check', 1);
  await writeRuntimeTestMessage(s.input, check);
  expect((await s.messages.next()).value).toEqual({
    contract: 'cos-backup-smb-current/v1',
    sequence: check.sequence,
    nonce: check.nonce,
  });
  const release = challenge('release', 2);
  await writeRuntimeTestMessage(s.input, release);
  s.input.end();
  expect((await s.messages.next()).value).toEqual({
    contract: 'cos-backup-smb-released/v1',
    sequence: release.sequence,
    nonce: release.nonce,
  });
  await running;
  expect(s.active()).toBe(false);
  expect(s.checks.mock.calls.length).toBeGreaterThan(3);
  expect(s.controls.assertParent.mock.calls.length).toBeGreaterThan(3);
  expect(s.controls.assertOwner).toHaveBeenCalledWith(s.open.owner);
  expect(f.credentials).toHaveBeenCalledWith(s.roots, s.expected, expect.any(Function));
  expect(Buffer.concat(observed).toString('utf8')).not.toContain('synthetic-password');
});
it('supports the repeated fresh checks required by mount journal reconciliation within the bounded pipe lifetime', async () => {
  const s = fixture();
  const running = runBackupSmbCredentialProbe(s.input, s.output, s.controls);
  const reply = () =>
    Promise.race([
      s.messages.next(),
      running.then(() => {
        throw Error('unexpected_probe_completion');
      }),
    ]);
  await writeRuntimeTestMessage(s.input, s.open);
  await reply();
  for (let sequence = 1; sequence <= 40; sequence++) {
    const check = challenge('check', sequence);
    await writeRuntimeTestMessage(s.input, check);
    expect((await reply()).value).toEqual({ contract: 'cos-backup-smb-current/v1', sequence, nonce: check.nonce });
  }
  const release = challenge('release', 41);
  await writeRuntimeTestMessage(s.input, release);
  s.input.end();
  expect((await reply()).value).toEqual({ contract: 'cos-backup-smb-released/v1', sequence: 41, nonce: release.nonce });
  await running;
});
it.each([
  'parent',
  'owner',
  'memory',
  'tty-input',
  'tty-output',
  'encoding',
  'invalid-deadline',
  'extra',
  'roots',
  'scope',
  'uid',
  'empty',
  'oversized',
  'json',
])('denies initial %s without opening a credential', async (reason) => {
  const s = fixture();
  if (reason === 'parent')
    s.controls.assertParent.mockImplementation(() => {
      throw Error('PRIVATE_PARENT');
    });
  if (reason === 'owner')
    s.controls.assertOwner.mockImplementation(() => {
      throw Error('PRIVATE_OWNER');
    });
  if (reason === 'memory')
    f.memory.mockImplementation(() => {
      throw Error('PRIVATE_MEMORY');
    });
  if (reason === 'tty-input') Object.assign(s.input, { isTTY: true });
  if (reason === 'tty-output') Object.assign(s.output, { isTTY: true });
  if (reason === 'encoding') s.input.setEncoding('utf8');
  if (reason === 'invalid-deadline') s.controls.deadlineMs = 30001;
  const request = structuredClone(s.open);
  if (reason === 'extra') Object.assign(request, { command: '/bin/sh' });
  if (reason === 'roots') request.roots.targetRoot = '/home/fixture/../foreign';
  if (reason === 'scope') request.expected.targetDigest = 'unsafe';
  if (reason === 'uid') request.owner.uid = 0;
  const running = runBackupSmbCredentialProbe(s.input, s.output, s.controls);
  const rejected = expect(running).rejects.toThrow(/^backup_smb_probe_unavailable$/);
  if (reason === 'empty') s.input.end();
  else if (reason === 'oversized') s.input.end(Buffer.alloc(9000, 0x61));
  else if (reason === 'json') s.input.end('{"broken":\n');
  else s.input.end(JSON.stringify(request) + '\n');
  await rejected;
  expect(f.credentials).not.toHaveBeenCalled();
});
it.each(['lease', 'parent', 'memory', 'sequence', 'nonce', 'extra', 'eof', 'release-extra', 'deadline'])(
  'drops the held lease and rejects %s after the ready response',
  async (reason) => {
    const s = fixture();
    if (reason === 'deadline') s.controls.deadlineMs = 30;
    const running = runBackupSmbCredentialProbe(s.input, s.output, s.controls);
    const rejected = expect(running).rejects.toThrow(/^backup_smb_probe_unavailable$/);
    await writeRuntimeTestMessage(s.input, s.open);
    await s.messages.next();
    if (reason === 'lease')
      s.checks.mockImplementation(() => {
        throw Error('PRIVATE_LEASE');
      });
    if (reason === 'parent')
      s.controls.assertParent.mockImplementation(() => {
        throw Error('PRIVATE_PARENT');
      });
    if (reason === 'memory')
      f.memory.mockImplementation(() => {
        throw Error('PRIVATE_MEMORY');
      });
    const check = challenge('check', 1);
    if (reason === 'sequence') check.sequence = 2;
    if (reason === 'nonce') check.nonce = 'foreign';
    if (reason === 'extra') Object.assign(check, { fd: 999 });
    if (reason === 'eof') s.input.end();
    else if (reason === 'release-extra') {
      await writeRuntimeTestMessage(s.input, challenge('release', 1));
      s.input.end(JSON.stringify(check) + '\n');
    } else if (reason !== 'deadline') await writeRuntimeTestMessage(s.input, check);
    await rejected;
    expect(s.active()).toBe(false);
  },
);
