import type Database from 'better-sqlite3';
import type { Session } from '../../../types.js';
import { scheduledContext } from './scheduled-origin.js';
import { reviewContext } from '../missions/review-origin.js';
/** Conflicting retained tasks close the main context, including when either individual lease has expired. */
export function automationContext(session: Session, db: Database.Database, now = Date.now()) {
  const scheduled = scheduledContext(session, db, now),
    review = reviewContext(session, db, now);
  return scheduled !== undefined && review !== undefined ? null : review !== undefined ? review : scheduled;
}
