import { digest } from '../domain/contracts.js';
import { checkedClient, validCalendarTokens } from '../calendar/oauth-core.js';
import { credentialProfileMetadata } from '../calendar/credential-core.js';
import { contextGenerationPattern } from '../ops/conversation-ownership.js';
import { credentialSource } from '../ops/backup-credential-event.js';
import {
  makeRoutedCredentialRecoveryManifest,
  routedCredentialRecoveryFiles,
  type RoutedCredentialRecoveryManifest,
} from '../ops/credential-recovery-routing.js';
import type { BackupRestoreValidationScope } from '../ops/backup-restore-workspace.js';
import { withVaultCredentialSnapshot } from '../ops/credential-vault-snapshot.js';
import { restoreVaultCredentialCapture } from '../ops/backup-upload.js';
import type { CalendarStorageRoots } from '../calendar/storage-policy.js';

export type MailDraftCredentialRecoveryIdentity = {
  scopeId: string;
  readerBindingId: string;
  writerBindingId: string;
  readerReference: string;
  writerReference: string;
  mailboxDigest: string;
  readerClientDigest: string;
  writerClientDigest: string;
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function validMailDraftCredentialRecoveryIdentity(value: MailDraftCredentialRecoveryIdentity): boolean {
  return (
    object(value) &&
    Object.keys(value).sort().join(',') ===
      'mailboxDigest,readerBindingId,readerClientDigest,readerReference,scopeId,writerBindingId,writerClientDigest,writerReference' &&
    typeof value.scopeId === 'string' &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(value.scopeId) &&
    [value.readerBindingId, value.writerBindingId, value.readerReference, value.writerReference].every(
      (id) => typeof id === 'string' && contextGenerationPattern.test(id),
    ) &&
    value.readerBindingId !== value.writerBindingId &&
    value.readerReference !== value.writerReference &&
    [value.mailboxDigest, value.readerClientDigest, value.writerClientDigest].every(hash) &&
    value.readerClientDigest !== value.writerClientDigest
  );
}
/** Content verification inside the real encrypted restore's owned workspace. The expected
 * complete set must come independently from the pinned current primary vault snapshot.
 * This evidence cannot restore a token, denial journal, policy or writer admission. */
export function verifyRecoveredMailDraftCredentialSet(
  scope: BackupRestoreValidationScope,
  set: RoutedCredentialRecoveryManifest,
  expectedSetDigest: string,
  identity: MailDraftCredentialRecoveryIdentity,
): { setDigest: string; selectionDigest: string; sourceCount: number; fileCount: number } {
  try {
    if (
      !validMailDraftCredentialRecoveryIdentity(identity) ||
      !hash(expectedSetDigest) ||
      digest(set) !== expectedSetDigest
    )
      throw Error('credential_selection_changed');
    const selectionDigest = digest(identity);
    scope.assertCurrent();
    scope.assertPayloadCurrent();
    const files = routedCredentialRecoveryFiles(set, set.ownerDigest).filter(
        (file) => file.name !== 'credential-set.json',
      ),
      routes = new Map<string, { name: string; kind: string }>();
    for (const file of files) {
      const actual = scope.inspectFile(file.name);
      if (actual.file !== file.name || actual.bytes !== file.bytes || actual.sha256 !== file.sha256)
        throw Error('credential_payload_changed');
    }
    for (const source of set.contents.sources) {
      const key = credentialSource(source),
        origin = set.origins.find((entry) => entry.source === key);
      if (!origin) throw Error('credential_origin_missing');
      for (const route of origin.files)
        if (route.destination !== null)
          routes.set(route.destination, {
            name: 'credential-sources/' + key + '/' + route.name,
            kind: source.sourceKind,
          });
    }
    const json = <T>(destination: string, kind: string, operation: (value: unknown) => T): T => {
      const route = routes.get(destination);
      if (!route || route.kind !== kind) throw Error('credential_origin_missing');
      scope.assertPayloadCurrent();
      return scope.withFileBytes(route.name, 32768, (bytes) =>
        operation(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))),
      );
    };
    for (const draft of [false, true]) {
      const profile = draft ? 'mail_draft_writer' : 'mail_reader',
        base = 'google/calendar/' + (draft ? 'mail-draft-writer' : 'mail-reader'),
        binding = draft ? identity.writerBindingId : identity.readerBindingId,
        reference = draft ? identity.writerReference : identity.readerReference,
        expectedClient = draft ? identity.writerClientDigest : identity.readerClientDigest;
      if (routes.has(base + '/access-denials/' + digest({ scope: identity.scopeId, binding }) + '.json'))
        throw Error('selected_credential_denied');
      const clientId = json(
        base + '/oauth-client.json',
        profile,
        (value) => checkedClient(value as { clientId: string }).clientId,
      );
      if (digest(clientId) !== expectedClient) throw Error('credential_client_changed');
      json(base + '/credentials/' + reference + '.json', profile, (value) => {
        if (
          !object(value) ||
          Object.keys(value).sort().join(',') !== 'clientId,contract,generation,identity,phase,tokens' ||
          value.contract !== credentialProfileMetadata(profile).contract ||
          value.clientId !== clientId ||
          value.identity !== digest({ scope: identity.scopeId, binding, reference, profile }) ||
          !Number.isSafeInteger(value.generation) ||
          Number(value.generation) < 1 ||
          value.phase !== 'ready' ||
          !validCalendarTokens(value.tokens, profile)
        )
          throw Error('selected_credential_unavailable');
      });
    }
    scope.assertCurrent();
    scope.assertPayloadCurrent();
    if (digest(set) !== expectedSetDigest || digest(identity) !== selectionDigest)
      throw Error('credential_selection_changed');
    return {
      setDigest: digest(set),
      selectionDigest,
      sourceCount: set.contents.sources.length,
      fileCount: files.length,
    };
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Restored credentials, client secrets, private origins and nested parse diagnostics never leave recovery.
    throw Error('mail_draft_credential_recovery_unavailable');
  }
}
/** Actual remote recovery composition, for the trusted owner administration path only.
 * No caller-supplied manifest, file list, credential bytes, transport or destination exists.
 * The actual decrypt/isolated-file verifier runs before this metadata proof can be returned. */
export async function restoreMailDraftCredentialBaseline(
  roots: CalendarStorageRoots,
  input: {
    identity: MailDraftCredentialRecoveryIdentity;
    captureOperationId: string;
    requestId: string;
    assertAuthority(): void;
  },
) {
  try {
    const selected = structuredClone(input.identity),
      captureId = input.captureOperationId,
      requestId = input.requestId,
      caller = input.assertAuthority,
      configuration = digest({ roots, selected, captureId, requestId });
    if (
      !validMailDraftCredentialRecoveryIdentity(selected) ||
      !contextGenerationPattern.test(captureId) ||
      !contextGenerationPattern.test(requestId) ||
      typeof input.assertAuthority !== 'function'
    )
      throw Error('credential_restore_identity_invalid');
    const authority = () => {
      if (input.assertAuthority !== caller) throw Error('credential_restore_authority_changed');
      caller();
      if (
        digest({ roots, selected: input.identity, captureId: input.captureOperationId, requestId: input.requestId }) !==
        configuration
      )
        throw Error('credential_restore_identity_changed');
    };
    authority();
    return await withVaultCredentialSnapshot(roots, { assertAuthority: authority }, async (snapshot) => {
      if (snapshot.openChecks !== 0) throw Error('credential_check_uncertain');
      const expected = makeRoutedCredentialRecoveryManifest(snapshot.ownerDigest, snapshot.sources),
        expectedDigest = digest(expected),
        current = () => {
          authority();
          snapshot.assertCurrent();
        };
      current();
      snapshot.assertPrimaryUnchanged();
      let verified: ReturnType<typeof verifyRecoveredMailDraftCredentialSet> | null = null;
      const recovered = await restoreVaultCredentialCapture(
        roots,
        captureId,
        requestId,
        current,
        async (scope, remote) => {
          current();
          if (remote.capture.ownerDigest !== snapshot.ownerDigest) throw Error('credential_restore_owner_changed');
          const result = verifyRecoveredMailDraftCredentialSet(scope, remote.capture.set, expectedDigest, selected);
          current();
          snapshot.assertPrimaryUnchanged();
          verified = structuredClone(result);
          return result;
        },
      );
      current();
      snapshot.assertPrimaryUnchanged();
      if (verified === null || digest(verified) !== digest(recovered.validation))
        throw Error('credential_restore_validation_missing');
      return {
        format: 'cos-mail-draft-credential-restore/v1' as const,
        ownerDigest: snapshot.ownerDigest,
        selectionDigest: digest(selected),
        captureOperationId: captureId,
        requestId,
        setDigest: recovered.validation.setDigest,
        sourceCount: recovered.validation.sourceCount,
        fileCount: recovered.validation.fileCount,
        snapshotId: recovered.remote.snapshotId,
        archiveSha256: recovered.remote.archiveSha256,
        archiveBytes: recovered.remote.archiveBytes,
        verifiedAt: recovered.remote.verifiedAt,
        credentialsActivated: false as const,
        admissionRestored: false as const,
        draftJournalRestored: false as const,
        writerActivated: false as const,
      };
    });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Real vault, NAS, decrypted workspace and current authority diagnostics remain private.
    throw Error('mail_draft_credential_recovery_unavailable');
  }
}
