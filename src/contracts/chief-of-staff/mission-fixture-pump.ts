import type { HostFixture } from './host-fixture-client.js';

/** Keep a flow failure and its bounded host diagnostics together. */
export async function pumpMissionFixture(host: Pick<HostFixture, 'request'>): Promise<boolean> {
  try {
    return await host.request('pump');
  } catch (error) {
    // Docker may still be removing an exact stopped orphan; observe again under the flow deadline.
    if (error instanceof Error && error.message === 'fixture_host_command_failed:mission_recovery_pending')
      return false;
    // A queued diagnostic command can time out too; it must never replace the failure being diagnosed.
    const diagnostics = await host.request('mission-diagnostics').catch(() => ({ status: 'unavailable' }));
    throw new Error(
      'mission_flow_failed:' + (error instanceof Error ? error.message : 'unknown') + ':' + JSON.stringify(diagnostics),
      { cause: error },
    );
  }
}
