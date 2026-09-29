import type { Migration } from './index.js';
import { ensureCosBoundarySchema } from '../../cos-boundary.js';
export const migration019: Migration = { version: 19, name: 'cos-identity-boundary', up: ensureCosBoundarySchema };
