import { describe, expect, it, vi } from 'vitest';

import { MattermostContractApi, type MattermostContractResponse } from './api.js';

function jsonResponse(status: number, body: unknown, headers: Readonly<Record<string, string>> = {}) {
  return {
    status,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    json: vi.fn().mockResolvedValue(body),
  };
}

function binaryResponse(status: number, body: Buffer) {
  return {
    status,
    json: vi.fn().mockRejectedValue(new Error('binary response')),
    arrayBuffer: vi.fn().mockResolvedValue(Uint8Array.from(body).buffer),
  };
}

describe('MattermostContractApi', () => {
  it('cannot be constructed for a non-loopback Mattermost server', () => {
    expect(() => new MattermostContractApi({ baseUrl: 'https://mattermost.production.example' })).toThrow(
      'Mattermost contract base URL must be loopback-only',
    );
  });

  it('waits for the disposable server with a bounded readiness poll', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { status: 'starting' }))
      .mockResolvedValueOnce(jsonResponse(200, { status: 'OK' }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const api = new MattermostContractApi(
      { baseUrl: 'http://127.0.0.1:8065/' },
      { fetch: fetchImpl, sleep, requestTimeoutMs: 100, maxRequestAttempts: 1 },
    );

    await expect(api.waitUntilReady({ maxAttempts: 2, delayMs: 25 })).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:8065/api/v4/system/ping',
      'http://127.0.0.1:8065/api/v4/system/ping',
    ]);
    expect(sleep).toHaveBeenCalledWith(25);
  });

  it('creates the first disposable administrator without an authorization header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(201, {
        id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa',
        username: 'contract-admin',
      }),
    );
    const api = new MattermostContractApi(
      { baseUrl: 'http://127.0.0.1:8065' },
      { fetch: fetchImpl, requestTimeoutMs: 100, maxRequestAttempts: 1 },
    );

    await expect(
      api.createInitialAdmin({
        email: 'admin@example.test',
        username: 'contract-admin',
        password: 'synthetic-admin-password',
      }),
    ).resolves.toEqual({ id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa', username: 'contract-admin' });

    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8065/api/v4/users', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: 'admin@example.test',
        username: 'contract-admin',
        password: 'synthetic-admin-password',
      }),
      signal: expect.any(AbortSignal),
    });
  });

  it('logs in the disposable administrator and returns the response token', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          200,
          { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa', username: 'contract-admin' },
          { token: 'synthetic-admin-token' },
        ),
      );
    const api = new MattermostContractApi(
      { baseUrl: 'http://127.0.0.1:8065' },
      { fetch: fetchImpl, requestTimeoutMs: 100, maxRequestAttempts: 1 },
    );

    await expect(api.login({ loginId: 'contract-admin', password: 'synthetic-admin-password' })).resolves.toEqual({
      user: { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa', username: 'contract-admin' },
      token: 'synthetic-admin-token',
    });

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      login_id: 'contract-admin',
      password: 'synthetic-admin-password',
    });
  });

  it('creates fixture users through the bearer-authenticated admin transport', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(201, {
        id: 'bbbbbbbbbbbbbbbbbbbbbbbbbb',
        username: 'contract-actor',
      }),
    );
    const api = new MattermostContractApi(
      { baseUrl: 'http://127.0.0.1:8065', adminToken: 'synthetic-admin-token' },
      { fetch: fetchImpl, requestTimeoutMs: 100, maxRequestAttempts: 1 },
    );

    await expect(
      api.createUser({
        email: 'actor@example.test',
        username: 'contract-actor',
        password: 'synthetic-actor-password',
      }),
    ).resolves.toEqual({ id: 'bbbbbbbbbbbbbbbbbbbbbbbbbb', username: 'contract-actor' });

    expect(fetchImpl.mock.calls[0][1].headers).toMatchObject({
      Authorization: 'Bearer synthetic-admin-token',
      'Content-Type': 'application/json',
    });
  });

  it('creates a disposable team for the contract scenario', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(201, {
        id: 'cccccccccccccccccccccccccc',
        name: 'nanoclaw-contract',
        display_name: 'NanoClaw Contract',
      }),
    );
    const api = new MattermostContractApi(
      { baseUrl: 'http://127.0.0.1:8065', adminToken: 'synthetic-admin-token' },
      { fetch: fetchImpl, requestTimeoutMs: 100, maxRequestAttempts: 1 },
    );

    await expect(api.createTeam({ name: 'nanoclaw-contract', displayName: 'NanoClaw Contract' })).resolves.toEqual({
      id: 'cccccccccccccccccccccccccc',
      name: 'nanoclaw-contract',
      displayName: 'NanoClaw Contract',
    });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      name: 'nanoclaw-contract',
      display_name: 'NanoClaw Contract',
      type: 'O',
    });
  });

  it('creates isolated disposable channels in the selected team', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(201, {
        id: 'dddddddddddddddddddddddddd',
        team_id: 'cccccccccccccccccccccccccc',
        name: 'contract-a',
        display_name: 'Contract A',
        type: 'O',
      }),
    );
    const api = new MattermostContractApi(
      { baseUrl: 'http://127.0.0.1:8065', adminToken: 'synthetic-admin-token' },
      { fetch: fetchImpl, requestTimeoutMs: 100, maxRequestAttempts: 1 },
    );

    await expect(
      api.createChannel({
        teamId: 'cccccccccccccccccccccccccc',
        name: 'contract-a',
        displayName: 'Contract A',
      }),
    ).resolves.toEqual({
      id: 'dddddddddddddddddddddddddd',
      teamId: 'cccccccccccccccccccccccccc',
      name: 'contract-a',
      displayName: 'Contract A',
      type: 'O',
    });
  });

  it('fails closed when a created channel response belongs to another team', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(201, {
        id: 'dddddddddddddddddddddddddd',
        team_id: 'unexpected-team-id',
        name: 'contract-a',
        display_name: 'Contract A',
        type: 'O',
      }),
    );
    const api = new MattermostContractApi(
      { baseUrl: 'http://127.0.0.1:8065', adminToken: 'synthetic-admin-token' },
      { fetch: fetchImpl, requestTimeoutMs: 100, maxRequestAttempts: 1 },
    );

    await expect(
      api.createChannel({
        teamId: 'cccccccccccccccccccccccccc',
        name: 'contract-a',
        displayName: 'Contract A',
      }),
    ).rejects.toThrow('Mattermost contract created channel response identity was invalid');
  });

  it('creates a disposable bot identity', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(201, {
        user_id: 'eeeeeeeeeeeeeeeeeeeeeeeeee',
        username: 'nanoclaw-contract-bot',
        display_name: 'NanoClaw Contract Bot',
      }),
    );
    const api = new MattermostContractApi(
      { baseUrl: 'http://127.0.0.1:8065', adminToken: 'synthetic-admin-token' },
      { fetch: fetchImpl, requestTimeoutMs: 100, maxRequestAttempts: 1 },
    );

    await expect(
      api.createBot({ username: 'nanoclaw-contract-bot', displayName: 'NanoClaw Contract Bot' }),
    ).resolves.toEqual({
      userId: 'eeeeeeeeeeeeeeeeeeeeeeeeee',
      username: 'nanoclaw-contract-bot',
      displayName: 'NanoClaw Contract Bot',
    });
    expect(fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:8065/api/v4/bots');
  });

  it('creates a personal access token using an encoded user path', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(201, {
        id: 'ffffffffffffffffffffffffff',
        token: 'synthetic-bot-token',
      }),
    );
    const api = new MattermostContractApi(
      { baseUrl: 'http://127.0.0.1:8065', adminToken: 'synthetic-admin-token' },
      { fetch: fetchImpl, requestTimeoutMs: 100, maxRequestAttempts: 1 },
    );

    await expect(api.createPersonalAccessToken('bot:user', 'NanoClaw contract token')).resolves.toEqual({
      id: 'ffffffffffffffffffffffffff',
      token: 'synthetic-bot-token',
    });
    expect(fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:8065/api/v4/users/bot%3Auser/tokens');
  });

  it('adds fixture identities to the disposable team and channel', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(201, { team_id: 'team:id', user_id: 'user:id', roles: 'team_user' }))
      .mockResolvedValueOnce(
        jsonResponse(201, { channel_id: 'channel:id', user_id: 'user:id', roles: 'channel_user' }),
      );
    const api = new MattermostContractApi(
      { baseUrl: 'http://127.0.0.1:8065', adminToken: 'synthetic-admin-token' },
      { fetch: fetchImpl, requestTimeoutMs: 100, maxRequestAttempts: 1 },
    );

    await expect(api.addTeamMember('team:id', 'user:id')).resolves.toEqual({
      teamId: 'team:id',
      userId: 'user:id',
      roles: 'team_user',
    });
    await expect(api.addChannelMember('channel:id', 'user:id')).resolves.toEqual({
      channelId: 'channel:id',
      userId: 'user:id',
      roles: 'channel_user',
    });

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:8065/api/v4/teams/team%3Aid/members',
      'http://127.0.0.1:8065/api/v4/channels/channel%3Aid/members',
    ]);
  });

  it('creates root and threaded fixture posts with explicit delivery identity', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(201, {
        id: 'gggggggggggggggggggggggggg',
        channel_id: 'channel:id',
        user_id: 'user:id',
        root_id: 'root:id',
        message: 'thread fixture',
        create_at: 42,
      }),
    );
    const api = new MattermostContractApi(
      { baseUrl: 'http://127.0.0.1:8065', adminToken: 'synthetic-admin-token' },
      { fetch: fetchImpl, requestTimeoutMs: 100, maxRequestAttempts: 1 },
    );

    await expect(
      api.createPost({
        channelId: 'channel:id',
        message: 'thread fixture',
        rootId: 'root:id',
        pendingPostId: 'contract-pending-id',
      }),
    ).resolves.toEqual({
      id: 'gggggggggggggggggggggggggg',
      channelId: 'channel:id',
      userId: 'user:id',
      rootId: 'root:id',
      message: 'thread fixture',
      createAt: 42,
      fileIds: [],
    });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      channel_id: 'channel:id',
      message: 'thread fixture',
      root_id: 'root:id',
      pending_post_id: 'contract-pending-id',
    });
  });

  it('uploads exact actor fixture bytes as multipart files without overriding the boundary', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(201, {
        file_infos: [{ id: 'file-id-one' }, { id: 'file-id-two' }],
      }),
    );
    const api = new MattermostContractApi(
      { baseUrl: 'http://127.0.0.1:8065', adminToken: 'synthetic-actor-token' },
      { fetch: fetchImpl, requestTimeoutMs: 100, maxRequestAttempts: 1 },
    );
    const first = Buffer.from('captioned fixture bytes\n');
    const second = Buffer.from([0, 1, 2, 253, 254, 255]);

    await expect(
      api.uploadFiles('channel:id', [
        { filename: 'captioned.txt', mimeType: 'text/plain', data: first },
        { filename: 'attachment-only.bin', mimeType: 'application/octet-stream', data: second },
      ]),
    ).resolves.toEqual(['file-id-one', 'file-id-two']);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8065/api/v4/files?channel_id=channel%3Aid');
    expect(init.headers).toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer synthetic-actor-token',
    });
    expect(init.body).toBeInstanceOf(FormData);
    const uploaded = (init.body as FormData).getAll('files');
    expect(uploaded).toHaveLength(2);
    expect(uploaded.map((value) => (value as File).name)).toEqual(['captioned.txt', 'attachment-only.bin']);
    expect(uploaded.map((value) => (value as File).type)).toEqual(['text/plain', 'application/octet-stream']);
    await expect(Buffer.from(await (uploaded[0] as File).arrayBuffer())).toEqual(first);
    await expect(Buffer.from(await (uploaded[1] as File).arrayBuffer())).toEqual(second);
  });

  it('associates uploaded file ids with captionless posts exactly', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(201, {
        id: 'post-with-files',
        channel_id: 'channel:id',
        user_id: 'user:id',
        root_id: 'root:id',
        message: '',
        create_at: 43,
        file_ids: ['file-id-one', 'file-id-two'],
      }),
    );
    const api = new MattermostContractApi(
      { baseUrl: 'http://127.0.0.1:8065', adminToken: 'synthetic-actor-token' },
      { fetch: fetchImpl, requestTimeoutMs: 100, maxRequestAttempts: 1 },
    );

    await expect(
      api.createPost({
        channelId: 'channel:id',
        rootId: 'root:id',
        message: '',
        fileIds: ['file-id-one', 'file-id-two'],
      }),
    ).resolves.toMatchObject({
      id: 'post-with-files',
      message: '',
      fileIds: ['file-id-one', 'file-id-two'],
    });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body as string)).toEqual({
      channel_id: 'channel:id',
      message: '',
      root_id: 'root:id',
      file_ids: ['file-id-one', 'file-id-two'],
    });
  });

  it('reads authenticated file metadata and exact binary downloads through encoded paths', async () => {
    const bytes = Buffer.from([0, 8, 16, 32, 64, 128, 255]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: 'file:id',
          post_id: 'post:id',
          channel_id: 'channel:id',
          name: 'fixture.bin',
          mime_type: 'application/octet-stream',
          size: bytes.length,
        }),
      )
      .mockResolvedValueOnce(binaryResponse(200, bytes));
    const api = new MattermostContractApi(
      { baseUrl: 'http://127.0.0.1:8065', adminToken: 'synthetic-actor-token' },
      { fetch: fetchImpl, requestTimeoutMs: 100, maxRequestAttempts: 1 },
    );

    await expect(api.getFileInfo('file:id')).resolves.toEqual({
      id: 'file:id',
      postId: 'post:id',
      channelId: 'channel:id',
      name: 'fixture.bin',
      mimeType: 'application/octet-stream',
      size: bytes.length,
    });
    await expect(api.downloadFile('file:id')).resolves.toEqual(bytes);
    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init.headers.Accept])).toEqual([
      ['http://127.0.0.1:8065/api/v4/files/file%3Aid/info', 'application/json'],
      ['http://127.0.0.1:8065/api/v4/files/file%3Aid', '*/*'],
    ]);
    expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe('Bearer synthetic-actor-token');
  });

  it('rejects malformed upload associations without exposing response bodies', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(201, {
        file_infos: [{ id: 'duplicate-id' }, { id: 'duplicate-id', token: 'response-body-credential' }],
      }),
    );
    const api = new MattermostContractApi(
      { baseUrl: 'http://127.0.0.1:8065', adminToken: 'synthetic-actor-token' },
      { fetch: fetchImpl, requestTimeoutMs: 100, maxRequestAttempts: 1 },
    );
    const outcome = api
      .uploadFiles('channel:id', [
        { filename: 'one.txt', mimeType: 'text/plain', data: Buffer.from('one') },
        { filename: 'two.txt', mimeType: 'text/plain', data: Buffer.from('two') },
      ])
      .then(
        () => '',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );

    await expect(outcome).resolves.toBe('Mattermost contract upload files response was invalid');
    await expect(outcome).resolves.not.toContain('response-body-credential');
  });

  it('rejects a sixth file before upload or post association', async () => {
    const fetchImpl = vi.fn();
    const api = new MattermostContractApi(
      { baseUrl: 'http://127.0.0.1:8065', adminToken: 'synthetic-actor-token' },
      { fetch: fetchImpl, requestTimeoutMs: 100, maxRequestAttempts: 1 },
    );
    const files = Array.from({ length: 6 }, (_, index) => ({
      filename: `file-${index}.txt`,
      mimeType: 'text/plain',
      data: Buffer.from(`${index}`),
    }));
    const fileIds = Array.from({ length: 6 }, (_, index) => `file-${index}`);

    await expect(api.uploadFiles('channel:id', files)).rejects.toThrow('Mattermost contract upload files are invalid');
    await expect(api.createPost({ channelId: 'channel:id', message: '', fileIds })).rejects.toThrow(
      'Mattermost contract file ids are invalid',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reads post, channel, and membership state through encoded paths', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: 'post:id',
          channel_id: 'channel:id',
          user_id: 'user:id',
          root_id: '',
          message: 'root fixture',
          create_at: 42,
          file_ids: null,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: 'channel:id',
          team_id: 'team:id',
          name: 'contract-a',
          display_name: 'Contract A',
          type: 'O',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { channel_id: 'channel:id', user_id: 'user:id', roles: 'channel_user' }),
      );
    const api = new MattermostContractApi(
      { baseUrl: 'http://127.0.0.1:8065', adminToken: 'synthetic-admin-token' },
      { fetch: fetchImpl, requestTimeoutMs: 100, maxRequestAttempts: 1 },
    );

    await expect(api.getPost('post:id')).resolves.toMatchObject({ id: 'post:id', rootId: '', fileIds: [] });
    await expect(api.getChannel('channel:id')).resolves.toMatchObject({
      id: 'channel:id',
      teamId: 'team:id',
    });
    await expect(api.getChannelMember('channel:id', 'user:id')).resolves.toEqual({
      channelId: 'channel:id',
      userId: 'user:id',
      roles: 'channel_user',
    });

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:8065/api/v4/posts/post%3Aid',
      'http://127.0.0.1:8065/api/v4/channels/channel%3Aid',
      'http://127.0.0.1:8065/api/v4/channels/channel%3Aid/members/user%3Aid',
    ]);
  });

  it('removes and deactivates every disposable resource through encoded paths', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { status: 'OK' }));
    const api = new MattermostContractApi(
      { baseUrl: 'http://127.0.0.1:8065', adminToken: 'synthetic-admin-token' },
      { fetch: fetchImpl, requestTimeoutMs: 100, maxRequestAttempts: 1 },
    );

    await api.deletePost('post:id');
    await api.removeChannelMember('channel:id', 'user:id');
    await api.deleteChannel('channel:id');
    await api.deleteTeam('team:id');
    await api.deactivateUser('user:id');
    await api.disableBot('bot:id');
    await api.revokePersonalAccessToken('token:id');

    expect(fetchImpl.mock.calls.map(([url, init]) => [init.method, url, init.body])).toEqual([
      ['DELETE', 'http://127.0.0.1:8065/api/v4/posts/post%3Aid', undefined],
      ['DELETE', 'http://127.0.0.1:8065/api/v4/channels/channel%3Aid/members/user%3Aid', undefined],
      ['DELETE', 'http://127.0.0.1:8065/api/v4/channels/channel%3Aid', undefined],
      ['DELETE', 'http://127.0.0.1:8065/api/v4/teams/team%3Aid', undefined],
      ['PUT', 'http://127.0.0.1:8065/api/v4/users/user%3Aid/active', JSON.stringify({ active: false })],
      ['POST', 'http://127.0.0.1:8065/api/v4/bots/bot%3Aid/disable', undefined],
      ['POST', 'http://127.0.0.1:8065/api/v4/users/tokens/revoke', JSON.stringify({ token_id: 'token:id' })],
    ]);
  });

  it('retries transient contract requests with bounded injected backoff', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { message: 'temporarily unavailable' }))
      .mockResolvedValueOnce(
        jsonResponse(201, {
          id: 'cccccccccccccccccccccccccc',
          name: 'nanoclaw-contract',
          display_name: 'NanoClaw Contract',
        }),
      );
    const sleep = vi.fn().mockResolvedValue(undefined);
    const api = new MattermostContractApi(
      { baseUrl: 'http://127.0.0.1:8065', adminToken: 'synthetic-admin-token' },
      {
        fetch: fetchImpl,
        sleep,
        requestTimeoutMs: 100,
        maxRequestAttempts: 2,
        retryBaseDelayMs: 10,
      },
    );

    await expect(
      api.createTeam({ name: 'nanoclaw-contract', displayName: 'NanoClaw Contract' }),
    ).resolves.toMatchObject({ id: 'cccccccccccccccccccccccccc' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it('rejects malformed response identities without exposing response data', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        id: 17,
        team_id: 'team:id',
        name: 'contract-a',
        display_name: 'Contract A',
        type: 'O',
        token: 'response-body-credential',
      }),
    );
    const api = new MattermostContractApi(
      { baseUrl: 'http://127.0.0.1:8065', adminToken: 'synthetic-admin-token' },
      { fetch: fetchImpl, requestTimeoutMs: 100, maxRequestAttempts: 1 },
    );

    const outcome = api.getChannel('channel:id').then(
      () => '',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    await expect(outcome).resolves.toBe('Mattermost contract channel id response was invalid');
    await expect(outcome).resolves.not.toContain('response-body-credential');
  });

  it('rejects malformed HTTP response status types', async () => {
    const malformed = {
      status: '200',
      json: vi.fn().mockResolvedValue({
        id: 'cccccccccccccccccccccccccc',
        name: 'nanoclaw-contract',
        display_name: 'NanoClaw Contract',
      }),
    } as unknown as MattermostContractResponse;
    const api = new MattermostContractApi(
      { baseUrl: 'http://127.0.0.1:8065', adminToken: 'synthetic-admin-token' },
      { fetch: vi.fn().mockResolvedValue(malformed), requestTimeoutMs: 100, maxRequestAttempts: 1 },
    );

    await expect(api.createTeam({ name: 'nanoclaw-contract', displayName: 'NanoClaw Contract' })).rejects.toThrow(
      'Mattermost contract HTTP response was invalid',
    );
  });

  it('bounds request time and redacts credentials from transport errors', async () => {
    vi.useFakeTimers();
    try {
      const credential = 'transport-error-credential';
      const fetchImpl = vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error(credential)), { once: true });
          }),
      );
      const api = new MattermostContractApi(
        { baseUrl: 'http://127.0.0.1:8065', adminToken: credential },
        { fetch: fetchImpl, requestTimeoutMs: 20, maxRequestAttempts: 1 },
      );

      const outcome = api.getPost('post:id').then(
        () => '',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      await vi.advanceTimersByTimeAsync(20);

      await expect(outcome).resolves.toBe('Mattermost contract request failed (GET /api/v4/posts/post%3Aid)');
      await expect(outcome).resolves.not.toContain(credential);
    } finally {
      vi.useRealTimers();
    }
  });
});
