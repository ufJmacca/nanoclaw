import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
  service: vi.fn(),
  mission: vi.fn(),
  connect: vi.fn(),
  authority: vi.fn(),
  actionAuthority: vi.fn(),
  draftAuthority: vi.fn(),
  reviewAuthority: vi.fn(),
  mailPoll: vi.fn(),
  mailRetention: vi.fn(),
  tick: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  release: vi.fn(() => false),
  maintenance: vi.fn(),
  maintenanceConnect: vi.fn(),
  maintenanceTick: vi.fn(async () => {}),
  maintenanceClose: vi.fn(async () => {}),
}));
vi.mock('../../env.js', () => ({
  readEnvFile: () => ({ COS_ENABLED: 'true', COS_TARGET_STATE_DIR: '/fixture/target' }),
}));
vi.mock('../../release-runtime.js', () => ({ releaseMode: f.release }));
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
vi.mock('./host-store.js', () => ({
  connectCosHostStore: f.connect,
  connectCosMailMaintenanceStore: f.maintenanceConnect,
}));
vi.mock('./mail/maintenance.js', () => ({
  mailMaintenanceContexts: () => () => [],
  MailMaintenance: class {
    constructor(options: unknown) {
      f.maintenance(options);
    }
    tick = f.maintenanceTick;
    close = f.maintenanceClose;
  },
}));
vi.mock('./missions/authority.js', () => ({
  createMissionAuthorityResolver: () => f.authority,
  createActionAuthorityResolver: () => f.actionAuthority,
  createMailDraftAuthorityResolver: () => f.draftAuthority,
  createMailReviewAuthorityResolver: () => f.reviewAuthority,
}));
vi.mock('./mail/authority.js', () => ({
  createMailAuthorities: () => ({ poll: f.mailPoll, retention: f.mailRetention }),
}));
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
  f.release.mockReturnValue(false);
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
  const runs = { fixture: 'checked-pool' },
    teams = { fixture: 'same-checked-pool' };
  options.specialists({ missionRuns: runs, teamRuns: teams });
  expect(f.mission).toHaveBeenCalledWith(
    expect.objectContaining({
      root: '/fixture/target',
      runs,
      teams,
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
    undefined,
    f.actionAuthority,
    f.mailPoll,
    f.draftAuthority,
    f.reviewAuthority,
  );
});
it('G05 selects its separate disabled-by-default switch and passes only native main draft authority', async () => {
  vi.stubEnv('COS_MAIL_ENABLED', 'true');
  vi.stubEnv('COS_MAIL_DRAFTS_ENABLED', 'true');
  host = startCosHostModule(vi.fn());
  const options = f.service.mock.calls[0][0];
  await options.connect();
  expect(f.connect.mock.calls[0][0].COS_MAIL_DRAFTS_ENABLED).toBe('true');
  expect(f.connect.mock.calls[0][9]).toBe(f.draftAuthority);
});
it('G06 supplies a separate native review authority without widening draft or specialist authority', async () => {
  host = startCosHostModule(vi.fn());
  await f.service.mock.calls[0][0].connect();
  expect(f.connect.mock.calls[0][4]).toBe(f.authority);
  expect(f.connect.mock.calls[0][9]).toBe(f.draftAuthority);
  expect(f.connect.mock.calls[0][10]).toBe(f.reviewAuthority);
  expect(f.reviewAuthority).not.toBe(f.draftAuthority);
  expect(f.reviewAuthority).not.toBe(f.authority);
});
it('G04 selects the mail switch and separates native poll and retention authority without model consent', async () => {
  vi.stubEnv('COS_MAIL_ENABLED', 'true');
  const assertHostAuthority = vi.fn();
  host = startCosHostModule(assertHostAuthority);
  const options = f.service.mock.calls[0][0];
  expect(options.mailAuthority).toEqual({ poll: f.mailPoll, retention: f.mailRetention });
  await options.connect();
  expect(f.connect.mock.calls[0][0].COS_MAIL_ENABLED).toBe('true');
  expect(f.connect.mock.calls[0][8]).toBe(f.mailPoll);
  expect(options.admission()).toBe(true);
  expect(assertHostAuthority).toHaveBeenCalled();
  assertHostAuthority.mockImplementation(() => {
    throw Error('PRIVATE_HOST_LEASE_LOSS');
  });
  expect(options.admission()).toBe(false);
});
it('G04 gives an installed globally disabled host a separate maintenance owner without enabling the runtime', async () => {
  vi.stubEnv('COS_ENABLED', 'false');
  vi.stubEnv('COS_MAIL_ENABLED', 'true');
  f.release.mockReturnValue(true);
  host = startCosHostModule(vi.fn());
  expect(f.service.mock.calls[0][0].enabled).toBe(false);
  expect(f.maintenance).toHaveBeenCalledOnce();
  expect(f.maintenanceTick).toHaveBeenCalledOnce();
  const options = f.maintenance.mock.calls[0][0];
  expect(options.authority).toEqual({ poll: f.mailPoll, retention: f.mailRetention });
  await options.connect();
  expect(f.maintenanceConnect).toHaveBeenCalledWith(
    expect.objectContaining({ COS_ENABLED: 'false' }),
    expect.any(Object),
    options.admitted,
  );
  expect(f.connect).not.toHaveBeenCalled();
  await host.stop();
  host = undefined;
  expect(f.maintenanceClose).toHaveBeenCalledOnce();
  expect(f.stop).toHaveBeenCalledOnce();
});
