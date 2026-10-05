/** Explicit synthetic calendar transport. No credential, OAuth, network or model capability is present. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { CosBinding } from '../../cos-boundary.js';
import { cosBoundary } from '../../cos-boundary.js';
import { getSession } from '../../db/sessions.js';
import { digest } from '../../modules/chief-of-staff/domain/contracts.js';
import type { ActionAuthority } from '../../modules/chief-of-staff/actions/authority.js';
import type { ActionDependencies } from '../../modules/chief-of-staff/actions/store.js';
import { validWriterBinding, type ActionWriterBinding } from '../../modules/chief-of-staff/actions/binding.js';
import { CalendarWriteError, type CalendarActionWriter } from '../../modules/chief-of-staff/actions/writer.js';
import { ActionWitness, initializeActionWitness } from '../../modules/chief-of-staff/actions/witness.js';
import { subscriptionActivation } from '../../modules/chief-of-staff/bridge/model-policy.js';
import {
  readConversationOwner,
  privateConversationDirectory,
} from '../../modules/chief-of-staff/ops/conversation-ownership.js';
import { readPrivate, writeAtomic } from '../../modules/chief-of-staff/ops/target-state.js';
import type { BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';
export type ActionFixtureConfiguration = { authority: ActionAuthority; writerId: string; binding: ActionWriterBinding };
const modes = ['success', 'busy', 'revoked', 'timeout-after-create', 'mismatch'] as const;
type Mode = (typeof modes)[number];
type ProviderState = { mode: Mode; writes: number; reads: number; events: Record<string, Record<string, unknown>> };
export function createActionFixtureHost(
  root: string,
  native: Database.Database,
  database: BoundedDatabase,
  binding: CosBinding,
  input: ActionFixtureConfiguration,
) {
  assert.equal(process.env.COS_FIXTURE_HOST_PROCESS, 'S01');
  assert.equal(input.binding.provider, 'fixture');
  assert.ok(validWriterBinding(input.binding));
  assert.equal(input.binding.bindingDigest, digest(binding));
  assert.equal(input.binding.instanceId, binding.instanceId);
  assert.equal(input.binding.channelId, binding.channelId);
  assert.equal(input.authority.bindingDigest, digest(binding));
  assert.equal(input.authority.actionProfileDigest, digest('cos-calendar-action/v1'));
  privateConversationDirectory(root);
  const directory = path.join(root, 'action-fixture');
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  privateConversationDirectory(directory);
  const installation = digest({ fixture: true, binding }),
    journalRoot = path.join(directory, 'effects'),
    owner = initializeActionWitness(journalRoot, installation),
    witness = new ActionWitness(journalRoot, installation, owner.generation),
    stateFile = path.join(directory, 'provider.json');
  if (!fs.existsSync(stateFile))
    writeAtomic(directory, 'provider.json', { mode: 'success', writes: 0, reads: 0, events: {} });
  const read = () => readPrivate<ProviderState>(stateFile);
  const writer: CalendarActionWriter = {
    access: async () => ({
      calendarId: input.binding.calendarId,
      generation: input.binding.credentialGeneration,
      accountFingerprint: input.binding.accountFingerprint,
      scopes: [...input.binding.scopes],
      auth: read().mode === 'revoked' ? 'revoked' : 'ready',
      writeEnabled: true,
    }),
    inspect: async (request) => ({
      complete: true,
      calendarId: request.calendar_id,
      calendarTimeZone: 'UTC',
      accountFingerprint: input.binding.accountFingerprint,
      generation: input.binding.credentialGeneration,
      ownershipDigest: digest('fixture owner'),
      availabilityDigest: digest({ busy: read().mode === 'busy', start: request.start, end: request.end }),
      busy:
        read().mode === 'busy'
          ? [
              {
                start: { kind: 'instant', instant: request.start, timeZone: request.time_zone },
                end: { kind: 'instant', instant: request.end, timeZone: request.time_zone },
                eventDigest: digest('fixture conflict'),
              },
            ]
          : [],
      observedAt: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace('.000Z', 'Z'),
    }),
    create: async (intent, _approved, permit) => {
      assert.equal(permit.valid(), true);
      assert.equal(database.pool.idleCount, database.pool.totalCount, 'provider execution holds no PostgreSQL client');
      assert.equal(witness.find(intent.actionId)?.intent.eventId, intent.eventId);
      const state = read();
      state.writes++;
      assert.equal(state.events[intent.eventId], undefined, 'no duplicate fixture POST is permitted');
      const event = { ...intent.payload, etag: 'fixture-created-1', status: 'confirmed' };
      state.events[intent.eventId] = event;
      writeAtomic(directory, 'provider.json', state);
      if (state.mode === 'timeout-after-create')
        throw new CalendarWriteError('writer_request_unavailable', 'uncertain');
      return structuredClone(event);
    },
    get: async (intent) => {
      assert.equal(database.pool.idleCount, database.pool.totalCount);
      const state = read();
      state.reads++;
      writeAtomic(directory, 'provider.json', state);
      if (state.mode === 'timeout-after-create')
        throw new CalendarWriteError('writer_readback_unavailable', 'read_unavailable');
      const event = state.events[intent.eventId] ?? null;
      return state.mode === 'mismatch' && event
        ? { ...event, summary: 'unapproved provider title' }
        : structuredClone(event);
    },
  };
  const dependencies: ActionDependencies = {
    witness,
    authority: (context) => {
      const session = getSession(context.sessionId),
        boundary = session && cosBoundary(session, native),
        retained = native
          .prepare('SELECT generation,status,binding_digest FROM cos_conversation_states WHERE scope_id=?')
          .get(binding.scopeId) as { generation: string; status: string; binding_digest: string } | undefined;
      if (
        !boundary?.restricted ||
        boundary.paused ||
        digest(boundary.binding) !== digest(binding) ||
        !retained ||
        retained.status !== 'active' ||
        retained.binding_digest !== digest(binding) ||
        context.origin ||
        retained.generation !== input.authority.contextGeneration ||
        context.scopeId !== binding.scopeId ||
        context.ownerId !== binding.ownerId ||
        context.agentGroupId !== binding.agentGroupId ||
        context.sessionId !== binding.sessionId
      )
        return null;
      const policy = subscriptionActivation(
          readPrivate(path.join(root, 'model-activation.json')),
          binding.scopeId,
          'a'.repeat(64),
        ),
        owner = readConversationOwner(root, retained.generation, binding);
      return policy && digest(policy) === input.authority.provider.policyDigest && owner.state === 'retained'
        ? structuredClone(input.authority)
        : null;
    },
    writer: (_context, id, body) => (id === input.writerId && digest(body) === digest(input.binding) ? writer : null),
  };
  return {
    dependencies,
    mode(value: unknown) {
      if (!modes.includes(value as Mode)) throw Error('invalid_fixture_mode');
      const state = read();
      state.mode = value as Mode;
      writeAtomic(directory, 'provider.json', state);
      return true;
    },
    state() {
      const state = read();
      return { writes: state.writes, reads: state.reads, events: Object.values(state.events) };
    },
  };
}
