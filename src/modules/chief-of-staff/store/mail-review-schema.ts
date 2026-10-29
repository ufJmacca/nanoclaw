import { createHash } from 'node:crypto';

const uuid = '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$';

/** No rows or consent are created. Only owner administration can publish review policy. */
export const MAIL_REVIEW_SCHEMA = `
CREATE TABLE cos.mail_review_policies (
 scope_id text NOT NULL REFERENCES cos.scopes(id),id uuid NOT NULL,
 owner_id text NOT NULL CHECK(length(owner_id)>0),session_id text NOT NULL CHECK(length(session_id)>0),
 agent_group_id text NOT NULL CHECK(length(agent_group_id)>0),version integer NOT NULL CHECK(version>0),
 state text NOT NULL CHECK(state IN ('enabled','disabled','revoked')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(scope_id,id)
);
CREATE UNIQUE INDEX mail_review_one_enabled_policy ON cos.mail_review_policies(scope_id) WHERE state='enabled';
CREATE TABLE cos.mail_review_policy_revisions (
 scope_id text NOT NULL,binding_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),
 reader_binding_id uuid NOT NULL,writer_binding_id uuid NOT NULL,writer_version integer NOT NULL CHECK(writer_version>0),
 body jsonb NOT NULL CHECK(jsonb_typeof(body)='object' AND COALESCE(
  body->>'format'='cos-mail-review-binding/v1' AND body->>'provider' IN ('google','fixture')
  AND body->>'readerBindingId'=reader_binding_id::text AND body->>'writerBindingId'=writer_binding_id::text
  AND body->'writerVersion'=to_jsonb(writer_version)
  AND body->>'writerDigest' ~ '^[a-f0-9]{64}$' AND body->>'writerConsentRef' ~ '^[a-f0-9]{64}$'
  AND body->>'nativeBindingDigest' ~ '^[a-f0-9]{64}$' AND body->>'mailboxDigest' ~ '^[a-f0-9]{64}$'
  AND body->>'contextGeneration' ~ '${uuid}'
  AND body->>'morningScheduleId' ~ '${uuid}' AND body->>'afternoonScheduleId' ~ '${uuid}'
  AND body->>'morningScheduleId'<>body->>'afternoonScheduleId'
  AND body->>'timeZone'='Australia/Sydney' AND body->'maxCandidateThreads'='10'::jsonb
  AND body->'maxModelAttempts'='3'::jsonb AND body->'maxDraftsPerDay'='5'::jsonb
  AND body-ARRAY['format','provider','readerBindingId','writerBindingId','writerVersion','writerDigest','writerConsentRef',
   'nativeBindingDigest','mailboxDigest','contextGeneration','morningScheduleId','afternoonScheduleId','timeZone',
   'maxCandidateThreads','maxModelAttempts','maxDraftsPerDay']::text[]='{}'::jsonb,false)),
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),owner_config_ref text NOT NULL CHECK(owner_config_ref ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(scope_id,binding_id,version),
 FOREIGN KEY(scope_id,binding_id) REFERENCES cos.mail_review_policies(scope_id,id),
 FOREIGN KEY(scope_id,reader_binding_id) REFERENCES cos.mail_bindings(scope_id,id),
 FOREIGN KEY(scope_id,writer_binding_id,writer_version) REFERENCES cos.mail_draft_writer_revisions(scope_id,binding_id,version)
);
ALTER TABLE cos.brief_schedules DROP CONSTRAINT brief_schedules_scope_id_key;
ALTER TABLE cos.brief_schedules
 ADD COLUMN purpose text NOT NULL DEFAULT 'brief' CHECK(purpose IN ('brief','mail_review')),
 ADD COLUMN mail_review_policy_id uuid,
 ADD COLUMN mail_review_policy_version integer,
 ADD COLUMN mail_review_slot text,
 ADD CONSTRAINT brief_schedule_review_policy FOREIGN KEY(scope_id,mail_review_policy_id,mail_review_policy_version)
  REFERENCES cos.mail_review_policy_revisions(scope_id,binding_id,version),
 ADD CONSTRAINT brief_schedule_purpose CHECK(COALESCE(
  (purpose='brief' AND mail_review_policy_id IS NULL AND mail_review_policy_version IS NULL AND mail_review_slot IS NULL)
  OR (purpose='mail_review' AND mail_review_policy_id IS NOT NULL AND mail_review_policy_version IS NOT NULL
   AND mail_review_slot IN ('morning','afternoon') AND policy->>'time_zone'='Australia/Sydney'
   AND policy->>'local_time'=CASE mail_review_slot WHEN 'morning' THEN '08:00' WHEN 'afternoon' THEN '15:00' END
   AND policy->'weekdays'='[1,2,3,4,5,6,7]'::jsonb AND policy->'quiet_hours'='null'::jsonb
   AND policy->'snooze_until'='null'::jsonb
   AND policy-ARRAY['state','time_zone','local_time','weekdays','quiet_hours','snooze_until']::text[]='{}'::jsonb
   AND limits='{"max_turns":3,"max_tool_calls":16,"deadline_seconds":300,"refresh_seconds":30}'::jsonb),false));
CREATE UNIQUE INDEX brief_schedule_one_generic ON cos.brief_schedules(scope_id) WHERE purpose='brief';
CREATE UNIQUE INDEX brief_schedule_one_mail_slot ON cos.brief_schedules(scope_id,mail_review_slot) WHERE purpose='mail_review';
ALTER TABLE cos.brief_schedule_revisions
 ALTER COLUMN proposal_id DROP NOT NULL,
 ADD COLUMN mail_review_policy_id uuid,
 ADD COLUMN mail_review_policy_version integer,
 ADD CONSTRAINT brief_revision_review_policy FOREIGN KEY(scope_id,mail_review_policy_id,mail_review_policy_version)
  REFERENCES cos.mail_review_policy_revisions(scope_id,binding_id,version),
 ADD CONSTRAINT brief_revision_one_authority CHECK(
  (proposal_id IS NOT NULL AND mail_review_policy_id IS NULL AND mail_review_policy_version IS NULL)
  OR (proposal_id IS NULL AND mail_review_policy_id IS NOT NULL AND mail_review_policy_version IS NOT NULL));
ALTER TABLE cos.brief_runs ADD COLUMN review_inputs jsonb;
`;
export const MAIL_REVIEW_CHECKSUM = createHash('sha256').update(MAIL_REVIEW_SCHEMA).digest('hex');
