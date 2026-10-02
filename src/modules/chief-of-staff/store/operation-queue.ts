export class OperationBusy extends Error {
  constructor() {
    super('artifact_operation_busy');
  }
}
type Waiting = { start(): void; expire(): void };
/** One bounded host queue before the kernel publication lock. Waiting work owns no database client. */
export class OperationQueue {
  private active = false;
  private waiting: Waiting[] = [];
  constructor(
    readonly capacity: number,
    readonly deadlineMs: number,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1)
      throw Error('artifact_operation_queue_invalid');
  }
  run<T>(operation: () => Promise<T>): Promise<T> {
    if (Number(this.active) + this.waiting.length >= this.capacity) return Promise.reject(new OperationBusy());
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const entry: Waiting = {
        start: () => {
          clearTimeout(timer);
          this.active = true;
          void (async () => {
            try {
              resolve(await operation());
            } catch (error) {
              reject(error);
            } finally {
              this.active = false;
              this.waiting.shift()?.start();
            }
          })();
        },
        expire: () => {
          const index = this.waiting.indexOf(entry);
          if (index < 0) return;
          this.waiting.splice(index, 1);
          reject(new OperationBusy());
        },
      };
      if (!this.active) entry.start();
      else {
        this.waiting.push(entry);
        timer = setTimeout(entry.expire, this.deadlineMs);
      }
    });
  }
}
