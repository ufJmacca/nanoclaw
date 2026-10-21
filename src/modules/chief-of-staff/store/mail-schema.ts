import { createHash } from 'node:crypto';
export const MAIL_SCHEMA = `
CREATE TABLE cos.mail_bindings (
 scope_id text NOT NULL REFERENCES cos.scopes(id), id uuid NOT NULL,
 provider text NOT NULL CHECK(provider IN ('google','fixture')),
 mailbox_email text NOT NULL CHECK(length(mailbox_email) BETWEEN 3 AND 254 AND mailbox_email=lower(mailbox_email)),
 permission_scopes text[] NOT NULL CHECK(permission_scopes=ARRAY['https://www.googleapis.com/auth/gmail.readonly']::text[]),
 credential_ref text CHECK(credential_ref ~ '^[a-f0-9-]{36}$'),
 processing_providers text[] NOT NULL CHECK(cardinality(processing_providers)<=2 AND processing_providers<@ARRAY['codex','claude']::text[]),
 auth text NOT NULL CHECK(auth IN ('ready','expired','revoked','disconnected')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), provenance jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(scope_id,id), CHECK(provider<>'google' OR credential_ref IS NOT NULL)
);
CREATE TABLE cos.mail_states (
 scope_id text NOT NULL, binding_id uuid NOT NULL, current_capture uuid, last_attempt uuid,
 history_cursor text CHECK(history_cursor ~ '^[1-9][0-9]{0,127}$'),
 last_attempt_at timestamptz, last_success_at timestamptz, next_poll_at timestamptz,
 PRIMARY KEY(scope_id,binding_id), FOREIGN KEY(scope_id,binding_id) REFERENCES cos.mail_bindings(scope_id,id)
);
CREATE TABLE cos.mail_captures (
 scope_id text NOT NULL, binding_id uuid NOT NULL, id uuid NOT NULL,
 binding_version integer NOT NULL CHECK(binding_version>0), base_capture uuid,
 status text NOT NULL CHECK(status IN ('collecting','complete','failed','superseded')),
 capture_window jsonb NOT NULL, content_digest text CHECK(content_digest ~ '^[a-f0-9]{64}$'),
 metadata jsonb, result jsonb, failure_code text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
 PRIMARY KEY(scope_id,binding_id,id), FOREIGN KEY(scope_id,binding_id) REFERENCES cos.mail_bindings(scope_id,id),
 CHECK(status<>'complete' OR (content_digest IS NOT NULL AND metadata IS NOT NULL AND result IS NOT NULL))
);
ALTER TABLE cos.mail_states ADD CONSTRAINT mail_current_capture FOREIGN KEY(scope_id,binding_id,current_capture) REFERENCES cos.mail_captures(scope_id,binding_id,id);
ALTER TABLE cos.mail_states ADD CONSTRAINT mail_last_attempt FOREIGN KEY(scope_id,binding_id,last_attempt) REFERENCES cos.mail_captures(scope_id,binding_id,id);
CREATE TABLE cos.mail_messages (
 scope_id text NOT NULL, binding_id uuid NOT NULL,
 provider_message_id text NOT NULL CHECK(provider_message_id ~ '^[a-f0-9]{1,128}$'),
 provider_thread_id text NOT NULL CHECK(provider_thread_id ~ '^[a-f0-9]{1,128}$'),
 message jsonb NOT NULL, content_digest text NOT NULL CHECK(content_digest ~ '^[a-f0-9]{64}$'),
 internal_date timestamptz NOT NULL, source_id text, selection_id uuid NOT NULL, last_capture uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(scope_id,binding_id,provider_message_id),
 FOREIGN KEY(scope_id,binding_id) REFERENCES cos.mail_bindings(scope_id,id),
 FOREIGN KEY(scope_id,binding_id,last_capture) REFERENCES cos.mail_captures(scope_id,binding_id,id),
 FOREIGN KEY(scope_id,binding_id,selection_id) REFERENCES cos.mail_captures(scope_id,binding_id,id),
 FOREIGN KEY(scope_id,source_id) REFERENCES cos.sources(scope_id,id)
);
CREATE INDEX mail_retention_date ON cos.mail_messages(scope_id,binding_id,internal_date);
`;
export const MAIL_CHECKSUM = createHash('sha256').update(MAIL_SCHEMA).digest('hex');
