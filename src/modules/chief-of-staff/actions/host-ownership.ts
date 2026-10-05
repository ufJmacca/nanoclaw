import fs from 'node:fs';
import path from 'node:path';
import { digest } from '../domain/contracts.js';
import {
  contextGenerationPattern,
  privateConversationDirectory,
  syncConversationDirectory,
} from '../ops/conversation-ownership.js';
import { readPrivate, writeAtomic } from '../ops/target-state.js';
import { ActionWitness, initializeActionWitness } from './witness.js';
type Owner = { format: 'cos-action-host-owner/v1'; installationDigest: string; journalGeneration: string };
/** Runtime reconstruction never initializes the independent journal or adopts a replacement owner. */
export function openTargetActionWitness(targetRoot: string, installationDigest: string): ActionWitness {
  privateConversationDirectory(targetRoot);
  const root = path.join(targetRoot, 'actions'),
    file = path.join(root, 'owner.json');
  privateConversationDirectory(root);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('unsafe_action_owner');
  const owner = readPrivate<Owner>(file);
  if (
    !owner ||
    Object.keys(owner).sort().join(',') !== 'format,installationDigest,journalGeneration' ||
    owner.format !== 'cos-action-host-owner/v1' ||
    owner.installationDigest !== installationDigest ||
    typeof owner.journalGeneration !== 'string' ||
    !contextGenerationPattern.test(owner.journalGeneration) ||
    !/^[a-f0-9]{64}$/.test(installationDigest)
  )
    throw new Error('unsafe_action_owner');
  return new ActionWitness(path.join(root, 'effects'), installationDigest, owner.journalGeneration);
}
/** Trusted setup only, under current target maintenance. An interrupted or lost ownership record stays closed. */
export function initializeTargetActionWitness(targetRoot: string, installationDigest: string): ActionWitness {
  privateConversationDirectory(targetRoot);
  if (!/^[a-f0-9]{64}$/.test(installationDigest)) throw new Error('unsafe_action_owner');
  const root = path.join(targetRoot, 'actions');
  if (fs.lstatSync(root, { throwIfNoEntry: false })) return openTargetActionWitness(targetRoot, installationDigest);
  fs.mkdirSync(root, { mode: 0o700 });
  syncConversationDirectory(targetRoot);
  const journal = initializeActionWitness(path.join(root, 'effects'), installationDigest),
    owner: Owner = { format: 'cos-action-host-owner/v1', installationDigest, journalGeneration: journal.generation };
  writeAtomic(root, 'owner.json', owner);
  if (digest(readPrivate(path.join(root, 'owner.json'))) !== digest(owner)) throw new Error('unsafe_action_owner');
  return openTargetActionWitness(targetRoot, installationDigest);
}
