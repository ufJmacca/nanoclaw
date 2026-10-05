import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validActionId, validActionInstant } from '../contracts/action-protocol.js';
import { validActionIntent, type ActionIntent } from './intent.js';
import { readPrivate } from '../ops/target-state.js';
import { privateConversationDirectory, syncConversationDirectory } from '../ops/conversation-ownership.js';

type WitnessOwner = { format: 'cos-action-witness-owner/v1'; installationDigest: string; generation: string };
export type StartedActionWitness = {
  format: 'cos-action-start-witness/v1';
  intent: ActionIntent;
  approvedDigest: string;
  proposalId: string;
  decisionIngressId: string;
  leaseOwner: string;
  fence: number;
  recordedAt: string;
};
export interface EffectWitness {
  find(actionId: string): StartedActionWitness | null;
  begin(value: StartedActionWitness): void;
  cancel(intent: ActionIntent, approvedDigest: string): void;
  cancelled(actionId: string): boolean;
  list(scopeId: string, offset?: number): StartedActionWitness[];
}
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
function validStart(value: StartedActionWitness): boolean {
  return (
    !!value &&
    Object.keys(value).length === 8 &&
    value.format === 'cos-action-start-witness/v1' &&
    validActionIntent(value.intent, value.approvedDigest) &&
    uuid(value.proposalId) &&
    uuid(value.leaseOwner) &&
    typeof value.decisionIngressId === 'string' &&
    value.decisionIngressId.length > 0 &&
    value.decisionIngressId.length <= 256 &&
    Number.isSafeInteger(value.fence) &&
    value.fence > 0 &&
    value.fence <= 2147483647 &&
    validActionInstant(value.recordedAt)
  );
}
/** Publish once without replacing an existing denial. The complete file and directory entry are fsynced. */
function publish(root: string, name: string, value: unknown): void {
  privateConversationDirectory(root);
  const temporary = path.join(root, '.' + randomUUID() + '.tmp'),
    target = path.join(root, name);
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(temporary, target);
  } finally {
    fs.unlinkSync(temporary);
  }
  syncConversationDirectory(root);
}
function owner(root: string, installationDigest: string, generation?: string): WitnessOwner {
  privateConversationDirectory(root);
  const value = readPrivate<WitnessOwner>(path.join(root, 'owner.json'));
  if (
    !value ||
    Object.keys(value).length !== 3 ||
    value.format !== 'cos-action-witness-owner/v1' ||
    !uuid(value.generation) ||
    !hash(installationDigest) ||
    value.installationDigest !== installationDigest ||
    (generation && value.generation !== generation)
  )
    throw new Error('action_witness_owner_changed');
  return value;
}
/** Explicit trusted setup only. An existing directory with missing history is never silently recreated. */
export function initializeActionWitness(root: string, installationDigest: string): WitnessOwner {
  if (!path.isAbsolute(root) || path.resolve(root) !== root || !hash(installationDigest))
    throw new Error('unsafe_action_witness');
  privateConversationDirectory(path.dirname(root));
  if (fs.lstatSync(root, { throwIfNoEntry: false })) return owner(root, installationDigest);
  fs.mkdirSync(root, { mode: 0o700 });
  syncConversationDirectory(path.dirname(root));
  const value: WitnessOwner = { format: 'cos-action-witness-owner/v1', installationDigest, generation: randomUUID() };
  publish(root, 'owner.json', value);
  return value;
}
/** Denial survives PostgreSQL/native-data restores. No method grants permission to call a provider. */
export class ActionWitness implements EffectWitness {
  constructor(
    readonly root: string,
    readonly installationDigest: string,
    readonly generation: string,
  ) {
    owner(root, installationDigest, generation);
  }
  private assertOwner() {
    owner(this.root, this.installationDigest, this.generation);
  }
  find(actionId: string): StartedActionWitness | null {
    this.assertOwner();
    if (!validActionId(actionId)) throw new Error('unsafe_action_witness');
    const file = path.join(this.root, actionId + '.json');
    if (!fs.lstatSync(file, { throwIfNoEntry: false })) return null;
    const value = readPrivate<{ generation: string; receipt: StartedActionWitness }>(file, 131072);
    if (
      !value ||
      Object.keys(value).length !== 2 ||
      value.generation !== this.generation ||
      !validStart(value.receipt) ||
      value.receipt.intent.actionId !== actionId
    )
      throw new Error('action_witness_changed');
    return value.receipt;
  }
  begin(value: StartedActionWitness): void {
    this.assertOwner();
    if (!validStart(value)) throw new Error('unsafe_action_witness');
    if (this.cancelled(value.intent.actionId)) throw new Error('action_cancelled');
    if (this.find(value.intent.actionId)) throw new Error('action_already_started');
    publish(this.root, value.intent.actionId + '.json', {
      generation: this.generation,
      receipt: structuredClone(value),
    });
  }
  cancel(intent: ActionIntent, approvedDigest: string): void {
    this.assertOwner();
    if (!validActionIntent(intent, approvedDigest)) throw new Error('unsafe_action_witness');
    const file = path.join(this.root, intent.actionId + '.cancel.json');
    if (fs.lstatSync(file, { throwIfNoEntry: false })) {
      const value = readPrivate<{ generation: string; actionId: string; approvedDigest: string }>(file);
      if (
        value.generation !== this.generation ||
        value.actionId !== intent.actionId ||
        value.approvedDigest !== approvedDigest
      )
        throw new Error('action_witness_changed');
      return;
    }
    publish(this.root, intent.actionId + '.cancel.json', {
      generation: this.generation,
      actionId: intent.actionId,
      approvedDigest,
    });
  }
  cancelled(actionId: string): boolean {
    this.assertOwner();
    if (!validActionId(actionId)) throw new Error('unsafe_action_witness');
    const file = path.join(this.root, actionId + '.cancel.json');
    if (!fs.lstatSync(file, { throwIfNoEntry: false })) return false;
    const value = readPrivate<{ generation: string; actionId: string; approvedDigest: string }>(file);
    if (
      !value ||
      Object.keys(value).length !== 3 ||
      value.generation !== this.generation ||
      value.actionId !== actionId ||
      !hash(value.approvedDigest)
    )
      throw new Error('action_witness_changed');
    return true;
  }
  list(scopeId: string, offset = 0): StartedActionWitness[] {
    this.assertOwner();
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) throw new Error('unsafe_action_witness');
    const names = fs
      .readdirSync(this.root)
      .filter((name) => /^action-[a-f0-9]{64}\.json$/.test(name))
      .sort();
    if (names.length > 100000) throw new Error('action_witness_inventory_limit');
    return names
      .map((name) => this.find(name.slice(0, -5))!)
      .filter((value) => value.intent.context.scopeId === scopeId)
      .slice(offset, offset + 100);
  }
}
