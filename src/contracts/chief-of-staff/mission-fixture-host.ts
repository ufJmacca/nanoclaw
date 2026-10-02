/** Test adapter only. Production dispatch/allocation/turn/RPC paths with a scripted provider in a real worker. */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { fixtureDatabaseConfig } from './fixture-database.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { MissionHost } from '../../modules/chief-of-staff/missions/host.js';
import type { MissionAuthorityResolver } from '../../modules/chief-of-staff/missions/proposal-store.js';
import type { PriorityStore } from '../../modules/chief-of-staff/store/priorities.js';
import type { CosBinding } from '../../cos-boundary.js';
import { prepareCosLaunch } from '../../cos-boundary.js';
import { cosMissionIdentities, type CosMissionIdentity } from '../../cos-mission-boundary.js';
import { getSession } from '../../db/sessions.js';
import { sessionDir } from '../../session-manager.js';
import { getInstallSlug } from '../../install-slug.js';
import { RestrictedExecutionProbe } from '../../modules/chief-of-staff/bridge/native-execution.js';
import { restrictedLaunch } from '../../modules/chief-of-staff/bridge/restricted-launch.js';
import { startSubscriptionTurns } from '../../modules/chief-of-staff/bridge/subscription-turns.js';
import { digest } from '../../modules/chief-of-staff/domain/contracts.js';
import { safeHostEnvironment } from '../../host-environment.js';
import { createMissionExecution } from '../../modules/chief-of-staff/missions/execution.js';
import { validateTeamChildWorkOrder } from '../../modules/chief-of-staff/missions/team-work-order.js';

const driver = `
import net from 'node:net';import fs from 'node:fs';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {loadMissionRuntime} from '/app/src/mission-runtime.ts';import {runMissionTask} from '/app/src/mission-task.ts';
import {executeMissionRequest} from '/app/src/mcp-tools/mission-client.ts';
import {createSubscriptionTurnClient} from '/app/src/providers/codex-turn-client.ts';
const runtime=loadMissionRuntime('/run/cos/mission',JSON.parse(fs.readFileSync('/workspace/agent/container.json','utf8')));
assert.equal(Object.keys(process.env).some(k=>/^(?:COS_(?:TEST_)?PG|PG(?:HOST|PORT|DATABASE|USER|PASSWORD|SERVICE))/.test(k)),false,'database environment absent');
for(const file of ['/workspace/.env','/run/secrets','/root/.ssh'])assert.equal(fs.existsSync(file),false,'credential root absent');
const connected=await new Promise(resolve=>{const socket=net.connect(databaseTarget);const timer=setTimeout(()=>finish(false),1000);function finish(value){clearTimeout(timer);socket.destroy();resolve(value);}socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));});
assert.equal(connected,false,'worker cannot connect to the database reachable by the host');
fs.writeFileSync('/workspace/agent/fixture-isolation.json',JSON.stringify({databaseNetworkDenied:true,databaseEnvironmentAbsent:true}),{mode:0o600});
const cancel=new AbortController();process.once('SIGTERM',()=>cancel.abort());
const turns=createSubscriptionTurnClient({signal:cancel.signal});
const provider={supportsNativeSlashCommands:false,query(){return {push(){},end(){},abort(){cancel.abort();},events:(async function*(){
 try{await turns.begin();
 yield {type:'init',continuation:'cos-mission-codex-subscription-v1:fixture-'+runtime.config.mission.attemptId};
 const call=async(method,params)=>executeMissionRequest({protocol:'cos-mission-rpc/v1',request_id:randomUUID(),method,params},undefined,cancel.signal);
 const read=await call('cos_mission_context_get',{});assert.equal(read.status,'ok','fixture context '+read.status);
 const source=read.result.context.sources[0],chunk=source.chunks[0];
 fs.writeFileSync('/workspace/agent/fixture-context.json',JSON.stringify(read),{mode:0o600});
 if(failFixture){fs.writeFileSync('/workspace/agent/fixture-provider-failure.json',JSON.stringify({reason:'scripted_provider_failure'}),{mode:0o600});throw Error('scripted_provider_failure');}
 const inputs=read.result.context.artifacts??[],role=read.result.template.id;
 const citation={source_id:source.source_id,revision_id:source.revision_id,ordinal:chunk.ordinal,start_line:chunk.start_line,end_line:chunk.end_line};
 const missing=inputs.filter(i=>i.state==='failed').map(i=>'Missing '+(i.required?'required':'optional')+' step '+i.step_id+'.');
 let result;
 if(role==='team-reviewer')result={format:'cos-team-review/v1',evidence_validity:inputs.filter(i=>i.state==='submitted').flatMap(i=>i.result.claims.map(c=>({step_id:i.step_id,claim_id:c.id,verdict:'supported',reason:'Fixture citation checked; preference is advisory.'}))),factual_gaps:missing,contradictions:inputs.some(i=>i.step_id==='technical'&&i.state==='submitted')?[{step_ids:['technical','operations'],description:'Analysts disagree: cost versus capacity.'}]:[],unmet_criteria:[],recommended_revisions:[],confidence:missing.length?'low':'medium'};
 else {
  const preference=role==='team-technical-analyst'?'Prefer Option A because it costs less.':role==='team-operational-analyst'?'Prefer Option B because it has more capacity.':role==='team-writer'?'Analysts disagree: retain the cost and capacity tradeoff. Choose a capacity-led pilot with cost uncertainty.':null;
  const claims=[{id:'comparison',kind:'quote',text:chunk.text,citations:[citation]},...(preference?[{id:'preference',kind:'inference',text:preference,citations:[citation]}]:[])];
  result={format:'cos-research-result/v1',outcome:missing.length?'partial':'answer',claims,criteria:read.result.work_order.request.acceptance_criteria.map(c=>({id:c.id,claim_ids:claims.map(c=>c.id)})),limitations:missing};
 }
 fs.writeFileSync('/workspace/agent/fixture-draft.json',JSON.stringify(result),{mode:0o600});
 while(holdFixture&&!fs.existsSync('/workspace/agent/fixture-release')&&!cancel.signal.aborted)await new Promise(resolve=>setTimeout(resolve,30));
 if(cancel.signal.aborted)throw Error('fixture_stopped');
 // The host may stop the worker after committing its result, before the RPC acknowledgement is read.
 // The outer test requires that exact durable submission and stop receipt before review.
 const submitted=await call('cos_result_submit',{result});
 fs.writeFileSync('/workspace/agent/fixture-submission.json',JSON.stringify(submitted),{mode:0o600});
 yield {type:'result',text:submitted.status==='ok'?'Fixture result acknowledged; main coordinator must review.':'Fixture submission acknowledgement uncertain; host must reconcile.'};
 }catch(error){console.error('fixture-provider: '+error.message);throw error;}finally{await turns.end();}
 })()};}};
const outcome=await runMissionTask({...runtime,provider,signal:cancel.signal});assert.equal(outcome,'processed');
`;
export async function createMissionFixtureHost(o: {
  root: string;
  repository: string;
  hostRepository: string;
  image: string;
  sourceRoot?: string;
  runnerVolume?: string;
  db: Database.Database;
  store: PriorityStore;
  authority: MissionAuthorityResolver;
  binding: CosBinding;
  teams?: boolean;
}) {
  if (
    o.runnerVolume &&
    (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(o.runnerVolume) ||
      !o.sourceRoot ||
      !path.isAbsolute(o.sourceRoot) ||
      path.resolve(o.sourceRoot) !== o.sourceRoot ||
      /[\r\n\0,]/.test(o.sourceRoot))
  )
    throw Error('invalid_fixture_source_root');
  const target = path.join(o.root, 'missions-private');
  if (!fs.existsSync(target)) fs.mkdirSync(target, { mode: 0o700 });
  const stat = fs.lstatSync(target);
  if (
    !stat.isDirectory() ||
    fs.realpathSync(target) !== target ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw Error('fixture_private_root_required');
  const config = await fixtureDatabaseConfig(),
    resolved = await lookup(config.host!, { family: 4 });
  const databaseTarget = { host: resolved.address, port: config.port! };
  let holdNext = false;
  let failureStep: string | undefined;
  const expectedFailures = new Set<string>();
  const translated = (file: string) => {
    const relative = path.relative(o.repository, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('fixture_path_outside_repository');
    return path.join(o.hostRepository, relative);
  };
  const probe = new RestrictedExecutionProbe(getInstallSlug(process.cwd())),
    runs = new Map<string, { process: ChildProcess; done: Promise<void> }>(),
    turns = new Map<string, Awaited<ReturnType<typeof startSubscriptionTurns>>>();
  const inertSocket = path.join(o.root, 'i-' + randomUUID().slice(0, 8) + '.sock'),
    server = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(inertSocket, resolve);
  });
  fs.chmodSync(inertSocket, 0o600);
  let failure: unknown;
  const stopping = new Set<string>();
  const diagnostics = new Map<string, { exit: number | null; stderr: string }>();
  const workspace = (i: CosMissionIdentity) => translated(sessionDir(i.agentGroupId, i.sessionId));
  const localRunning = (id: string) => {
    const child = runs.get(id)?.process;
    return !!child && child.exitCode === null && child.signalCode === null;
  };
  const native = createMissionExecution({
    db: o.db,
    assertHostAuthority() {},
    session: getSession,
    directory: (group, session) => translated(sessionDir(group, session)),
    running: localRunning,
    stop: (id) => {
      stopping.add(id);
    },
    probe,
  });
  const execution = {
    ...native,
    async stop(i: CosMissionIdentity) {
      await native.stop(i);
      await runs.get(i.sessionId)?.done;
    },
  };
  const stop = execution.stop;
  const host = new MissionHost(
    {
      root: target,
      db: o.db,
      runs: o.store.missionRuns,
      teams: o.teams ? o.store.teamRuns : undefined,
      authority: o.authority,
      admitted: () => true,
      assertHostAuthority() {},
      facts: async () => ({
        id: o.binding.channelId,
        type: 'P',
        delete_at: 0,
        members: [o.binding.ownerId, o.binding.botId],
        activeSubscription: true,
      }),
      running: execution.running,
      unallocated: execution.unallocated,
      stop,
      wake: async (session) => {
        let launch;
        try {
          launch = await prepareCosLaunch(session);
        } catch (error) {
          const reasons: string[] = [];
          for (let current: unknown = error; current instanceof Error && reasons.length < 4; current = current.cause)
            reasons.push(current.message);
          failure = Error('fixture_launch_failed: ' + reasons.join(':'));
          throw error;
        }
        if (!launch) throw Error('fixture_restricted_launch_missing');
        const child = spawn('docker', launch.args, {
          env: safeHostEnvironment('docker'),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let diagnostic = '';
        child.stdout?.resume();
        child.stderr?.on('data', (chunk) => {
          diagnostic = (diagnostic + chunk.toString()).slice(-2000);
        });
        const done = new Promise<void>((resolve) => {
          child.once('error', (error) => {
            failure = error;
            resolve();
          });
          child.once('exit', (code) => {
            diagnostics.set(session.id, { exit: code, stderr: diagnostic });
            const scriptedFailure =
              expectedFailures.has(session.id) &&
              fs.existsSync(
                path.join(sessionDir(session.agent_group_id, session.id), 'agent/fixture-provider-failure.json'),
              );
            if (code !== 0 && !stopping.has(session.id) && !scriptedFailure)
              failure = new Error('fixture_worker_failed: ' + diagnostic);
            resolve();
          });
        });
        runs.set(session.id, { process: child, done });
        return true;
      },
    },
    {
      launcher: {
        async prepare(input, paths, session, authorize) {
          const identity = input.identity,
            mission = {
              missionId: identity.missionId,
              attemptId: identity.attemptId,
              inputId: input.inputId,
              generation: identity.generation,
              workOrderDigest: input.order.digest,
              contextDigest: input.order.body.contextDigest,
              templateDigest: input.order.body.template.digest,
            };
          const failFixture = validateTeamChildWorkOrder(input.order) && input.order.body.team.stepId === failureStep;
          if (failFixture) {
            expectedFailures.add(session.id);
            failureStep = undefined;
          }
          const config = path.join(paths.controlDirectory, 'fixture.json');
          fs.writeFileSync(
            config,
            JSON.stringify({
              provider: 'codex',
              model: input.order.body.provider.model,
              runtime: 'codex-subscription/v1',
              profile: 'research',
              contextGeneration: identity.attemptId,
              agentGroupId: identity.agentGroupId,
              assistantName: 'CoS Research',
              groupName: 'CoS Research',
              maxMessagesPerPrompt: 1,
              mcpServers: {},
              mission,
            }),
            { mode: 0o600 },
          );
          const turnSocket = path.join(o.root, 't-' + randomUUID().slice(0, 8) + '.sock');
          const turn = await startSubscriptionTurns({
            socket: turnSocket,
            authorize,
            reserve: async (id) => {
              const result = await o.store.missionRuns.reserve(
                identity,
                id,
                'model',
                digest({ kind: 'fixture-model', attempt: identity.attemptId }),
              );
              return result.status === 'ok' && result.reserved === true;
            },
          });
          turns.set(session.id, turn);
          const launch = restrictedLaunch({
            image: o.image,
            sessionDirectory: paths.sessionDirectory,
            configurationFile: config,
            gatewaySocket: inertSocket,
            uid: process.getuid!(),
            gid: process.getgid!(),
            entry: 'research',
            research: { contextDirectory: paths.contextDirectory, binding: mission },
            subscription: {
              providerDirectory: paths.providerDirectory,
              credentialSocket: inertSocket,
              turnSocket,
              contextGeneration: identity.attemptId,
            },
          });
          launch.args = launch.args.map((arg) =>
            arg.startsWith('type=bind,')
              ? arg.replace('src=' + o.repository + '/', 'src=' + o.hostRepository + '/')
              : arg,
          );
          launch.args.splice(
            launch.args.indexOf(o.image) + 1,
            launch.args.length,
            '--',
            'bun',
            '-e',
            'const databaseTarget=' +
              JSON.stringify(databaseTarget) +
              ';const holdFixture=' +
              holdNext +
              ';const failFixture=' +
              failFixture +
              ';' +
              driver,
          );
          if (o.runnerVolume) {
            // Source-stage fixture only. Final release runs use baked code and cannot receive these mounts.
            launch.args.splice(
              launch.args.indexOf(o.image),
              0,
              '--mount',
              `type=bind,src=${path.join(o.sourceRoot!, 'container/agent-runner/src')},dst=/app/src,readonly`,
              '--mount',
              `type=volume,src=${o.runnerVolume},dst=/app/node_modules,readonly`,
            );
            launch.args[launch.args.indexOf('--entrypoint') + 1] = 'bun';
            launch.args.splice(launch.args.indexOf(o.image) + 1, 2);
          }
          return launch;
        },
        async close(id) {
          await turns.get(id)?.close();
          turns.delete(id);
        },
        async shutdown() {
          for (const turn of turns.values()) await turn.close();
          turns.clear();
        },
      },
    },
  );
  return {
    host,
    execution,
    stop,
    holdNext() {
      holdNext = true;
    },
    releaseHeld() {
      holdNext = false;
      for (const i of cosMissionIdentities(o.db)) {
        const agent = path.join(sessionDir(i.agentGroupId, i.sessionId), 'agent');
        if (fs.existsSync(agent)) fs.writeFileSync(path.join(agent, 'fixture-release'), '', { mode: 0o600 });
      }
    },
    failStep(step: string) {
      failureStep = step;
    },
    states() {
      return cosMissionIdentities(o.db).map((identity) => {
        const directory = sessionDir(identity.agentGroupId, identity.sessionId);
        const read = (name: string) => {
          const file = path.join(directory, 'agent', name);
          return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
        };
        return {
          identity,
          running: probe.present(workspace(identity)),
          draft: read('fixture-draft.json'),
          isolation: read('fixture-isolation.json'),
          submission: read('fixture-submission.json'),
          released: fs.existsSync(path.join(directory, 'agent/fixture-release')),
          diagnostic: diagnostics.get(identity.sessionId) ?? null,
        };
      });
    },
    stopSession(id: string) {
      const identity = cosMissionIdentities(o.db).find((i) => i.sessionId === id);
      if (identity)
        void stop(identity).catch((error) => {
          failure = error;
        });
    },
    check() {
      if (failure) throw failure;
    },
    diagnostics() {
      return failure instanceof Error ? failure.message : null;
    },
    sessions() {
      return cosMissionIdentities(o.db)
        .map((i) => getSession(i.sessionId))
        .filter((s) => !!s);
    },
    async close() {
      await host.close();
      for (const i of cosMissionIdentities(o.db)) await stop(i);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(inertSocket, { force: true });
    },
  };
}
