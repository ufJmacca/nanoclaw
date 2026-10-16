import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('resolves native roots after owner startup selects the installation when launched from another directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-owner-startup-'));
  try {
    const installation = path.join(root, 'installation');
    fs.mkdirSync(installation, { mode: 0o700 });
    const entry = pathToFileURL(path.resolve('src/modules/chief-of-staff/ops/target-owner-admin.ts')).href;
    const config = pathToFileURL(path.resolve('src/config.ts')).href;
    const output = execFileSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        '--input-type=module',
        '--eval',
        `await import(${JSON.stringify(entry)});
       process.chdir(${JSON.stringify(installation)});
       const config=await import(${JSON.stringify(config)});
       console.log(JSON.stringify({data:config.DATA_DIR,groups:config.GROUPS_DIR}));`,
      ],
      {
        cwd: root,
        env: { PATH: '/usr/bin:/bin', HOME: root, NANOCLAW_LOG_STDERR: 'true' },
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 16384,
      },
    );
    expect(JSON.parse(output.trim())).toEqual({ data: installation + '/data', groups: installation + '/groups' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
