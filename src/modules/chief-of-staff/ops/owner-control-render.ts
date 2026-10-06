import type { Result } from '../domain/contracts.js';
/** Fixed host acknowledgements reveal no cached database content or driver diagnostics. */
export function renderOwnerControl(result: Result): string {
  if (!['ok', 'pending'].includes(result.status))
    return 'CoS control was denied. Inspect status before trying another command.';
  if (result.state === 'admission_paused')
    return 'CoS admission paused.\nNew work is fenced in this CoS group. Stop requests were recorded for its coordinator and specialists.\nAlready-started external effects still require reconciliation. Use cos status to inspect current state.';
  if (result.state === 'cancellation_recorded')
    return 'Mission cancellation recorded.\nA permanent local fence prevents this mission from starting or retrying here. PostgreSQL reconciliation is pending.\nStop requests do not confirm that every worker or external effect has stopped. Use cos status missions to inspect current state.';
  if (result.state === 'source_revocation_recorded')
    return 'Source revocation recorded.\nCoS admission is paused and its exposed context is invalidated. PostgreSQL revocation is pending.\nAlready-delivered content and retained backups have separate deletion limits. Use cos status sources to inspect current state.';
  if (result.state === 'connector_disable_recorded')
    return 'Connector disable recorded.\nCoS admission is paused and its exposed context is invalidated. The account connector denial is pending PostgreSQL reconciliation.\nAlready-started external effects still require reconciliation. Use cos status to inspect current state.';
  return 'CoS control status is unavailable. No admission or action authority was granted.';
}
