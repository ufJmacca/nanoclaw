/** Source alias must be `s`. The parameter is a host-checked text[] of open binding identities.
 * Apply before ranking/pagination as well as at the final disclosure boundary. */
export function calendarSourceAccess(parameter: string): string {
  return `COALESCE((
    (s.provenance->>'origin' IS DISTINCT FROM 'calendar_observation' AND NOT s.access_policy ? 'calendar_binding_id')
    OR (s.provenance->>'origin'='calendar_observation' AND s.access_policy->>'calendar_binding_id'=ANY(${parameter}::text[])
      AND EXISTS(SELECT 1 FROM cos.calendar_observations co
        JOIN cos.calendar_bindings cb ON cb.scope_id=co.scope_id AND cb.id=co.binding_id
        JOIN cos.calendar_states cs ON cs.scope_id=co.scope_id AND cs.binding_id=co.binding_id AND cs.calendar_id=co.calendar_id
        WHERE co.scope_id=s.scope_id AND co.source_id=s.id AND co.lifecycle='current'
          AND cb.id::text=s.access_policy->>'calendar_binding_id' AND co.calendar_id=s.access_policy->>'calendar_id'
          AND cb.auth='ready' AND co.calendar_id=ANY(cb.selected_calendar_ids) AND co.last_snapshot=cs.current_snapshot))
    ),false)`;
}
