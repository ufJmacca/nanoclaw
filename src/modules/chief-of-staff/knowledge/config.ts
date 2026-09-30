import fs from 'node:fs';
import path from 'node:path';
import { DatabaseConfigurationError } from '../store/config.js';
import { readPrivate, writeAtomic } from '../ops/target-state.js';
import { KnowledgeArtifacts } from './artifacts.js';

export function knowledgeSettings(env: NodeJS.ProcessEnv): { enabled: boolean; retentionMs: number } {
  const enabled = env.COS_KNOWLEDGE_ENABLED ?? 'false',
    days = env.COS_KNOWLEDGE_RETENTION_DAYS ?? '30';
  if (!['true', 'false'].includes(enabled)) throw new DatabaseConfigurationError('COS_KNOWLEDGE_ENABLED');
  if (!/^(0|[1-9][0-9]{0,2})$/.test(days) || Number(days) > 365)
    throw new DatabaseConfigurationError('COS_KNOWLEDGE_RETENTION_DAYS');
  return { enabled: enabled === 'true', retentionMs: Number(days) * 86400000 };
}
function privateDirectory(root: string): void {
  const stat = fs.lstatSync(root);
  if (
    !path.isAbsolute(root) ||
    path.resolve(root) !== root ||
    fs.realpathSync(root) !== root ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new Error('unsafe_knowledge_configuration');
}
function createPrivateDirectory(root: string): void {
  if (!fs.lstatSync(root, { throwIfNoEntry: false })) {
    fs.mkdirSync(root, { mode: 0o700 });
    const parent = fs.openSync(
      path.dirname(root),
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    try {
      fs.fsyncSync(parent);
    } finally {
      fs.closeSync(parent);
    }
  }
  privateDirectory(root);
}
/** The caller first authenticates the bound target. These siblings of provider history are never worker mounts. */
export function openKnowledgeArtifacts(targetRoot: string, excludedRoots: string[]): KnowledgeArtifacts {
  privateDirectory(targetRoot);
  if (
    excludedRoots.some(
      (root) => root === targetRoot || targetRoot.startsWith(root + '/') || root.startsWith(targetRoot + '/'),
    )
  )
    throw new Error('unsafe_knowledge_configuration');
  for (let ancestor = targetRoot; ; ancestor = path.dirname(ancestor)) {
    if (fs.lstatSync(path.join(ancestor, '.git'), { throwIfNoEntry: false }))
      throw new Error('unsafe_knowledge_configuration');
    if (path.dirname(ancestor) === ancestor) break;
  }
  const root = path.join(targetRoot, 'knowledge');
  createPrivateDirectory(root);
  const marker = path.join(root, 'ownership.json');
  if (!fs.lstatSync(marker, { throwIfNoEntry: false })) {
    if (fs.readdirSync(root).length) throw new Error('unowned_knowledge_configuration');
    writeAtomic(root, 'ownership.json', { format: 'cos-knowledge-root/v1' });
  }
  const owner = readPrivate<{ format: string }>(marker);
  if (!owner || Object.keys(owner).length !== 1 || owner.format !== 'cos-knowledge-root/v1')
    throw new Error('unowned_knowledge_configuration');
  const artifacts = path.join(root, 'artifacts'),
    staging = path.join(root, 'staging');
  for (const directory of [artifacts, staging]) createPrivateDirectory(directory);
  return new KnowledgeArtifacts(artifacts, staging);
}
