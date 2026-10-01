import { CronExpressionParser } from 'cron-parser';

/** Shared native parser with an explicit clock and timezone; safe before host configuration loads. */
export function nextRecurrenceAt(expression: string, timeZone: string, after: Date): string {
  return CronExpressionParser.parse(expression, { tz: timeZone, currentDate: after }).next().toISOString()!;
}
