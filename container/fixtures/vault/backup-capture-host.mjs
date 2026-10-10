// Only manager observations and PostgreSQL are fixtures. The encrypted queue,
// native leases, memory guards, mount inspection and capture producers are real.
import assert from 'node:assert/strict';
import { MIGRATIONS } from '../../../src/modules/chief-of-staff/store/migrations.js';
export { targetBinding } from '../../../src/modules/chief-of-staff/ops/target-host.js';
export const captureHostFixture = { scopeId: '', ownerId: '', agentGroupId: '', connections: 0 };
export const targetCommands = (settings) => ({
  observe: async () => ({ pid: 0, cwd: settings.installationRoot, activeState: 'inactive' }),
  ownedContainers: async () => [],
});
export async function checkedTargetDatabase() {
  assert.equal(process.getuid(), 1000);
  captureHostFixture.connections++;
  return {
    async query(sql, parameters) {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      if (sql.includes('to_regclass')) return { rows: [{ ledger: 'cos.schema_migrations' }] };
      if (sql.includes('FROM cos.schema_migrations'))
        return { rows: MIGRATIONS.map(({ version, checksum }) => ({ version, checksum })) };
      if (sql.includes('SELECT owner_id,agent_group_id'))
        return { rows: [{ owner_id: captureHostFixture.ownerId, agent_group_id: captureHostFixture.agentGroupId }] };
      if (sql.includes('FROM pg_attribute'))
        return {
          rows: (parameters?.[0] === 'cos.scopes' ? ['id', 'owner_id', 'agent_group_id'] : ['scope_id']).map(
            (attname) => ({ attname }),
          ),
        };
      if (sql.includes('to_jsonb(t)'))
        return {
          rows: sql.includes('cos."scopes"')
            ? [
                {
                  body: {
                    id: captureHostFixture.scopeId,
                    owner_id: captureHostFixture.ownerId,
                    agent_group_id: captureHostFixture.agentGroupId,
                  },
                },
              ]
            : [],
        };
      if (sql.includes('clock_timestamp')) return { rows: [{ now: new Date() }] };
      return { rows: [] };
    },
    async end() {},
  };
}
