import type { CosBinding } from '../../../cos-boundary.js';
import type { PriorityStore } from '../store/priorities.js';
import type { Change } from '../domain/contracts.js';
import { validChange, digest } from '../domain/contracts.js';
export type Preview = {
  id: string;
  proposalId: string;
  token: string;
  change: Change;
  expiresAt: string;
  sessionId: string;
  text: string;
};
export type OutboxDependencies = {
  store: Pick<PriorityStore, 'pendingOutbox' | 'acknowledgePreview' | 'apply'>;
  admitted(binding: CosBinding): Promise<boolean>;
  preview(binding: CosBinding, preview: Preview): Promise<boolean>;
};
export class CosOutbox {
  constructor(readonly dependencies: OutboxDependencies) {}
  private readonly draining = new Set<string>();
  async drain(binding: CosBinding): Promise<void> {
    if (this.draining.has(binding.scopeId)) return;
    this.draining.add(binding.scopeId);
    try {
      const d = this.dependencies;
      if (!(await d.admitted(binding))) return;
      const pending = await d.store.pendingOutbox(binding.scopeId);
      if (pending.status !== 'ok' || !Array.isArray(pending.items)) return;
      for (const item of pending.items) {
        if (!(await d.admitted(binding))) return;
        if (item.session_id !== binding.sessionId || typeof item.payload?.proposal_id !== 'string') continue;
        const proposalId = item.payload.proposal_id;
        if (item.kind === 'proposal_apply') {
          await d.store.apply(binding.scopeId, proposalId);
          continue;
        }
        if (
          item.kind !== 'approval_preview' ||
          !validChange(item.payload.change) ||
          typeof item.payload.confirmation_token !== 'string' ||
          !/^[A-Za-z0-9_-]{32}$/.test(item.payload.confirmation_token)
        )
          continue;
        const expiresAt = new Date(item.expires_at).toISOString();
        if (Date.parse(expiresAt) <= Date.now()) continue;
        const change = item.payload.change,
          token = item.payload.confirmation_token;
        const json = JSON.stringify(change, null, 2);
        // User-supplied markdown cannot terminate the exact-value block.
        const fence = '`'.repeat(Math.max(3, ...[...json.matchAll(/`+/g)].map((match) => match[0].length + 1)));
        const text = `Proposed internal change — awaiting your approval.\n\n${fence}json\n${json}\n${fence}\n\nProposal: ${proposalId}\nChange digest: ${digest(change)}\nExpires: ${expiresAt}\n\nTo approve, send exactly:\ncos approve ${proposalId} ${token}\n\nTo reject, send exactly:\ncos reject ${proposalId} ${token}`;
        if (
          await d.preview(binding, {
            id: 'cos-' + proposalId,
            proposalId,
            token,
            change,
            expiresAt,
            sessionId: item.session_id,
            text,
          })
        )
          await d.store.acknowledgePreview(binding.scopeId, item.id);
      }
    } finally {
      this.draining.delete(binding.scopeId);
    }
  }
}
