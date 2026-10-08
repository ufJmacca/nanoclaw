import { expect, it, vi } from 'vitest';
import { pumpMissionFixture } from './mission-fixture-pump.js';

it('returns a successful pump without fetching diagnostics', async () => {
  const request = vi.fn().mockResolvedValue(true);
  await expect(pumpMissionFixture({ request })).resolves.toBe(true);
  expect(request.mock.calls).toEqual([['pump']]);
});

it('allows only the explicit pending exact-stop observation to be polled again', async () => {
  const request = vi.fn().mockRejectedValue(new Error('fixture_host_command_failed:mission_recovery_pending'));
  await expect(pumpMissionFixture({ request })).resolves.toBe(false);
  expect(request.mock.calls).toEqual([['pump']]);
});

it('retains the original pump failure and its available diagnostics', async () => {
  const primary = new Error('fixture_host_command_failed:mission_recovery_unavailable');
  const diagnostics = { worker: null, database: [{ code: 'unavailable', frame: 'client:32', elapsed: 3000 }] };
  const request = vi.fn().mockRejectedValueOnce(primary).mockResolvedValueOnce(diagnostics);
  const failure = await pumpMissionFixture({ request }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).cause).toBe(primary);
  expect((failure as Error).message).toBe('mission_flow_failed:' + primary.message + ':' + JSON.stringify(diagnostics));
  expect(request.mock.calls).toEqual([['pump'], ['mission-diagnostics']]);
});

it('does not let a second diagnostic timeout hide the original pump failure', async () => {
  const primary = new Error('fixture_host_deadline');
  const request = vi.fn().mockRejectedValueOnce(primary).mockRejectedValueOnce(new Error('fixture_host_deadline'));
  const failure = await pumpMissionFixture({ request }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).cause).toBe(primary);
  expect((failure as Error).message).toBe('mission_flow_failed:fixture_host_deadline:{"status":"unavailable"}');
});
