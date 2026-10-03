/** Owner-approved recommendation limits. Observation/model text never supplies this configuration. */
export type ProactivePolicy = {
  due_horizon_hours: number;
  no_update_days: number | null;
  max_candidates: number;
  max_proposals: number;
  notifications_per_day: number;
  time_zone: string;
  quiet_hours: { start: string; end: string } | null;
  urgent_rule: 'confirmed_due_24h' | null;
};
const integer = (v: unknown, min: number, max: number) =>
  Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const clock = (v: unknown) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
export function validProactivePolicy(v: unknown): v is ProactivePolicy {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const p = v as ProactivePolicy;
  const keys = [
    'due_horizon_hours',
    'no_update_days',
    'max_candidates',
    'max_proposals',
    'notifications_per_day',
    'time_zone',
    'quiet_hours',
    'urgent_rule',
  ];
  if (
    Object.keys(p).length !== keys.length ||
    !keys.every((k) => Object.hasOwn(p, k)) ||
    !integer(p.due_horizon_hours, 1, 168) ||
    (p.no_update_days !== null && !integer(p.no_update_days, 1, 90)) ||
    !integer(p.max_candidates, 1, 5) ||
    !integer(p.max_proposals, 0, 3) ||
    !integer(p.notifications_per_day, 0, 3) ||
    typeof p.time_zone !== 'string' ||
    p.time_zone.length > 100 ||
    /^[+-]/.test(p.time_zone) ||
    ![null, 'confirmed_due_24h'].includes(p.urgent_rule) ||
    (p.quiet_hours !== null &&
      (!p.quiet_hours ||
        typeof p.quiet_hours !== 'object' ||
        Object.keys(p.quiet_hours).length !== 2 ||
        !Object.hasOwn(p.quiet_hours, 'start') ||
        !Object.hasOwn(p.quiet_hours, 'end') ||
        !clock(p.quiet_hours.start) ||
        !clock(p.quiet_hours.end) ||
        p.quiet_hours.start === p.quiet_hours.end))
  )
    return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: p.time_zone });
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}
