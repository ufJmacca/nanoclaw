import type { MailStore } from './store.js';
import type { MailConnector } from './connector.js';
import type { MailHostFences } from './config.js';
/** A lost final proof is terminal only after the pinned resource lifetime settled. */
export async function closeMailProfile(resource: MailHostFences): Promise<void> {
  try {
    await resource.close();
  } catch (error) {
    if (!(error instanceof Error && error.message === 'mail_configuration_unavailable' && resource.closed())) {
      // eslint-disable-next-line preserve-caught-error -- Private resource diagnostics are not an operational or model response.
      throw Error('mail_host_retirement_unavailable');
    }
  }
}
/** Trusted host ownership, never an RPC capability or model admission grant. */
export class MailHost {
  readonly store: MailStore;
  readonly connector?: MailConnector;
  readonly resource?: MailHostFences;
  private fenced = false;
  private retired = false;
  private closing?: Promise<void>;
  constructor(options: { store: MailStore; connector?: MailConnector; resource?: MailHostFences }) {
    this.store = options.store;
    this.connector = options.connector;
    this.resource = options.resource;
  }
  active(): boolean {
    return !this.fenced && !!this.connector;
  }
  async close(): Promise<void> {
    if (this.retired) return;
    if (this.closing) return this.closing;
    this.fenced = true;
    const work = this.retire();
    this.closing = work;
    try {
      await work;
      this.retired = true;
    } finally {
      if (this.closing === work) this.closing = undefined;
    }
  }
  private async retire(): Promise<void> {
    await this.connector?.close();
    if (!this.resource) return;
    await closeMailProfile(this.resource);
  }
}
