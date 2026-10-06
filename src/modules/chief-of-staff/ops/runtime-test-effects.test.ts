import { expect, it } from 'vitest';
import { selectCosTestContainers, runtimeTestSchemaCompatible } from './runtime-test-effects.js';
import { fixtureRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
it('S11-PG02 the installed verified release defines runtime fixture schema compatibility', () => {
  expect(runtimeTestSchemaCompatible(fixtureRelease('S10'), 18)).toBe(true);
  expect(runtimeTestSchemaCompatible(fixtureRelease('S10'), 1)).toBe(false);
  expect(runtimeTestSchemaCompatible(fixtureRelease('S10'), 19)).toBe(false);
  expect(runtimeTestSchemaCompatible(fixtureRelease('S01'), 18)).toBe(false);
  expect(runtimeTestSchemaCompatible(undefined, 18)).toBe(false);
});
const worker = {
  Id: '1'.repeat(64),
  Name: '/nanoclaw-cos-fixture',
  State: { Running: true },
  Config: {
    Labels: { 'nanoclaw-install': 'fixture-install', 'nanoclaw.cos-protocol': 'cos-rpc/v1' },
    Env: ['NANOCLAW_COS_PROTOCOL=cos-rpc/v1'],
  },
};
it('selects only this installation’s explicitly labelled CoS workers, preserving ordinary containers', () => {
  const ordinary = {
    ...worker,
    Id: '2'.repeat(64),
    Name: '/nanoclaw-ordinary',
    Config: { Labels: { 'nanoclaw-install': 'fixture-install' }, Env: [] },
  };
  expect(selectCosTestContainers([ordinary, worker], 'fixture-install')).toEqual([worker.Id]);
  expect(selectCosTestContainers([{ ...worker, State: { Running: false } }], 'fixture-install')).toEqual([]);
});
it('refuses changed installation identity, unknown protocols and ambiguous CoS workers', () => {
  const unknown = {
    ...worker,
    Config: { ...worker.Config, Labels: { ...worker.Config.Labels, 'nanoclaw.cos-protocol': 'unknown' } },
  };
  const ambiguous = { ...worker, Config: { ...worker.Config, Labels: { 'nanoclaw-install': 'fixture-install' } } };
  expect(() => selectCosTestContainers([worker], 'different-install')).toThrow('unexpected_owned_container');
  expect(() => selectCosTestContainers([unknown], 'fixture-install')).toThrow('unexpected_owned_container');
  expect(() => selectCosTestContainers([ambiguous], 'fixture-install')).toThrow('unexpected_owned_container');
});
