/** Trusted Mac metadata coordinator. GitHub/Git/SSH remain host operations; no credentials are read. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest } from '../domain/contracts.js';
import { deploymentSettings, shellArgument } from './deployment-settings.js';
import { artifactHash } from './release-artifacts.js';
import { readPrivate, writeAtomic } from './target-state.js';
import { validateReleaseManifest } from './release-manifest.js';
import { completionReferences, makeProgrammeProtection, validateProgrammeProtection } from './programme-protection.js';

function privateDirectory(root: string, create = false) {
  if (create && !fs.lstatSync(root, { throwIfNoEntry: false })) fs.mkdirSync(root, { mode: 0o700 });
  const stat = fs.lstatSync(root);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700 ||
    fs.realpathSync(root) !== root
  )
    throw new Error('programme_completion_unverified');
}

export async function macProgrammeCommand(args: string[]): Promise<string> {
  const [operation, id] = args;
  if (
    args.length !== 2 ||
    !['references', 'make', 'command', 'verify'].includes(operation) ||
    !/^release-[a-f0-9]{12}-[0-9]{14}$/.test(id)
  )
    throw new Error('programme_completion_unverified');
  const state = path.resolve('.cos-plan-state'),
    archive = path.join(state, 'releases', id);
  privateDirectory(state);
  privateDirectory(archive);
  const manifest = validateReleaseManifest(readPrivate(path.join(archive, 'release.json')));
  const settings = deploymentSettings(readPrivate(path.join(state, 'deployment-target.json')));
  const binding = {
    hostFingerprint: settings.hostFingerprint,
    databaseFingerprint: settings.databaseFingerprint,
    service: settings.service,
    installationRoot: settings.installationRoot,
    dataRoot: settings.dataRoot,
  };
  if (manifest.releaseId !== id || manifest.slice !== 'S11') throw new Error('programme_completion_unverified');
  const closure = path.join(state, 'programme-protection', id);
  if (operation === 'references') {
    const refs = completionReferences(readPrivate(path.join(state, 'execution.json'), 1024 * 1024), manifest);
    if (!refs) return '';
    privateDirectory(path.dirname(closure), true);
    privateDirectory(closure, true);
    writeAtomic(closure, 'request.json', { refs, manifestDigest: digest(manifest), bindingDigest: digest(binding) });
    return refs.map((ref, index) => [index, ref.url, ref.commit].join('\t')).join('\n');
  }
  privateDirectory(closure);
  const request = readPrivate<{ refs: unknown[]; manifestDigest: string; bindingDigest: string }>(
    path.join(closure, 'request.json'),
  );
  if (request.manifestDigest !== digest(manifest) || request.bindingDigest !== digest(binding))
    throw new Error('programme_completion_unverified');
  if (operation === 'make') {
    const ledger = readPrivate(path.join(state, 'execution.json'), 1024 * 1024),
      refs = completionReferences(ledger, manifest);
    if (!refs || digest(refs) !== digest(request.refs)) throw new Error('programme_completion_unverified');
    const reviews = refs.map((_, index) => readPrivate(path.join(closure, 'review-' + index + '.json')));
    const ancestryFile = path.join(closure, 'ancestry.tsv');
    const fd = fs.openSync(ancestryFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let ancestry: string;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 8192)
        throw new Error('programme_completion_unverified');
      ancestry = fs.readFileSync(fd, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    const expected = refs.map((ref, index) => [index, ref.commit, manifest.source.commit].join('\t')).join('\n') + '\n';
    if (ancestry !== expected) throw new Error('programme_completion_unverified');
    const proof = makeProgrammeProtection(
      ledger,
      manifest,
      digest(binding),
      reviews,
      (commit, final) => refs.some((ref) => ref.commit === commit) && final === manifest.source.commit,
    );
    writeAtomic(closure, 'proof.json', proof);
    return 'verified';
  }
  const proof = validateProgrammeProtection(readPrivate(path.join(closure, 'proof.json')));
  if (proof.bindingDigest !== digest(binding) || digest(proof.releaseManifest) !== digest(manifest))
    throw new Error('programme_completion_unverified');
  if (operation === 'verify') {
    const result = readPrivate<Record<string, unknown>>(path.join(closure, 'target-result.json'));
    if (
      result.status !== 'protected' ||
      result.lifecycle !== 'protected' ||
      result.bindingDigest !== digest(binding) ||
      result.completionDigest !== digest(proof) ||
      result.sourceCommit !== manifest.source.commit ||
      result.sourceTree !== manifest.source.tree ||
      result.accountActivation !== 'not_granted_by_protection'
    )
      throw new Error('programme_completion_unverified');
    writeAtomic(closure, 'verified.json', {
      status: 'protected',
      completionDigest: digest(proof),
      bindingDigest: digest(binding),
      source: manifest.source,
      at: new Date().toISOString(),
      receipt: 'target-result.json',
    });
    return 'protected';
  }
  const proofHash = await artifactHash(path.join(closure, 'proof.json'), 65536);
  // This fixed locator executes only an already delivered, tested S11 helper. The helper rechecks
  // its recorded all-seven deployment, extracted payload digest and target binding before sealing.
  const program = `const f=require('fs'),p=require('path'),c=require('crypto'),x=require('child_process').execFileSync;
const s=JSON.parse(process.argv[1]),hash=process.argv[2];
function dir(root){const a=f.lstatSync(root);if(!a.isDirectory()||a.uid!==process.getuid()||(a.mode&511)!==448||f.realpathSync(root)!==root)throw Error('unsafe target')}
function read(file){const fd=f.openSync(file,f.constants.O_RDONLY|f.constants.O_NOFOLLOW);try{const a=f.fstatSync(fd);if(!a.isFile()||a.uid!==process.getuid()||(a.mode&511)!==384||a.size>65536)throw Error('unsafe receipt');return JSON.parse(f.readFileSync(fd,'utf8'))}finally{f.closeSync(fd)}}
function canonical(v){if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v!==null&&typeof v==='object')return '{'+Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';return JSON.stringify(v)}
function digest(v){return c.createHash('sha256').update(canonical(v)).digest('hex')}
try{if(process.platform!=='linux'||process.arch!=='arm64')throw Error('wrong target');const machine=f.readFileSync('/etc/machine-id','utf8').trim();if(!/^[a-f0-9]{32}$/.test(machine)||c.createHash('sha256').update('linux-machine-id:'+machine).digest('hex')!==s.hostFingerprint)throw Error('wrong target');dir(s.stateRoot);
const bytes=f.readFileSync(0);if(bytes.length>65536||c.createHash('sha256').update(bytes).digest('hex')!==hash)throw Error('proof mismatch');const proof=JSON.parse(bytes),state=read(p.join(s.stateRoot,'state.json'));if(proof.bindingDigest!==digest(state.binding))throw Error('wrong binding');
let selected;for(const id of [...new Set([state.releaseId,...proof.releaseManifest.previousReleaseIds])]){if(typeof id!=='string'||!/^release-[a-zA-Z0-9_-]{1,120}$/.test(id))continue;const root=p.join(s.releaseRoot,id);if(!f.existsSync(p.join(root,'release.json')))continue;const m=read(p.join(root,'release.json'));if(m.slice!=='S11')continue;const receipt=read(p.join(s.stateRoot,'releases',id,'deployment.json'));if(receipt.status!=='healthy'||receipt.pending!==null||receipt.manifestDigest!==digest(m)||receipt.bindingDigest!==proof.bindingDigest)continue;selected=id;break}if(!selected)throw Error('tested S11 helper required');
const incoming=p.join(s.stateRoot,'programme-incoming-'+hash+'.json');if(f.existsSync(incoming)){read(incoming);if(c.createHash('sha256').update(f.readFileSync(incoming)).digest('hex')!==hash)throw Error('proof conflict')}else{const temporary=p.join(s.stateRoot,'.programme-'+c.randomUUID()+'.tmp'),fd=f.openSync(temporary,'wx',384);try{f.writeFileSync(fd,bytes);f.fsyncSync(fd)}finally{f.closeSync(fd)}f.renameSync(temporary,incoming);const d=f.openSync(s.stateRoot,f.constants.O_RDONLY|f.constants.O_DIRECTORY);try{f.fsyncSync(d)}finally{f.closeSync(d)}}
const payload=p.join(s.releaseRoot,selected,'payload');const out=x(p.join(payload,'node/bin/node'),[p.join(payload,'dist/modules/chief-of-staff/ops/target-helper.js'),'programme-protect','--settings',p.join(s.stagingRoot,selected,'target.json'),'--completion',incoming],{env:{PATH:'/usr/bin:/bin',HOME:s.userHome,NANOCLAW_LOG_STDERR:'true'},encoding:'utf8',maxBuffer:65536,timeout:180000});process.stdout.write(out);
}catch{console.error('programme_protection_unconfirmed');process.exitCode=1}`;
  return ['/usr/bin/node', '-e', program.replaceAll('\n', ' '), JSON.stringify(settings), proofHash]
    .map(shellArgument)
    .join(' ');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  macProgrammeCommand(process.argv.slice(2))
    .then((value) => {
      if (value) console.log(value);
    })
    .catch(() => {
      console.error('programme_completion_unverified');
      process.exitCode = 1;
    });
}
