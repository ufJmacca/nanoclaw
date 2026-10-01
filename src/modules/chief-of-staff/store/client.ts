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
    readonly admission?: () => boolean,
  ) {
    pool.on('error', () => {
      this.cooldownUntil = Date.now() + 1000;
    });
  }

  async run<T>(operation: (client: PoolClient) => Promise<T>, mutation = false, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new DatabaseUnavailable();
    if (this.admission && !this.admission()) throw new DatabaseUnavailable();
    if (Date.now() < this.cooldownUntil) throw new DatabaseUnavailable();
    if (this.admitted >= this.capacity) throw new DatabaseUnavailable('busy');
    this.admitted++;
    let client: PoolClient | undefined;
    let expired = false;
    let started = false;
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
    let abort: (() => void) | undefined;
    const deadline = new Promise<never>((_, reject) => {
      abort = () => {
        if (expired) return;
        expired = true;
        release(true);
        reject(new DatabaseUnavailable(mutation && started ? 'pending' : 'unavailable'));
      };
      timer = setTimeout(abort, this.deadlineMs);
      signal?.addEventListener('abort', abort, { once: true });
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
        if (this.admission) {
          const lock = await client.query('SELECT pg_try_advisory_lock_shared(73101003) AS locked');
          if (!lock.rows[0]?.locked || expired || !this.admission()) throw new DatabaseUnavailable();
        }
        started = true;
        const result = await operation(client);
        if (expired) throw new DatabaseUnavailable();
        if (this.admission) {
          const unlocked = await client.query('SELECT pg_advisory_unlock_shared(73101003) AS unlocked');
          if (!unlocked.rows[0]?.unlocked) throw new DatabaseUnavailable();
        }
        return result;
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
      throw new DatabaseUnavailable(mutation && started ? 'pending' : 'unavailable');
    } finally {
      clearTimeout(timer);
      if (abort) signal?.removeEventListener('abort', abort);
      // A late acquisition retains its admission slot until settled, so
      // repeated timeouts cannot create an unbounded driver wait queue.
      if (acquisitionSettled) finishAdmission();
    }
  }

  static fromConfig(config: PoolConfig, admission?: () => boolean): BoundedDatabase {
    return new BoundedDatabase(new pg.Pool(config), 12000, (config.max ?? 5) + 20, admission);
  }
}
