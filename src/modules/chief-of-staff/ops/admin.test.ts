import { describe, it, expect, vi } from 'vitest';
import { parseAdminArguments, adminStatus, safeAdminError } from './admin.js';
import { DatabasePreflightError } from '../store/preflight.js';
import { DatabaseConfigurationError } from '../store/config.js';
describe('S01 owner administration', () => {
  it('requires a private policy path for activation and stable identities for explicit resume', () => {
    expect(parseAdminArguments(['model-activate', '--scope', 'fixture', '--policy', '/private/fixture.json'])).toEqual({
      command: 'model-activate',
      scopeId: 'fixture',
      policyFile: '/private/fixture.json',
    });
    const activationId = 'a'.repeat(32),
      resumeId = '11111111-1111-4111-8111-111111111111';
    expect(
      parseAdminArguments([
        'context-resume',
        '--scope',
        'fixture',
        '--activation-id',
        activationId,
        '--resume-id',
        resumeId,
      ]),
    ).toEqual({ command: 'context-resume', scopeId: 'fixture', activationId, resumeId });
    for (const args of [
      ['model-activate', '--scope', 'fixture', '--policy', 'relative.json'],
      ['context-resume', '--scope', 'fixture'],
      ['context-resume', '--scope', 'fixture', '--activation-id', activationId, '--resume-id', 'invalid'],
    ])
      expect(() => parseAdminArguments(args)).toThrow('invalid_admin_arguments');
  });
  it('reports actionable context errors without passing through raw account or filesystem text', () => {
    expect(safeAdminError(new Error('context_recovery_stale_generation'))).toBe('context_recovery_stale_generation');
    expect(safeAdminError(new Error('NanoClaw host execution lease is already held by a live process'))).toBe(
      'host_writer_active',
    );
    expect(safeAdminError(new Error('context_recovery_conflict: secret-canary'))).toBe('unreachable');
  });
  it('parses explicit context inspection, preparation and generation-bound recovery without accepting implicit reset', () => {
    expect(parseAdminArguments(['context-status', '--scope', 'fixture'])).toEqual({
      command: 'context-status',
      scopeId: 'fixture',
    });
    expect(parseAdminArguments(['context-prepare', '--scope', 'fixture'])).toEqual({
      command: 'context-prepare',
      scopeId: 'fixture',
    });
    const generation = '11111111-1111-4111-8111-111111111111',
      recovery = '22222222-2222-4222-8222-222222222222';
    expect(
      parseAdminArguments([
        'context-recover',
        '--scope',
        'fixture',
        '--expected-generation',
        generation,
        '--recovery-id',
        recovery,
      ]),
    ).toEqual({ command: 'context-recover', scopeId: 'fixture', expectedGeneration: generation, recoveryId: recovery });
    for (const args of [
      ['context-recover', '--scope', 'fixture'],
      ['context-status', '--scope', 'fixture', '--reset', 'yes'],
      ['context-prepare', '--scope', '../foreign'],
    ])
      expect(() => parseAdminArguments(args)).toThrow('invalid_admin_arguments');
  });
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
    database.mockResolvedValue(1);
    expect(await adminStatus(env, { target, database })).toMatchObject({ status: 'schema_incompatible' });
    database.mockResolvedValue(2);
    expect(await adminStatus(env, { target, database })).toMatchObject({ status: 'schema_incompatible' });
    database.mockResolvedValue(3);
    expect(await adminStatus(env, { target, database })).toMatchObject({ status: 'schema_incompatible' });
    database.mockResolvedValue(4);
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
