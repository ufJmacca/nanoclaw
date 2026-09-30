import type { Result } from './contracts.js';
/** Deterministic fixture/diagnostic presentation, never represented as model output. */
export function renderPriorities(result: Result): string {
  if (result.status !== 'ok') return 'CoS priorities are unavailable. No cached private records are shown.';
  if (!Array.isArray(result.records) || !result.records.length)
    return 'No approved priorities yet. Propose a charter, goal or project, then approve its exact preview.';
  const quote = (value: unknown) => JSON.stringify(String(value)).replace(/@/g, '＠');
  const lines = result.records.map((record) => {
    if (!record || typeof record.id !== 'string' || typeof record.provenance?.proposal_id !== 'string')
      throw new Error('Approved record provenance missing');
    return `- ${quote(record.kind)}: ${quote(record.title)} — ${quote(record.description)}\n  Source record ${record.id}, revision ${record.version}; approved proposal ${record.provenance.proposal_id}.`;
  });
  return (
    'Deterministic priority view — suggested attention is advice, based only on approved records.\n\n' +
    lines.join('\n')
  );
}
