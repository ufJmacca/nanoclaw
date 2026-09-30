import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
/** Identity of extracted prebuilt files, independent of copying user and timestamps. */
export async function payloadDigest(root: string): Promise<string> {
  if (!path.isAbsolute(root) || fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory())
    throw new Error('unsafe_release_payload');
  const digest = createHash('sha256');
  let count = 0,
    bytes = 0;
  const visit = async (relative: string): Promise<void> => {
    const file = path.join(root, relative),
      stat = fs.lstatSync(file);
    if (++count > 500000) throw new Error('unsafe_release_payload');
    const name = path.basename(relative);
    // Dependencies may legitimately contain directories called data; installation-root state must never be included.
    if (
      (!relative.includes('/') && ['data', 'groups', 'logs', '.cos-plan-state'].includes(name)) ||
      /^\.env(?:\.|$)/.test(name) ||
      ['.ssh', 'auth.json', 'credentials.json'].includes(name) ||
      /\.(pem|key|p12|pfx)$/.test(name)
    )
      throw new Error('unsafe_release_payload');
    if (stat.isDirectory()) {
      digest.update(JSON.stringify([relative, 'directory', stat.mode & 0o777]) + '\n');
      for (const child of fs.readdirSync(file).sort()) await visit(relative ? relative + '/' + child : child);
    } else if (stat.isSymbolicLink()) {
      const target = fs.realpathSync(file);
      if (!target.startsWith(root + '/')) throw new Error('unsafe_release_payload');
      digest.update(JSON.stringify([relative, 'link', fs.readlinkSync(file)]) + '\n');
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > 16 * 1024 * 1024 * 1024) throw new Error('unsafe_release_payload');
      const hash = createHash('sha256');
      for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
      digest.update(JSON.stringify([relative, 'file', stat.mode & 0o777, stat.size, hash.digest('hex')]) + '\n');
    } else throw new Error('unsafe_release_payload');
  };
  // The release directory's own mode is chosen by the target parent, not by Docker COPY.
  for (const child of fs.readdirSync(root).sort()) await visit(child);
  return digest.digest('hex');
}
