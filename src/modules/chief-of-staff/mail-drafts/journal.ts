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
  saved: { draftId: string; messageId: string } | null;
};
export type DraftObservation =
  | { state: 'verified'; draftId: string; messageId: string; threadId: string; contentDigest: string }
  | { state: 'edited' | 'missing' | 'sent' | 'collision' };
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const providerId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{1,128}$/.test(value);
const draftId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && contextGenerationPattern.test(value);
const keys = (value: object, expected: string) => Object.keys(value).sort().join(',') === expected;
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
  private assertCurrent(): void {
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
        'bindingId,contentDigest,contextGeneration,correlation,day,format,mailboxDigest,observedAt,operationId,requestId,reservedAt,saved,scopeId,sourceMessageId,state,threadId',
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
      (value.state === 'reserved' ? value.observedAt !== null || value.saved !== null : value.observedAt === null) ||
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
              (record.saved.draftId !== observation.draftId || record.saved.messageId !== observation.messageId))
          )
            throw new Error('mail_draft_observation_conflict');
          record.saved = { draftId: observation.draftId, messageId: observation.messageId };
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
