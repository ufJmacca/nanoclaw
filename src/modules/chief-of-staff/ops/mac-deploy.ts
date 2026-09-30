import type { ReleaseManifest } from './release-manifest.js';
import { deploymentSettings, shellArgument, type DeploymentSettings } from './deployment-settings.js';
import { digest } from '../domain/contracts.js';
import type { TargetState } from './target-state.js';

export function validateDeliveryReceipt(
  phase: 'source_verified' | 'prepared' | 'healthy',
  manifest: ReleaseManifest,
  value: unknown,
): void {
  const receipt = value as {
    status?: string;
    releaseId?: string;
    commit?: string;
    tree?: string;
    sourceCommit?: string;
    sourceTree?: string;
  };
  if (
    !receipt ||
    receipt.status !== phase ||
    receipt.releaseId !== manifest.releaseId ||
    (phase === 'source_verified' ? receipt.commit : receipt.sourceCommit) !== manifest.source.commit ||
    (phase === 'source_verified' ? receipt.tree : receipt.sourceTree) !== manifest.source.tree
  )
    throw new Error('target_receipt_mismatch');
}

export function validateTargetObservation(
  settings: DeploymentSettings,
  value: unknown,
  allowStopped = false,
): TargetState | null {
  deploymentSettings(settings);
  const observed = value as {
    fingerprint?: string;
    platform?: string;
    architecture?: string;
    dockerArchitecture?: string;
    dockerOS?: string;
    service?: string;
    cwd?: string;
    state?: TargetState | null;
  };
  if (
    !observed ||
    observed.fingerprint !== settings.hostFingerprint ||
    observed.platform !== 'linux' ||
    observed.architecture !== 'arm64' ||
    !['arm64', 'aarch64'].includes(observed.dockerArchitecture ?? '') ||
    observed.dockerOS !== 'linux' ||
    !(allowStopped
      ? ['active', 'inactive', 'failed'].includes(observed.service ?? '')
      : observed.service === 'active') ||
    observed.cwd !== settings.installationRoot
  )
    throw new Error('wrong_deployment_target');
  const state = observed.state;
  if (state === null) return null;
  const binding = {
    hostFingerprint: settings.hostFingerprint,
    databaseFingerprint: settings.databaseFingerprint,
    service: settings.service,
    installationRoot: settings.installationRoot,
    dataRoot: settings.dataRoot,
  };
  if (
    !state ||
    state.version !== 1 ||
    digest(state.binding) !== digest(binding) ||
    !['implementation_disposable', 'protected'].includes(state.lifecycle) ||
    !Number.isSafeInteger(state.generation) ||
    state.generation < 1 ||
    typeof state.maintenance !== 'boolean' ||
    (state.releaseId !== null && !/^release-[a-zA-Z0-9_-]{1,120}$/.test(state.releaseId))
  )
    throw new Error('target_state_conflict');
  return state;
}

/** Read-only corrective builds may inspect a stopped bound target; deployment still owns recovery. */
export function validateBuildTargetObservation(settings: DeploymentSettings, value: unknown): TargetState | null {
  const state = validateTargetObservation(settings, value, true);
  if (
    (value as { service: string }).service !== 'active' &&
    (!state?.maintenance || !/^[a-f0-9-]{36}$/.test(state.maintenanceId ?? ''))
  )
    throw new Error('wrong_deployment_target');
  return state;
}

/** Fixed read-only inspection using the installed Node executable; no environment or provider state is emitted. */
export function targetPreflightCommand(input: DeploymentSettings): string {
  const settings = deploymentSettings(input);
  const program = `const f=require('fs'),c=require('crypto'),{execFileSync:x}=require('child_process');
const s=JSON.parse(process.argv[1]);
const file=s.stateRoot+'/state.json';let state=null;
if(f.existsSync(s.stateRoot)) {const a=f.lstatSync(s.stateRoot),b=f.lstatSync(file);if(!a.isDirectory()||a.uid!==process.getuid()||(a.mode&511)!==448||f.realpathSync(s.stateRoot)!==s.stateRoot||!b.isFile()||b.isSymbolicLink()||b.uid!==process.getuid()||(b.mode&511)!==384)throw Error('unsafe target');state=JSON.parse(f.readFileSync(file,'utf8'));}
const show=x('/usr/bin/systemctl',['--user','show',s.service,'--property=ActiveState','--property=WorkingDirectory'],{encoding:'utf8'}).trim().split('\\n');
const service=Object.fromEntries(show.map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)]}));
const docker=JSON.parse(x('/usr/bin/docker',['--host=unix:///var/run/docker.sock','info','--format','{{json .}}'],{encoding:'utf8'}));
const machine=f.readFileSync('/etc/machine-id','utf8').trim();if(!/^[a-f0-9]{32}$/.test(machine))throw Error('invalid machine');
console.log(JSON.stringify({fingerprint:c.createHash('sha256').update('linux-machine-id:'+machine).digest('hex'),platform:process.platform,architecture:process.arch,dockerArchitecture:docker.Architecture,dockerOS:docker.OSType,service:service.ActiveState,cwd:service.WorkingDirectory,state}));`;
  return ['/usr/bin/node', '-e', program.replaceAll('\n', ' '), JSON.stringify(settings)].map(shellArgument).join(' ');
}
