import { afterEach, describe, it, expect } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  STALE_THREAD_RE,
  createCodexConfigOverrides,
  tomlBasicString,
  writeCodexMcpConfigToml,
} from './codex-app-server.js';

const originalHome = process.env.HOME;
const tempDirs: string[] = [];

afterEach(() => {
  process.env.HOME = originalHome;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('tomlBasicString', () => {
  it('leaves safe strings unchanged inside quotes', () => {
    expect(tomlBasicString('hello')).toBe('"hello"');
    expect(tomlBasicString('bun')).toBe('"bun"');
    expect(tomlBasicString('/usr/local/bin/node')).toBe('"/usr/local/bin/node"');
  });

  it('escapes double-quotes', () => {
    expect(tomlBasicString('a"b')).toBe('"a\\"b"');
    expect(tomlBasicString('"quoted"')).toBe('"\\"quoted\\""');
  });

  it('escapes backslashes', () => {
    expect(tomlBasicString('a\\b')).toBe('"a\\\\b"');
    expect(tomlBasicString('C:\\path\\to\\bin')).toBe('"C:\\\\path\\\\to\\\\bin"');
  });

  it('escapes backslash before quote (order matters)', () => {
    expect(tomlBasicString('\\"')).toBe('"\\\\\\""');
  });

  it('rejects strings containing newlines', () => {
    expect(() => tomlBasicString('line1\nline2')).toThrow(/newline/);
    expect(() => tomlBasicString('trailing\n')).toThrow(/newline/);
    expect(() => tomlBasicString('crlf\r\nhere')).toThrow(/newline/);
  });
});

describe('STALE_THREAD_RE', () => {
  it('matches stale-thread error messages', () => {
    expect(STALE_THREAD_RE.test('thread not found')).toBe(true);
    expect(STALE_THREAD_RE.test('unknown thread xyz')).toBe(true);
    expect(STALE_THREAD_RE.test('No such thread: abc')).toBe(true);
    expect(STALE_THREAD_RE.test('invalid thread_id')).toBe(true);
  });

  it('does not match transient or unrelated errors', () => {
    expect(STALE_THREAD_RE.test('rate limit exceeded')).toBe(false);
    expect(STALE_THREAD_RE.test('authentication failed')).toBe(false);
    expect(STALE_THREAD_RE.test('connection reset by peer')).toBe(false);
    expect(STALE_THREAD_RE.test('internal server error')).toBe(false);
  });
});

describe('Codex feature flags', () => {
  it('enables goals in launch config overrides', () => {
    expect(createCodexConfigOverrides()).toContain('features.goals=true');
  });

  it('writes goals to config.toml alongside MCP servers', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-config-'));
    tempDirs.push(home);
    process.env.HOME = home;

    writeCodexMcpConfigToml({
      nanoclaw: {
        command: 'bun',
        args: ['run', '/app/src/mcp-tools/index.ts'],
      },
    });

    const config = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf-8');
    expect(config).toContain('[features]\ngoals = true');
    expect(config).toContain('[mcp_servers.nanoclaw]');
  });
});
