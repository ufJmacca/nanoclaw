import pg from 'pg';
import type { PoolClient, PoolConfig } from 'pg';

export class DatabaseUnavailable extends Error {
  constructor(readonly code: 'busy' | 'unavailable' | 'pending' = 'unavailable') {
    super(`CoS database ${code}`);
  }
}

export class BoundedDatabase {
  private admitted = 0;
  private cooldownUntil = 0;
  constructor(
    readonly pool: pg.Pool,
    readonly deadlineMs = 12000,
    readonly capacity = 25,
  ) {
    pool.on('error', () => {
      this.cooldownUntil = Date.now() + 1000;
    });
  }

  async run<T>(operation: (client: PoolClient) => Promise<T>, mutation = false): Promise<T> {
    if (Date.now() < this.cooldownUntil) throw new DatabaseUnavailable();
    if (this.admitted >= this.capacity) throw new DatabaseUnavailable('busy');
    this.admitted++;
    let client: PoolClient | undefined;
    let expired = false;
    let released = false;
    let admissionFinished = false;
    let acquisitionSettled = false;
    const finishAdmission = () => {
      if (!admissionFinished) {
        this.admitted--;
        admissionFinished = true;
      }
    };
    const release = (destroy: boolean) => {
      if (client && !released) {
        released = true;
        client.release(destroy);
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        release(true);
        reject(new DatabaseUnavailable(mutation && client ? 'pending' : 'unavailable'));
      }, this.deadlineMs);
    });
    const work = (async () => {
      try {
        client = await this.pool.connect();
        acquisitionSettled = true;
        if (expired) {
          release(true);
          finishAdmission();
          throw new DatabaseUnavailable();
        }
        return await operation(client);
      } catch (error) {
        acquisitionSettled = true;
        if (expired) finishAdmission();
        throw error;
      }
    })();
    try {
      const result = await Promise.race([work, deadline]);
      release(false);
      return result;
    } catch {
      release(true);
      this.cooldownUntil = Date.now() + 1000;
      throw new DatabaseUnavailable(mutation && client ? 'pending' : 'unavailable');
    } finally {
      clearTimeout(timer);
      // A late acquisition retains its admission slot until settled, so
      // repeated timeouts cannot create an unbounded driver wait queue.
      if (acquisitionSettled) finishAdmission();
    }
  }

  static fromConfig(config: PoolConfig): BoundedDatabase {
    return new BoundedDatabase(new pg.Pool(config), 12000, (config.max ?? 5) + 20);
  }
}
