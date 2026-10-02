import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { CosBinding } from '../../../cos-boundary.js';
import { digest } from '../domain/contracts.js';
import { TEAM_TEMPLATES } from '../contracts/team-templates.js';
import { TEAM_ADMISSION_POLICY } from './team-admission.js';
import { installReviewedTeamTemplates } from './template-admin.js';

function fixture() {
  const binding: CosBinding = {
    scopeId: 'scope',
    ownerId: 'owner',
    botId: 'bot',
    agentGroupId: 'main',
    sessionId: 'main',
    messagingGroupId: 'mg',
    provider: 'codex',
    instanceId: 'fixture',
    channelId: 'private',
  };
  const scope = {
    owner_id: 'owner',
    instance_id: 'fixture',
    channel_id: 'private',
    agent_group_id: 'main',
    status: 'active',
  };
  const templates = new Map<string, { body: unknown; digest: string; reviewed_by: string }>();
  const query = vi.fn(async (sql: string, args: unknown[]) => {
    if (sql.startsWith('SELECT owner_id')) return { rows: [scope] };
    if (sql.startsWith('SELECT body'))
      return { rows: templates.has(String(args[1])) ? [templates.get(String(args[1]))] : [] };
    if (sql.startsWith('INSERT INTO cos.mission_template_versions'))
      templates.set(String(args[1]), {
        body: JSON.parse(String(args[3])),
        digest: String(args[4]),
        reviewed_by: String(args[5]),
      });
    return { rows: [] };
  });
  const client = { query };
  const change = {
    expectedRevision: 0,
    enabled: true,
    templateBundleDigest: digest(TEAM_TEMPLATES),
    policyDigest: digest(TEAM_ADMISSION_POLICY),
    reviewRef: 'reviewed-fixture',
  };
  const requestId = randomUUID();
  return { binding, scope, templates, query, client, change, requestId };
}
it('S06-T01 installs and replays all four exact owner-reviewed templates under the caller transaction', async () => {
  const t = fixture();
  await installReviewedTeamTemplates(t.client as never, t.binding, t.requestId, t.change);
  expect([...t.templates.keys()]).toEqual(Object.keys(TEAM_TEMPLATES).sort());
  for (const template of Object.values(TEAM_TEMPLATES))
    expect(t.templates.get(template.id)).toEqual({
      body: template,
      digest: digest(template),
      reviewed_by: t.binding.ownerId,
    });
  const inserted = t.query.mock.calls.filter(([sql]) => sql.startsWith('INSERT'));
  for (const [, args] of inserted)
    expect(JSON.parse(String(args[6]))).toEqual({
      request_id: t.requestId,
      review_ref: t.change.reviewRef,
      binding_digest: digest(t.binding),
    });
  t.query.mockClear();
  await installReviewedTeamTemplates(t.client as never, t.binding, t.requestId, t.change);
  expect(t.query.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false);
  expect(t.query.mock.calls.some(([sql]) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql))).toBe(false);
});
it.each(['body', 'digest', 'reviewer'])('S06-T01 conflicting late template %s blocks every insert', async (kind) => {
  const t = fixture(),
    template = TEAM_TEMPLATES['team-writer'];
  const record = { body: template as unknown, digest: digest(template), reviewed_by: t.binding.ownerId };
  if (kind === 'body') record.body = { ...template, tools: ['shell'] };
  if (kind === 'digest') record.digest = 'a'.repeat(64);
  if (kind === 'reviewer') record.reviewed_by = 'foreign';
  t.templates.set(template.id, record);
  await expect(installReviewedTeamTemplates(t.client as never, t.binding, t.requestId, t.change)).rejects.toThrow(
    'team_template_conflict',
  );
  expect(t.query.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false);
  expect(t.templates.size).toBe(1);
});
it.each(['owner_id', 'instance_id', 'channel_id', 'agent_group_id', 'status'] as const)(
  'S06-T05 changed scope %s blocks installation',
  async (field) => {
    const t = fixture();
    t.scope[field] = 'foreign';
    await expect(installReviewedTeamTemplates(t.client as never, t.binding, t.requestId, t.change)).rejects.toThrow(
      'context_binding_changed',
    );
    expect(t.templates.size).toBe(0);
  },
);
