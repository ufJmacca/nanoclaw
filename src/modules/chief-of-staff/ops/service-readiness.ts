/** systemd start may return before the host has acquired its SQLite execution lease. */
export async function waitForTargetProcess<T>(observe: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      return await observe();
    } catch (error) {
      const failure = error as NodeJS.ErrnoException;
      if (
        attempt === 39 ||
        !(
          ['target_service_unhealthy', 'target_host_ownership_mismatch'].includes(failure.message) ||
          failure.code === 'ENOENT'
        )
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error('target_service_unhealthy');
}
