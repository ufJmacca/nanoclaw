import { hasCalendarControl, object } from '../calendar/normalization.js';
import { digest } from '../domain/contracts.js';
import { GOOGLE_CALENDAR_METADATA_SCOPE, GOOGLE_OWNED_EVENT_WRITE_SCOPE, type CalendarWriterAccess } from './writer.js';

/** Credentials stay in the host vault. This immutable revision records separately granted writer consent. */
export type ActionWriterBinding = {
  format: 'cos-calendar-writer/v1';
  provider: 'google' | 'fixture';
  calendarId: string;
  accountFingerprint: string;
  credentialGeneration: string;
  instanceId: string;
  channelId: string;
  bindingDigest: string;
  processingProvider: 'codex';
  restoreProofDigest: string;
  scopes: string[];
};
const opaque = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 1024 &&
  !hasCalendarControl(value) &&
  !/\s/u.test(value) &&
  !['.', '..'].includes(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function validWriterBinding(value: unknown): value is ActionWriterBinding {
  const fields = [
    'format',
    'provider',
    'calendarId',
    'accountFingerprint',
    'credentialGeneration',
    'instanceId',
    'channelId',
    'bindingDigest',
    'processingProvider',
    'restoreProofDigest',
    'scopes',
  ];
  return (
    object(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((key) => Object.hasOwn(value, key)) &&
    value.format === 'cos-calendar-writer/v1' &&
    ['google', 'fixture'].includes(String(value.provider)) &&
    opaque(value.calendarId) &&
    value.calendarId.toLowerCase() !== 'primary' &&
    hash(value.accountFingerprint) &&
    opaque(value.credentialGeneration) &&
    value.credentialGeneration.length <= 200 &&
    opaque(value.instanceId) &&
    opaque(value.channelId) &&
    hash(value.bindingDigest) &&
    value.processingProvider === 'codex' &&
    hash(value.restoreProofDigest) &&
    Array.isArray(value.scopes) &&
    value.scopes.length === 2 &&
    new Set(value.scopes).size === 2 &&
    value.scopes.includes(GOOGLE_OWNED_EVENT_WRITE_SCOPE) &&
    value.scopes.includes(GOOGLE_CALENDAR_METADATA_SCOPE)
  );
}
export function writerAccessMatches(binding: ActionWriterBinding, access: CalendarWriterAccess): boolean {
  return (
    access.auth === 'ready' &&
    access.writeEnabled === true &&
    access.calendarId === binding.calendarId &&
    access.accountFingerprint === binding.accountFingerprint &&
    access.generation === binding.credentialGeneration &&
    digest([...access.scopes].sort()) === digest([...binding.scopes].sort())
  );
}
