import { validActionId } from '../contracts/action-protocol.js';
import { digest } from '../domain/contracts.js';
import { object, hasCalendarControl } from '../calendar/normalization.js';
export const ACTION_NOTICE_STATES = ['verified', 'blocked', 'failed', 'outcome_uncertain', 'cancelled'] as const;
export type ActionNoticeState = (typeof ACTION_NOTICE_STATES)[number];
export type ActionNotification = {
  format: 'cos-action-notification/v1';
  scopeId: string;
  ownerId: string;
  sessionId: string;
  agentGroupId: string;
  instanceId: string;
  channelId: string;
  actionId: string;
  intentDigest: string;
  state: ActionNoticeState;
  textDigest: string;
};
const fields = [
  'format',
  'scopeId',
  'ownerId',
  'sessionId',
  'agentGroupId',
  'instanceId',
  'channelId',
  'actionId',
  'intentDigest',
  'state',
  'textDigest',
];
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function validActionNotification(value: unknown): value is ActionNotification {
  return (
    object(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((key) => Object.hasOwn(value, key)) &&
    value.format === 'cos-action-notification/v1' &&
    validActionId(value.actionId) &&
    hash(value.intentDigest) &&
    hash(value.textDigest) &&
    ACTION_NOTICE_STATES.includes(value.state as ActionNoticeState) &&
    ['scopeId', 'ownerId', 'sessionId', 'agentGroupId', 'instanceId', 'channelId'].every(
      (key) =>
        typeof value[key] === 'string' &&
        value[key].length > 0 &&
        value[key].length <= 256 &&
        !hasCalendarControl(value[key]),
    )
  );
}
export function actionNotificationId(value: ActionNotification): string {
  if (!validActionNotification(value)) throw new Error('unsafe_action_notification');
  return 'cos-action-' + digest({ actionId: value.actionId, intentDigest: value.intentDigest, state: value.state });
}
