import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../../../db/connection.js';
import { createAgentGroup, getAgentGroup } from '../../../db/agent-groups.js';
import { createSession, getSession } from '../../../db/sessions.js';
import {
  installCosMissionBoundary,
  validCosMissionIdentity,
  missionBoundary,
  type CosMissionIdentity,
} from '../../../cos-mission-boundary.js';
import { isCosMissionStopped } from '../../../cos-mission-stop.js';
import {
  initSessionFolder,
  openInboundDb,
  sessionDir,
  sessionsBaseDir,
  writeSessionMessage,
} from '../../../session-manager.js';
import { ensureRpcSchema } from '../bridge/rpc.js';
import { canonical, digest } from '../domain/contracts.js';
import { RESEARCH_TEMPLATE, sealResearchWorkOrder, type ResearchWorkOrder } from './work-order.js';
import { validateTeamChildWorkOrder, type TeamChildWorkOrder } from './team-work-order.js';
import { TEAM_TEMPLATES } from '../contracts/team-templates.js';
import type { Session } from '../../../types.js';

export type NativeMissionInput = {
  identity: CosMissionIdentity;
  inputId: string;
  order: ResearchWorkOrder | TeamChildWorkOrder;
};
export type NativeMissionPaths = {
  sessionDirectory: string;
  providerDirectory: string;
  contextDirectory: string;
  controlDirectory: string;
};
const steps = ['intent', 'group', 'session', 'directories', 'context', 'transport', 'input'] as const;
type Step = (typeof steps)[number];
type Journal = { attempt_id: string; identity: string; input_id: string; payload_digest: string; stage: Step };
function directory(dir: string, create = false, privateMode = true): void {
  if (create && !fs.lstatSync(dir, { throwIfNoEntry: false })) fs.mkdirSync(dir, { mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (
    !path.isAbsolute(dir) ||
    fs.realpathSync(dir) !== dir ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (privateMode ? (stat.mode & 0o777) !== 0o700 : (stat.mode & 0o022) !== 0)
  )
    throw new Error('unsafe_mission_path');
}
function regular(file: string): void {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (
    stat &&
    (!stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      fs.realpathSync(file) !== file)
  )
    throw new Error('unsafe_mission_path');
}
function exactFile(file: string, value: unknown): void {
  const bytes = canonical(value) + '\n';
  regular(file);
  if (fs.existsSync(file)) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (fs.fstatSync(fd).size !== Buffer.byteLength(bytes) || fs.readFileSync(fd, 'utf8') !== bytes)
        throw new Error('mission_artifact_conflict');
    } finally {
      fs.closeSync(fd);
    }
    return;
  }
  const fd = fs.openSync(
    file,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o400,
  );
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const parent = fs.openSync(path.dirname(file), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    fs.fsyncSync(parent);
  } finally {
    fs.closeSync(parent);
  }
}
/** Concrete native allocation only. An allocation is not permission to launch; all child boundaries remain closed.
 * The caller owns the PostgreSQL dispatch lease and must provide fresh admission at every await boundary. */
export class NativeMissionAllocation {
  private readonly root: string;
  constructor(readonly options: { root: string; afterEffect?: (step: Step) => void }) {
    directory(options.root);
    this.root = path.join(options.root, 'missions');
    directory(this.root, true);
    directory(path.dirname(sessionsBaseDir()), false, false);
    directory(sessionsBaseDir(), true, false);
    getDb().exec(`CREATE TABLE IF NOT EXISTS cos_mission_allocations (
      attempt_id TEXT PRIMARY KEY,identity TEXT NOT NULL,input_id TEXT NOT NULL UNIQUE,payload_digest TEXT NOT NULL,
      stage TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
  }
  private paths(i: CosMissionIdentity): NativeMissionPaths {
    const base = path.join(this.root, i.attemptId);
    return {
      sessionDirectory: path.join(sessionsBaseDir(), i.agentGroupId, i.sessionId, 'cos-v1'),
      providerDirectory: path.join(base, 'provider'),
      contextDirectory: path.join(base, 'context'),
      controlDirectory: path.join(base, 'control'),
    };
  }
  private validate(input: NativeMissionInput) {
    const { identity: i, order } = input;
    if (
      !validCosMissionIdentity(i) ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(input.inputId) ||
      i.missionId !== order.body.missionId ||
      i.scopeId !== order.body.origin.scopeId ||
      order.digest !== digest(order.body) ||
      order.body.contextDigest !== digest(order.context)
    )
      throw new Error('mission_allocation_denied');
    if (order.body.format === 'cos-team-child-work-order/v1') {
      if (!validateTeamChildWorkOrder(order)) throw new Error('mission_allocation_denied');
      return TEAM_TEMPLATES[order.body.team.step.template_id];
    }
    if (order.body.format !== 'cos-research-work-order/v1') throw new Error('mission_allocation_denied');
    const b = order.body;
    const checked = sealResearchWorkOrder({
      missionId: b.missionId,
      request: b.request,
      origin: b.origin,
      related: b.related,
      sources: order.context.sources,
      provider: b.provider,
      reviewedTemplateDigest: b.template.digest,
      issuedAt: b.issuedAt,
    });
    if (checked.digest !== order.digest) throw new Error('mission_allocation_denied');
    return RESEARCH_TEMPLATE;
  }
  async prepare(input: NativeMissionInput, admitted: () => Promise<boolean>): Promise<NativeMissionPaths> {
    const template = this.validate(input);
    const { identity: i, order, inputId } = input,
      db = getDb(),
      paths = this.paths(i);
    const allowed = async () => {
      if (!(await admitted()) || isCosMissionStopped(i, db)) throw new Error('mission_allocation_denied');
      directory(this.root);
      directory(sessionsBaseDir(), false, false);
    };
    const payloadDigest = digest({
      identity: i,
      inputId,
      workOrder: order.digest,
      context: order.body.contextDigest,
      paths,
    });
    const read = () =>
      db.prepare('SELECT * FROM cos_mission_allocations WHERE attempt_id=?').get(i.attemptId) as Journal | undefined;
    const completed = (step: Step) => steps.indexOf(read()?.stage ?? 'intent') >= steps.indexOf(step);
    const retainedPath = (step: Step, file: string) => {
      if (completed(step) && !fs.lstatSync(file, { throwIfNoEntry: false }))
        throw new Error('mission_allocation_recovery_required');
    };
    const finished = (step: Step) => {
      this.options.afterEffect?.(step);
      const old = read();
      if (old && steps.indexOf(old.stage) < steps.indexOf(step))
        db.prepare('UPDATE cos_mission_allocations SET stage=?,updated_at=CURRENT_TIMESTAMP WHERE attempt_id=?').run(
          step,
          i.attemptId,
        );
    };
    await allowed();
    db.transaction(() => {
      const old = read();
      if (old) {
        if (
          old.input_id !== inputId ||
          old.payload_digest !== payloadDigest ||
          digest(JSON.parse(old.identity)) !== digest(i) ||
          !steps.includes(old.stage)
        )
          throw new Error('mission_allocation_conflict');
      } else {
        if (
          getAgentGroup(i.agentGroupId) ||
          getSession(i.sessionId) ||
          fs.lstatSync(path.join(this.root, i.attemptId), { throwIfNoEntry: false }) ||
          fs.lstatSync(path.join(sessionsBaseDir(), i.agentGroupId), { throwIfNoEntry: false })
        )
          throw new Error('unowned_mission_state');
        db.prepare(
          "INSERT INTO cos_mission_allocations(attempt_id,identity,input_id,payload_digest,stage) VALUES(?,?,?,?,'intent')",
        ).run(i.attemptId, JSON.stringify(i), inputId, payloadDigest);
      }
      installCosMissionBoundary(i, db);
    })();
    finished('intent');
    await allowed();
    const group = getAgentGroup(i.agentGroupId);
    if (!group && completed('group')) throw new Error('mission_allocation_recovery_required');
    if (group) {
      if (group.folder !== i.agentGroupId || group.agent_provider !== 'codex' || group.name !== 'CoS research')
        throw new Error('mission_allocation_conflict');
    } else
      createAgentGroup({
        id: i.agentGroupId,
        name: 'CoS research',
        folder: i.agentGroupId,
        agent_provider: 'codex',
        created_at: order.body.issuedAt,
      });
    finished('group');
    await allowed();
    const session = getSession(i.sessionId);
    if (!session && completed('session')) throw new Error('mission_allocation_recovery_required');
    if (session) {
      if (session.container_status !== 'stopped') throw new Error('mission_execution_active');
      const boundary = missionBoundary(session, db);
      if (!boundary.restricted || !boundary.identity || digest(boundary.identity) !== digest(i))
        throw new Error('mission_allocation_conflict');
    } else {
      const created: Session = {
        id: i.sessionId,
        agent_group_id: i.agentGroupId,
        messaging_group_id: null,
        thread_id: null,
        agent_provider: 'codex',
        status: 'active',
        container_status: 'stopped',
        last_active: null,
        created_at: order.body.issuedAt,
      };
      createSession(created);
    }
    finished('session');
    await allowed();
    for (const dir of [
      path.join(this.root, i.attemptId),
      paths.contextDirectory,
      paths.providerDirectory,
      paths.controlDirectory,
      path.join(sessionsBaseDir(), i.agentGroupId),
      path.join(sessionsBaseDir(), i.agentGroupId, i.sessionId),
      paths.sessionDirectory,
      path.join(paths.sessionDirectory, 'agent'),
      path.join(paths.sessionDirectory, 'outbox'),
    ]) {
      retainedPath('directories', dir);
      directory(dir, true);
    }
    if (sessionDir(i.agentGroupId, i.sessionId) !== paths.sessionDirectory)
      throw new Error('mission_allocation_conflict');
    finished('directories');
    await allowed();
    for (const file of ['work-order.json', 'context.json', 'template.json'])
      retainedPath('context', path.join(paths.contextDirectory, file));
    exactFile(path.join(paths.contextDirectory, 'work-order.json'), order.body);
    exactFile(path.join(paths.contextDirectory, 'context.json'), order.context);
    exactFile(path.join(paths.contextDirectory, 'template.json'), template);
    finished('context');
    await allowed();
    for (const file of ['inbound.db', 'outbound.db']) {
      retainedPath('transport', path.join(paths.sessionDirectory, file));
      regular(path.join(paths.sessionDirectory, file));
    }
    initSessionFolder(i.agentGroupId, i.sessionId);
    const inbound = openInboundDb(i.agentGroupId, i.sessionId);
    try {
      ensureRpcSchema(inbound);
      if (completed('input') && !inbound.prepare('SELECT 1 FROM messages_in WHERE id=?').get(inputId))
        throw new Error('mission_allocation_recovery_required');
      if (
        inbound.prepare('SELECT 1 FROM destinations LIMIT 1').get() ||
        inbound
          .prepare(
            'SELECT 1 FROM session_routing WHERE channel_type IS NOT NULL OR platform_id IS NOT NULL OR thread_id IS NOT NULL LIMIT 1',
          )
          .get() ||
        inbound.prepare('SELECT 1 FROM messages_in WHERE id<>? LIMIT 1').get(inputId)
      )
        throw new Error('mission_transport_conflict');
    } finally {
      inbound.close();
    }
    finished('transport');
    await allowed();
    writeSessionMessage(i.agentGroupId, i.sessionId, {
      id: inputId,
      kind: 'task',
      timestamp: order.body.issuedAt,
      content: JSON.stringify({
        text: 'Perform the approved read-only research work order using only its admitted context.',
        mission: {
          mission_id: i.missionId,
          attempt_id: i.attemptId,
          generation: i.generation,
          work_order_digest: order.digest,
        },
      }),
      idempotent: true,
    });
    finished('input');
    await allowed();
    return paths;
  }
}
