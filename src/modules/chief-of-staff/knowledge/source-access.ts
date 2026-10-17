import { calendarSourceAccess } from '../calendar/source-access.js';
import { mailSourceAccess } from '../mail/source-access.js';

/** Profile qualification prevents a Calendar binding with the same UUID from
 * opening mail. Both guards also deny conflicting or missing source markers. */
export function sourceAccess(parameter: string): string {
  const calendar = `ARRAY(SELECT substring(binding FROM 10) FROM unnest(${parameter}::text[]) AS binding WHERE binding LIKE 'calendar:%')`;
  return `(${calendarSourceAccess(calendar)} AND ${mailSourceAccess(parameter)})`;
}
