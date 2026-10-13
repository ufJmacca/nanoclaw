import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ memory: vi.fn(), install: vi.fn() }));
vi.mock('./vault-memory.js', () => ({ verifyVaultMemory: f.memory }));
vi.mock('./backup-credential-install.js', () => ({ installBackupCredentials: f.install }));
import { parseBackupCredentialInstallArguments, runBackupCredentialInstallAdmin } from './backup-credential-admin.js';
const requestId = '48f99256-b105-4ee3-848c-00140c98151d';
const credentialReference = '319c6740-24ba-4d68-9d3c-a4d53c9607d1';
const args = [
  'backup-credentials-install',
  '--scope',
  'fixture',
  '--request-id',
  requestId,
  '--credential-reference',
  credentialReference,
];
const parsed = { command: 'backup-credentials-install' as const, scopeId: 'fixture', requestId, credentialReference };
const roots = { targetRoot: '/synthetic/state', installationRoot: '/synthetic/install', dataRoot: '/synthetic/data' };
const receipt = {
  contract: 'cos-backup-credential-installation-result/v1',
  status: 'ready',
  rootsDigest: 'a'.repeat(64),
  filesystemUuid: '11111111-1111-4111-8111-111111111111',
};
afterEach(() => {
  f.memory.mockReset();
  f.install.mockReset();
});
function bundle() {
  return Buffer.concat([
    Buffer.from([0x43, 0x4f, 0x53, 0x42, 1, 16, 64]),
    Buffer.alloc(16, 0x62),
    Buffer.alloc(64, 0x61),
  ]);
}

it('parses only owner scope and stable non-secret setup references', () => {
  expect(parseBackupCredentialInstallArguments(args)).toEqual(parsed);
  expect(parseBackupCredentialInstallArguments([args[0], ...args.slice(5), ...args.slice(1, 5)])).toEqual(parsed);
});
it.each(['extra-password', 'extra-root', 'duplicate', 'missing', 'wrong-scope', 'wrong-request', 'wrong-reference'])(
  'refuses %s credential setup arguments',
  (reason) => {
    let input = [...args];
    if (reason === 'extra-password') input.push('--password', 'PRIVATE_VALUE');
    if (reason === 'extra-root') input.push('--root', '/tmp/unsafe');
    if (reason === 'duplicate') input.push('--scope', 'fixture');
    if (reason === 'missing') input = input.slice(0, -2);
    if (reason === 'wrong-scope') input[2] = '../foreign';
    if (reason === 'wrong-request') input[4] = 'not-a-uuid';
    if (reason === 'wrong-reference') input[6] = 'not-a-uuid';
    expect(() => parseBackupCredentialInstallArguments(input)).toThrow(/^invalid_admin_arguments$/);
  },
);
it('passes the private frame to the vault installer with fresh owner authority and clears all borrowed copies', async () => {
  const bytes = bundle(),
    check = vi.fn(async () => {}),
    assertAuthority = vi.fn(() => {});
  let retained!: Buffer;
  f.install.mockImplementation(async (input) => {
    expect(input.roots).toBe(roots);
    expect(input.operationId).toBe(requestId);
    expect(input.credentialReference).toBe(credentialReference);
    expect(input.bytes.equals(bundle())).toBe(true);
    retained = input.bytes;
    await input.check();
    input.assertAuthority();
    return receipt;
  });
  expect(
    await runBackupCredentialInstallAdmin({
      args: parsed,
      roots,
      check,
      assertAuthority,
      stream: Readable.from([bytes]),
    }),
  ).toEqual(receipt);
  expect(check).toHaveBeenCalled();
  expect(assertAuthority).toHaveBeenCalled();
  expect(bytes.every((byte) => byte === 0)).toBe(true);
  expect(retained.every((byte) => byte === 0)).toBe(true);
});
it.each(['memory', 'authority', 'check'])('refuses %s before reading the private pipe', async (reason) => {
  let read = false;
  const stream = new Readable({
    read() {
      read = true;
      this.push(null);
    },
  });
  const check = vi.fn(async () => {}),
    assertAuthority = vi.fn(() => {});
  if (reason === 'memory')
    f.memory.mockImplementation(() => {
      throw Error('PRIVATE_MEMORY');
    });
  if (reason === 'authority')
    assertAuthority.mockImplementation(() => {
      throw Error('PRIVATE_AUTHORITY');
    });
  if (reason === 'check') check.mockRejectedValue(Error('PRIVATE_CHECK'));
  await expect(
    runBackupCredentialInstallAdmin({ args: parsed, roots, check, assertAuthority, stream }),
  ).rejects.toThrow(/^backup_credential_setup_unavailable$/);
  expect(read).toBe(false);
  expect(f.install).not.toHaveBeenCalled();
  expect(stream.destroyed).toBe(true);
});
it('rechecks owner authority after receiving the complete frame and before installation', async () => {
  const bytes = bundle();
  const check = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(Error('PRIVATE_LATE_CHECK'));
  await expect(
    runBackupCredentialInstallAdmin({
      args: parsed,
      roots,
      check,
      assertAuthority() {},
      stream: Readable.from([bytes]),
    }),
  ).rejects.toThrow(/^backup_credential_setup_unavailable$/);
  expect(f.install).not.toHaveBeenCalled();
  expect(bytes.every((byte) => byte === 0)).toBe(true);
});
it('redacts installer diagnostics and wipes its extra bounded frame copy', async () => {
  const bytes = bundle();
  let retained!: Buffer;
  f.install.mockImplementation(async (input) => {
    retained = input.bytes;
    throw Error('PRIVATE_PASSWORD_DIAGNOSTIC');
  });
  const failure = await runBackupCredentialInstallAdmin({
    args: parsed,
    roots,
    check: async () => {},
    assertAuthority() {},
    stream: Readable.from([bytes]),
  }).catch((error: Error) => error);
  expect(failure).toEqual(Error('backup_credential_setup_unavailable'));
  expect(failure && failure.cause).toBeUndefined();
  expect(bytes.every((byte) => byte === 0)).toBe(true);
  expect(retained.every((byte) => byte === 0)).toBe(true);
});
