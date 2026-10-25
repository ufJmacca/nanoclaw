import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { initializeTargetDraftJournal } from './host-ownership.js';
import type { MailDraftHostProfile } from './profile.js';
import type { MailDraftRecoveryProof } from './recovery.js';
import type { MailHostCredentials } from '../mail/config.js';
import { GOOGLE_MAIL_READ_SCOPE } from '../mail/oauth.js';
import { GOOGLE_MAIL_DRAFT_SCOPE } from './oauth.js';
import { openMailDraftHost } from './open-host.js';
const ports = vi.hoisted(() => ({ target: vi.fn(), profile: vi.fn(), proof: vi.fn(), writer: vi.fn() }));
vi.mock('../ops/target-identity.js', () => ({ localTarget: ports.target }));
vi.mock('./profile.js', async (original) => ({
  ...(await original<typeof import('./profile.js')>()),
  readMailDraftHostProfile: ports.profile,
}));
vi.mock('./recovery.js', () => ({ readMailDraftRecoveryProof: ports.proof }));
vi.mock('./config.js', async (original) => ({
  ...(await original<typeof import('./config.js')>()),
  openMailDraftCredentials: ports.writer,
}));
const cleanup: string[] = [],
  hosts: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const root of cleanup.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const context = {
  scopeId: 'scope',
  ownerId: 'owner',
  agentGroupId: 'group',
  sessionId: 'session',
  ingressId: 'ingress',
  provider: 'codex',
  generation: '33333333-3333-4333-8333-333333333333',
};
function resource(clientId: string) {
  return {
    clientId,
    verifyStorage: vi.fn(),
    close: vi.fn(async () => {}),
    closed: () => false,
    fences: { assertOpen: vi.fn(), deny: vi.fn(), runCheck: vi.fn() },
    credentials: { inspect: vi.fn(), token: vi.fn() },
  };
}
function fixture() {
  const root = fs.mkdtempSync(os.tmpdir() + '/cos-draft-open-');
  cleanup.push(root);
  const roots = { targetRoot: root, installationRoot: '/fixture/app', dataRoot: '/fixture/app/data' },
    targetBinding = {
      hostFingerprint: digest('host'),
      databaseFingerprint: digest('database'),
      service: 'fixture.service',
      installationRoot: roots.installationRoot,
      dataRoot: roots.dataRoot,
    },
    installation = digest(targetBinding),
    journal = initializeTargetDraftJournal(root, installation),
    generation = journal.generation;
  journal.close();
  const reader = resource('reader.apps.googleusercontent.com'),
    writer = resource('writer.apps.googleusercontent.com'),
    authority = {
      bindingDigest: digest('native'),
      contextGeneration: context.generation,
      draftProfileDigest: digest('cos-mail-draft/v1'),
      provider: { profile: 'subscription', model: 'fixture', policyDigest: digest('policy') },
    },
    readerReference = randomUUID();
  const profile: MailDraftHostProfile = {
    format: 'cos-mail-draft-host/v1',
    installationDigest: installation,
    journalGeneration: generation,
    grants: [
      {
        scopeId: context.scopeId,
        ownerId: context.ownerId,
        agentGroupId: context.agentGroupId,
        sessionId: context.sessionId,
        id: randomUUID(),
        version: 1,
        backupOperationId: 'release-fixture',
        targetBackupDigest: digest('snapshot'),
        writeEnabled: true,
        binding: {
          format: 'cos-mail-draft-binding/v1',
          provider: 'google',
          readerBindingId: randomUUID(),
          mailboxDigest: digest('owner@example.test'),
          writerClientDigest: digest(writer.clientId),
          readerClientDigest: digest(reader.clientId),
          credentialReference: randomUUID(),
          nativeBindingDigest: authority.bindingDigest,
          journalGeneration: generation,
          maxPerDay: 5,
          timeZone: 'Australia/Sydney',
          replyMode: 'plain_text_reply',
          permissionScopes: [GOOGLE_MAIL_DRAFT_SCOPE],
          recoveryProofDigest: digest('proof'),
        },
      },
    ],
  };
  // Recovery content/actual producers are tested separately. This boundary test receives their validated metadata.
  const proof = { selection: { readerReference } } as MailDraftRecoveryProof,
    target = { lifecycle: 'protected', maintenance: false, binding: targetBinding },
    selected = {
      id: profile.grants[0].id,
      version: 1,
      body: profile.grants[0].binding,
      digest: digest(profile.grants[0].binding),
      consent_ref: digest('consent'),
      reader_provider: 'google' as const,
      mailbox_email: 'owner@example.test',
      reader_scopes: [GOOGLE_MAIL_READ_SCOPE],
      reader_auth: 'ready',
      processing_providers: ['codex'],
      reader_credential_ref: readerReference,
    };
  ports.target.mockReset().mockImplementation(() => structuredClone(target));
  ports.profile.mockReset().mockImplementation(() => structuredClone(profile));
  ports.proof.mockReset().mockImplementation(() => structuredClone(proof));
  ports.writer.mockReset().mockResolvedValue(writer);
  let admitted = true;
  const open = () =>
    openMailDraftHost(
      { COS_MAIL_ENABLED: 'true', COS_MAIL_DRAFTS_ENABLED: 'true' },
      roots,
      () => admitted,
      () => authority,
      reader as unknown as MailHostCredentials,
    );
  return {
    root,
    roots,
    profile,
    proof,
    target,
    selected,
    reader,
    writer,
    authority,
    open,
    admitted: (value: boolean) => {
      admitted = value;
    },
  };
}
it('disabled setup opens no writer, journal, recovery or native resource', async () => {
  const f = fixture();
  expect(
    await openMailDraftHost(
      {},
      f.roots,
      () => true,
      () => null,
      undefined,
    ),
  ).toBeUndefined();
  expect(ports.target).not.toHaveBeenCalled();
  expect(ports.writer).not.toHaveBeenCalled();
});
it('opens only the existing independent history and validated proofs, then owns only its writer lifetime', async () => {
  const f = fixture(),
    host = await f.open();
  expect(host).toBeDefined();
  hosts.push(host!);
  expect(host!.dependencies.matches(context, f.selected)).toBe(true);
  expect(ports.proof).toHaveBeenCalled();
  expect(f.reader.credentials.token).not.toHaveBeenCalled();
  expect(f.writer.credentials.token).not.toHaveBeenCalled();
  await host!.close();
  expect(f.writer.close).toHaveBeenCalledTimes(1);
  expect(f.reader.close).not.toHaveBeenCalled();
});
it.each(['maintenance', 'target', 'profile', 'proof', 'reader_reference', 'admission'])(
  'offline request admission closes after installed %s changes',
  async (failure) => {
    const f = fixture(),
      host = await f.open();
    hosts.push(host!);
    if (failure === 'maintenance') f.target.maintenance = true;
    if (failure === 'target') f.target.binding.databaseFingerprint = digest('foreign');
    if (failure === 'profile') f.profile.grants[0].writeEnabled = false;
    if (failure === 'proof') f.proof.selection.readerReference = randomUUID();
    if (failure === 'reader_reference') f.selected.reader_credential_ref = randomUUID();
    if (failure === 'admission') f.admitted(false);
    expect(host!.dependencies.matches(context, f.selected)).toBe(false);
  },
);
it('missing/corrupt recovery remains closed before opening credentials and creates no replacement proof', async () => {
  const f = fixture();
  ports.proof.mockImplementation(() => {
    throw Error('PRIVATE_PROOF_PATH');
  });
  await expect(f.open()).rejects.toThrow('mail_draft_host_unavailable');
  expect(ports.writer).not.toHaveBeenCalled();
  expect(fs.existsSync(f.root + '/mail-drafts/restore-proofs')).toBe(false);
});
it('releases a writer opened during a raced profile replacement and keeps the reader owned by its original host', async () => {
  const f = fixture();
  ports.writer.mockImplementationOnce(async () => {
    f.profile.grants[0].writeEnabled = false;
    return f.writer;
  });
  await expect(f.open()).rejects.toThrow('mail_draft_host_unavailable');
  expect(f.writer.close).toHaveBeenCalledTimes(1);
  expect(f.reader.close).not.toHaveBeenCalled();
});
