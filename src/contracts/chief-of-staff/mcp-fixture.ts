import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { safeHostEnvironment } from '../../host-environment.js';

/** Real MCP stdio client and runner container, with no network or host credentials. */
export class McpFixture {
  private child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private buffer = '';
  private diagnostic = '';
  readonly name = 'cos-fixture-' + randomUUID();
  constructor(
    repository: string,
    sessionDirectory: string,
    hostRepository: string,
    image: string,
    dependenciesVolume: string,
    launch?: { containerName: string; args: string[] },
  ) {
    if (launch) this.name = launch.containerName;
    if (dependenciesVolume && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(dependenciesVolume))
      throw new Error('Explicit runner dependency volume required');
    if (!dependenciesVolume && !/^sha256:[a-f0-9]{64}$/.test(image))
      throw new Error('Baked fixture requires an immutable image identity');
    const hostPath = (local: string) => {
      const relative = path.relative(repository, local);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Fixture path outside repository');
      return path.join(hostRepository, relative);
    };
    this.child = spawn(
      'docker',
      launch?.args ?? [
        'run',
        '--rm',
        '--pull=never',
        '--name',
        this.name,
        '--network=none',
        '--read-only',
        '--user=1000:1000',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--pids-limit=64',
        '--memory=256m',
        '--tmpfs',
        '/tmp:rw,noexec,nosuid,size=16m',
        '-i',
        '-e',
        'NANOCLAW_COS_PROTOCOL=cos-rpc/v1',
        '--mount',
        `type=bind,src=${hostPath(sessionDirectory)},dst=/workspace`,
        '--mount',
        `type=bind,src=${hostPath(path.join(sessionDirectory, 'inbound.db'))},dst=/workspace/inbound.db,readonly`,
        ...(dependenciesVolume
          ? [
              '--mount',
              `type=bind,src=${hostPath(path.join(repository, 'container/agent-runner/src'))},dst=/app/src,readonly`,
              '--mount',
              `type=volume,src=${dependenciesVolume},dst=/app/node_modules,readonly`,
            ]
          : []),
        '-w',
        '/app',
        '--entrypoint',
        'bun',
        image,
        '/app/src/cos-mcp.ts',
      ],
      { env: safeHostEnvironment('docker'), stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.child.stderr.on('data', (chunk) => {
      this.diagnostic = (this.diagnostic + chunk.toString()).slice(-2000);
    });
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString();
      if (this.buffer.length > 1_000_000) {
        this.fail();
        return;
      }
      let end: number;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        try {
          const response = JSON.parse(line);
          const waiter = this.pending.get(response.id);
          if (waiter) {
            clearTimeout(waiter.timer);
            this.pending.delete(response.id);
            if (response.error) waiter.reject(new Error('Fixture MCP error'));
            else waiter.resolve(response.result);
          }
        } catch {
          this.fail();
        }
      }
    });
    this.child.on('error', () => this.fail());
    this.child.on('exit', () => this.fail());
  }
  private fail() {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Fixture MCP transport unavailable: ' + this.diagnostic));
    }
    this.pending.clear();
  }
  request(method: string, params: unknown): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Fixture MCP deadline'));
      }, 25000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async start(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'cos-fixture', version: '1' },
    });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }
  async call(name: string, args: Record<string, unknown>) {
    const result = await this.request('tools/call', { name, arguments: args });
    return JSON.parse(result.content[0].text);
  }
  /** Fixture provider reply, written by the same isolated container as ordinary runner output. */
  async reply(text: string, platformId: string): Promise<void> {
    const source =
      "import {writeMessageOut} from '/app/src/db/messages-out.ts'; const value=JSON.parse(await Bun.stdin.text()); writeMessageOut(value);";
    const child = spawn('docker', ['exec', '-i', this.name, 'bun', '-e', source], {
      env: safeHostEnvironment('docker'),
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.stdin.end(
      JSON.stringify({
        id: 'fixture-reply-' + randomUUID(),
        kind: 'chat',
        platform_id: platformId,
        channel_type: 'mattermost',
        thread_id: null,
        content: JSON.stringify({ text }),
      }),
    );
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error('Fixture reply failed'))));
    });
  }
  async close(): Promise<void> {
    this.child.stdin.end();
    this.fail();
    await new Promise<void>((resolve) => {
      const stop = spawn('docker', ['rm', '-f', this.name], { env: safeHostEnvironment('docker'), stdio: 'ignore' });
      stop.once('error', () => resolve());
      stop.once('exit', () => resolve());
    });
  }
}
