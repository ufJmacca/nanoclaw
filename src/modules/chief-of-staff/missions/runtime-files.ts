import fs from 'node:fs';
import path from 'node:path';
import { digest } from '../domain/contracts.js';
import { validMissionRuntimeBinding, type MissionRuntimeBinding } from '../contracts/mission-runtime.js';
import { RESEARCH_TEMPLATE, sealResearchWorkOrder, type ResearchWorkOrder } from './work-order.js';
import { validateTeamChildWorkOrder } from './team-work-order.js';
import { TEAM_TEMPLATES } from '../contracts/team-templates.js';

/** Recheck host-owned allocation bytes before mounting individual files, never the containing directory. */
export function researchRuntimeFiles(directory: string, binding: MissionRuntimeBinding, model: string): string[] {
  if (
    !validMissionRuntimeBinding(binding) ||
    !path.isAbsolute(directory) ||
    path.resolve(directory) !== directory ||
    /[,\r\n\0]/.test(directory) ||
    fs.realpathSync(directory) !== directory
  )
    throw new Error('mission_artifacts_denied');
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700)
    throw new Error('mission_artifacts_denied');
  const read = (name: string, limit: number) => {
    const file = path.join(directory, name),
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const metadata = fs.fstatSync(fd);
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        metadata.uid !== process.getuid?.() ||
        (metadata.mode & 0o777) !== 0o400 ||
        metadata.size > limit
      )
        throw new Error('mission_artifacts_denied');
      return JSON.parse(fs.readFileSync(fd, 'utf8'));
    } finally {
      fs.closeSync(fd);
    }
  };
  const body = read('work-order.json', 24576) as ResearchWorkOrder['body'];
  const context = read('context.json', 65536) as ResearchWorkOrder['context'];
  const template = read('template.json', 8192);
  if (
    digest(body) !== binding.workOrderDigest ||
    digest(context) !== binding.contextDigest ||
    digest(template) !== binding.templateDigest ||
    body.missionId !== binding.missionId ||
    body.provider.model !== model ||
    body.contextDigest !== binding.contextDigest ||
    body.template.digest !== binding.templateDigest
  )
    throw new Error('mission_artifacts_denied');
  const order = { body, context, digest: binding.workOrderDigest };
  if (body.format === 'cos-team-child-work-order/v1') {
    if (
      !validateTeamChildWorkOrder(order) ||
      digest(template) !== digest(TEAM_TEMPLATES[order.body.team.step.template_id])
    )
      throw new Error('mission_artifacts_denied');
    return ['work-order.json', 'context.json', 'template.json'].map((name) => path.join(directory, name));
  }
  if (body.format !== 'cos-research-work-order/v1' || digest(template) !== digest(RESEARCH_TEMPLATE))
    throw new Error('mission_artifacts_denied');
  const checked = sealResearchWorkOrder({
    missionId: body.missionId,
    request: body.request,
    origin: body.origin,
    related: body.related,
    sources: context.sources,
    provider: body.provider,
    reviewedTemplateDigest: body.template.digest,
    issuedAt: body.issuedAt,
  });
  if (checked.digest !== binding.workOrderDigest || digest(checked.context) !== binding.contextDigest)
    throw new Error('mission_artifacts_denied');
  return ['work-order.json', 'context.json', 'template.json'].map((name) => path.join(directory, name));
}
