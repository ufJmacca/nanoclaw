import type { Readable } from 'node:stream';
import { checkedClient, type GoogleOAuthClient } from '../calendar/oauth-core.js';
import { object } from '../calendar/normalization.js';
import { verifyVaultMemory } from './vault-memory.js';

/** Downloaded Desktop client only. Provider endpoints and redirect destinations
 * are never taken from these bytes; the production OAuth transport fixes them.
 */
function desktopClient(value: unknown): GoogleOAuthClient {
  if (!object(value) || Object.keys(value).join(',') !== 'installed' || !object(value.installed))
    throw Error('invalid_desktop_client');
  const client = value.installed;
  if (
    Object.keys(client).sort().join(',') !==
      'auth_provider_x509_cert_url,auth_uri,client_id,client_secret,project_id,redirect_uris,token_uri' ||
    typeof client.project_id !== 'string' ||
    !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(client.project_id) ||
    client.auth_uri !== 'https://accounts.google.com/o/oauth2/auth' ||
    client.token_uri !== 'https://oauth2.googleapis.com/token' ||
    client.auth_provider_x509_cert_url !== 'https://www.googleapis.com/oauth2/v1/certs' ||
    !Array.isArray(client.redirect_uris) ||
    client.redirect_uris.length !== 1 ||
    client.redirect_uris[0] !== 'http://localhost' ||
    typeof client.client_secret !== 'string' ||
    !client.client_secret
  )
    throw Error('invalid_desktop_client');
  return checkedClient({ clientId: client.client_id as string, clientSecret: client.client_secret });
}

/** Trusted private pipe, never argv/environment or a plaintext Pi staging file.
 * EOF and bounded fatal UTF-8/JSON validation precede any profile mutation.
 */
export async function consumeMailClientStream(
  stream: Readable,
  operation: (client: GoogleOAuthClient) => Promise<void>,
  controls: { deadlineMs?: number } = {},
): Promise<void> {
  let bytes: Buffer | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    verifyVaultMemory();
    const deadline = controls.deadlineMs ?? 15000;
    if (
      (stream as Readable & { isTTY?: boolean }).isTTY ||
      stream.readableEncoding !== null ||
      !Number.isSafeInteger(deadline) ||
      deadline < 1 ||
      deadline > 15000
    )
      throw Error('invalid_client_pipe');
    bytes = Buffer.alloc(16384);
    let offset = 0;
    timer = setTimeout(() => stream.destroy(Error('mail_client_input_unavailable')), deadline);
    for await (const chunk of stream) {
      try {
        verifyVaultMemory();
        if (!Buffer.isBuffer(chunk) || chunk.length > bytes.length - offset) throw Error('client_pipe_bounds');
        chunk.copy(bytes, offset);
        offset += chunk.length;
        verifyVaultMemory();
      } finally {
        if (Buffer.isBuffer(chunk)) chunk.fill(0);
      }
    }
    clearTimeout(timer);
    timer = undefined;
    verifyVaultMemory();
    const client = desktopClient(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset))),
    );
    await operation(client);
    verifyVaultMemory();
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Client bytes, private pipe and installer diagnostics cannot cross the owner boundary.
    throw Error('mail_client_input_unavailable');
  } finally {
    if (timer) clearTimeout(timer);
    bytes?.fill(0);
    stream.destroy();
  }
}
