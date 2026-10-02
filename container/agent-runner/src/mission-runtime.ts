import fs from 'node:fs';
import path from 'node:path';
import { digest } from './mcp-tools/generated/cos-protocol.js';
import { RESEARCH_TEMPLATE } from './mcp-tools/generated/research-template.js';
import { TEAM_TEMPLATES } from './mcp-tools/generated/team-templates.js';
import { validateTeamInputs } from './mcp-tools/generated/team-inputs.js';
import { validMissionRuntimeConfig } from './mcp-tools/generated/mission-runtime.js';

/** Startup integrity check only. The host must authorize every model/tool call against current state. */
export function loadMissionRuntime(directory: string, raw: unknown) {
  if (!validMissionRuntimeConfig(raw)) throw new Error('mission_runtime_denied');
  const read = (name: string, max: number) => {
    const file = path.join(directory, name),
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o777) !== 0o400 ||
        stat.size > max
      )
        throw new Error('mission_runtime_denied');
      return JSON.parse(fs.readFileSync(fd, 'utf8'));
    } finally {
      fs.closeSync(fd);
    }
  };
  const body = read('work-order.json', 24576),
    context = read('context.json', 65536),
    template = read('template.json', 8192);
  const team = body?.format === 'cos-team-child-work-order/v1';
  const selected =
    team && Object.hasOwn(TEAM_TEMPLATES, body?.template?.id ?? '')
      ? TEAM_TEMPLATES[body.template.id as keyof typeof TEAM_TEMPLATES]
      : RESEARCH_TEMPLATE;
  if (
    team &&
    (selected === RESEARCH_TEMPLATE ||
      body.template?.version !== selected.version ||
      body.resultSchema !== selected.resultSchema ||
      body.team?.step?.template_id !== selected.id ||
      body.team?.step?.template_version !== selected.version ||
      body.team?.step?.result_schema !== selected.resultSchema ||
      body.team?.step?.step_id !== body.team?.stepId ||
      !Number.isSafeInteger(body.team?.generation) ||
      body.team.generation < 1 ||
      typeof body.team?.teamId !== 'string' ||
      !/^team-[a-f0-9]{64}$/.test(body.team.teamId) ||
      !context ||
      Object.keys(context).length !== 3 ||
      !Array.isArray(context.sources) ||
      !validateTeamInputs(body.team, context.artifacts, digest))
  )
    throw new Error('mission_runtime_denied');
  if (
    digest(body) !== raw.mission.workOrderDigest ||
    digest(context) !== raw.mission.contextDigest ||
    digest(template) !== raw.mission.templateDigest ||
    digest(template) !== digest(selected) ||
    (!team && body?.format !== 'cos-research-work-order/v1') ||
    body.missionId !== raw.mission.missionId ||
    body.provider?.model !== raw.model ||
    body.provider?.profile !== selected.providerProfile ||
    body.template?.digest !== raw.mission.templateDigest ||
    body.contextDigest !== raw.mission.contextDigest ||
    context?.format !== (team ? 'cos-team-child-context/v1' : 'cos-mission-context/v1') ||
    typeof body.deadlineAt !== 'string' ||
    !Number.isFinite(Date.parse(body.deadlineAt))
  )
    throw new Error('mission_runtime_denied');
  return {
    config: raw,
    deadlineAt: body.deadlineAt as string,
    instructions: selected.instructions,
    resultSchema: selected.resultSchema as 'cos-research-result/v1' | 'cos-team-review/v1',
  };
}
