import { afterEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
  gateway: vi.fn(),
  installer: vi.fn(),
  probe: vi.fn(),
  mount: vi.fn(),
  setup: vi.fn(),
  recovery: vi.fn(),
  inspection: vi.fn(),
}));
vi.mock('./vault-root-gateway.js', () => ({ runVaultRootGateway: f.gateway }));
vi.mock('./vault-root-installer.js', () => ({ runVaultRootInstaller: f.installer }));
vi.mock('./backup-smb-probe.js', () => ({ runBackupSmbCredentialProbe: f.probe }));
vi.mock('./backup-nas-root-runtime.js', () => ({ runBackupNasRootMount: f.mount }));
vi.mock('./backup-nas-root-setup.js', () => ({ runBackupNasRootSetup: f.setup }));
vi.mock('./backup-nas-root-recovery.js', () => ({ runBackupNasRootRecovery: f.recovery }));
vi.mock('./backup-nas-root-inspection.js', () => ({ runBackupNasRootInitializationInspection: f.inspection }));
const originalArgv = process.argv,
  originalExitCode = process.exitCode;
const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
  else Reflect.deleteProperty(process.stdin, 'isTTY');
  vi.restoreAllMocks();
  for (const fn of Object.values(f)) fn.mockReset();
});
async function invoke(args: string[], isTTY = false) {
  vi.restoreAllMocks();
  vi.resetModules();
  process.argv = ['/sealed/node', '/sealed/gateway.mjs', ...args];
  process.exitCode = undefined;
  Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true });
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
    error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  f.gateway.mockResolvedValue({ contract: 'fixture-gateway', status: 'ready' });
  f.installer.mockResolvedValue({ contract: 'fixture-installer', status: 'ready' });
  await import('./vault-root-entry.js');
  return {
    stdout: out.mock.calls.map((call) => String(call[0])).join(''),
    stderr: error.mock.calls.map((call) => String(call[0])).join(''),
    exitCode: process.exitCode,
  };
}
it('preserves the fixed gateway and staged installer routes', async () => {
  const gateway = await invoke([]);
  expect(f.gateway).toHaveBeenCalledWith(process.stdin);
  expect(f.installer).not.toHaveBeenCalled();
  expect(f.probe).not.toHaveBeenCalled();
  expect(gateway).toEqual({
    stdout: '{"contract":"fixture-gateway","status":"ready"}\n',
    stderr: '',
    exitCode: undefined,
  });
  f.gateway.mockClear();
  const installer = await invoke(['--install']);
  expect(f.installer).toHaveBeenCalledWith(process.stdin);
  expect(f.gateway).not.toHaveBeenCalled();
  expect(f.probe).not.toHaveBeenCalled();
  expect(installer.stdout).toBe('{"contract":"fixture-installer","status":"ready"}\n');
});
it('routes only the exact private owner probe invocation without appending a second success receipt', async () => {
  f.probe.mockImplementation(async (_input, output) => {
    output.write('{"contract":"fixture-probe-ready"}\n');
  });
  const result = await invoke(['--backup-credential-probe']);
  expect(f.probe).toHaveBeenCalledWith(process.stdin, process.stdout);
  expect(f.gateway).not.toHaveBeenCalled();
  expect(f.installer).not.toHaveBeenCalled();
  expect(result).toEqual({ stdout: '{"contract":"fixture-probe-ready"}\n', stderr: '', exitCode: undefined });
});
it.each(['mount', 'unmount'])(
  'routes only the fixed backup %s command to its independent root admission',
  async (action) => {
    f.mount.mockResolvedValue({ contract: 'fixture-backup-mount', status: action === 'mount' ? 'mounted' : 'closed' });
    const result = await invoke(['--backup-' + action]);
    expect(f.mount).toHaveBeenCalledWith(action);
    expect(f.gateway).not.toHaveBeenCalled();
    expect(f.installer).not.toHaveBeenCalled();
    expect(f.probe).not.toHaveBeenCalled();
    expect(result).toEqual({
      stdout:
        JSON.stringify({ contract: 'fixture-backup-mount', status: action === 'mount' ? 'mounted' : 'closed' }) + '\n',
      stderr: '',
      exitCode: undefined,
    });
  },
);
it('routes only the exact private NAS configuration command to the owner-bound setup route', async () => {
  f.setup.mockResolvedValue({ contract: 'fixture-backup-setup', status: 'configured' });
  const result = await invoke(['--backup-configure']);
  expect(f.setup).toHaveBeenCalledWith(process.stdin);
  expect(f.gateway).not.toHaveBeenCalled();
  expect(f.installer).not.toHaveBeenCalled();
  expect(f.probe).not.toHaveBeenCalled();
  expect(f.mount).not.toHaveBeenCalled();
  expect(result).toEqual({
    stdout: '{"contract":"fixture-backup-setup","status":"configured"}\n',
    stderr: '',
    exitCode: undefined,
  });
});
it('routes only the exact private recovery command without granting ordinary mount or setup capability', async () => {
  f.recovery.mockResolvedValue({ contract: 'fixture-backup-recovery', status: 'closed' });
  expect(await invoke(['--backup-recover-unmount'])).toEqual({
    stdout: '{"contract":"fixture-backup-recovery","status":"closed"}\n',
    stderr: '',
    exitCode: undefined,
  });
  expect(f.recovery).toHaveBeenCalledWith(process.stdin);
  expect(f.gateway).not.toHaveBeenCalled();
  expect(f.setup).not.toHaveBeenCalled();
  expect(f.mount).not.toHaveBeenCalled();
  expect(f.probe).not.toHaveBeenCalled();
});
it('redacts private recovery failures into one fixed CLI result', async () => {
  f.recovery.mockRejectedValue(Error('PRIVATE_NAS_SOCKET_AND_RECOVERY_INTENT'));
  expect(await invoke(['--backup-recover-unmount'])).toEqual({
    stdout: '',
    stderr: '{"code":"backup_nas_root_recovery_unavailable"}\n',
    exitCode: 1,
  });
});
it('routes only the fixed private initialization inspection without invoking setup or recovery', async () => {
  f.inspection.mockResolvedValue({ contract: 'fixture-backup-inspection', status: 'observed' });
  expect(await invoke(['--backup-inspect-initialization'])).toEqual({
    stdout: '{"contract":"fixture-backup-inspection","status":"observed"}\n',
    stderr: '',
    exitCode: undefined,
  });
  expect(f.inspection).toHaveBeenCalledWith(process.stdin);
  for (const fn of [f.setup, f.recovery, f.mount, f.gateway, f.installer, f.probe]) expect(fn).not.toHaveBeenCalled();
});
it('redacts private initialization inspection diagnostics', async () => {
  f.inspection.mockRejectedValue(Error('PRIVATE_UNCLAIMED_RESOURCE'));
  expect(await invoke(['--backup-inspect-initialization'])).toEqual({
    stdout: '',
    stderr: '{"code":"backup_nas_root_inspection_unavailable"}\n',
    exitCode: 1,
  });
});
it.each(
  [
    ['--root=/tmp'],
    ['--backup-credential-probe', '--owner=0'],
    ['--install', '--root=/tmp'],
    ['--backup-mount', '--target=/tmp'],
    ['--backup-unmount', '--force'],
    ['--backup-configure', '--host=192.168.56.13'],
    ['--backup-recover-unmount', '--mount-id=55'],
    ['--backup-inspect-initialization', '--path=/tmp'],
    ['--probe'],
    ['--install', '--backup-credential-probe'],
  ].map((args) => ({ args })),
)('refuses arbitrary helper selectors $args', async ({ args }) => {
  const result = await invoke(args);
  expect(f.gateway).not.toHaveBeenCalled();
  expect(f.installer).not.toHaveBeenCalled();
  expect(f.probe).not.toHaveBeenCalled();
  expect(f.mount).not.toHaveBeenCalled();
  expect(f.setup).not.toHaveBeenCalled();
  expect(f.recovery).not.toHaveBeenCalled();
  expect(f.inspection).not.toHaveBeenCalled();
  expect(result.stdout).toBe('');
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/unavailable/);
});
it.each(
  [
    [],
    ['--install'],
    ['--backup-credential-probe'],
    ['--backup-mount'],
    ['--backup-unmount'],
    ['--backup-configure'],
    ['--backup-recover-unmount'],
    ['--backup-inspect-initialization'],
  ].map((args) => ({
    args,
  })),
)('refuses interactive entry before reading any input for $args', async ({ args }) => {
  const result = await invoke(args, true);
  expect(f.gateway).not.toHaveBeenCalled();
  expect(f.installer).not.toHaveBeenCalled();
  expect(f.probe).not.toHaveBeenCalled();
  expect(f.mount).not.toHaveBeenCalled();
  expect(f.setup).not.toHaveBeenCalled();
  expect(f.recovery).not.toHaveBeenCalled();
  expect(f.inspection).not.toHaveBeenCalled();
  expect(result.exitCode).toBe(1);
});
it('emits only a fixed probe failure for private nested diagnostics', async () => {
  f.probe.mockRejectedValue(Error('PRIVATE_PASSWORD_OR_PATH'));
  const result = await invoke(['--backup-credential-probe']);
  expect(result).toEqual({ stdout: '', stderr: '{"code":"backup_smb_probe_unavailable"}\n', exitCode: 1 });
});
it.each(['mount', 'unmount'])('emits only a fixed root backup failure for private %s diagnostics', async (action) => {
  f.mount.mockRejectedValue(Error('PRIVATE_PASSWORD_OR_PATH'));
  const result = await invoke(['--backup-' + action]);
  expect(result).toEqual({ stdout: '', stderr: '{"code":"backup_nas_root_mount_unavailable"}\n', exitCode: 1 });
});
it('redacts private NAS setup failures into one fixed CLI result', async () => {
  f.setup.mockRejectedValue(Error('PRIVATE_NAS_SOCKET_AND_TOKEN'));
  expect(await invoke(['--backup-configure'])).toEqual({
    stdout: '',
    stderr: '{"code":"backup_nas_root_setup_unavailable"}\n',
    exitCode: 1,
  });
});
