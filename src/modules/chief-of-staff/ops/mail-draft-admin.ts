/** Trusted standing policy administration. No model/message can invoke this writer. */
import fs from 'node:fs';
import type pg from 'pg';
import type { CosBinding } from '../../../cos-boundary.js';
import { digest } from '../domain/contracts.js';
import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import type { StorageInspection } from '../calendar/storage-protection.js';
import { GOOGLE_MAIL_READ_SCOPE, GOOGLE_MAIL_DRAFT_SCOPE } from '../calendar/oauth-core.js';
import { openMailCredentials, type MailHostCredentials } from '../mail/config.js';
import { openMailDraftCredentials, type MailDraftHostCredentials } from '../mail-drafts/config.js';
import { openTargetDraftJournal } from '../mail-drafts/host-ownership.js';
import {
  parseMailDraftHostGrant,
  readMailDraftHostProfile,
  type MailDraftHostProfile,
} from '../mail-drafts/profile.js';
import { readMailDraftRecoveryProof } from '../mail-drafts/recovery.js';
import { connectChecked } from '../store/preflight.js';
import { parseDatabaseConfig } from '../store/config.js';
import { migrationStatus } from '../store/migrations.js';
import { localTarget, databaseFingerprint } from './target-identity.js';
import { readPrivate, writeAtomic } from './target-state.js';
import { calendarAdminDirectory as directory } from './calendar-admin.js';
import { readMailDraftAccountConsent } from './mail-draft-consent.js';
import type { ReleaseManifest } from './release-manifest.js';
import { verifyVaultMemory } from './vault-memory.js';
import { writeMailDraftStandingPolicy } from './mail-draft-policy-store.js';
import { parseMailDraftAdminArguments, type MailDraftAdminArguments } from './mail-draft-admin-arguments.js';
type Options = {
  args: MailDraftAdminArguments;
  env: NodeJS.ProcessEnv;
  roots: CalendarStorageRoots;
  binding: CosBinding;
  release: ReleaseManifest;
  check(): Promise<void>;
  assertAuthority(): void;
};
function operation(root: string, id: string, request: unknown) {
  const dir = directory(directory(root, 'mail-draft-policy-admin'), id),
    expected = { contract: 'cos-mail-draft-policy-admin/v1', requestDigest: digest(request) },
    file = dir + '/request.json';
  if (fs.lstatSync(file, { throwIfNoEntry: false })) {
    if (digest(readPrivate(file)) !== digest(expected)) throw Error('draft_policy_request_conflict');
  } else {
    if (fs.readdirSync(dir).length) throw Error('draft_policy_request_conflict');
    writeAtomic(dir, 'request.json', expected);
  }
}
const context = ({
  scopeId,
  ownerId,
  agentGroupId,
  sessionId,
}: Pick<CosBinding, 'scopeId' | 'ownerId' | 'agentGroupId' | 'sessionId'>) => ({
  scopeId,
  ownerId,
  agentGroupId,
  sessionId,
});
/** Enclosing context admin owns fresh maintenance/native leases and paused private membership.
 * Configuration requires both complete recovery and separately linked ready credentials.
 * Local disable needs neither provider/NAS nor a database connection. */
export async function runMailDraftAdmin(o: Options, inspect?: StorageInspection): Promise<Record<string, unknown>> {
  try {
    const { roots, binding } = o,
      args = parseMailDraftAdminArguments([
        o.args.command,
        '--scope',
        o.args.scopeId,
        '--request-id',
        o.args.requestId,
        ...(o.args.command === 'mail-draft-configure'
          ? ['--manifest', o.args.manifestFile]
          : ['--binding', o.args.bindingId]),
      ]);
    const schema = o.release.slice === 'G06' ? 21 : o.release.slice === 'G05' ? 20 : null;
    if (
      args.scopeId !== binding.scopeId ||
      binding.provider !== 'codex' ||
      schema === null ||
      o.release.postgres.minimum !== schema ||
      o.release.postgres.maximum !== schema
    )
      throw Error('draft_policy_owner_required');
    const target = localTarget(roots.targetRoot, roots.installationRoot, roots.dataRoot),
      installation = digest(target.binding);
    const authority = () => {
      verifyVaultMemory();
      o.assertAuthority();
      const now = localTarget(roots.targetRoot, roots.installationRoot, roots.dataRoot);
      if (
        digest(now.binding) !== installation ||
        now.lifecycle !== 'protected' ||
        now.releaseId !== o.release.releaseId
      )
        throw Error('draft_policy_owner_changed');
    };
    const check = async () => {
      authority();
      await o.check();
      authority();
    };
    await check();
    const journal = openTargetDraftJournal(roots.targetRoot, installation);
    try {
      const root = roots.targetRoot + '/mail-drafts',
        file = root + '/writer-profile.json',
        profile = () =>
          fs.lstatSync(file, { throwIfNoEntry: false })
            ? readMailDraftHostProfile(roots.targetRoot, installation, journal)
            : null,
        existing = profile(),
        priorDigest = digest(existing);
      const current = () => {
        authority();
        journal.assertCurrent();
        if (digest(profile()) !== priorDigest) throw Error('draft_policy_profile_changed');
      };
      const base = { scope_id: binding.scopeId, paused: true, live_model: 'not_invoked' };
      current();
      if (args.command === 'mail-draft-disable') {
        const grant = existing?.grants.find(
          (g) =>
            g.id === args.bindingId &&
            digest(context(g)) === digest(context(binding)) &&
            g.binding.nativeBindingDigest === digest(binding),
        );
        if (!grant) throw Error('draft_policy_binding_required');
        operation(roots.targetRoot, args.requestId, { command: args.command, binding, bindingId: args.bindingId });
        await check();
        current();
        writeAtomic(root, 'writer-profile.json', {
          ...existing,
          grants: existing!.grants.map((g) => (g.id === grant.id ? { ...g, writeEnabled: false } : g)),
        });
        authority();
        journal.assertCurrent();
        readMailDraftHostProfile(roots.targetRoot, installation, journal);
        return { ...base, status: 'disabled_paused', binding_id: grant.id, writer_enabled: false };
      }
      const grant = parseMailDraftHostGrant(readPrivate(args.manifestFile));
      if (
        grant.version !== 1 ||
        digest(context(grant)) !== digest(context(binding)) ||
        grant.binding.nativeBindingDigest !== digest(binding) ||
        grant.binding.journalGeneration !== journal.generation
      )
        throw Error('draft_policy_binding_changed');
      const consent = readMailDraftAccountConsent(roots.targetRoot, installation, binding, grant.id, journal),
        consentDigest = digest(consent);
      if (
        grant.binding.readerBindingId !== consent.selection.readerBindingId ||
        grant.binding.credentialReference !== consent.selection.writerReference ||
        grant.binding.mailboxDigest !== consent.selection.mailboxDigest ||
        grant.binding.readerClientDigest !== consent.selection.readerClientDigest ||
        grant.binding.writerClientDigest !== consent.selection.writerClientDigest
      )
        throw Error('draft_policy_consent_changed');
      const recovery = () => {
        const proof = readMailDraftRecoveryProof(roots.targetRoot, installation, journal, grant);
        if (
          digest(proof) !== grant.binding.recoveryProofDigest ||
          digest(proof.selection) !== digest(consent.selection)
        )
          throw Error('draft_policy_recovery_changed');
      };
      recovery();
      const prior = existing?.grants.find((g) => g.id === grant.id);
      if (prior && digest({ ...prior, writeEnabled: grant.writeEnabled }) !== digest(grant))
        throw Error('draft_policy_immutable_binding');
      const next: MailDraftHostProfile = {
        format: 'cos-mail-draft-host/v1',
        installationDigest: installation,
        journalGeneration: journal.generation,
        grants: [...(existing?.grants.filter((g) => g.id !== grant.id) ?? []), grant],
      };
      const enabled = next.grants.filter((g) => g.writeEnabled).map((g) => g.scopeId + ':' + g.binding.readerBindingId);
      if (
        next.grants.length > 10 ||
        new Set(next.grants.map((g) => g.binding.credentialReference)).size !== next.grants.length ||
        new Set(enabled).size !== enabled.length
      )
        throw Error('draft_policy_profile_conflict');
      operation(roots.targetRoot, args.requestId, { command: args.command, binding, grant });
      let reader: MailHostCredentials | undefined,
        writer: MailDraftHostCredentials | undefined,
        client: pg.Client | undefined;
      try {
        reader = await openMailCredentials(roots, inspect);
        await check();
        current();
        writer = await openMailDraftCredentials(roots, inspect);
        await check();
        current();
        const heldReader = reader,
          heldWriter = writer;
        const held = () => {
          current();
          recovery();
          if (
            digest(readMailDraftAccountConsent(roots.targetRoot, installation, binding, grant.id, journal)) !==
              consentDigest ||
            digest(heldReader.clientId) !== consent.selection.readerClientDigest ||
            digest(heldWriter.clientId) !== consent.selection.writerClientDigest ||
            heldReader.clientId === heldWriter.clientId
          )
            throw Error('draft_policy_credentials_changed');
          heldReader.verifyStorage();
          heldWriter.verifyStorage();
          heldReader.fences.assertOpen(binding.scopeId, grant.binding.readerBindingId);
          heldWriter.fences.assertOpen(binding.scopeId, grant.id);
        };
        const ready = async () => {
          await check();
          held();
          const read = await heldReader.credentials.inspect(
            binding.scopeId,
            grant.binding.readerBindingId,
            consent.selection.readerReference,
          );
          held();
          const write = await heldWriter.credentials.inspect(
            binding.scopeId,
            grant.id,
            grant.binding.credentialReference,
          );
          held();
          if (
            read.auth !== 'ready' ||
            digest(read.scopes) !== digest([GOOGLE_MAIL_READ_SCOPE]) ||
            write.auth !== 'ready' ||
            digest(write.scopes) !== digest([GOOGLE_MAIL_DRAFT_SCOPE])
          )
            throw Error('draft_policy_credentials_changed');
          await check();
          held();
        };
        await ready();
        client = await connectChecked(o.env, 'runtime', 'migration');
        if (
          (await databaseFingerprint(client, parseDatabaseConfig(o.env, 'runtime', 'migration'))) !==
            target.binding.databaseFingerprint ||
          (await migrationStatus(client)) !== schema
        )
          throw Error('draft_policy_database_changed');
        await writeMailDraftStandingPolicy(client, binding, grant, consent, ready);
        // A lost commit acknowledgement cannot publish the separate host authority.
        await ready();
        current();
        writeAtomic(root, 'writer-profile.json', next);
        readMailDraftHostProfile(roots.targetRoot, installation, journal);
      } finally {
        try {
          await client?.end();
        } finally {
          try {
            await writer?.close();
          } finally {
            await reader?.close();
          }
        }
      }
      authority();
      journal.assertCurrent();
      if (digest(readMailDraftHostProfile(roots.targetRoot, installation, journal)) !== digest(next))
        throw Error('draft_policy_profile_changed');
      return { ...base, status: 'configured_paused', binding_id: grant.id, writer_enabled: grant.writeEnabled };
    } finally {
      journal.close();
    }
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Native owner, private policy, credential, recovery and database diagnostics cannot leave trusted administration.
    throw Error('mail_draft_configuration_unavailable');
  }
}
