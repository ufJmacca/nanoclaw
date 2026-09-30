import type { Migration } from './index.js';
import { ensureConversationSchema } from '../../modules/chief-of-staff/bridge/conversation-state.js';
import { ensureModelBudget } from '../../modules/chief-of-staff/bridge/model-policy.js';
export const migration022: Migration = {
  version: 22,
  name: 'cos-subscription-context',
  up(db) {
    ensureModelBudget(db);
    ensureConversationSchema(db);
  },
};
