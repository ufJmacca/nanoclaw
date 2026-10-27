/** Synthetic policy setup and scripted native G06 worker, never live Google/model authority. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import type { PoolClient } from 'pg';
import type { CosBinding } from '../../cos-boundary.js';
import { digest } from '../../modules/chief-of-staff/domain/contracts.js';
import { DraftJournal } from '../../modules/chief-of-staff/mail-drafts/journal.js';
import { mailReviewSchedulePolicy } from '../../modules/chief-of-staff/automation/mail-review-policy.js';
import type { MailDraftFixtureConfiguration } from './mail-draft-fixture-host.js';
import type { HostFixture } from './host-fixture-client.js';
import type { McpFixture } from './mcp-fixture.js';
import type { mailReviewFixtureTiming } from './mail-review-fixture-timing.js';

export async function seedMailReviewFixture(
  admin: Pick<PoolClient, 'query'>,
  binding: CosBinding,
  input: MailDraftFixtureConfiguration,
  knowledgeRoot: string,
  activatedAt: string,
): Promise<void> {
  assert.equal(process.env.COS_FIXTURE_DATABASE_PROFILE, 'test');
  assert.equal(input.policy.provider, 'fixture');
  const review: NonNullable<MailDraftFixtureConfiguration['review']> = {
    id: randomUUID(),
    version: 1,
    binding: {
      format: 'cos-mail-review-binding/v1',
      provider: 'fixture',
      readerBindingId: input.policy.readerBindingId,
      writerBindingId: input.writerId,
      writerVersion: 1,
      writerDigest: digest(input.policy),
      writerConsentRef: digest('explicit synthetic fixture grant only'),
      nativeBindingDigest: digest(binding),
      mailboxDigest: input.policy.mailboxDigest,
      contextGeneration: input.authority.contextGeneration,
      morningScheduleId: randomUUID(),
      afternoonScheduleId: randomUUID(),
      timeZone: 'Australia/Sydney',
      maxCandidateThreads: 10,
      maxModelAttempts: 3,
      maxDraftsPerDay: 5,
    },
  };
  await admin.query(
    "INSERT INTO cos.mail_review_policies(scope_id,id,owner_id,session_id,agent_group_id,version,state) VALUES($1,$2,$3,$4,$5,1,'enabled')",
    [binding.scopeId, review.id, binding.ownerId, binding.sessionId, binding.agentGroupId],
  );
  await admin.query(
    'INSERT INTO cos.mail_review_policy_revisions(scope_id,binding_id,version,reader_binding_id,writer_binding_id,writer_version,body,digest,owner_config_ref) VALUES($1,$2,1,$3,$4,1,$5,$6,$7)',
    [
      binding.scopeId,
      review.id,
      input.policy.readerBindingId,
      input.writerId,
      JSON.stringify(review.binding),
      digest(review.binding),
      digest('synthetic review owner configuration'),
    ],
  );
  for (const slot of ['morning', 'afternoon'] as const) {
    await admin.query(
      `INSERT INTO cos.brief_schedules(scope_id,id,owner_id,session_id,agent_group_id,title,policy,limits,version,provenance,purpose,mail_review_policy_id,mail_review_policy_version,mail_review_slot,activated_at)
      VALUES($1,$2,$3,$4,$5,'Synthetic mail review',$6,$7,1,'{}','mail_review',$8,1,$9,$10)`,
      [
        binding.scopeId,
        slot === 'morning' ? review.binding.morningScheduleId : review.binding.afternoonScheduleId,
        binding.ownerId,
        binding.sessionId,
        binding.agentGroupId,
        JSON.stringify(mailReviewSchedulePolicy(slot)),
        JSON.stringify({ max_turns: 3, max_tool_calls: 16, deadline_seconds: 300, refresh_seconds: 30 }),
        review.id,
        slot,
        activatedAt,
      ],
    );
  }
  await admin.query(
    `INSERT INTO cos.brief_schedule_revisions(scope_id,schedule_id,version,body,proposal_id,mail_review_policy_id,mail_review_policy_version)
    SELECT scope_id,id,version,to_jsonb(s),NULL,mail_review_policy_id,mail_review_policy_version FROM cos.brief_schedules s WHERE scope_id=$1`,
    [binding.scopeId],
  );
  const journal = new DraftJournal(
    path.join(knowledgeRoot, 'mail-draft-fixture/effects'),
    digest({ fixture: true, binding }),
    input.policy.journalGeneration,
  );
  try {
    journal.publishReviewPolicyPin(
      {
        requestId: randomUUID(),
        expectedRevision: 0,
        enabled: true,
        pin: {
          scopeId: binding.scopeId,
          policyId: review.id,
          policyVersion: 1,
          profileDigest: digest({ fixture: 'mail-review/v1', binding, review }),
        },
      },
      () => {},
    );
  } finally {
    journal.close();
  }
  input.review = review;
}

export async function exerciseMailReviewNativeFlow(options: {
  admin: Pick<PoolClient, 'query'>;
  binding: CosBinding;
  drafting: MailDraftFixtureConfiguration;
  generation: string;
  platform: string;
  timing: ReturnType<typeof mailReviewFixtureTiming>;
  host(): HostFixture;
  client(): McpFixture;
  restart(): Promise<void>;
}) {
  const { admin, binding, drafting, generation } = options,
    delivered: HostFixture['delivered'] = [],
    rows = async () =>
      (await admin.query('SELECT * FROM cos.brief_runs WHERE scope_id=$1 ORDER BY intended_at,id', [binding.scopeId]))
        .rows,
    complete = async () => {
      const ids = await options.client().completePending();
      await options.host().request('sync-acks');
      return ids;
    };
  assert(drafting.review);
  // A pending owner conversation takes precedence over both due automatic schedules.
  await options.host().request('ingress', { id: randomUUID(), text: 'Harmless synthetic owner conversation' });
  assert.equal(await options.host().request('mail-review-fixture-clear-owner-ingress'), false);
  await options.host().request('pump');
  assert.equal((await rows()).length, 0);
  await complete();
  // Normal native resume clears the last owner-message marker. Both schedules must
  // still use the retained main context without another owner chat as a prerequisite.
  assert.equal(await options.host().request('mail-review-fixture-clear-owner-ingress'), true);
  assert.equal(await options.host().request('main-context-generation'), generation);
  let firstOperation = '';
  for (const [index, slot] of (['morning', 'afternoon'] as const).entries()) {
    await options.host().request('clock', options.timing.clock(slot));
    await options.host().request('pump');
    const current = (await rows())[index];
    assert(current, JSON.stringify(await options.host().request('mail-draft-diagnostics')));
    assert.equal(current.state, 'dispatched');
    assert.equal(
      current.schedule_id,
      slot === 'morning' ? drafting.review.binding.morningScheduleId : drafting.review.binding.afternoonScheduleId,
    );
    const intended = Temporal.Instant.from(current.intended_at.toISOString()).toZonedDateTimeISO('Australia/Sydney');
    assert.equal(intended.hour, slot === 'morning' ? 8 : 15);
    assert.equal(intended.minute, 0);
    assert.equal(current.review_inputs.candidates.length, 10);
    assert.equal(current.review_inputs.unexamined_threads, 2);
    assert(current.review_inputs.excluded_threads >= 2);
    assert.equal(current.model_calls, 0);
    assert.equal((await options.host().request('mail-draft-fixture-state')).writes, index === 0 ? 0 : 1);
    if (index === 0) {
      delivered.push(...options.host().delivered);
      await options.restart();
      await options.host().request('pump');
      assert.equal((await rows()).length, 1, 'a native restart preserves the same frozen occurrence');
      assert.equal((await rows())[0].id, current.id);
    }
    assert.equal(await options.host().request('reserve-fixture-turn', randomUUID()), true);
    const context = await options.client().call('cos_context_get', {});
    assert.equal(context.status, 'ok', JSON.stringify(await options.host().request('mail-draft-diagnostics')));
    assert.equal(context.result.mail_review.candidates.length, 10);
    assert.equal(context.result.mail_review.unexamined_threads, 2);
    assert.doesNotMatch(JSON.stringify(context.result.mail_review), /EXCLUDED_|Newsletter/);
    const candidate = context.result.mail_review.candidates[0];
    assert.equal(candidate.source_message_id, 'aa11');
    assert.match(candidate.excerpt, /Could you please/);
    assert(candidate.citation.evidence_id);
    assert.notEqual(
      (
        await options.client().call('cos_mail_thread_get', {
          binding_id: drafting.policy.readerBindingId,
          thread_id: 'bb22',
        })
      ).status,
      'ok',
      'the eleventh eligible thread is outside this run',
    );
    if (index === 0) {
      const saved = await options.client().call('cos_mail_draft_create', {
        request_id: randomUUID(),
        writer_binding_id: drafting.writerId,
        source_message_id: candidate.source_message_id,
        reply_text: 'Thanks. I will review the details.',
      });
      assert.equal(saved.status, 'ok', JSON.stringify(await options.host().request('mail-draft-diagnostics')));
      assert.equal(saved.result.draft_status, 'verified');
      firstOperation = saved.result.operation_id;
    } else {
      const replay = await options.client().call('cos_mail_draft_create', {
        request_id: randomUUID(),
        writer_binding_id: drafting.writerId,
        source_message_id: candidate.source_message_id,
        reply_text: 'Thanks. I will review the details.',
      });
      assert.equal(replay.status, 'ok');
      assert.equal(replay.result.operation_id, firstOperation);
    }
    // All retries consume both the scheduled and global synthetic counters; the fourth is denied.
    assert.equal(await options.host().request('reserve-fixture-turn', randomUUID()), true);
    assert.equal(await options.host().request('reserve-fixture-turn', randomUUID()), true);
    assert.equal(await options.host().request('reserve-fixture-turn', randomUUID()), false);
    const briefing = await options
      .client()
      .call('cos_brief_request', { request_id: randomUUID(), time_zone: 'Australia/Sydney' });
    assert.equal(briefing.status, 'ok', JSON.stringify(await options.host().request('mail-draft-diagnostics')));
    for (const heading of ['Needs attention:', 'Drafts ready:', 'Upcoming meetings:'])
      assert(briefing.result.text.includes(heading));
    assert.match(briefing.result.text, /Verified unsent draft/);
    assert.match(briefing.result.text, /Last successful refresh|Last Mail refresh|last refreshed/i);
    assert.match(briefing.result.text, /not.*all mail|does not.*all mail/i);
    assert.doesNotMatch(briefing.result.text, /EXCLUDED_|Newsletter/);
    assert((await complete()).includes('cos-brief-' + current.id));
    await options.host().request('pump');
    await options.host().request('pump');
    const finished = (await rows())[index];
    assert.equal(finished.state, 'delivered');
    assert.equal(finished.model_calls, 3);
    assert(finished.tool_calls <= 16);
    const notifications = [...delivered, ...options.host().delivered].filter((r) => r.id === 'brief-' + current.id);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].platform, options.platform);
    assert.equal(notifications[0].text, briefing.result.text);
    assert.equal(await options.host().request('main-context-generation'), generation);
    assert.equal((await options.host().request('mail-draft-fixture-state')).writes, 1);
  }
  // Fresh header exclusions can leave no useful candidates without withdrawing prior sources
  // or replacing the retained main context. The already saved draft is preserved.
  await options.host().request('mail-review-fixture-no-useful-candidates');
  await options.host().request('clock', options.timing.clock('morning', 2));
  await options.host().request('pump');
  await options.host().request('pump');
  const emptyRun = (await rows())[2];
  assert(
    emptyRun,
    JSON.stringify({
      native: await options.host().request('brief-diagnostics'),
      paused: await options.host().request('paused'),
      runs: (await rows()).map((r) => ({ state: r.state, intended: r.intended_at, generation: r.generation })),
    }),
  );
  assert.equal(emptyRun.state, 'dispatched');
  assert.deepEqual(emptyRun.review_inputs.candidates, []);
  assert.equal(await options.host().request('reserve-fixture-turn', randomUUID()), true);
  const empty = await options
    .client()
    .call('cos_brief_request', { request_id: randomUUID(), time_zone: 'Australia/Sydney' });
  assert.equal(empty.status, 'ok');
  assert.match(empty.result.text, /No useful candidate changes in this selected view/);
  assert.match(empty.result.text, /Other existing drafts are not inventoried here/);
  assert.doesNotMatch(empty.result.text, /Verified unsent draft/);
  await complete();
  await options.host().request('pump');
  assert.equal((await rows())[2].state, 'delivered');
  assert.equal((await options.host().request('mail-draft-fixture-state')).writes, 1);
  assert.equal(await options.host().request('main-context-generation'), generation);
  await options.host().request('mail-review-fixture-exhaust-allowance');
  await options.host().request('clock', options.timing.clock('afternoon', 2));
  await options.host().request('pump');
  await options.host().request('pump');
  const exhausted = (await rows())[3];
  assert(exhausted, JSON.stringify(await options.host().request('brief-diagnostics')));
  assert.equal(exhausted.state, 'cancelled');
  assert.equal(exhausted.review_inputs, null, 'allowance exhaustion stops before Mail preparation');
  assert.equal(exhausted.model_calls, 0);
  assert.equal(exhausted.tool_calls, 0);
  assert.equal((await options.host().request('mail-draft-fixture-state')).writes, 1);
  assert.equal(await options.host().request('main-context-generation'), generation);
  assert.equal(
    await options
      .host()
      .request('ordinary-ingress', { id: randomUUID(), text: 'Ordinary fixture chat remains available' }),
    true,
  );
  console.log(
    JSON.stringify({
      demonstration: 'G06',
      provider: 'scripted_fixture',
      liveCalls: false,
      bothSydneySchedules: true,
      candidateThreadLimit: 10,
      modelAttemptLimit: 3,
      privateCheckedBriefs: 3,
      noUsefulCandidateChanges: true,
      exhaustedAllowanceStopsBeforePreparation: true,
      nativeRestart: true,
      ownerConversationPrecedence: true,
      mainContextPreserved: true,
      duplicateDraftNotRecreated: true,
      providerDraftPosts: 1,
      nativeAcknowledgements: true,
      modelQualityEvaluated: false,
      actualLiveScheduleEvidence: false,
    }),
  );
}
