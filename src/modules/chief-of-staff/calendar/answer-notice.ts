import type { PoolClient } from 'pg';
import type { KnowledgeContext } from '../knowledge/store.js';
import { digest } from '../domain/contracts.js';
import { hasCalendarReadScope } from './reader.js';

export type CalendarAnswerNotice = { text: string; fingerprint: string };
export type CalendarContextCheck = { status: 'ok'; notice: CalendarAnswerNotice | null } | { status: 'denied' };
/** A write-once disclosure dependency for this exact native context. Contains only hashes and identity. */
export async function checkCalendarContext(
  client: PoolClient,
  context: KnowledgeContext,
  notice: () => Promise<CalendarAnswerNotice>,
  register = false,
): Promise<CalendarContextCheck> {
  const ticket =
    'calendar-context-' +
    digest({ scope: context.scopeId, generation: context.generation, provider: context.provider });
  const row = (
    await client.query(
      'SELECT scope_id,method,payload_hash,result FROM cos.operations WHERE session_id=$1 AND request_id=$2',
      [context.sessionId, ticket],
    )
  ).rows[0];
  if (!row && !register) return { status: 'ok', notice: null };
  const current = await notice();
  const result = { generation: context.generation, provider: context.provider, notice_digest: digest(current) };
  if (row)
    return row.scope_id === context.scopeId &&
      row.method === 'cos_calendar_context' &&
      row.payload_hash === digest(result) &&
      digest(row.result) === digest(result)
      ? { status: 'ok', notice: current }
      : { status: 'denied' };
  const inserted = await client.query(
    `INSERT INTO cos.operations(session_id,request_id,scope_id,method,payload_hash,result)
    VALUES($1,$2,$3,'cos_calendar_context',$4,$5) ON CONFLICT DO NOTHING RETURNING request_id`,
    [context.sessionId, ticket, context.scopeId, digest(result), JSON.stringify(result)],
  );
  return inserted.rowCount ? { status: 'ok', notice: current } : checkCalendarContext(client, context, notice);
}
const label = (value: unknown) => String(value).replace(/[\\`*_{}[\]<>]/g, (character) => '\\' + character);
const timestamp = (value: Date | string | null) => (value ? new Date(value).toISOString() : 'never');
/** Called inside the answer's scoped transaction. No network, event text or credentials. */
export async function calendarAnswerNotice(
  client: PoolClient,
  context: KnowledgeContext,
  options: { enabled(): boolean; access(scope: string, binding: string): boolean },
): Promise<CalendarAnswerNotice> {
  if (!options.enabled())
    return {
      text: 'Calendar coverage is unavailable because calendar retrieval is disabled. This does not mean nothing is scheduled.',
      fingerprint: digest({ calendar: 'disabled' }),
    };
  const rows = (
    await client.query(
      `SELECT b.id AS binding_id,c.calendar_id,b.version,b.time_zone,b.auth,b.permission_scopes,
      s.current_snapshot,s.last_attempt,s.last_success_at,s.last_attempt_at,g.coverage_window,a.status AS attempt_status,
      EXISTS(SELECT 1 FROM cos.calendar_observations o
        LEFT JOIN cos.sources src ON src.scope_id=o.scope_id AND src.id=o.source_id
        LEFT JOIN cos.source_revisions r ON r.scope_id=src.scope_id AND r.id=src.current_revision_id
        LEFT JOIN cos.artifacts ar ON ar.scope_id=r.scope_id AND ar.id=r.artifact_id
        WHERE o.scope_id=b.scope_id AND o.binding_id=b.id AND o.calendar_id=c.calendar_id
          AND o.last_snapshot=s.current_snapshot AND o.lifecycle='current' AND
          (src.id IS NULL OR src.status NOT IN ('current','stale') OR NOT $2=ANY(src.processing_providers)
           OR ar.lifecycle IS DISTINCT FROM 'published'
           OR EXISTS(SELECT 1 FROM cos.revocation_tombstones t WHERE t.scope_id=src.scope_id AND t.source_id=src.id))) AS hidden_evidence
      FROM cos.calendar_bindings b CROSS JOIN LATERAL unnest(b.selected_calendar_ids) AS c(calendar_id)
      LEFT JOIN cos.calendar_states s ON s.scope_id=b.scope_id AND s.binding_id=b.id AND s.calendar_id=c.calendar_id
      LEFT JOIN cos.calendar_snapshots g ON g.scope_id=s.scope_id AND g.binding_id=s.binding_id AND g.id=s.current_snapshot
      LEFT JOIN cos.calendar_snapshots a ON a.scope_id=s.scope_id AND a.binding_id=s.binding_id AND a.id=s.last_attempt
      WHERE b.scope_id=$1 AND $2=ANY(b.processing_providers)
      ORDER BY b.id,c.calendar_id LIMIT 101`,
      [context.scopeId, context.provider],
    )
  ).rows;
  // Keep the entire dependency bounded even when only its first page is displayed.
  // Over-limit inventories must not acquire a partial dependency that appears complete.
  if (rows.length > 100) throw new Error('calendar_inventory_limit');
  const more = rows.length > 10;
  const states = rows.map((row) => {
    let accessible = row.auth === 'ready' && hasCalendarReadScope(row.permission_scopes);
    try {
      accessible = accessible && options.access(context.scopeId, row.binding_id);
    } catch {
      accessible = false;
    }
    const { permission_scopes: _scopes, ...safe } = row;
    return {
      ...safe,
      last_success_at: row.last_success_at ? timestamp(row.last_success_at) : null,
      last_attempt_at: row.last_attempt_at ? timestamp(row.last_attempt_at) : null,
      accessible,
    };
  });
  const text = states.length
    ? [
        'Calendar coverage (selected calendars only; this is a stored snapshot, not a live availability check):',
        ...states.slice(0, 10).map((row) => {
          const coverage = !row.accessible
            ? 'Incomplete: calendar access is unavailable.'
            : row.hidden_evidence
              ? 'Incomplete: some calendar evidence is unavailable.'
              : !row.current_snapshot
                ? 'Incomplete: no successful snapshot is available.'
                : row.current_snapshot !== row.last_attempt || row.attempt_status !== 'complete'
                  ? row.attempt_status === 'failed'
                    ? 'Incomplete: the latest refresh failed.'
                    : 'Incomplete: the latest refresh is incomplete.'
                  : 'Snapshot capture is complete within its recorded window only.';
          return (
            `Calendar ${label(row.calendar_id)} (${label(row.time_zone)}): ${coverage}` +
            (row.accessible
              ? ` Last successful refresh: ${timestamp(row.last_success_at)}. Last attempt: ${timestamp(row.last_attempt_at)}.` +
                (row.coverage_window
                  ? ` Recorded window: ${label(row.coverage_window.timeMin)} to ${label(row.coverage_window.timeMax)} (end exclusive).`
                  : '')
              : '')
          );
        }),
        ...(more
          ? [
              'Only the first 10 selected calendar entries are shown; additional calendars are not covered by this notice.',
            ]
          : []),
        'A missing or incomplete calendar is not evidence that nothing is scheduled. Calendar events do not approve inferred preparation tasks.',
      ].join('\n\n')
    : 'Calendar coverage is incomplete: no calendar is connected for this processing provider. This does not mean nothing is scheduled.';
  return { text, fingerprint: digest({ states, more }) };
}
