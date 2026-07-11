import { EventEmitter } from 'events';

import { describe, expect, it, vi } from 'vitest';

import { MattermostClient, NodeMattermostTransport, type MattermostTransport } from './mattermost-client.js';

function authenticatedSocket() {
  let receive: ((payload: string) => void) | undefined;
  return {
    send: vi.fn(() => queueMicrotask(() => receive?.(JSON.stringify({ status: 'OK', seq_reply: 1 })))),
    close: vi.fn(),
    onMessage: vi.fn((listener: (payload: string) => void) => {
      receive = listener;
      return vi.fn();
    }),
  };
}

describe('MattermostClient authentication', () => {
  it('validates the configured bot with a bearer-authenticated users/me request', async () => {
    const credential = 'fixture-credential-value';
    const transport: MattermostTransport = {
      request: vi.fn().mockResolvedValue({ status: 200, body: { id: 'bot-user-id' } }),
      openWebSocket: vi.fn().mockResolvedValue(authenticatedSocket()),
    };
    const client = new MattermostClient(
      {
        baseUrl: 'https://mattermost.example.test/',
        botToken: credential,
        instanceKey: 'primary',
      },
      transport,
    );

    await client.setup();

    expect(transport.request).toHaveBeenCalledOnce();
    expect(transport.request).toHaveBeenCalledWith({
      method: 'GET',
      url: 'https://mattermost.example.test/api/v4/users/me',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${credential}`,
      },
    });
  });

  it('fails setup on invalid credentials without opening a WebSocket', async () => {
    const transport: MattermostTransport = {
      request: vi.fn().mockResolvedValue({ status: 401, body: { message: 'authentication rejected' } }),
      openWebSocket: vi.fn(),
    };
    const client = new MattermostClient(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'rejected-fixture-credential',
        instanceKey: 'primary',
      },
      transport,
    );

    await expect(client.setup()).rejects.toThrow('Mattermost authentication failed');
    expect(transport.openWebSocket).not.toHaveBeenCalled();
  });

  it('authenticates the WebSocket with a challenge before setup completes', async () => {
    let receive: ((payload: string) => void) | undefined;
    const socket = {
      send: vi.fn(),
      close: vi.fn(),
      onMessage: vi.fn((listener: (payload: string) => void) => {
        receive = listener;
        return vi.fn();
      }),
    };
    const transport: MattermostTransport = {
      request: vi.fn().mockResolvedValue({ status: 200, body: { id: 'bot-user-id' } }),
      openWebSocket: vi.fn().mockResolvedValue(socket),
    };
    const client = new MattermostClient(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'websocket-fixture-credential',
        instanceKey: 'primary',
      },
      transport,
    );

    let setupComplete = false;
    const setup = client.setup().then(() => {
      setupComplete = true;
    });
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());

    expect(transport.openWebSocket).toHaveBeenCalledWith('wss://mattermost.example.test/api/v4/websocket');
    expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({
      seq: 1,
      action: 'authentication_challenge',
      data: { token: 'websocket-fixture-credential' },
    });
    expect(setupComplete).toBe(false);

    receive?.(JSON.stringify({ status: 'OK', seq_reply: 1 }));
    await setup;
    expect(setupComplete).toBe(true);
  });

  it('owns and clears a bounded WebSocket authentication timer', async () => {
    let receive: ((payload: string) => void) | undefined;
    const socket = {
      send: vi.fn(),
      close: vi.fn(),
      onMessage: vi.fn((listener: (payload: string) => void) => {
        receive = listener;
        return vi.fn();
      }),
    };
    const timerHandle = Symbol('auth-timer');
    const timers = {
      setTimeout: vi.fn(() => timerHandle),
      clearTimeout: vi.fn(),
    };
    const client = new MattermostClient(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'timer-fixture-credential',
        instanceKey: 'primary',
      },
      {
        request: vi.fn().mockResolvedValue({ status: 200, body: { id: 'bot-user-id' } }),
        openWebSocket: vi.fn().mockResolvedValue(socket),
      },
      timers,
    );

    const setup = client.setup();
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
    receive?.(JSON.stringify({ status: 'OK', seq_reply: 1 }));
    await setup;

    expect(timers.setTimeout).toHaveBeenCalledOnce();
    expect(timers.clearTimeout).toHaveBeenCalledWith(timerHandle);
  });

  it('teardown closes the socket and cancels pending authentication', async () => {
    let receive: ((payload: string) => void) | undefined;
    const socket = {
      send: vi.fn(),
      close: vi.fn(),
      onMessage: vi.fn((listener: (payload: string) => void) => {
        receive = listener;
        return vi.fn();
      }),
    };
    const timerHandle = Symbol('pending-auth-timer');
    const timers = {
      setTimeout: vi.fn(() => timerHandle),
      clearTimeout: vi.fn(),
    };
    const client = new MattermostClient(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'teardown-fixture-credential',
        instanceKey: 'primary',
      },
      {
        request: vi.fn().mockResolvedValue({ status: 200, body: { id: 'bot-user-id' } }),
        openWebSocket: vi.fn().mockResolvedValue(socket),
      },
      timers,
    );

    const setup = client.setup().then(
      () => 'resolved',
      () => 'rejected',
    );
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
    const teardown = (client as unknown as { teardown?: () => void }).teardown?.bind(client);
    teardown?.();
    if (!teardown) receive?.(JSON.stringify({ status: 'OK', seq_reply: 1 }));
    const outcome = await setup;

    expect(teardown).toBeTypeOf('function');
    expect(outcome).toBe('rejected');
    expect(socket.close).toHaveBeenCalledOnce();
    expect(timers.clearTimeout).toHaveBeenCalledWith(timerHandle);

    teardown?.();
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it('redacts the bot credential from REST transport failures', async () => {
    const credential = 'rest-redaction-fixture-credential';
    const transport: MattermostTransport = {
      request: vi.fn().mockRejectedValue(new Error(`request failed with Authorization: Bearer ${credential}`)),
      openWebSocket: vi.fn(),
    };
    const client = new MattermostClient(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: credential,
        instanceKey: 'primary',
      },
      transport,
    );

    const error = await client.setup().catch((caught: unknown) => caught);
    const rendered = `${String(error)}\n${error instanceof Error ? error.stack : ''}\n${JSON.stringify(error)}`;

    expect(error).toBeInstanceOf(Error);
    expect(rendered).not.toContain(credential);
    expect(rendered).not.toContain('Authorization: Bearer');
    expect(transport.openWebSocket).not.toHaveBeenCalled();
  });

  it('redacts the bot credential from WebSocket transport failures', async () => {
    const credential = 'websocket-redaction-fixture-credential';
    const transport: MattermostTransport = {
      request: vi.fn().mockResolvedValue({ status: 200, body: { id: 'bot-user-id' } }),
      openWebSocket: vi.fn().mockRejectedValue(new Error(`socket URL leaked token=${credential}`)),
    };
    const client = new MattermostClient(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: credential,
        instanceKey: 'primary',
      },
      transport,
    );

    const error = await client.setup().catch((caught: unknown) => caught);
    const rendered = `${String(error)}\n${error instanceof Error ? error.stack : ''}\n${JSON.stringify(error)}`;

    expect(error).toBeInstanceOf(Error);
    expect(rendered).not.toContain(credential);
    expect(rendered).not.toContain('token=');
  });

  it('redacts the bot credential when sending the WebSocket challenge fails', async () => {
    const credential = 'challenge-redaction-fixture-credential';
    const socket = {
      send: vi.fn(() => {
        throw new Error(`challenge contained ${credential}`);
      }),
      close: vi.fn(),
      onMessage: vi.fn(() => vi.fn()),
    };
    const client = new MattermostClient(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: credential,
        instanceKey: 'primary',
      },
      {
        request: vi.fn().mockResolvedValue({ status: 200, body: { id: 'bot-user-id' } }),
        openWebSocket: vi.fn().mockResolvedValue(socket),
      },
    );

    const error = await client.setup().catch((caught: unknown) => caught);
    client.teardown();
    const rendered = `${String(error)}\n${error instanceof Error ? error.stack : ''}\n${JSON.stringify(error)}`;

    expect(error).toBeInstanceOf(Error);
    expect(rendered).not.toContain(credential);
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it('rejects a failed WebSocket authentication response and closes the socket', async () => {
    let receive: ((payload: string) => void) | undefined;
    const socket = {
      send: vi.fn(),
      close: vi.fn(),
      onMessage: vi.fn((listener: (payload: string) => void) => {
        receive = listener;
        return vi.fn();
      }),
    };
    const client = new MattermostClient(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'failed-websocket-fixture-credential',
        instanceKey: 'primary',
      },
      {
        request: vi.fn().mockResolvedValue({ status: 200, body: { id: 'bot-user-id' } }),
        openWebSocket: vi.fn().mockResolvedValue(socket),
      },
    );

    const setup = client.setup();
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
    receive?.(
      JSON.stringify({
        status: 'FAIL',
        seq_reply: 1,
        error: { message: 'authentication rejected' },
      }),
    );

    await expect(setup).rejects.toThrow('Mattermost WebSocket authentication failed');
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it('fails closed when users/me omits the authenticated user id', async () => {
    const transport: MattermostTransport = {
      request: vi.fn().mockResolvedValue({ status: 200, body: {} }),
      openWebSocket: vi.fn().mockResolvedValue(authenticatedSocket()),
    };
    const client = new MattermostClient(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'identity-fixture-credential',
        instanceKey: 'primary',
      },
      transport,
    );

    await expect(client.setup()).rejects.toThrow('Mattermost authentication identity response was invalid');
    expect(transport.openWebSocket).not.toHaveBeenCalled();
  });

  it('forwards raw events only after authentication and unsubscribes on teardown', async () => {
    const listeners = new Set<(payload: string) => void>();
    const socket = {
      send: vi.fn(),
      close: vi.fn(),
      onMessage: vi.fn((listener: (payload: string) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    };
    const emit = (payload: string) => {
      for (const listener of [...listeners]) listener(payload);
    };
    const onEvent = vi.fn();
    const client = new MattermostClient(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'event-fixture-credential',
        instanceKey: 'primary',
      },
      {
        request: vi.fn().mockResolvedValue({ status: 200, body: { id: 'authenticated-bot-id' } }),
        openWebSocket: vi.fn().mockResolvedValue(socket),
      },
    );

    const setup = client.setup(onEvent);
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
    emit(JSON.stringify({ event: 'posted', data: { post: '{}' } }));
    expect(onEvent).not.toHaveBeenCalled();
    emit(JSON.stringify({ status: 'OK', seq_reply: 1 }));
    await setup;

    const rawEvent = JSON.stringify({ event: 'posted', data: { post: '{"id":"post-id"}' } });
    emit(rawEvent);
    expect(onEvent).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith(rawEvent, { botUserId: 'authenticated-bot-id' });

    client.teardown();
    emit(rawEvent);
    expect(onEvent).toHaveBeenCalledOnce();
  });
});

describe('NodeMattermostTransport', () => {
  it('adapts host fetch responses to the Mattermost transport contract', async () => {
    const fetch = vi.fn().mockResolvedValue({
      status: 200,
      json: vi.fn().mockResolvedValue({ id: 'bot-user-id' }),
    });
    const transport = new NodeMattermostTransport(fetch);

    const response = await transport.request({
      method: 'GET',
      url: 'https://mattermost.example.test/api/v4/users/me',
      headers: { Authorization: 'Bearer fixture' },
    });

    expect(fetch).toHaveBeenCalledWith('https://mattermost.example.test/api/v4/users/me', {
      method: 'GET',
      headers: { Authorization: 'Bearer fixture' },
      body: undefined,
    });
    expect(response).toEqual({ status: 200, body: { id: 'bot-user-id' } });
  });

  it('adapts a ws connection and text messages to the transport socket contract', async () => {
    class FakeWebSocket extends EventEmitter {
      static instances: FakeWebSocket[] = [];
      readonly send = vi.fn();
      readonly close = vi.fn();

      constructor(readonly url: string) {
        super();
        FakeWebSocket.instances.push(this);
      }
    }

    const fetch = vi.fn();
    const transport = new NodeMattermostTransport(fetch, FakeWebSocket);
    const opening = transport.openWebSocket('wss://mattermost.example.test/api/v4/websocket');
    const rawSocket = FakeWebSocket.instances[0];
    let opened = false;
    void opening.then(
      () => {
        opened = true;
      },
      () => undefined,
    );
    await Promise.resolve();
    expect(opened).toBe(false);

    if (!rawSocket) {
      await opening.catch(() => undefined);
      expect(FakeWebSocket.instances).toHaveLength(1);
      return;
    }

    rawSocket.emit('open');
    const socket = await opening;
    const receive = vi.fn();
    const unsubscribe = socket.onMessage(receive);
    rawSocket.emit('message', Buffer.from('{"status":"OK"}'));

    expect(rawSocket.url).toBe('wss://mattermost.example.test/api/v4/websocket');
    expect(receive).toHaveBeenCalledWith('{"status":"OK"}');
    socket.send('challenge');
    expect(rawSocket.send).toHaveBeenCalledWith('challenge');

    unsubscribe();
    rawSocket.emit('message', Buffer.from('ignored'));
    expect(receive).toHaveBeenCalledOnce();
    socket.close();
    expect(rawSocket.close).toHaveBeenCalledOnce();
  });
});
