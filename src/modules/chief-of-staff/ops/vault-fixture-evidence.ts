/** Reuse the actual wire run inside the successful kernel fixture, rather than inventing another execution. */
export function verifyVaultFixtureImage(value: unknown, sourceCommit: string, hostImage: string): string {
  const entries = value as Array<{
    Id: string;
    Os: string;
    Architecture: string;
    Config?: { Labels?: Record<string, string> };
  }>;
  const entry = Array.isArray(entries) && entries.length === 1 ? entries[0] : undefined;
  if (
    !/^[a-f0-9]{40}$/.test(sourceCommit) ||
    !/^sha256:[a-f0-9]{64}$/.test(hostImage) ||
    !entry ||
    !/^sha256:[a-f0-9]{64}$/.test(entry.Id) ||
    entry.Os !== 'linux' ||
    entry.Architecture !== 'arm64' ||
    entry.Config?.Labels?.['nanoclaw.release-role'] !== 'vault-fixture' ||
    entry.Config?.Labels?.['org.opencontainers.image.revision'] !== sourceCommit ||
    entry.Config?.Labels?.['nanoclaw.tested-host'] !== hostImage
  )
    throw Error('vault_fixture_identity_mismatch');
  return entry.Id;
}
export function verifyVaultWireEvidence(records: unknown[], sourceCommit: string, fixtureImage: string): void {
  const deny = (): never => {
    throw Error('vault_wire_evidence_unavailable');
  };
  if (
    !Array.isArray(records) ||
    records.length > 256 ||
    !/^[a-f0-9]{40}$/.test(sourceCommit) ||
    !/^sha256:[a-f0-9]{64}$/.test(fixtureImage)
  )
    deny();
  const one = (field: string) => {
    const matches = records.filter(
      (value) => value && typeof value === 'object' && !Array.isArray(value) && field in value,
    );
    if (matches.length !== 1) return deny();
    return matches[0] as Record<string, unknown>;
  };
  const header = one('vaultFixtureImage'),
    wire = one('rootRecoveryWire'),
    kernel = one('kernelVault'),
    journal = one('rootOrchestration');
  if (
    header.vaultFixtureImage !== fixtureImage ||
    header.sourceCommit !== sourceCommit ||
    header.mode !== 'kernel' ||
    wire.rootRecoveryWire !== 'passed' ||
    wire.liveOwnerProof !== 'verified' ||
    wire.realRecoverySlot !== 'verified' ||
    wire.recoveryKeyOnDisk !== false ||
    journal.rootOrchestration !== 'passed' ||
    kernel.kernelVault !== 'passed' ||
    kernel.volumeBytes !== 1073741824 ||
    kernel.bootKeyRemoved !== true ||
    kernel.recoveredCanary !== true ||
    kernel.wrongKeyDenied !== true ||
    kernel.mountRaceDenied !== true ||
    kernel.plaintextFallback !== false ||
    kernel.memoryProtection !== 'verified' ||
    kernel.recoveryKeyOnDisk !== false
  )
    deny();
}
