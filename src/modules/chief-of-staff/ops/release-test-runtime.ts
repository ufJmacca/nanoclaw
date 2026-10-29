import fs from 'node:fs';
export type ReleaseTestRuntime = {
  platform: string;
  architecture: string;
  uid: number | undefined;
  machineIdentityInitialized: boolean;
  systemdAnalyzeAvailable: boolean;
  systemdEscapeAvailable: boolean;
};
/** Development tests exercise real Linux service units and target identity.
 * Reject a stale or incomplete devcontainer before creating a release. */
export function assertReleaseTestRuntime(runtime: ReleaseTestRuntime): void {
  if (
    runtime.platform !== 'linux' ||
    runtime.architecture !== 'arm64' ||
    runtime.uid !== 1000 ||
    runtime.machineIdentityInitialized !== true ||
    runtime.systemdAnalyzeAvailable !== true ||
    runtime.systemdEscapeAvailable !== true
  )
    throw Error('development_test_runtime_unavailable');
}
function observeReleaseTestRuntime(): ReleaseTestRuntime {
  const executable = (file: string) => {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  };
  return {
    platform: process.platform,
    architecture: process.arch,
    uid: process.getuid?.(),
    machineIdentityInitialized: /^[a-f0-9]{32}$/.test(fs.readFileSync('/etc/machine-id', 'utf8').trim()),
    systemdAnalyzeAvailable: executable('/usr/bin/systemd-analyze'),
    systemdEscapeAvailable: executable('/usr/bin/systemd-escape'),
  };
}
/** The observer argument is a code-only fixture seam. No identity bytes are returned. */
export function verifyReleaseTestRuntime(observe: () => ReleaseTestRuntime = observeReleaseTestRuntime): void {
  try {
    assertReleaseTestRuntime(observe());
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Local machine identity and inspection details must not escape the fixed prerequisite category.
    throw Error('development_test_runtime_unavailable');
  }
}
