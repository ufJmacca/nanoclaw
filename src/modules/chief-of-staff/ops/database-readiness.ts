import { DatabaseConfigurationError } from '../store/config.js';
import { DatabasePreflightError } from '../store/preflight.js';
/** Diagnostics are fixed stages, never driver messages, environment values or connection objects. */
export function databaseReadiness(error: unknown) {
  if (error === null) return { state: 'READY', currentAuthority: 'checked', privateContent: 'requires_scope_check' };
  const state =
    error === 'reconciling'
      ? 'RECONCILING'
      : error instanceof DatabaseConfigurationError
        ? error.phase
        : error instanceof DatabasePreflightError
          ? error.stage
          : 'UNAVAILABLE';
  return { state, currentAuthority: 'unavailable', privateContent: 'withheld' };
}
