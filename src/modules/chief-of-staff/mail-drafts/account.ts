/** Owner setup only. A dedicated compose token must prove the reader's selected
 * mailbox before it can be installed. This fixed GET cannot read mail or write drafts. */
export async function verifyMailDraftMailbox(
  mailboxEmail: string,
  token: () => Promise<string>,
  options: { current(): void; fetch?: (url: string, init: RequestInit) => Promise<Response>; signal?: AbortSignal },
): Promise<void> {
  let response: Response | undefined,
    reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
    signal: AbortSignal | undefined,
    cancel: (() => void) | undefined,
    consumed = false;
  try {
    if (
      typeof mailboxEmail !== 'string' ||
      mailboxEmail.length > 254 ||
      !/^[a-z0-9][a-z0-9._%+-]{0,127}@[a-z0-9.-]{1,180}\.[a-z]{2,24}$/i.test(mailboxEmail) ||
      typeof token !== 'function' ||
      typeof options.current !== 'function'
    )
      throw Error('invalid_account_check');
    const assertOwner = options.current;
    signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(10000)]);
    const current = () => {
      assertOwner();
      if (signal!.aborted) throw Error('account_check_cancelled');
    };
    current();
    const access = await token();
    current();
    if (typeof access !== 'string' || access.length > 8192 || !/^[\x21-\x7e]+$/.test(access))
      throw Error('invalid_account_token');
    response = await (options.fetch ?? globalThis.fetch)(
      'https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress',
      {
        method: 'GET',
        redirect: 'error',
        signal,
        headers: { Authorization: 'Bearer ' + access, Accept: 'application/json', 'Cache-Control': 'no-store' },
      },
    );
    current();
    const maximum = 16384;
    if (response.status !== 200 || Number(response.headers.get('content-length')) > maximum || !response.body)
      throw Error('account_profile_unavailable');
    reader = response.body.getReader();
    const held = reader;
    cancel = () => {
      void held.cancel().catch(() => {});
    };
    signal.addEventListener('abort', cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      current();
      const next = await reader.read();
      current();
      if (next.done) {
        consumed = true;
        break;
      }
      bytes += next.value.byteLength;
      if (bytes > maximum) {
        cancel();
        throw Error('account_profile_too_large');
      }
      chunks.push(next.value);
    }
    const profile: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (
      !profile ||
      typeof profile !== 'object' ||
      Array.isArray(profile) ||
      Object.keys(profile).join(',') !== 'emailAddress' ||
      typeof (profile as { emailAddress?: unknown }).emailAddress !== 'string' ||
      (profile as { emailAddress: string }).emailAddress.toLowerCase() !== mailboxEmail.toLowerCase()
    )
      throw Error('account_profile_denied');
    current();
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Tokens, foreign account details and private owner/provider errors stay inside trusted setup.
    throw Error('mail_draft_account_unavailable');
  } finally {
    if (cancel) signal?.removeEventListener('abort', cancel);
    reader?.releaseLock();
    if (!consumed) void response?.body?.cancel().catch(() => {});
  }
}
