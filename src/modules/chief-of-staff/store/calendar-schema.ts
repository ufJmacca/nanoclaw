import { createHash } from 'node:crypto';

export const CALENDAR_SCHEMA = `
CREATE TABLE cos.calendar_bindings (
  scope_id text NOT NULL REFERENCES cos.scopes(id), id uuid NOT NULL,
  provider text NOT NULL CHECK(provider IN ('google','fixture')),
  selected_calendar_ids text[] NOT NULL CHECK(cardinality(selected_calendar_ids) BETWEEN 1 AND 20),
  permission_scopes text[] NOT NULL CHECK(cardinality(permission_scopes) <= 50),
  credential_ref text CHECK(credential_ref ~ '^[a-zA-Z0-9_-]{1,128}$'),
  time_zone text NOT NULL CHECK(length(time_zone) BETWEEN 1 AND 80),
  processing_providers text[] NOT NULL,
  auth text NOT NULL CHECK(auth IN ('ready','expired','revoked','disconnected')),
  version integer NOT NULL DEFAULT 1 CHECK(version > 0), provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,id), CHECK(provider<>'google' OR credential_ref IS NOT NULL)
);
CREATE TABLE cos.calendar_states (
  scope_id text NOT NULL, binding_id uuid NOT NULL, calendar_id text NOT NULL CHECK(length(calendar_id) BETWEEN 1 AND 1024),
  current_snapshot uuid, last_attempt uuid,
  last_attempt_at timestamptz, last_success_at timestamptz,
  PRIMARY KEY(scope_id,binding_id,calendar_id),
  FOREIGN KEY(scope_id,binding_id) REFERENCES cos.calendar_bindings(scope_id,id)
);
CREATE TABLE cos.calendar_snapshots (
  scope_id text NOT NULL, binding_id uuid NOT NULL, calendar_id text NOT NULL, id uuid NOT NULL,
  binding_version integer NOT NULL CHECK(binding_version > 0), coverage_window jsonb NOT NULL,
  status text NOT NULL CHECK(status IN ('collecting','failed','complete','superseded')),
  failure_code text, content_digest text CHECK(content_digest ~ '^[a-f0-9]{64}$'),
  result jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
  PRIMARY KEY(scope_id,binding_id,id), UNIQUE(scope_id,binding_id,calendar_id,id),
  FOREIGN KEY(scope_id,binding_id,calendar_id) REFERENCES cos.calendar_states(scope_id,binding_id,calendar_id)
);
ALTER TABLE cos.calendar_states ADD CONSTRAINT calendar_current_snapshot
  FOREIGN KEY(scope_id,binding_id,calendar_id,current_snapshot) REFERENCES cos.calendar_snapshots(scope_id,binding_id,calendar_id,id);
ALTER TABLE cos.calendar_states ADD CONSTRAINT calendar_last_attempt
  FOREIGN KEY(scope_id,binding_id,calendar_id,last_attempt) REFERENCES cos.calendar_snapshots(scope_id,binding_id,calendar_id,id);
CREATE TABLE cos.calendar_observations (
  scope_id text NOT NULL, binding_id uuid NOT NULL, calendar_id text NOT NULL, provider_event_id text NOT NULL CHECK(length(provider_event_id) BETWEEN 1 AND 1024),
  event jsonb NOT NULL, content_digest text NOT NULL CHECK(content_digest ~ '^[a-f0-9]{64}$'),
  provider_version text, version integer NOT NULL CHECK(version > 0),
  lifecycle text NOT NULL CHECK(lifecycle IN ('current','cancelled','retired','quarantined')),
  last_snapshot uuid NOT NULL, source_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,binding_id,calendar_id,provider_event_id),
  FOREIGN KEY(scope_id,binding_id,calendar_id,last_snapshot) REFERENCES cos.calendar_snapshots(scope_id,binding_id,calendar_id,id),
  FOREIGN KEY(scope_id,source_id) REFERENCES cos.sources(scope_id,id)
);
CREATE TABLE cos.calendar_event_revisions (
  scope_id text NOT NULL, binding_id uuid NOT NULL, calendar_id text NOT NULL, provider_event_id text NOT NULL,
  version integer NOT NULL CHECK(version > 0), event jsonb NOT NULL,
  snapshot_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,binding_id,calendar_id,provider_event_id,version),
  FOREIGN KEY(scope_id,binding_id,calendar_id,provider_event_id) REFERENCES cos.calendar_observations(scope_id,binding_id,calendar_id,provider_event_id),
  FOREIGN KEY(scope_id,binding_id,calendar_id,snapshot_id) REFERENCES cos.calendar_snapshots(scope_id,binding_id,calendar_id,id)
);
`;
export const CALENDAR_CHECKSUM = createHash('sha256').update(CALENDAR_SCHEMA).digest('hex');
