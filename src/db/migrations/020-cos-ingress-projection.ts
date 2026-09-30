import type { Migration } from './index.js';
import { ensureCosIngressProjectionSchema } from '../../cos-boundary.js';
export const migration020: Migration = {
  version: 20,
  name: 'cos-ingress-projection',
  up: ensureCosIngressProjectionSchema,
};
