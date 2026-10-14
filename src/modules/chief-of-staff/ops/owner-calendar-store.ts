import { CalendarStore } from '../calendar/store.js';

/** Trusted native-owner administration only; runtime stores continue to require an active scope.
 * The enclosing admin command verifies paused native ownership, private membership and maintenance.
 * No command changes the database scope status or grants model admission.
 */
export class OwnerCalendarStore extends CalendarStore {
  protected readonly ownerAdministration = true;
}
