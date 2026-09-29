import { readEnvFile } from './env.js';

const SYSTEM_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'TZ',
  'TERM',
];
const PROVIDER_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'CODEX_MODEL',
  'CODEX_REASONING_EFFORT',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
];
const DOCKER_KEYS = ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY'];
const DATABASE_SECRET_KEYS = [
  'COS_MODEL_API_KEY',
  'COS_PGPASSWORD',
  'COS_PG_MIGRATION_PASSWORD',
  'COS_TEST_PGPASSWORD',
  'COS_TEST_PG_MIGRATION_PASSWORD',
  'PGPASSWORD',
  'DATABASE_URL',
];

export function isDatabaseEnvironmentKey(key: string): boolean {
  return /^(?:COS_MODEL_|COS_PG|COS_TEST_PG|COS_TEST_TARGET_ID$|PG|DATABASE_URL$)/i.test(key);
}

export function databaseSecretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const file = readEnvFile(DATABASE_SECRET_KEYS);
  return [
    ...new Set(
      [...DATABASE_SECRET_KEYS.map((key) => env[key]), ...Object.values(file)].filter((value): value is string =>
        Boolean(value),
      ),
    ),
  ];
}

export function safeHostEnvironment(
  kind: 'provider' | 'docker',
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allowed = new Set([...SYSTEM_KEYS, ...(kind === 'provider' ? PROVIDER_KEYS : DOCKER_KEYS)]);
  const secrets = databaseSecretValues(env);
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key, value]) => allowed.has(key) && value !== undefined && !secrets.some((secret) => value.includes(secret)),
    ),
  );
}

/** Reject rather than silently redact an agent-authored configuration. */
export function assertNoDatabaseMaterial(value: unknown): void {
  const inspect = (node: unknown): boolean => {
    if (!node || typeof node !== 'object') return false;
    return Object.entries(node).some(([key, child]) => isDatabaseEnvironmentKey(key) || inspect(child));
  };
  const serialized = JSON.stringify(value) ?? '';
  if (inspect(value) || databaseSecretValues().some((secret) => serialized.includes(secret))) {
    throw new Error('Database configuration must remain in trusted host processes');
  }
}

export function assertNoDatabaseLaunchArguments(args: string[]): void {
  assertNoDatabaseMaterial(args);
  if (
    args.some((arg) =>
      /(?:^|[\s"'])((?:COS_MODEL_|COS_(?:TEST_)?PG|COS_TEST_TARGET_ID|PG|DATABASE_URL)[A-Z0-9_]*)(?:=|$)/i.test(arg),
    )
  ) {
    throw new Error('Database configuration cannot enter container launch arguments');
  }
}
