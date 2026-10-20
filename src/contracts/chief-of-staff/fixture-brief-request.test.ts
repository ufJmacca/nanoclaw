import { expect, it, vi } from 'vitest';
import { fixtureBriefRequest } from './fixture-brief-request.js';

const request = { request_id: '11111111-1111-4111-8111-111111111111', time_zone: 'UTC' };
it('reconciles a lost completion reply with exactly the original request identity', async () => {
  const completed = { status: 'ok', artifact_id: 'original-artifact' };
  const call = vi.fn().mockResolvedValueOnce({ status: 'pending' }).mockResolvedValueOnce(completed);
  await expect(fixtureBriefRequest(call, request)).resolves.toBe(completed);
  expect(call).toHaveBeenCalledTimes(2);
  expect(call.mock.calls[0][0]).toEqual(request);
  expect(call.mock.calls[1][0]).toBe(call.mock.calls[0][0]);
  expect(Object.isFrozen(call.mock.calls[0][0])).toBe(true);
});
it('keeps a second pending result unconfirmed rather than polling without a bound', async () => {
  const pending = { status: 'pending' },
    call = vi.fn().mockResolvedValue(pending);
  await expect(fixtureBriefRequest(call, request)).resolves.toBe(pending);
  expect(call).toHaveBeenCalledTimes(2);
});
it.each(['ok', 'denied', 'unavailable', 'conflict'])('does not replay a %s result', async (status) => {
  const value = { status },
    call = vi.fn().mockResolvedValue(value);
  await expect(fixtureBriefRequest(call, request)).resolves.toBe(value);
  expect(call).toHaveBeenCalledTimes(1);
});
it('does not hide a transport failure', async () => {
  const failure = Error('fixture_transport_failed'),
    call = vi.fn().mockRejectedValue(failure);
  await expect(fixtureBriefRequest(call, request)).rejects.toBe(failure);
  expect(call).toHaveBeenCalledTimes(1);
});
