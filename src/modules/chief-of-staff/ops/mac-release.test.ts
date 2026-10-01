import { expect, it } from 'vitest';
import {
  completeLocalRelease,
  selectTestEnvironment,
  selectRuntimeEnvironment,
  checkpointLocalExecution,
  readLocalExecution,
} from './mac-release.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPrivate } from './target-state.js';
import { fixtureRelease } from '../../../contracts/chief-of-staff/release-fixture.js';

it('preserves a large programme ledger while accepting an active S01 alignment correction', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-release-ledger-'));
  try {
    const ledger = {
      active_slice: 'S01',
      slices: [
        { id: 'S01', implementation_status: 'alignment_in_progress' },
        { id: 'S02', implementation_status: 'not_started' },
      ],
      prior_evidence: 'x'.repeat(70000),
      unknown: { preserved: true },
    };
    const file = path.join(root, 'execution.json');
    fs.writeFileSync(file, JSON.stringify(ledger), { mode: 0o600 });
    expect(readLocalExecution(root, true)).toEqual(ledger);
    checkpointLocalExecution(root, { release_status: 'local_checks_pending' });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({
      ...ledger,
      slices: [
        { id: 'S01', implementation_status: 'alignment_in_progress', release_status: 'local_checks_pending' },
        ledger.slices[1],
      ],
    });
    expect(() => readPrivate(file)).toThrow('unsafe_target_state');
    fs.chmodSync(file, 0o644);
    expect(() => readLocalExecution(root)).toThrow('unsafe_target_state');
    fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, JSON.stringify({ ...ledger, slices: [{ id: 'S01', implementation_status: 'complete' }] }));
    expect(() => readLocalExecution(root, true)).toThrow('active_slice_required');
    fs.writeFileSync(file, JSON.stringify({ ...ledger, active_slice: 'S02' }));
    expect(() => readLocalExecution(root, true)).toThrow('active_slice_required');
    fs.writeFileSync(file, JSON.stringify({ ...ledger, prior_evidence: 'x'.repeat(1024 * 1024) }));
    expect(() => readLocalExecution(root)).toThrow('unsafe_target_state');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('cannot produce a transferable manifest from failed, missing or differently built checks', () => {
  const manifest = fixtureRelease();
  expect(completeLocalRelease(manifest, manifest.checks)).toEqual(manifest);
  const failed = structuredClone(manifest.checks);
  failed.slice.status = 'failed';
  expect(() => completeLocalRelease(manifest, failed)).toThrow('release_not_transferable');
  const stale = structuredClone(manifest.checks);
  stale.host_image.sourceCommit = '9'.repeat(40);
  expect(() => completeLocalRelease(manifest, stale)).toThrow('release_not_transferable');
  const rebuilt = structuredClone(manifest.checks);
  rebuilt.agent_image.imageIds[0] = 'sha256:' + '9'.repeat(64);
  expect(() => completeLocalRelease(manifest, rebuilt)).toThrow('release_not_transferable');
  expect(() => completeLocalRelease(manifest, {})).toThrow('release_not_transferable');
});

it('exports only the explicitly selected test profile and refuses unsafe env-file values', () => {
  const input = {
    COS_TEST_PGHOST: 'db.example.test',
    COS_TEST_PGPORT: '5432',
    COS_TEST_PGDATABASE: 'fixture',
    COS_TEST_PGUSER: 'fixture_user',
    COS_TEST_PGPASSWORD: 'fixture-pass$with`literal`quotes',
    COS_TEST_PGSSLMODE: 'verify-full',
    COS_TEST_PGSSLROOTCERT: '/private/local/ca.pem',
    COS_TEST_PG_MIGRATION_USER: 'fixture_migration',
    COS_TEST_PG_MIGRATION_PASSWORD: 'fixture-admin',
    COS_TEST_TARGET_ID: 'fixture-marker',
    COS_TEST_PGUNRECOGNIZED: 'must-not-export',
    COS_PGPASSWORD: 'runtime-must-not-export',
    MATTERMOST_TOKEN: 'bot-must-not-export',
    OPENAI_API_KEY: 'model-must-not-export',
  };
  const selected = selectTestEnvironment(input, '/fixture/certificate.pem');
  expect(Object.keys(selected).sort()).toEqual(
    Object.keys(input)
      .filter(
        (key) => !['COS_TEST_PGUNRECOGNIZED', 'COS_PGPASSWORD', 'MATTERMOST_TOKEN', 'OPENAI_API_KEY'].includes(key),
      )
      .sort(),
  );
  expect(selected.COS_TEST_PGSSLROOTCERT).toBe('/fixture/certificate.pem');
  expect(selected.COS_TEST_PGPASSWORD).toBe(input.COS_TEST_PGPASSWORD);
  expect(() =>
    selectTestEnvironment({ ...input, COS_TEST_PGPASSWORD: 'line\nbreak' }, '/fixture/certificate.pem'),
  ).toThrow('unsafe_test_environment');
  expect(() => selectTestEnvironment({}, '/fixture/certificate.pem')).toThrow('test_profile_incomplete');
});
it('selects runtime credentials separately without inheriting a test marker or another account', () => {
  const env = {
    COS_PGHOST: '192.168.50.10',
    COS_PGPORT: '5432',
    COS_PGDATABASE: 'fixture',
    COS_PGUSER: 'runtime',
    COS_PGPASSWORD: 'synthetic',
    COS_PGSSLMODE: 'verify-full',
    COS_PGSSLROOTCERT: '/original/ca.pem',
    COS_PG_MIGRATION_USER: 'migration',
    COS_PG_MIGRATION_PASSWORD: 'synthetic-admin',
    COS_TEST_PGPASSWORD: 'excluded',
    COS_TEST_TARGET_ID: 'excluded',
    MATTERMOST_BOT_TOKEN: 'excluded',
  };
  const selected = selectRuntimeEnvironment(env, '/fixture/ca.pem');
  expect(Object.keys(selected)).toHaveLength(9);
  expect(selected.COS_PGSSLROOTCERT).toBe('/fixture/ca.pem');
  expect(selected.COS_TEST_TARGET_ID).toBeUndefined();
  expect(selected.MATTERMOST_BOT_TOKEN).toBeUndefined();
});

it.each(['S02', 'S03', 'S04'])(
  '%s release checkpoints preserve reviewed predecessor evidence and reject an unfinished predecessor',
  (slice) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-s02-release-ledger-'));
    const source = 'a'.repeat(40);
    const prior = {
      id: slice === 'S02' ? 'S01' : slice === 'S03' ? 'S02' : 'S03',
      implementation_status: 'merged',
      review_status: 'human_merged',
      merged_sha: source,
      deployed_source_sha: source,
      merged_source_delivery_status: 'passed',
      pi_smoke_status: 'passed',
    };
    const ledger = {
      active_slice: slice,
      slices: [prior, { id: slice, implementation_status: 'in_progress' }],
      unknown: 'preserve',
    };
    const file = path.join(root, 'execution.json');
    const save = (value: unknown) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
    try {
      save(ledger);
      expect(readLocalExecution(root, true)).toEqual(ledger);
      checkpointLocalExecution(root, { release_status: 'local_checks_pending' });
      const updated = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(updated.slices[0]).toEqual(prior);
      expect(updated.slices[1].release_status).toBe('local_checks_pending');
      expect(updated.unknown).toBe('preserve');
      for (const patch of [
        { review_status: 'awaiting_review' },
        { deployed_source_sha: 'b'.repeat(40) },
        { pi_smoke_status: 'not_run' },
        { implementation_status: 'in_progress' },
      ]) {
        save({ ...ledger, slices: [{ ...prior, ...patch }, ledger.slices[1]] });
        expect(() => readLocalExecution(root, true)).toThrow('predecessor_acceptance_required');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
