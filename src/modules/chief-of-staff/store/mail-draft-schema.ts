import { createHash } from 'node:crypto';
/** No migration creates consent. Only trusted owner administration may write these policy records. */
export const MAIL_DRAFT_SCHEMA = `
CREATE TABLE cos.mail_draft_writer_bindings (
 scope_id text NOT NULL REFERENCES cos.scopes(id), id uuid NOT NULL,
 reader_binding_id uuid NOT NULL, owner_id text NOT NULL CHECK(length(owner_id)>0),
 session_id text NOT NULL CHECK(length(session_id)>0), version integer NOT NULL CHECK(version>0),
 state text NOT NULL CHECK(state IN ('enabled','disabled','revoked')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(scope_id,id), FOREIGN KEY(scope_id,reader_binding_id) REFERENCES cos.mail_bindings(scope_id,id)
);
CREATE UNIQUE INDEX mail_draft_one_enabled_writer ON cos.mail_draft_writer_bindings(scope_id,reader_binding_id) WHERE state='enabled';
CREATE TABLE cos.mail_draft_writer_revisions (
 scope_id text NOT NULL, binding_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
 body jsonb NOT NULL CHECK(jsonb_typeof(body)='object' AND COALESCE(
   body->>'format'='cos-mail-draft-binding/v1' AND body->>'provider' IN ('google','fixture')
   AND body->'maxPerDay'='5'::jsonb AND body->>'timeZone'='Australia/Sydney' AND body->>'replyMode'='plain_text_reply'
   AND body->'permissionScopes'='["https://www.googleapis.com/auth/gmail.compose"]'::jsonb
   AND body->>'mailboxDigest' ~ '^[a-f0-9]{64}$' AND body->>'nativeBindingDigest' ~ '^[a-f0-9]{64}$'
   AND body->>'writerClientDigest' ~ '^[a-f0-9]{64}$' AND body->>'readerClientDigest' ~ '^[a-f0-9]{64}$'
   AND body->>'writerClientDigest'<>body->>'readerClientDigest' AND body->>'recoveryProofDigest' ~ '^[a-f0-9]{64}$'
   AND body->>'readerBindingId' ~ '^[a-f0-9-]{36}$' AND body->>'credentialReference' ~ '^[a-f0-9-]{36}$'
   AND body->>'journalGeneration' ~ '^[a-f0-9-]{36}$'
   AND body-ARRAY['format','provider','readerBindingId','mailboxDigest','writerClientDigest','readerClientDigest','credentialReference','nativeBindingDigest','journalGeneration','maxPerDay','timeZone','replyMode','permissionScopes','recoveryProofDigest']::text[]='{}'::jsonb,
   false)),
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'), consent_ref text NOT NULL CHECK(consent_ref ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(scope_id,binding_id,version),
 FOREIGN KEY(scope_id,binding_id) REFERENCES cos.mail_draft_writer_bindings(scope_id,id)
);
`;
export const MAIL_DRAFT_CHECKSUM = createHash('sha256').update(MAIL_DRAFT_SCHEMA).digest('hex');
