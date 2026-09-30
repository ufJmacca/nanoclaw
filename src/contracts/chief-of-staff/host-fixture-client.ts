import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { safeHostEnvironment } from '../../host-environment.js';
import { selectedFixtureEnvironment } from './fixture-database.js';
export class HostFixture {
  readonly process: ChildProcess;
  readonly delivered: Array<{ text: string; id: string; platform: string }> = [];
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  constructor() {
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    const selected = selectedFixtureEnvironment(process.env, false);
    this.process = fork(fileURLToPath(new URL('./host-fixture-worker.' + extension, import.meta.url)), [], {
      env: { ...safeHostEnvironment('docker'), ...selected, COS_FIXTURE_HOST_PROCESS: 'S01' },
      execArgv: extension === 'ts' ? ['--import', 'tsx'] : [],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    this.process.stdout?.resume();
    this.process.stderr?.resume();
    this.process.on('message', (message: any) => {
      if (message.event === 'delivered') {
        this.delivered.push(message.value);
        return;
      }
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error('fixture_host_command_failed'));
      else waiter.resolve(message.value);
    });
    this.process.on('exit', () => this.fail());
    this.process.on('error', () => this.fail());
  }
  private fail() {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('fixture_host_exited'));
    }
    this.pending.clear();
  }
  request(command: string, value?: unknown): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('fixture_host_deadline'));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.process.send({ id, command, value }, (error) => {
        if (error) this.fail();
      });
    });
  }
  async close(crash = false): Promise<void> {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => this.process.once('exit', () => resolve()));
    const deadline = setTimeout(() => this.process.kill('SIGKILL'), 3000);
    if (crash) this.process.kill('SIGKILL');
    else {
      try {
        await this.request('shutdown');
      } catch {
        this.process.kill('SIGKILL');
      }
    }
    try {
      await exited;
    } finally {
      clearTimeout(deadline);
    }
  }
}
