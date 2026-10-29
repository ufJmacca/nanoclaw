/** One stable synthetic timeline; never changes an installed schedule or clock. */
import { Temporal } from '@js-temporal/polyfill';

export function mailReviewFixtureTiming(now = Temporal.Now.instant().toString()) {
  const date = Temporal.Instant.from(now).toZonedDateTimeISO('Australia/Sydney').toPlainDate();
  const clock = (slot: 'morning' | 'afternoon', days = 1): string =>
    date
      .add({ days })
      .toPlainDateTime(slot === 'morning' ? '08:01' : '15:01')
      .toZonedDateTime('Australia/Sydney')
      .toInstant()
      .toString();
  return {
    activatedAt: date.add({ days: 1 }).toZonedDateTime('Australia/Sydney').toInstant().toString(),
    clock,
  };
}
