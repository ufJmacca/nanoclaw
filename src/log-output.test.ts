import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

it('keeps a trusted admin JSON response parseable while retaining informational diagnostics on stderr', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      "import {log} from './src/log.ts'; log.info('fixture migration diagnostic'); process.stdout.write(JSON.stringify({status:'complete'})+'\\n');",
    ],
    {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LOG_LEVEL: 'info', NANOCLAW_LOG_STDERR: 'true' },
    },
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('{"status":"complete"}\n');
  expect(result.stderr).toContain('fixture migration diagnostic');
});

it('preserves ordinary host informational logging when no admin protocol is selected', () => {
  const output = execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      "import {log} from './src/log.ts'; log.info('ordinary fixture log');",
    ],
    { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, LOG_LEVEL: 'info' } },
  );
  expect(output).toContain('ordinary fixture log');
});
