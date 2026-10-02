import { expect, it, vi } from 'vitest';
import { RestrictedExecutionProbe } from './native-execution.js';
const id = 'a'.repeat(64),
  other = 'b'.repeat(64),
  directory = '/fixture/sessions/main';
function fixture() {
  let rows = [
    {
      Id: id,
      Labels: { 'nanoclaw-install': 'install' },
      State: { Status: 'running' },
      Mounts: [{ Type: 'bind', Source: directory, Destination: '/workspace' }],
    },
  ];
  const command = vi.fn((args: string[]) =>
    args[0] === 'ps'
      ? rows.map((r) => r.Id).join('\n')
      : args[0] === 'inspect'
        ? rows.map((r) => JSON.stringify(r)).join('\n')
        : '',
  );
  return {
    command,
    probe: new RestrictedExecutionProbe('install', command),
    rows: () => rows,
    setRows: (next: typeof rows) => {
      rows = next;
    },
  };
}
it('S05-T06 sees an untracked container by installation and exact session workspace', () => {
  const f = fixture();
  expect(f.probe.present(directory)).toBe(true);
  f.setRows([
    {
      ...f.rows()[0],
      Id: other,
      Mounts: [{ Type: 'bind', Source: directory + '-sibling', Destination: '/workspace' }],
    },
  ]);
  expect(f.probe.present(directory)).toBe(false);
  expect(f.command).toHaveBeenCalledWith(expect.arrayContaining(['label=nanoclaw-install=install']));
});
it('S05-T06 stops only matching immutable container IDs and requires a separate absence check', () => {
  const f = fixture();
  f.setRows([
    ...f.rows(),
    { ...f.rows()[0], Id: other, Mounts: [{ Type: 'bind', Source: '/unrelated', Destination: '/workspace' }] },
  ]);
  f.probe.stop(directory);
  expect(f.command).toHaveBeenCalledWith(['stop', '-t', '1', id]);
  expect(f.command).not.toHaveBeenCalledWith(['stop', '-t', '1', other]);
  expect(f.probe.present(directory)).toBe(true);
  f.setRows([]);
  expect(f.probe.present(directory)).toBe(false);
});
it.each(['unavailable', 'malformed', 'foreign-label', 'missing-row', 'unknown-state'])(
  'S05-T10 %s cannot prove native absence or authorize a broad stop',
  (failure) => {
    const f = fixture();
    if (failure === 'unavailable')
      f.command.mockImplementation(() => {
        throw Error('offline');
      });
    if (failure === 'malformed') f.command.mockImplementation((args) => (args[0] === 'ps' ? id : 'invalid'));
    if (failure === 'foreign-label') f.setRows([{ ...f.rows()[0], Labels: { 'nanoclaw-install': 'foreign' } }]);
    if (failure === 'missing-row') f.command.mockImplementation((args) => (args[0] === 'ps' ? id : ''));
    if (failure === 'unknown-state') f.setRows([{ ...f.rows()[0], State: { Status: 'unexpected' } }]);
    expect(f.probe.present(directory)).toBe(true);
    expect(() => f.probe.stop(directory)).toThrow();
    expect(f.command.mock.calls.some(([args]) => args[0] === 'stop')).toBe(false);
  },
);
it.each(['created', 'restarting', 'paused', 'running', 'removing'])(
  'S05-T06 %s remains execution-present',
  (status) => {
    const f = fixture();
    f.setRows([{ ...f.rows()[0], State: { Status: status } }]);
    expect(f.probe.present(directory)).toBe(true);
  },
);
it.each(['exited', 'dead'])('S05-T06 verified %s container does not remain executable', (status) => {
  const f = fixture();
  f.setRows([{ ...f.rows()[0], State: { Status: status } }]);
  expect(f.probe.present(directory)).toBe(false);
});
