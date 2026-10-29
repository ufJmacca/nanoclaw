import { calendarSourceAccess } from '../calendar/source-access.js';
import { mailSourceAccess } from '../mail/source-access.js';

/** Profile qualification prevents a Calendar binding with the same UUID from
 * opening mail. Both guards also deny conflicting or missing source markers. */
export function sourceAccess(parameter: string, mailReviewParameter?: string): string {
  const calendar = `ARRAY(SELECT substring(binding FROM 10) FROM unnest(${parameter}::text[]) AS binding WHERE binding LIKE 'calendar:%')`;
  const review = mailReviewParameter
    ? ` AND (${mailReviewParameter}::jsonb IS NULL OR
    ((s.provenance->>'origin' IS DISTINCT FROM 'mail_message' AND NOT s.access_policy ? 'mail_binding_id') OR
     (s.provenance->>'origin'='mail_message' AND s.access_policy->>'mail_binding_id'=${mailReviewParameter}::jsonb->>'binding_id'
      AND s.access_policy->>'provider_thread_id'=ANY(ARRAY(SELECT jsonb_array_elements_text(${mailReviewParameter}::jsonb->'thread_ids'))))))`
    : '';
  return `(${calendarSourceAccess(calendar)} AND ${mailSourceAccess(parameter)}${review})`;
}
