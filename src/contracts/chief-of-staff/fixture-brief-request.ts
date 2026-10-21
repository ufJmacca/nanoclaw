type FixtureBriefRequest = Readonly<{ request_id: string; time_zone: string }>;

/** Fixture caller for the brief tool's documented same-request reconciliation. */
export async function fixtureBriefRequest<T extends { status: string }>(
  call: (request: FixtureBriefRequest) => Promise<T>,
  request: FixtureBriefRequest,
): Promise<T> {
  const original = Object.freeze({ ...request });
  const result = await call(original);
  // One protocol reconciliation stays within the scenario's unchanged deadline.
  return result.status === 'pending' ? call(original) : result;
}
