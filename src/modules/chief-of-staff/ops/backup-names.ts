/** Portable provider-history segments may start with one dot followed by an
 * alphanumeric character. Empty, dot, dot-dot and separator segments stay invalid. */
export const validBackupPathSegment = (name: string): boolean =>
  /^(?:[A-Za-z0-9]|\.[A-Za-z0-9])[A-Za-z0-9_.-]*$/.test(name);
