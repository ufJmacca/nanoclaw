import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { GOOGLE_MAIL_DRAFT_SCOPE, GOOGLE_MAIL_READ_SCOPE } from '../calendar/oauth-core.js';
import { authorizeMailProfile } from './mail-authorization.js';
const cleanup: string[] = [];
afterEach(() => {
  for (const root of cleanup.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(draft = true) {
  const root = fs.mkdtempSync(os.tmpdir() + '/cos-mail-authorization-');
  cleanup.push(root);
  const bindingId = randomUUID(),
    reference = randomUUID(),
    scope = draft ? GOOGLE_MAIL_DRAFT_SCOPE : GOOGLE_MAIL_READ_SCOPE;
  let installed = false,
    active = true;
  const credentials = {
    install: vi.fn(async () => {
      installed = true;
    }),
    inspect: vi.fn(async () => {
      if (!installed) throw Error('PRIVATE_MISSING_CREDENTIAL');
      return { auth: 'ready' as const, scopes: [scope], generation: 1 };
    }),
    token: vi.fn(async () => {
      if (!installed) throw Error('PRIVATE_MISSING_CREDENTIAL');
      return 'FIXTURE_RETRY_ACCESS';
    }),
  };
  const check = vi.fn(async () => {
      if (!active) throw Error('PRIVATE_NATIVE_OWNER_LOSS');
    }),
    verifyMailbox = vi.fn(async (token: () => Promise<string>) => {
      expect(await token()).toMatch(/^FIXTURE_(NEW|RETRY)_ACCESS$/);
    }),
    fetchToken = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: 'FIXTURE_NEW_ACCESS',
            refresh_token: 'FIXTURE_REFRESH',
            expires_in: 3600,
            token_type: 'Bearer',
            scope,
          }),
        ),
    ),
    display = vi.fn(async (url: string) => {
      const auth = new URL(url);
      expect(auth.searchParams.get('scope')).toBe(scope);
      const callback = new URL(auth.searchParams.get('redirect_uri')!);
      callback.searchParams.set('state', auth.searchParams.get('state')!);
      callback.searchParams.set('code', 'fixture-code');
      const response = await fetch(callback);
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain('FIXTURE_');
    });
  const input = {
    root,
    profile: draft ? ('mail_draft_writer' as const) : ('mail_reader' as const),
    scopeId: 'scope',
    bindingId,
    reference,
    client: { clientId: 'fixture.apps.googleusercontent.com' },
    credentials,
    credentialsPresent: () => installed,
    verifyMailbox,
    check,
    fetch: fetchToken,
    display,
  };
  return {
    input,
    root,
    credentials,
    check,
    verifyMailbox,
    fetchToken,
    display,
    installed: () => installed,
    active: (value: boolean) => {
      active = value;
    },
    setInstalled: () => {
      installed = true;
    },
  };
}
it.each([false, true])(
  'shares the durable consent-attempt/retry contract without mixing reader and draft profiles: %s',
  async (draft) => {
    const f = fixture(draft);
    await authorizeMailProfile(f.input);
    expect(f.credentials.install).toHaveBeenCalledWith(
      'scope',
      f.input.bindingId,
      f.input.reference,
      expect.objectContaining({ scopes: [draft ? GOOGLE_MAIL_DRAFT_SCOPE : GOOGLE_MAIL_READ_SCOPE] }),
    );
    const marker = JSON.parse(fs.readFileSync(f.root + '/authorization.json', 'utf8'));
    expect(marker).toEqual({
      contract: draft ? 'cos-mail-draft-authorization/v1' : 'cos-mail-authorization/v1',
      attempted: true,
    });
    expect(JSON.stringify(marker)).not.toMatch(/FIXTURE|https/);
    await authorizeMailProfile(f.input);
    expect(f.fetchToken).toHaveBeenCalledTimes(1);
    expect(f.display).toHaveBeenCalledTimes(1);
    expect(f.credentials.install).toHaveBeenCalledTimes(1);
    expect(f.verifyMailbox).toHaveBeenCalledTimes(2);
  },
);
it('does not install an account that fails same-mailbox verification, and never blindly reopens its uncertain consent', async () => {
  const f = fixture();
  f.verifyMailbox.mockRejectedValueOnce(Error('PRIVATE_WRONG_ACCOUNT'));
  await expect(authorizeMailProfile(f.input)).rejects.toThrow('mail_draft_authorization_unavailable');
  expect(f.credentials.install).not.toHaveBeenCalled();
  await expect(authorizeMailProfile(f.input)).rejects.toThrow('mail_draft_link_uncertain');
  expect(f.fetchToken).toHaveBeenCalledTimes(1);
});
it('rejects unexplained credentials or a foreign marker before opening any new consent', async () => {
  const f = fixture();
  f.setInstalled();
  await expect(authorizeMailProfile(f.input)).rejects.toThrow('mail_draft_operation_conflict');
  fs.writeFileSync(
    f.root + '/authorization.json',
    JSON.stringify({ contract: 'cos-mail-authorization/v1', attempted: true }),
    { mode: 0o600 },
  );
  await expect(authorizeMailProfile(f.input)).rejects.toThrow('mail_draft_operation_conflict');
  expect(f.display).not.toHaveBeenCalled();
});
it('reconciles an installed credential after a lost acknowledgement without repeating Google consent', async () => {
  const f = fixture();
  f.credentials.install.mockImplementationOnce(async () => {
    f.setInstalled();
    throw Error('PRIVATE_LOST_INSTALL_ACK');
  });
  await expect(authorizeMailProfile(f.input)).rejects.toThrow('mail_draft_authorization_unavailable');
  await authorizeMailProfile(f.input);
  expect(f.fetchToken).toHaveBeenCalledTimes(1);
  expect(f.credentials.install).toHaveBeenCalledTimes(1);
});
it('does not use a ready record from another scope profile on retry', async () => {
  const f = fixture();
  await authorizeMailProfile(f.input);
  f.credentials.inspect.mockResolvedValueOnce({ auth: 'ready', scopes: [GOOGLE_MAIL_READ_SCOPE], generation: 1 });
  await expect(authorizeMailProfile(f.input)).rejects.toThrow('mail_draft_link_uncertain');
  expect(f.fetchToken).toHaveBeenCalledTimes(1);
});
it('requires current owner authority before creating any consent marker', async () => {
  const f = fixture();
  f.active(false);
  await expect(authorizeMailProfile(f.input)).rejects.toThrow('mail_draft_authorization_unavailable');
  expect(f.display).not.toHaveBeenCalled();
  expect(fs.existsSync(f.root + '/authorization.json')).toBe(false);
});
