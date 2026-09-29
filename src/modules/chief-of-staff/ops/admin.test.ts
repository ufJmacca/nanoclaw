import { describe, it, expect, vi } from 'vitest';
import { parseAdminArguments, adminStatus } from './admin.js';
import { DatabasePreflightError } from '../store/preflight.js';
import { DatabaseConfigurationError } from '../store/config.js';
describe('S01 owner administration', () => {
  it('requires an exact complete private binding and refuses unknown commands or providers', () => {
    const args = [
      'bind',
      '--scope',
      'fixture',
      '--instance',
      'fixture',
      '--channel',
      'private',
      '--owner',
      'owner',
      '--bot',
      'bot',
      '--provider',
      'codex',
    ];
    expect(parseAdminArguments(args)).toMatchObject({
      command: 'bind',
      binding: { scopeId: 'fixture', provider: 'codex' },
    });
    for (const bad of [
      ['reset'],
      ['bind'],
      [...args, '--provider', 'claude'],
      [...args.slice(0, -1), 'claude'],
      [...args.slice(0, -1), 'shell'],
      ['status', '--scope', 'fixture'],
    ])
      expect(() => parseAdminArguments(bad)).toThrow('invalid_admin_arguments');
  });
  it('reports disabled without reading a target or contacting PostgreSQL', async () => {
    const target = vi.fn(),
      database = vi.fn();
    expect(await adminStatus({}, { target, database })).toMatchObject({ status: 'disabled' });
    expect(target).not.toHaveBeenCalled();
    expect(database).not.toHaveBeenCalled();
  });
  it('distinguishes unbound, maintenance, incompatible schema and ready infrastructure', async () => {
    const target = vi.fn().mockReturnValue(null),
      database = vi.fn().mockResolvedValue(1);
    const env = { COS_ENABLED: 'true' };
    expect(await adminStatus(env, { target, database })).toMatchObject({ status: 'unbound' });
    target.mockReturnValue({ maintenance: true, lifecycle: 'implementation_disposable' });
    expect(await adminStatus(env, { target, database })).toMatchObject({ status: 'maintenance' });
    expect(database).not.toHaveBeenCalled();
    target.mockReturnValue({ maintenance: false, lifecycle: 'implementation_disposable' });
    database.mockResolvedValue(2);
    expect(await adminStatus(env, { target, database })).toMatchObject({ status: 'schema_incompatible' });
    database.mockResolvedValue(1);
    expect(await adminStatus(env, { target, database })).toMatchObject({
      status: 'ready',
      model_activation: 'not_verified',
    });
  });
  it('returns classified dependency errors without echoing credentials or driver text', async () => {
    const target = vi.fn().mockReturnValue({ maintenance: false, lifecycle: 'implementation_disposable' }),
      database = vi.fn();
    for (const [error, status] of [
      [new DatabaseConfigurationError('COS_PGHOST'), 'misconfigured'],
      [new DatabasePreflightError('tls_rejected'), 'tls_rejected'],
      [new Error('password-canary'), 'unreachable'],
    ] as const) {
      database.mockRejectedValue(error);
      const result = await adminStatus({ COS_ENABLED: 'true' }, { target, database });
      expect(result.status).toBe(status);
      expect(JSON.stringify(result)).not.toContain('password-canary');
    }
  });
});
