import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { digest } from '../domain/contracts.js';
import { readPrivate, writeAtomic } from '../ops/target-state.js';
import {
  contextGenerationPattern,
  privateConversationDirectory,
  syncConversationDirectory,
} from '../ops/conversation-ownership.js';

type JournalOwner = {
  format: 'cos-mail-draft-journal-owner/v1';
  installationDigest: string;
  generation: string;
  databaseDevice: number;
  databaseInode: number;
};
export type DraftReservation = {
  scopeId: string;
  bindingId: string;
  contextGeneration: string;
  mailboxDigest: string;
  sourceMessageId: string;
  threadId: string;
  requestId: string;
  contentDigest: string;
};
export type DraftEffectState = 'reserved' | 'verified' | 'edited' | 'missing' | 'sent' | 'collision';
export type DraftEffect = DraftReservation & {
  format: 'cos-mail-draft-effect/v1';
  operationId: string;
  correlation: string;
  reservedAt: string;
  day: string;
  state: DraftEffectState;
  observedAt: string | null;
  candidate: { draftId: string; messageId: string } | null;
  saved: { draftId: string; messageId: string } | null;
};
export type DraftObservation =
  | { state: 'verified'; draftId: string; messageId: string; threadId: string; contentDigest: string }
  | { state: 'edited' | 'missing' | 'sent' | 'collision' };
export type MailReviewPolicyPin = { scopeId: string; policyId: string; policyVersion: number; profileDigest: string };
export type MailReviewPolicyHead = MailReviewPolicyPin & { revision: number; enabled: boolean };
export type MailReviewPinRequest = {
  requestId: string;
  expectedRevision: number;
  pin: MailReviewPolicyPin;
  enabled: boolean;
};
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const providerId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{1,128}$/.test(value);
const draftId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && contextGenerationPattern.test(value);
const keys = (value: object, expected: string) => Object.keys(value).sort().join(',') === expected;
const positiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
function validReviewPin(pin: MailReviewPolicyPin): boolean {
  return (
    !!pin &&
    typeof pin === 'object' &&
    !Array.isArray(pin) &&
    keys(pin, 'policyId,policyVersion,profileDigest,scopeId') &&
    typeof pin.scopeId === 'string' &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(pin.scopeId) &&
    uuid(pin.policyId) &&
    positiveInt(pin.policyVersion) &&
    hash(pin.profileDigest)
  );
}
const reservationKeys =
  'bindingId,contentDigest,contextGeneration,mailboxDigest,requestId,scopeId,sourceMessageId,threadId';
function validReservation(value: DraftReservation): boolean {
  return (
    !!value &&
    keys(value, reservationKeys) &&
    typeof value.scopeId === 'string' &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(value.scopeId) &&
    uuid(value.bindingId) &&
    uuid(value.contextGeneration) &&
    uuid(value.requestId) &&
    hash(value.mailboxDigest) &&
    hash(value.contentDigest) &&
    providerId(value.sourceMessageId) &&
    providerId(value.threadId)
  );
}
function instant(now: number): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000) throw new Error('unsafe_mail_draft_journal');
  return new Date(now).toISOString();
}
function sydneyDay(now: number): string {
  instant(now);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find((value) => value.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function fileStat(file: string): fs.Stats {
  const value = fs.lstatSync(file);
  if (
    !value.isFile() ||
    value.nlink !== 1 ||
    value.uid !== process.getuid?.() ||
    (value.mode & 0o7777) !== 0o600 ||
    fs.realpathSync(file) !== file
  )
    throw new Error('unsafe_mail_draft_journal');
  return value;
}
function sameFile(first: fs.Stats, current: fs.Stats): boolean {
  return (
    first.dev === current.dev && first.ino === current.ino && first.uid === current.uid && first.mode === current.mode
  );
}
function readOwner(root: string, installation: string, generation?: string): JournalOwner {
  privateConversationDirectory(root);
  const file = path.join(root, 'owner.json');
  fileStat(file);
  const owner = readPrivate<JournalOwner>(file);
  if (
    !owner ||
    !keys(owner, 'databaseDevice,databaseInode,format,generation,installationDigest') ||
    owner.format !== 'cos-mail-draft-journal-owner/v1' ||
    !hash(installation) ||
    owner.installationDigest !== installation ||
    !uuid(owner.generation) ||
    (generation !== undefined && owner.generation !== generation) ||
    !Number.isSafeInteger(owner.databaseDevice) ||
    !Number.isSafeInteger(owner.databaseInode)
  )
    throw new Error('unsafe_mail_draft_journal');
  const database = fileStat(path.join(root, 'effects.sqlite'));
  if (database.dev !== owner.databaseDevice || database.ino !== owner.databaseInode)
    throw new Error('mail_draft_journal_replaced');
  return owner;
}
function durableDatabase(file: string): Database.Database {
  const db = new Database(file, { fileMustExist: true, timeout: 1000 });
  let complete = false;
  try {
    // No long-lived WAL can be omitted by an ordinary file operation. Each reservation commits before POST.
    if (db.pragma('journal_mode=DELETE', { simple: true }) !== 'delete') throw new Error('unsafe_mail_draft_journal');
    db.pragma('synchronous=EXTRA');
    db.pragma('trusted_schema=OFF');
    complete = true;
    return db;
  } finally {
    if (!complete) db.close();
  }
}
/** Trusted setup under target maintenance only. A missing/replaced existing history is never adopted. */
export function initializeDraftJournal(root: string, installationDigest: string): JournalOwner {
  if (!path.isAbsolute(root) || path.resolve(root) !== root || !hash(installationDigest))
    throw new Error('unsafe_mail_draft_journal');
  privateConversationDirectory(path.dirname(root));
  if (fs.lstatSync(root, { throwIfNoEntry: false })) {
    const owner = readOwner(root, installationDigest),
      journal = new DraftJournal(root, installationDigest, owner.generation);
    journal.close();
    return owner;
  }
  fs.mkdirSync(root, { mode: 0o700 });
  syncConversationDirectory(path.dirname(root));
  const file = path.join(root, 'effects.sqlite'),
    fd = fs.openSync(file, 'wx', 0o600);
  fs.closeSync(fd);
  const db = durableDatabase(file),
    generation = randomUUID();
  try {
    db.transaction(() => {
      db.exec(`CREATE TABLE ownership (id INTEGER PRIMARY KEY CHECK(id=1), installation TEXT NOT NULL, generation TEXT NOT NULL);
        CREATE TABLE effects (operation_id TEXT PRIMARY KEY, mailbox_digest TEXT NOT NULL, source_id TEXT NOT NULL,
          thread_id TEXT NOT NULL, day TEXT NOT NULL, reserved_at INTEGER NOT NULL, state TEXT NOT NULL, record TEXT NOT NULL,
          UNIQUE(mailbox_digest,source_id));
        CREATE INDEX draft_daily_count ON effects(day);
        CREATE INDEX draft_thread_fence ON effects(mailbox_digest,thread_id,state);
        PRAGMA user_version=1;`);
      db.prepare('INSERT INTO ownership VALUES (1,?,?)').run(installationDigest, generation);
    }).immediate();
  } finally {
    db.close();
  }
  const stat = fileStat(file);
  const owner: JournalOwner = {
    format: 'cos-mail-draft-journal-owner/v1',
    installationDigest,
    generation,
    databaseDevice: stat.dev,
    databaseInode: stat.ino,
  };
  writeAtomic(root, 'owner.json', owner);
  return readOwner(root, installationDigest, generation);
}
type Row = {
  operation_id: string;
  mailbox_digest: string;
  source_id: string;
  thread_id: string;
  day: string;
  reserved_at: number;
  state: string;
  record: string;
};
/** Independent deny-only history: no method grants provider, model, session or scheduling authority. */
export class DraftJournal {
  private readonly db: Database.Database;
  private readonly rootStat: fs.Stats;
  private readonly ownerStat: fs.Stats;
  private readonly databaseStat: fs.Stats;
  constructor(
    readonly root: string,
    readonly installationDigest: string,
    readonly generation: string,
  ) {
    if (!uuid(generation)) throw new Error('unsafe_mail_draft_journal');
    readOwner(root, installationDigest, generation);
    this.rootStat = fs.lstatSync(root);
    this.ownerStat = fileStat(path.join(root, 'owner.json'));
    this.databaseStat = fileStat(path.join(root, 'effects.sqlite'));
    this.db = durableDatabase(path.join(root, 'effects.sqlite'));
    let complete = false;
    try {
      this.assertCurrent();
      if (
        this.db.pragma('user_version', { simple: true }) !== 1 ||
        this.db.pragma('quick_check', { simple: true }) !== 'ok'
      )
        throw new Error('unsafe_mail_draft_journal');
      complete = true;
    } finally {
      if (!complete) this.db.close();
    }
  }
  close(): void {
    if (this.db.open) this.db.close();
  }
  assertCurrent(): void {
    readOwner(this.root, this.installationDigest, this.generation);
    if (
      !this.db.open ||
      !sameFile(this.rootStat, fs.lstatSync(this.root)) ||
      !sameFile(this.ownerStat, fileStat(path.join(this.root, 'owner.json'))) ||
      !sameFile(this.databaseStat, fileStat(path.join(this.root, 'effects.sqlite')))
    )
      throw new Error('mail_draft_journal_replaced');
    const owner = this.db.prepare('SELECT installation,generation FROM ownership WHERE id=1').get() as
      | { installation: string; generation: string }
      | undefined;
    if (!owner || owner.installation !== this.installationDigest || owner.generation !== this.generation)
      throw new Error('unsafe_mail_draft_journal');
  }
  private hasReviewPins(): boolean {
    const rows = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('mail_review_policy_heads','mail_review_policy_requests')",
      )
      .all();
    if (rows.length !== 0 && rows.length !== 2) throw Error('unsafe_mail_review_pin');
    return rows.length === 2;
  }
  /** A denial pin only. Missing history is never initialized by a runtime read. */
  reviewPolicyPin(scopeId: string): MailReviewPolicyHead | null {
    this.assertCurrent();
    if (typeof scopeId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(scopeId)) throw Error('unsafe_mail_review_pin');
    if (!this.hasReviewPins()) return null;
    const row = this.db.prepare('SELECT record FROM mail_review_policy_heads WHERE scope_id=?').get(scopeId) as
      | { record: string }
      | undefined;
    if (!row) return null;
    const head = JSON.parse(row.record) as MailReviewPolicyHead;
    if (
      !head ||
      typeof head !== 'object' ||
      !keys(head, 'enabled,policyId,policyVersion,profileDigest,revision,scopeId') ||
      !validReviewPin({
        scopeId: head.scopeId,
        policyId: head.policyId,
        policyVersion: head.policyVersion,
        profileDigest: head.profileDigest,
      }) ||
      head.scopeId !== scopeId ||
      !positiveInt(head.revision) ||
      typeof head.enabled !== 'boolean'
    )
      throw Error('unsafe_mail_review_pin');
    return structuredClone(head);
  }
  /** Trusted owner administration only, after SQL policy/readiness checks. This metadata grants no
   * provider or model authority; it prevents restored SQL/profile files from reviving older policy. */
  publishReviewPolicyPin(request: MailReviewPinRequest, assertAuthority: () => void): MailReviewPolicyHead {
    if (
      !request ||
      typeof request !== 'object' ||
      !keys(request, 'enabled,expectedRevision,pin,requestId') ||
      !uuid(request.requestId) ||
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 0 ||
      request.expectedRevision >= 2147483647 ||
      typeof request.enabled !== 'boolean' ||
      !validReviewPin(request.pin)
    )
      throw Error('unsafe_mail_review_pin');
    const captured = structuredClone(request),
      inputDigest = digest(captured);
    const current = () => {
      this.assertCurrent();
      assertAuthority();
      if (digest(request) !== inputDigest) throw Error('mail_review_pin_inputs_changed');
    };
    current();
    return this.db
      .transaction(() => {
        current();
        if (!this.hasReviewPins())
          this.db.exec(`CREATE TABLE mail_review_policy_heads(scope_id TEXT PRIMARY KEY,record TEXT NOT NULL);
        CREATE TABLE mail_review_policy_requests(scope_id TEXT NOT NULL,request_id TEXT NOT NULL,input_digest TEXT NOT NULL,result_digest TEXT NOT NULL,PRIMARY KEY(scope_id,request_id));`);
        const head = this.reviewPolicyPin(captured.pin.scopeId),
          prior = this.db
            .prepare(
              'SELECT input_digest,result_digest FROM mail_review_policy_requests WHERE scope_id=? AND request_id=?',
            )
            .get(captured.pin.scopeId, captured.requestId) as
            | { input_digest: string; result_digest: string }
            | undefined;
        if (prior) {
          if (prior.input_digest !== inputDigest) throw Error('mail_review_pin_request_conflict');
          if (!head || digest(head) !== prior.result_digest) throw Error('mail_review_pin_request_stale');
          current();
          return head;
        }
        if ((head?.revision ?? 0) !== captured.expectedRevision) throw Error('mail_review_pin_revision_conflict');
        if (head?.policyId === captured.pin.policyId && captured.pin.policyVersion < head.policyVersion)
          throw Error('mail_review_pin_version_regressed');
        const next: MailReviewPolicyHead = {
          ...captured.pin,
          revision: captured.expectedRevision + 1,
          enabled: captured.enabled,
        };
        this.db
          .prepare(
            'INSERT INTO mail_review_policy_heads(scope_id,record) VALUES(?,?) ON CONFLICT(scope_id) DO UPDATE SET record=excluded.record',
          )
          .run(next.scopeId, JSON.stringify(next));
        this.db
          .prepare(
            'INSERT INTO mail_review_policy_requests(scope_id,request_id,input_digest,result_digest) VALUES(?,?,?,?)',
          )
          .run(next.scopeId, captured.requestId, inputDigest, digest(next));
        current();
        return structuredClone(next);
      })
      .immediate();
  }
  private identity(mailboxDigest: string, sourceMessageId: string): string {
    return digest({
      format: 'cos-mail-draft-id/v1',
      installation: this.installationDigest,
      mailboxDigest,
      sourceMessageId,
    });
  }
  private record(row: Row): DraftEffect {
    const value = JSON.parse(row.record) as DraftEffect;
    if (
      !value ||
      !keys(
        value,
        'bindingId,candidate,contentDigest,contextGeneration,correlation,day,format,mailboxDigest,observedAt,operationId,requestId,reservedAt,saved,scopeId,sourceMessageId,state,threadId',
      )
    )
      throw new Error('unsafe_mail_draft_journal');
    const {
      scopeId,
      bindingId,
      contextGeneration,
      mailboxDigest,
      sourceMessageId,
      threadId,
      requestId,
      contentDigest,
    } = value;
    if (
      !validReservation({
        scopeId,
        bindingId,
        contextGeneration,
        mailboxDigest,
        sourceMessageId,
        threadId,
        requestId,
        contentDigest,
      }) ||
      value.format !== 'cos-mail-draft-effect/v1' ||
      !hash(value.correlation) ||
      value.operationId !== this.identity(mailboxDigest, sourceMessageId) ||
      value.operationId !== row.operation_id ||
      mailboxDigest !== row.mailbox_digest ||
      sourceMessageId !== row.source_id ||
      threadId !== row.thread_id ||
      value.day !== row.day ||
      value.reservedAt !== instant(row.reserved_at) ||
      value.day !== sydneyDay(row.reserved_at) ||
      value.state !== row.state ||
      !['reserved', 'verified', 'edited', 'missing', 'sent', 'collision'].includes(value.state) ||
      (value.observedAt !== null &&
        (!Number.isFinite(Date.parse(value.observedAt)) ||
          instant(Date.parse(value.observedAt)) !== value.observedAt ||
          Date.parse(value.observedAt) < row.reserved_at)) ||
      (value.saved !== null &&
        (!keys(value.saved, 'draftId,messageId') ||
          !draftId(value.saved.draftId) ||
          !providerId(value.saved.messageId))) ||
      (value.candidate !== null &&
        (!keys(value.candidate, 'draftId,messageId') ||
          !draftId(value.candidate.draftId) ||
          !providerId(value.candidate.messageId))) ||
      (value.saved !== null && (!value.candidate || digest(value.saved) !== digest(value.candidate))) ||
      (value.state === 'reserved'
        ? (value.candidate === null ? value.observedAt !== null : value.observedAt === null) || value.saved !== null
        : value.observedAt === null) ||
      (value.state === 'verified' && value.saved === null)
    )
      throw new Error('unsafe_mail_draft_journal');
    return value;
  }
  find(operationId: string): DraftEffect | null {
    this.assertCurrent();
    if (!hash(operationId)) throw new Error('unsafe_mail_draft_journal');
    const row = this.db.prepare('SELECT * FROM effects WHERE operation_id=?').get(operationId) as Row | undefined;
    return row ? this.record(row) : null;
  }
  findSource(mailboxDigest: string, sourceMessageId: string): DraftEffect | null {
    if (!hash(mailboxDigest) || !providerId(sourceMessageId)) throw new Error('unsafe_mail_draft_journal');
    return this.find(this.identity(mailboxDigest, sourceMessageId));
  }
  /** Exactly one caller receives created=true. A crash or uncertain POST never makes that permission repeatable. */
  reserve(input: DraftReservation, now: number): { created: boolean; record: DraftEffect } {
    this.assertCurrent();
    if (!validReservation(input)) throw new Error('unsafe_mail_draft_journal');
    const at = instant(now),
      day = sydneyDay(now),
      operationId = this.identity(input.mailboxDigest, input.sourceMessageId);
    return this.db
      .transaction(() => {
        this.assertCurrent();
        const last = this.db.prepare('SELECT MAX(reserved_at) AS last,COUNT(*) AS count FROM effects').get() as {
          last: number | null;
          count: number;
        };
        if (last.last !== null && now < last.last) throw new Error('mail_draft_clock_regressed');
        const existing = this.find(operationId);
        if (existing) {
          if (
            existing.threadId !== input.threadId ||
            existing.contentDigest !== input.contentDigest ||
            existing.scopeId !== input.scopeId
          )
            throw new Error('mail_draft_already_reserved');
          return { created: false, record: existing };
        }
        if (last.count >= 100000) throw new Error('mail_draft_journal_inventory_limit');
        if (
          this.db
            .prepare(
              "SELECT 1 FROM effects WHERE mailbox_digest=? AND thread_id=? AND state IN ('reserved','verified','edited','collision') LIMIT 1",
            )
            .get(input.mailboxDigest, input.threadId)
        )
          throw new Error('mail_draft_thread_reserved');
        const count = this.db.prepare('SELECT COUNT(*) AS count FROM effects WHERE day=?').get(day) as {
          count: number;
        };
        if (count.count >= 5) throw new Error('mail_draft_daily_limit');
        const record: DraftEffect = {
          ...input,
          format: 'cos-mail-draft-effect/v1',
          operationId,
          correlation: randomBytes(32).toString('hex'),
          reservedAt: at,
          day,
          state: 'reserved',
          observedAt: null,
          candidate: null,
          saved: null,
        };
        this.db
          .prepare('INSERT INTO effects VALUES (?,?,?,?,?,?,?,?)')
          .run(
            operationId,
            input.mailboxDigest,
            input.sourceMessageId,
            input.threadId,
            day,
            now,
            record.state,
            JSON.stringify(record),
          );
        return { created: true, record };
      })
      .immediate();
  }
  /** Provider IDs are denial/reconciliation metadata, never proof that intended content was saved. */
  acknowledge(operationId: string, candidate: { draftId: string; messageId: string }, now: number): DraftEffect {
    this.assertCurrent();
    const at = instant(now);
    if (
      !candidate ||
      !keys(candidate, 'draftId,messageId') ||
      !draftId(candidate.draftId) ||
      !providerId(candidate.messageId)
    )
      throw new Error('unsafe_mail_draft_journal');
    return this.db
      .transaction(() => {
        const record = this.find(operationId);
        if (!record) throw new Error('mail_draft_effect_missing');
        if (now < Date.parse(record.observedAt ?? record.reservedAt)) throw new Error('mail_draft_clock_regressed');
        if (record.state !== 'reserved' || (record.candidate && digest(record.candidate) !== digest(candidate)))
          throw new Error('mail_draft_observation_conflict');
        record.candidate = { ...candidate };
        record.observedAt = at;
        this.db.prepare('UPDATE effects SET record=? WHERE operation_id=?').run(JSON.stringify(record), operationId);
        return record;
      })
      .immediate();
  }
  /** Only fixed provider readback can supply observations. Terminal effects never become new creates. */
  observe(operationId: string, observation: DraftObservation, now: number): DraftEffect {
    this.assertCurrent();
    const at = instant(now);
    if (
      !observation ||
      !['verified', 'edited', 'missing', 'sent', 'collision'].includes(observation.state) ||
      (observation.state === 'verified'
        ? !keys(observation, 'contentDigest,draftId,messageId,state,threadId') ||
          !draftId(observation.draftId) ||
          !providerId(observation.messageId) ||
          !providerId(observation.threadId) ||
          !hash(observation.contentDigest)
        : !keys(observation, 'state'))
    )
      throw new Error('unsafe_mail_draft_journal');
    return this.db
      .transaction(() => {
        const record = this.find(operationId);
        if (!record) throw new Error('mail_draft_effect_missing');
        if (now < Date.parse(record.observedAt ?? record.reservedAt)) throw new Error('mail_draft_clock_regressed');
        if (
          (['missing', 'sent'].includes(record.state) && record.state !== observation.state) ||
          (['edited', 'collision'].includes(record.state) &&
            ![record.state, 'missing', 'sent'].includes(observation.state))
        )
          throw new Error('mail_draft_observation_conflict');
        if (observation.state === 'verified') {
          if (
            !['reserved', 'verified'].includes(record.state) ||
            observation.threadId !== record.threadId ||
            observation.contentDigest !== record.contentDigest ||
            (record.saved &&
              (record.saved.draftId !== observation.draftId || record.saved.messageId !== observation.messageId)) ||
            (record.candidate &&
              (record.candidate.draftId !== observation.draftId ||
                record.candidate.messageId !== observation.messageId))
          )
            throw new Error('mail_draft_observation_conflict');
          record.saved = { draftId: observation.draftId, messageId: observation.messageId };
          record.candidate = { ...record.saved };
        }
        record.state = observation.state;
        record.observedAt = at;
        this.db
          .prepare('UPDATE effects SET state=?,record=? WHERE operation_id=?')
          .run(record.state, JSON.stringify(record), operationId);
        return record;
      })
      .immediate();
  }
}
