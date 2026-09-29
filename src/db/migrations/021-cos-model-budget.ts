import type { Migration } from './index.js';
import { ensureModelBudget } from '../../modules/chief-of-staff/bridge/model-policy.js';
export const migration021: Migration = { version: 21, name: 'cos-model-budget', up: ensureModelBudget };
