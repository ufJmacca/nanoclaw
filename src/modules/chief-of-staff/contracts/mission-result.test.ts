import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validMissionResult, type MissionResult } from './mission-result.js';

const result = (): MissionResult => ({
  format: 'cos-research-result/v1',
  outcome: 'answer',
  claims: [
    {
      id: 'comparison',
      kind: 'inference',
      text: 'A has the smaller footprint.',
      citations: [{ source_id: 'note-a', revision_id: 'revision-a', ordinal: 0, start_line: 1, end_line: 2 }],
    },
  ],
  criteria: [{ id: 'tradeoffs', claim_ids: ['comparison'] }],
  limitations: ['Only the admitted notes were compared.'],
});

describe('S05-T03/T08 researcher result contract', () => {
  it('has one canonical host and worker schema', () => {
    expect(fs.readFileSync('container/agent-runner/src/mcp-tools/generated/mission-result.ts', 'utf8')).toBe(
      fs.readFileSync('src/modules/chief-of-staff/contracts/mission-result.ts', 'utf8'),
    );
  });
  it('accepts cited answers and honest partial or blocked submissions, without approving them', () => {
    expect(validMissionResult(result())).toBe(true);
    expect(
      validMissionResult({
        ...result(),
        outcome: 'partial',
        criteria: [...result().criteria, { id: 'missing', claim_ids: [] }],
      }),
    ).toBe(true);
    expect(
      validMissionResult({
        ...result(),
        outcome: 'blocked',
        claims: [],
        criteria: [{ id: 'tradeoffs', claim_ids: [] }],
      }),
    ).toBe(true);
  });
  it('rejects invented authority, completion, filesystem or destination fields', () => {
    for (const patch of [
      { approved: true },
      { outcome: 'completed' },
      { mission_id: 'other' },
      { owner_id: 'owner' },
      { destination: 'channel' },
      { artifact_path: '/private/secret' },
    ])
      expect(validMissionResult({ ...result(), ...patch })).toBe(false);
    expect(
      validMissionResult({ ...result(), criteria: [{ id: 'tradeoffs', claim_ids: ['comparison'], passed: true }] }),
    ).toBe(false);
  });
  it('requires bounded, valid Unicode text and actual UTF-8 byte accounting', () => {
    for (const text of ['', ' ', '\u0000', '\ud800', 'x'.repeat(2001)]) {
      const value = result();
      value.claims[0].text = text;
      expect(validMissionResult(value)).toBe(false);
    }
    const value = result();
    value.claims[0].text = '界'.repeat(1000);
    expect(validMissionResult(value, 1024)).toBe(false);
    expect(validMissionResult(value, 8192)).toBe(true);
    for (const bound of [0, 16385, Infinity, NaN, 512.5]) expect(validMissionResult(value, bound)).toBe(false);
  });
  it('rejects unbound, duplicated or missing claim references and incomplete answer claims', () => {
    for (const patch of [
      { claims: [] },
      { claims: [result().claims[0], result().claims[0]] },
      { criteria: [] },
      { criteria: [{ id: 'tradeoffs', claim_ids: [] }] },
      { criteria: [{ id: 'tradeoffs', claim_ids: ['unknown'] }] },
      { criteria: [{ id: 'tradeoffs', claim_ids: ['comparison', 'comparison'] }] },
      { criteria: [result().criteria[0], result().criteria[0]] },
      { outcome: 'blocked' },
      { outcome: 'partial', limitations: [] },
    ])
      expect(validMissionResult({ ...result(), ...patch })).toBe(false);
  });
  it('requires exact bounded source locators and one citation per quote', () => {
    const original = result().claims[0].citations[0];
    for (const patch of [
      { source_id: '../other' },
      { revision_id: '' },
      { ordinal: -1 },
      { start_line: 0 },
      { end_line: 0 },
      { end_line: 0.5 },
      { approved: true },
    ]) {
      const value = result();
      value.claims[0].citations = [{ ...original, ...patch }];
      expect(validMissionResult(value)).toBe(false);
    }
    const value = result();
    value.claims[0].citations = [original, original];
    expect(validMissionResult(value)).toBe(false);
    value.claims[0].kind = 'quote';
    value.claims[0].citations[1] = { ...original, source_id: 'note-b' };
    expect(validMissionResult(value)).toBe(false);
  });
});
