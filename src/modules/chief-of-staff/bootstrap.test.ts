import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
  service: vi.fn(),
  mission: vi.fn(),
  connect: vi.fn(),
  authority: vi.fn(),
  tick: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
}));
vi.mock('../../env.js', () => ({
  readEnvFile: () => ({ COS_ENABLED: 'true', COS_TARGET_STATE_DIR: '/fixture/target' }),
}));
vi.mock('../../release-runtime.js', () => ({ releaseMode: () => false }));
vi.mock('./ops/target-identity.js', () => ({ localTarget: () => ({ binding: {} }) }));
vi.mock('./ops/maintenance.js', () => ({ admittedGeneration: () => 'fixture' }));
vi.mock('../../install-slug.js', async () => ({
  ...(await vi.importActual('../../install-slug.js')),
  getInstallSlug: () => 'fixture',
}));
vi.mock('../../container-runner.js', () => ({
  killContainer: vi.fn(),
  wakeContainer: vi.fn(),
  hasContainerExecution: vi.fn(() => false),
}));
vi.mock('./host-store.js', () => ({ connectCosHostStore: f.connect }));
vi.mock('./missions/authority.js', () => ({ createMissionAuthorityResolver: () => f.authority }));
vi.mock('./bridge/coordinator-launcher.js', () => ({ createCoordinatorLauncher: () => ({ close: f.close }) }));
vi.mock('./service.js', () => ({
  CosService: class {
    constructor(options: unknown) {
      f.service(options);
    }
    tick = f.tick;
    stop = f.stop;
  },
}));
vi.mock('./missions/host.js', () => ({
  MissionHost: class {
    constructor(options: unknown) {
      f.mission(options);
    }
  },
}));
import { initTestDb, closeDb } from '../../db/connection.js';
import { wakeContainer } from '../../container-runner.js';
import { startCosHostModule } from './bootstrap.js';
let host: ReturnType<typeof startCosHostModule> | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  initTestDb();
  vi.stubEnv('COS_ENABLED', 'true');
  vi.stubEnv('COS_TARGET_STATE_DIR', '/fixture/target');
});
afterEach(async () => {
  await host?.stop();
  host = undefined;
  closeDb();
  vi.unstubAllEnvs();
});
it('S05 production bootstrap creates specialists from the checked service store with native wake and current authority', async () => {
  const assertHostAuthority = vi.fn();
  host = startCosHostModule(assertHostAuthority);
  const options = f.service.mock.calls[0][0];
  expect(f.mission).not.toHaveBeenCalled();
  expect(options.specialists).toBeTypeOf('function');
  const runs = { fixture: 'checked-pool' };
  options.specialists({ missionRuns: runs });
  expect(f.mission).toHaveBeenCalledWith(
    expect.objectContaining({
      root: '/fixture/target',
      runs,
      authority: f.authority,
      assertHostAuthority,
      admitted: options.admission,
      facts: options.facts,
      wake: wakeContainer,
      running: expect.any(Function),
      stop: expect.any(Function),
    }),
  );
  await options.connect();
  expect(f.connect).toHaveBeenCalledWith(
    expect.any(Object),
    expect.any(Object),
    options.admission,
    {},
    f.authority,
    expect.any(Function),
  );
});
