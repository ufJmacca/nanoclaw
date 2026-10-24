import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { makeCredentialEvent, credentialSource } from '../ops/backup-credential-event.js';
import {
  makeRoutedCredentialRecoveryManifest,
  type RoutedCredentialInventory,
} from '../ops/credential-recovery-routing.js';
import type { BackupRestoreValidationScope } from '../ops/backup-restore-workspace.js';
import { credentialRootMarker, credentialProfileMetadata } from '../calendar/credential-core.js';
import { accessFenceRootMarker } from '../calendar/access-fences.js';
import { GOOGLE_MAIL_READ_SCOPE } from '../mail/oauth.js';
import { GOOGLE_MAIL_DRAFT_SCOPE } from './oauth.js';
import { verifyRecoveredMailDraftCredentialSet, restoreMailDraftCredentialBaseline } from './credential-recovery.js';
const backends = vi.hoisted(() => ({ snapshot: vi.fn(), restore: vi.fn() }));
vi.mock('../ops/credential-vault-snapshot.js', () => ({ withVaultCredentialSnapshot: backends.snapshot }));
vi.mock('../ops/backup-upload.js', () => ({ restoreVaultCredentialCapture: backends.restore }));

const owner = digest('fixture vault'),
  identity = {
    scopeId: 'scope',
    readerBindingId: '11111111-1111-4111-8111-111111111111',
    writerBindingId: '22222222-2222-4222-8222-222222222222',
    readerReference: '33333333-3333-4333-8333-333333333333',
    writerReference: '44444444-4444-4444-8444-444444444444',
    mailboxDigest: digest('owner@example.test'),
    readerClientDigest: digest('reader.apps.googleusercontent.com'),
    writerClientDigest: digest('writer.apps.googleusercontent.com'),
  };
function fixture(
  patch: {
    wrongIdentity?: boolean;
    phase?: string;
    widerScope?: boolean;
    sharedClient?: boolean;
    denied?: boolean;
  } = {},
) {
  const inventory: RoutedCredentialInventory = [],
    contents = new Map<string, Buffer>();
  const add = (
    kind: 'mail_reader' | 'mail_draft_writer',
    tag: string,
    data: Array<{ name: string; destination: string | null; bytes: Buffer }>,
    phase = 'ready',
  ) => {
    const event = makeCredentialEvent(
      { sourceKind: kind, sourceKey: digest(kind + tag), generation: 1, phase: phase as 'ready', files: data },
      owner,
    );
    inventory.push({ event, files: data.map(({ name, destination }) => ({ name, destination })) });
    for (const file of data)
      contents.set('credential-sources/' + credentialSource(event) + '/' + file.name, file.bytes);
  };
  for (const draft of [false, true]) {
    const kind = draft ? 'mail_draft_writer' : 'mail_reader',
      directory = 'google/calendar/' + (draft ? 'mail-draft-writer' : 'mail-reader'),
      clientId =
        draft && !patch.sharedClient ? 'writer.apps.googleusercontent.com' : 'reader.apps.googleusercontent.com',
      marker = credentialRootMarker(kind),
      fence = accessFenceRootMarker();
    add(kind, 'configuration', [
      {
        name: 'oauth-client.json',
        destination: directory + '/oauth-client.json',
        bytes: Buffer.from(JSON.stringify({ clientId, clientSecret: 'PRIVATE_FIXTURE_SECRET' })),
      },
      {
        name: 'credential-profile.json',
        destination: directory + '/credentials/' + marker.name,
        bytes: Buffer.from(marker.contents),
      },
      {
        name: 'denial-profile.txt',
        destination: directory + '/access-denials/' + fence.name,
        bytes: Buffer.from(fence.contents),
      },
      {
        name: 'profile-proof.json',
        destination: directory + (draft ? '/.cos-mail-draft-writer' : '/.cos-mail-reader'),
        bytes: Buffer.from('{}'),
      },
    ]);
    const reference = draft ? identity.writerReference : identity.readerReference,
      state = {
        contract: credentialProfileMetadata(kind).contract,
        clientId,
        identity: digest({
          scope: identity.scopeId,
          binding:
            patch.wrongIdentity && draft ? 'foreign' : draft ? identity.writerBindingId : identity.readerBindingId,
          reference,
          profile: kind,
        }),
        generation: 1,
        phase: draft ? (patch.phase ?? 'ready') : 'ready',
        tokens: {
          accessToken: 'PRIVATE_FIXTURE_ACCESS',
          refreshToken: 'PRIVATE_FIXTURE_REFRESH',
          expiresAt: 1792717200000,
          refreshExpiresAt: null,
          scopes: draft
            ? patch.widerScope
              ? [GOOGLE_MAIL_DRAFT_SCOPE, 'https://www.googleapis.com/auth/gmail.send']
              : [GOOGLE_MAIL_DRAFT_SCOPE]
            : [GOOGLE_MAIL_READ_SCOPE],
        },
      };
    add(kind, 'token', [
      {
        name: 'credential.json',
        destination: directory + '/credentials/' + reference + '.json',
        bytes: Buffer.from(JSON.stringify(state)),
      },
    ]);
    if (draft && patch.denied) {
      const denial = Buffer.from(
        JSON.stringify({
          version: 1,
          scopeDigest: digest(identity.scopeId),
          bindingId: identity.writerBindingId,
          auth: 'revoked',
          at: '2026-10-23T00:00:00.000Z',
        }),
      );
      add(
        kind,
        'denial',
        [
          {
            name: 'access-denial.json',
            destination:
              directory +
              '/access-denials/' +
              digest({ scope: identity.scopeId, binding: identity.writerBindingId }) +
              '.json',
            bytes: denial,
          },
          { name: 'denial-identity.json', destination: null, bytes: Buffer.from('{}') },
        ],
        'revoked',
      );
    }
  }
  const set = makeRoutedCredentialRecoveryManifest(owner, inventory),
    scope = {
      directory: '/fixture-owned-restore',
      assertCurrent: vi.fn(),
      assertPayloadCurrent: vi.fn(),
      ensureDirectory: vi.fn(),
      inspectFile: vi.fn((name: string) => {
        const bytes = contents.get(name)!;
        return { file: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      }),
      withFileBytes: vi.fn((name: string, maximum: number, run: (bytes: Buffer) => unknown) => {
        const bytes = Buffer.from(contents.get(name)!);
        expect(bytes.length).toBeLessThanOrEqual(maximum);
        try {
          return run(bytes);
        } finally {
          bytes.fill(0);
        }
      }),
    } as unknown as BackupRestoreValidationScope;
  const sources = inventory.map(({ event, files }) => ({
    event,
    files: files.map((file) => ({
      ...file,
      bytes: contents.get('credential-sources/' + credentialSource(event) + '/' + file.name)!,
    })),
  }));
  return { set, scope, contents, sources, expected: digest(set) };
}
it('verifies every actual restored file against the complete independently selected set and fixed reader/writer identities', () => {
  const f = fixture(),
    result = verifyRecoveredMailDraftCredentialSet(f.scope, f.set, f.expected, identity);
  expect(result).toEqual({ setDigest: f.expected, selectionDigest: digest(identity), sourceCount: 4, fileCount: 10 });
  expect(f.scope.inspectFile).toHaveBeenCalledTimes(10);
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_FIXTURE|apps.googleusercontent/);
});
it.each([
  { wrongIdentity: true },
  { phase: 'refreshing' },
  { phase: 'uncertain' },
  { phase: 'revoked' },
  { widerScope: true },
  { sharedClient: true },
  { denied: true },
])('rejects a fully rehashed archive with an unadmitted selected credential: %j', (patch) => {
  const f = fixture(patch);
  expect(() => verifyRecoveredMailDraftCredentialSet(f.scope, f.set, f.expected, identity)).toThrow(
    'mail_draft_credential_recovery_unavailable',
  );
});
it('rejects an incomplete/older set even when each selected credential looks valid', () => {
  const f = fixture();
  expect(() =>
    verifyRecoveredMailDraftCredentialSet(f.scope, f.set, digest('different complete primary inventory'), identity),
  ).toThrow();
});
it('checks unselected files too and rejects damaged bytes rather than trusting the manifest', () => {
  const f = fixture(),
    key = [...f.contents.keys()].find((name) => name.endsWith('profile-proof.json'))!;
  f.contents.set(key, Buffer.from('damaged'));
  expect(() => verifyRecoveredMailDraftCredentialSet(f.scope, f.set, f.expected, identity)).toThrow();
});
it('denies changed recovery scope and malformed or shared reference identities without returning private diagnostics', () => {
  const f = fixture();
  vi.mocked(f.scope.assertPayloadCurrent).mockImplementation(() => {
    throw Error('PRIVATE_RESTORE_PATH');
  });
  expect(() => verifyRecoveredMailDraftCredentialSet(f.scope, f.set, f.expected, identity)).toThrow(
    'mail_draft_credential_recovery_unavailable',
  );
  expect(() =>
    verifyRecoveredMailDraftCredentialSet(fixture().scope, f.set, f.expected, {
      ...identity,
      writerReference: identity.readerReference,
    }),
  ).toThrow();
});
function composition() {
  const f = fixture(),
    snapshot = {
      ownerDigest: owner,
      sources: f.sources,
      openChecks: 0,
      assertCurrent: vi.fn(),
      assertPrimaryUnchanged: vi.fn(),
    },
    roots = { targetRoot: '/fixture/target', installationRoot: '/fixture/installation', dataRoot: '/fixture/data' },
    input = {
      identity: structuredClone(identity),
      captureOperationId: '55555555-5555-4555-8555-555555555555',
      requestId: '66666666-6666-4666-8666-666666666666',
      assertAuthority: vi.fn(),
    },
    remote = {
      contract: 'cos-backup-credential-capture-restore/v1',
      kind: 'credentials',
      operationId: input.captureOperationId,
      capture: { ownerDigest: owner, operationId: input.captureOperationId, set: f.set },
      snapshotId: digest('remote snapshot'),
      archiveSha256: digest('encrypted archive'),
      archiveBytes: 40960,
      verifiedAt: '2026-10-23T00:00:00.000Z',
    };
  const beforeValidation = vi.fn(),
    afterValidation = vi.fn();
  backends.snapshot.mockReset().mockImplementation(async (_roots, options, run) => {
    options.assertAuthority();
    return await run(snapshot);
  });
  backends.restore.mockReset().mockImplementation(async (_roots, _captureId, _requestId, current, validate) => {
    beforeValidation();
    current();
    const validation = await validate(f.scope, remote);
    afterValidation();
    current();
    return { remote, validation };
  });
  return { ...f, roots, input, snapshot, remote, beforeValidation, afterValidation };
}
it('the fixed remote composition requires a primary snapshot and real restore callback before returning metadata-only evidence', async () => {
  const f = composition(),
    proof = await restoreMailDraftCredentialBaseline(f.roots, f.input);
  expect(proof).toMatchObject({
    format: 'cos-mail-draft-credential-restore/v1',
    setDigest: f.expected,
    selectionDigest: digest(identity),
    sourceCount: 4,
    fileCount: 10,
    snapshotId: f.remote.snapshotId,
    credentialsActivated: false,
    admissionRestored: false,
    draftJournalRestored: false,
    writerActivated: false,
  });
  expect(backends.restore).toHaveBeenCalledWith(
    f.roots,
    f.input.captureOperationId,
    f.input.requestId,
    expect.any(Function),
    expect.any(Function),
  );
  expect(f.scope.inspectFile).toHaveBeenCalledTimes(10);
  expect(f.snapshot.assertPrimaryUnchanged.mock.calls.length).toBeGreaterThanOrEqual(3);
  expect(JSON.stringify(proof)).not.toMatch(/PRIVATE_FIXTURE|credential-sources|apps.googleusercontent/);
});
it('a shaped remote result without the actual owned-file verification callback cannot produce a proof', async () => {
  const f = composition();
  backends.restore.mockResolvedValue({
    remote: f.remote,
    validation: { setDigest: f.expected, selectionDigest: digest(identity), sourceCount: 4, fileCount: 10 },
  });
  await expect(restoreMailDraftCredentialBaseline(f.roots, f.input)).rejects.toThrow(
    'mail_draft_credential_recovery_unavailable',
  );
});
it.each([
  'nas_failure',
  'authority_replaced',
  'identity_changed',
  'primary_changed',
  'foreign_archive_owner',
  'pending_access_check',
])('actual recovery composition closes on %s and never enables credentials', async (failure) => {
  const f = composition();
  if (failure === 'nas_failure') backends.restore.mockRejectedValue(Error('PRIVATE_NAS_LOCATION'));
  if (failure === 'authority_replaced')
    f.beforeValidation.mockImplementation(() => {
      f.input.assertAuthority = vi.fn();
    });
  if (failure === 'identity_changed')
    f.beforeValidation.mockImplementation(() => {
      f.input.identity.mailboxDigest = digest('foreign');
    });
  if (failure === 'primary_changed')
    f.afterValidation.mockImplementation(() => {
      f.snapshot.assertPrimaryUnchanged.mockImplementation(() => {
        throw Error('PRIVATE_CHANGED_TOKEN');
      });
    });
  if (failure === 'foreign_archive_owner') f.remote.capture.ownerDigest = digest('foreign owner');
  if (failure === 'pending_access_check') f.snapshot.openChecks = 1;
  await expect(restoreMailDraftCredentialBaseline(f.roots, f.input)).rejects.toThrow(
    'mail_draft_credential_recovery_unavailable',
  );
});
