import { createHash } from 'node:crypto';

/** S09 creates no binding or write admission. The service can read, but cannot grant, writer consent. */
export const ACTION_SCHEMA = `
CREATE TABLE cos.action_writer_bindings (
  scope_id text NOT NULL REFERENCES cos.scopes(id), id uuid NOT NULL,
  owner_id text NOT NULL, session_id text NOT NULL,
  version integer NOT NULL CHECK(version>0),
  state text NOT NULL CHECK(state IN ('enabled','disabled','revoked')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(scope_id,id)
);
CREATE TABLE cos.action_writer_revisions (
  scope_id text NOT NULL, binding_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
  body jsonb NOT NULL, digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
  consent_ref text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,binding_id,version),
  FOREIGN KEY(scope_id,binding_id) REFERENCES cos.action_writer_bindings(scope_id,id)
);
CREATE TABLE cos.action_intents (
  scope_id text NOT NULL REFERENCES cos.scopes(id), id text NOT NULL CHECK(id ~ '^action-[a-f0-9]{64}$'),
  body jsonb NOT NULL, digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
  authority jsonb NOT NULL, proposal_id text NOT NULL UNIQUE REFERENCES cos.proposals(id) DEFERRABLE INITIALLY DEFERRED,
  binding_id uuid NOT NULL, calendar_id text NOT NULL, event_id text NOT NULL CHECK(event_id ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(scope_id,id),
  UNIQUE(scope_id,binding_id,calendar_id,event_id),
  FOREIGN KEY(scope_id,binding_id) REFERENCES cos.action_writer_bindings(scope_id,id)
);
CREATE TABLE cos.actions (
  scope_id text NOT NULL, id text NOT NULL,
  state text NOT NULL CHECK(state IN ('proposed','waiting_approval','authorised','queued','executing','verified','blocked','failed','outcome_uncertain','cancelled')),
  lease_owner uuid, fence integer NOT NULL DEFAULT 0 CHECK(fence>=0), lease_expires_at timestamptz,
  cancel_requested boolean NOT NULL DEFAULT false, reason text, result jsonb,
  reconcile_count integer NOT NULL DEFAULT 0 CHECK(reconcile_count BETWEEN 0 AND 12),
  next_reconcile_at timestamptz, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(scope_id,id),
  FOREIGN KEY(scope_id,id) REFERENCES cos.action_intents(scope_id,id),
  CHECK((lease_owner IS NULL)=(lease_expires_at IS NULL))
);
CREATE TABLE cos.action_request_starts (
  scope_id text NOT NULL, action_id text NOT NULL, intent_digest text NOT NULL CHECK(intent_digest ~ '^[a-f0-9]{64}$'),
  lease_owner uuid NOT NULL, fence integer NOT NULL CHECK(fence>0),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(scope_id,action_id),
  FOREIGN KEY(scope_id,action_id) REFERENCES cos.action_intents(scope_id,id)
);
CREATE TABLE cos.action_receipts (
  scope_id text NOT NULL, id uuid NOT NULL, action_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('blocked','failed','uncertain','missing','mismatch','verified','cancelled','cancel_requested')),
  body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(scope_id,id),
  FOREIGN KEY(scope_id,action_id) REFERENCES cos.action_intents(scope_id,id)
);
CREATE INDEX action_ready ON cos.actions(scope_id,state,next_reconcile_at,id);
CREATE INDEX action_receipt_history ON cos.action_receipts(scope_id,action_id,created_at,id);
`;
export const ACTION_CHECKSUM = createHash('sha256').update(ACTION_SCHEMA).digest('hex');
