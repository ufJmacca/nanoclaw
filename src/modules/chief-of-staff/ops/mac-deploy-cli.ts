/** Validated transfer metadata and fixed Pi commands for the Mac host wrapper. No credentials are returned. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { deploymentSettings, shellArgument } from './deployment-settings.js';
import { readPrivate, writeAtomic } from './target-state.js';
import { artifactHash, verifyReleaseBundle } from './release-artifacts.js';
import { validateReleaseManifest } from './release-manifest.js';
import { targetPreflightCommand, validateTargetObservation, validateDeliveryReceipt } from './mac-deploy.js';
import { digest } from '../domain/contracts.js';
import { checkpointLocalExecution } from './mac-release.js';

function localRoot(id: string) {
  if (id !== 'status' && !/^release-[a-f0-9]{12}-[0-9]{14}$/.test(id)) throw new Error('invalid_local_release');
  const root = path.resolve(id === 'status' ? '.cos-plan-state/deployment-status' : '.cos-plan-state/releases/' + id);
  const stat = fs.lstatSync(root);
  if (
    !stat.isDirectory() ||
    fs.realpathSync(root) !== root ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new Error('unsafe_local_release');
  return root;
}
function nodeCommand(program: string, args: string[]) {
  return ['/usr/bin/node', '-e', program.replaceAll('\n', ' '), ...args].map(shellArgument).join(' ');
}
export async function macDeployCommand(args: string[]): Promise<string | void> {
  const [operation, id, ...values] = args;
  const settingsFile = path.resolve('.cos-plan-state/deployment-target.json'),
    settings = deploymentSettings(readPrivate(settingsFile));
  if (operation === 'alias' && args.length === 1) return settings.sshAlias;
  if (operation === 'preflight-command' && args.length === 1) return targetPreflightCommand(settings);
  const root = localRoot(id),
    stage = path.join(settings.stagingRoot, id);
  if (operation === 'rollback-command' && values.length === 1) {
    const target = values[0];
    if (id !== 'status' || !/^release-[a-zA-Z0-9_-]{1,120}$/.test(target)) throw new Error('invalid_rollback_request');
    const state = validateTargetObservation(settings, readPrivate(path.join(root, 'target-observation.json')), true);
    if (!state?.releaseId) throw new Error('no_recorded_release');
    const file = path.join(root, 'rollback-request.json');
    type Request = { status: 'pending' | 'complete'; targetDigest: string; fromReleaseId: string; releaseId: string };
    let request: Request | undefined = fs.existsSync(file) ? readPrivate<Request>(file) : undefined;
    if (request && (request.targetDigest !== digest(settings) || !['pending', 'complete'].includes(request.status)))
      throw new Error('rollback_request_conflict');
    if (
      request?.status === 'pending' &&
      (request.releaseId !== target || ![request.fromReleaseId, target].includes(state.releaseId))
    )
      throw new Error('rollback_request_conflict');
    if (!request || (request.status === 'complete' && !(request.releaseId === target && state.releaseId === target)))
      request = {
        status: 'pending',
        targetDigest: digest(settings),
        fromReleaseId: state.releaseId,
        releaseId: target,
      };
    if (request.fromReleaseId === request.releaseId) throw new Error('rollback_not_compatible');
    writeAtomic(root, 'rollback-request.json', request);
    const payload = path.join(settings.releaseRoot, request.fromReleaseId, 'payload');
    return [
      payload + '/node/bin/node',
      payload + '/dist/modules/chief-of-staff/ops/target-helper.js',
      'rollback',
      '--settings',
      path.join(settings.stagingRoot, request.fromReleaseId, 'target.json'),
      '--from-release-id',
      request.fromReleaseId,
      '--release-id',
      request.releaseId,
    ]
      .map(shellArgument)
      .join(' ');
  }
  if (operation === 'rollback-check' && !values.length) {
    const request = readPrivate<{ targetDigest: string; fromReleaseId: string; releaseId: string }>(
      path.join(root, 'rollback-request.json'),
    );
    const result = readPrivate<{ status: string; fromReleaseId: string; releaseId: string; maintenance: boolean }>(
      path.join(root, 'rollback-result.json'),
    );
    if (
      request.targetDigest !== digest(settings) ||
      result.status !== 'rolled_back' ||
      result.fromReleaseId !== request.fromReleaseId ||
      result.releaseId !== request.releaseId ||
      result.maintenance !== true
    )
      throw new Error('rollback_receipt_conflict');
    writeAtomic(root, 'rollback-request.json', { ...request, status: 'complete', at: new Date().toISOString() });
    return;
  }
  if (operation === 'status-command' && !values.length) {
    const state = validateTargetObservation(settings, readPrivate(path.join(root, 'target-observation.json')), true);
    if (!state?.releaseId) return '';
    const payload = path.join(settings.releaseRoot, state.releaseId, 'payload');
    const targetFile = path.join(settings.stagingRoot, state.releaseId, 'target.json');
    return [
      payload + '/node/bin/node',
      payload + '/dist/modules/chief-of-staff/ops/target-helper.js',
      'status',
      '--settings',
      targetFile,
    ]
      .map(shellArgument)
      .join(' ');
  }
  if (operation === 'target-check' && !values.length) {
    validateTargetObservation(settings, readPrivate(path.join(root, 'target-observation.json')), true);
    return;
  }
  if (operation === 'unbound-status' && !values.length) {
    const state = validateTargetObservation(settings, readPrivate(path.join(root, 'target-observation.json')), true);
    return JSON.stringify({
      status: state ? 'bound_without_active_release' : 'unbound',
      releaseId: null,
      lifecycle: state?.lifecycle ?? 'unbound',
      maintenance: state?.maintenance ?? null,
    });
  }
  const manifest = validateReleaseManifest(readPrivate(path.join(root, 'release.json')));
  if (manifest.releaseId !== id) throw new Error('release_identity_mismatch');
  const local = readPrivate<{
    status: string;
    manifestHash: string;
    archiveHash: string;
    bootstrapHash: string;
    source: unknown;
    checks: unknown;
  }>(path.join(root, 'local-tests.json'));
  const plan = readPrivate<{ targetDigest: string }>(path.join(root, 'plan.json'));
  if (
    local.status !== 'transferable' ||
    digest(local.source) !== digest(manifest.source) ||
    digest(local.checks) !== digest(manifest.checks) ||
    plan.targetDigest !== digest(settings) ||
    (await artifactHash(path.join(root, 'release.json'))) !== local.manifestHash
  )
    throw new Error('local_evidence_mismatch');
  if (operation === 'verify' && !values.length) {
    await verifyReleaseBundle(root, local.manifestHash);
    if ((await artifactHash(path.join(root, 'bootstrap.mjs'), 1024 * 1024)) !== local.bootstrapHash)
      throw new Error('bootstrap_identity_mismatch');
    fs.copyFileSync(settingsFile, path.join(root, 'target.json'));
    fs.chmodSync(path.join(root, 'target.json'), 0o600);
    const binding = path.resolve('.cos-plan-state/coordinator-binding.json');
    if (fs.existsSync(binding)) {
      readPrivate(binding);
      fs.copyFileSync(binding, path.join(root, 'binding.json'));
      fs.chmodSync(path.join(root, 'binding.json'), 0o600);
    }
    writeAtomic(root, 'delivery.json', {
      status: 'verified_locally',
      releaseId: id,
      manifestHash: local.manifestHash,
      source: manifest.source,
      review: 'tested_unreviewed_candidate',
      at: new Date().toISOString(),
    });
    return;
  }
  if (operation === 'field' && values.length === 1) {
    const fields: Record<string, string> = {
      commit: manifest.source.commit,
      tree: manifest.source.tree,
      fetchRef: manifest.source.fetchRef,
      stage,
      manifestHash: local.manifestHash,
    };
    if (!Object.hasOwn(fields, values[0])) throw new Error('invalid_delivery_field');
    return fields[values[0]];
  }
  if (operation === 'stage-command' && !values.length) {
    return nodeCommand(
      `const f=require('fs'),p=require('path');const s=JSON.parse(process.argv[1]),stage=process.argv[2];
for(const target of [s.stagingRoot,p.dirname(s.stateRoot),s.releaseRoot,s.sourceRoot,stage]){let current=s.userHome;for(const part of p.relative(s.userHome,target).split('/')){current=p.join(current,part);if(!f.lstatSync(current,{throwIfNoEntry:false}))f.mkdirSync(current,{mode:448});const a=f.lstatSync(current);if(!a.isDirectory()||f.realpathSync(current)!==current||a.uid!==process.getuid()||(a.mode&18))throw Error('unsafe staging');} }if((f.statSync(stage).mode&511)!==448)throw Error('unsafe staging');`,
      [JSON.stringify(settings), stage],
    );
  }
  if (operation === 'seal-command' && values.length === 1) {
    const name = values[0];
    if (!['release.json', 'SHA256SUMS', 'bootstrap.mjs', 'target.json', 'binding.json', 'images.tar.gz'].includes(name))
      throw new Error('invalid_transfer_file');
    const hash = await artifactHash(path.join(root, name));
    return nodeCommand(
      `const f=require('fs'),c=require('crypto'),p=require('path');const [root,name,expected]=process.argv.slice(1);const a=f.lstatSync(root);if(!a.isDirectory()||f.realpathSync(root)!==root||a.uid!==process.getuid()||(a.mode&511)!==448)throw Error('unsafe stage');
async function hash(file){const fd=f.openSync(file,f.constants.O_RDONLY|f.constants.O_NOFOLLOW);try{const st=f.fstatSync(fd);if(!st.isFile()||st.uid!==process.getuid()||(st.mode&18))throw Error('unsafe artifact');const h=c.createHash('sha256');for await(const b of f.createReadStream(file,{fd,autoClose:false}))h.update(b);return h.digest('hex')}finally{f.closeSync(fd)}}
(async()=>{const final=p.join(root,name),partial=final+'.partial';if(await hash(partial)!==expected)throw Error('checksum mismatch');if(f.lstatSync(final,{throwIfNoEntry:false})&&await hash(final)!==expected)throw Error('release conflict');f.chmodSync(partial,384);f.renameSync(partial,final);})().catch(()=>{console.error('artifact verification failed');process.exitCode=1});`,
      [stage, name, hash],
    );
  }
  if (operation === 'bootstrap-command' && values.length === 1 && ['source', 'prepare'].includes(values[0])) {
    return ['/usr/bin/node', stage + '/bootstrap.mjs', values[0], stage + '/target.json', id, local.manifestHash]
      .map(shellArgument)
      .join(' ');
  }
  if (operation === 'deploy-command' && values.length <= 1) {
    const recoverFrom = values[0];
    if (recoverFrom !== undefined && (!/^release-[a-zA-Z0-9_-]{1,120}$/.test(recoverFrom) || recoverFrom === id))
      throw new Error('deployment_recovery_denied');
    const payload = path.join(settings.releaseRoot, id, 'payload');
    return [
      payload + '/node/bin/node',
      payload + '/dist/modules/chief-of-staff/ops/target-helper.js',
      'deploy',
      '--settings',
      stage + '/target.json',
      '--release-id',
      id,
      '--manifest-sha256',
      local.manifestHash,
      ...(fs.existsSync(path.join(root, 'binding.json')) ? ['--binding', stage + '/binding.json'] : []),
      ...(recoverFrom ? ['--recover-from', recoverFrom] : []),
    ]
      .map(shellArgument)
      .join(' ');
  }
  if (operation === 'checkpoint' && values.length === 1) {
    const phase = values[0];
    if (!['source_pushed', 'source_verified', 'transferred', 'prepared', 'healthy'].includes(phase))
      throw new Error('invalid_delivery_phase');
    if (phase === 'source_verified' || phase === 'prepared' || phase === 'healthy') {
      const file = {
        source_verified: 'source-result.json',
        prepared: 'prepare-result.json',
        healthy: 'deploy-result.json',
      }[phase]!;
      validateDeliveryReceipt(phase, manifest, readPrivate(path.join(root, file)));
    }
    const prior = readPrivate<Record<string, unknown>>(path.join(root, 'delivery.json'));
    writeAtomic(root, 'delivery.json', { ...prior, status: phase, [phase]: new Date().toISOString() });
    const patch: Record<string, unknown> = {
      delivery_phase: phase,
      delivery_receipt: path.relative(process.cwd(), path.join(root, 'delivery.json')),
    };
    if (phase === 'source_pushed') patch.source_push_status = 'verified';
    if (phase === 'source_verified')
      Object.assign(patch, {
        pi_source_sync_status: 'verified',
        verified_source_commit: manifest.source.commit,
        verified_source_tree: manifest.source.tree,
        source_checkout_receipt: path.relative(process.cwd(), path.join(root, 'source-result.json')),
      });
    if (phase === 'transferred') patch.transfer_status = 'verified_archive';
    if (phase === 'prepared') patch.deployment_status = 'prepared_not_activated';
    if (phase === 'healthy')
      Object.assign(patch, {
        deployment_status: 'tested_unreviewed_candidate_healthy',
        deployed_source_sha: manifest.source.commit,
        pi_smoke_status: 'passed',
        migration_status: 'applied_on_pi',
        deployment_receipt: path.relative(process.cwd(), path.join(root, 'deploy-result.json')),
      });
    checkpointLocalExecution(path.resolve('.cos-plan-state'), patch);
    return;
  }
  throw new Error('invalid_delivery_operation');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.env.NANOCLAW_LOG_STDERR = 'true';
  macDeployCommand(process.argv.slice(2))
    .then((value) => {
      if (value !== undefined) console.log(value);
    })
    .catch((error) => {
      console.error(
        JSON.stringify({
          status: 'failed',
          code: error instanceof Error && /^[a-z_]{1,80}$/.test(error.message) ? error.message : 'delivery_failed',
        }),
      );
      process.exitCode = 1;
    });
}
