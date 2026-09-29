import pg from 'pg';
import { parseDatabaseConfig, verifyExternalHost } from './config.js';

export class DatabasePreflightError extends Error {
  constructor(readonly code: string) {
    super(`CoS preflight: ${code}`);
  }
}

export async function connectChecked(
  env: NodeJS.ProcessEnv,
  profile: 'runtime' | 'test',
  login: 'runtime' | 'migration' = 'runtime',
): Promise<pg.Client> {
  const config = parseDatabaseConfig(env, profile, login);
  await verifyExternalHost(config.host!);
  const client = new pg.Client(config);
  client.on('error', () => {});
  try {
    await client.connect();
    const { rows } = await client.query(`SELECT current_setting('server_version_num')::integer AS version,
      (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls,
      has_schema_privilege(current_user,'cos','USAGE') AS usage,
      has_schema_privilege(current_user,'cos','CREATE') AS create_schema_objects,
      has_database_privilege(current_user,current_database(),'CREATE') AS create_schemas,
      pg_has_role(current_user,(SELECT nspowner FROM pg_namespace WHERE nspname='cos'),'MEMBER') AS owner_member,
      rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user`);
    const row = rows[0];
    if (!row || row.version < 140000 || row.version >= 190000) throw new DatabasePreflightError('unsupported_server');
    if (config.ssl && !row.tls) throw new DatabasePreflightError('tls_required');
    if (!row.usage || row.rolsuper || row.rolcreatedb || row.rolcreaterole || row.create_schemas)
      throw new DatabasePreflightError('unsafe_role');
    if (login === 'runtime' && (row.create_schema_objects || row.owner_member))
      throw new DatabasePreflightError('runtime_can_migrate');
    if (login === 'migration' && !row.create_schema_objects)
      throw new DatabasePreflightError('migration_role_required');
    if (profile === 'test') await assertTestTarget(client, env.COS_TEST_TARGET_ID);
    return client;
  } catch (error) {
    await client.end();
    if (error instanceof DatabasePreflightError) throw error;
    throw new DatabasePreflightError('connection_failed');
  }
}

export async function assertTestTarget(client: Pick<pg.Client, 'query'>, expected: string | undefined): Promise<void> {
  if (!expected) throw new DatabasePreflightError('test_marker_required');
  const { rows } = await client.query(`SELECT target_id,purpose,
    has_table_privilege(current_user,'cos_admin.target_identity','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') AS writable,
    has_schema_privilege(current_user,'cos_admin','CREATE') AS schema_writable,
    pg_has_role(current_user,(SELECT relowner FROM pg_class WHERE oid='cos_admin.target_identity'::regclass),'MEMBER') AS owner_member
    FROM cos_admin.target_identity`);
  if (
    rows.length !== 1 ||
    rows[0].target_id !== expected ||
    rows[0].purpose !== 'test' ||
    rows[0].writable ||
    rows[0].schema_writable ||
    rows[0].owner_member
  ) {
    throw new DatabasePreflightError('test_target_not_admitted');
  }
}
