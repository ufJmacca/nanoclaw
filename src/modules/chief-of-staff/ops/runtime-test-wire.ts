import type { Writable } from 'node:stream';
/** Bounded JSON lines carried only over the authenticated host SSH channel or a private fixture socket. */
export async function* runtimeTestMessages(stream: AsyncIterable<Uint8Array | string>): AsyncGenerator<unknown> {
  let pending = Buffer.alloc(0);
  for await (const chunk of stream) {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    let newline: number;
    while ((newline = pending.indexOf(10)) !== -1) {
      if (newline === 0 || newline > 4096) throw new Error('runtime_test_protocol_invalid');
      const bytes = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      let value: unknown;
      try {
        value = JSON.parse(bytes.toString('utf8'));
      } catch (error) {
        throw new Error('runtime_test_protocol_invalid', { cause: error });
      }
      yield value;
    }
    if (pending.length > 4096) throw new Error('runtime_test_protocol_invalid');
  }
  if (pending.length) throw new Error('runtime_test_protocol_invalid');
}
export function writeRuntimeTestMessage(stream: Writable, value: unknown): Promise<void> {
  const line = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(line) > 4096) throw new Error('runtime_test_protocol_invalid');
  return new Promise((resolve, reject) => stream.write(line, (error) => (error ? reject(error) : resolve())));
}
