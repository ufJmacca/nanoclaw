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

function reconnectableSocket() {
  let receive: ((payload: string) => void) | undefined;
  let notifyClose: (() => void) | undefined;
  const socket = {
    send: vi.fn(),
    close: vi.fn(),
    onMessage: vi.fn((listener: (payload: string) => void) => {
      receive = listener;
      return vi.fn();
    }),
    onClose: vi.fn((listener: () => void) => {
      notifyClose = listener;
      return vi.fn();
    }),
  };
  return { socket, emit: (payload: string) => receive?.(payload), terminate: () => notifyClose?.() };
}

function reconnectTimers() {
  const scheduled: Array<{ callback: () => void; delayMs: number; cleared: boolean; fired: boolean }> = [];
  return {
    timers: {
      setTimeout: vi.fn((callback: () => void, delayMs = 0) => {
        const handle = { callback, delayMs, cleared: false, fired: false };
        scheduled.push(handle);
        return handle;
      }),
      clearTimeout: vi.fn((handle: unknown) => {
        (handle as (typeof scheduled)[number]).cleared = true;
      }),
    },
    fireReconnect() {
      const timer = scheduled.find((candidate) => !candidate.cleared && !candidate.fired);
      if (!timer) throw new Error('Reconnect timer was not scheduled');
      timer.fired = true;
      timer.callback();
    },
    activeDelay() {
      return scheduled.find((candidate) => !candidate.cleared && !candidate.fired)?.delayMs;
    },
  };
}

function deferredVoid() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('MattermostClient authentication', () => {
  it('returns the authenticated host context without exposing the credential', async () => {
    const client = new MattermostClient(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'context-fixture-credential',
        instanceKey: 'primary',
      },
      {
        request: vi.fn().mockResolvedValue({ status: 200, body: { id: 'bot-user-id' } }),
        openWebSocket: vi.fn().mockResolvedValue(authenticatedSocket()),
      },
    );

    await expect(client.setup()).resolves.toEqual({ botUserId: 'bot-user-id' });
  });

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

  it('subscribes socket termination before waiting for authentication', async () => {
    let notifyClose: (() => void) | undefined;
    const socket = {
      send: vi.fn(),
      close: vi.fn(),
      onMessage: vi.fn(() => vi.fn()),
      onClose: vi.fn((listener: () => void) => {
        notifyClose = listener;
        return vi.fn();
      }),
    };
    const client = new MattermostClient(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'auth-close-fixture-credential',
        instanceKey: 'primary',
      },
      {
        request: vi.fn().mockResolvedValue({ status: 200, body: { id: 'bot-user-id' } }),
        openWebSocket: vi.fn().mockResolvedValue(socket),
      },
    );

    const setup = client.setup().then(
      () => 'resolved',
      () => 'rejected',
    );
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
    const subscribedBeforeAuthentication = socket.onClose.mock.calls.length;
    if (notifyClose) notifyClose();
    else client.teardown();

    expect(await setup).toBe('rejected');
    expect(subscribedBeforeAuthentication).toBe(1);
    expect(socket.close).toHaveBeenCalledOnce();
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

  it('reconnects after an unexpected close with bounded exponential backoff', async () => {
    let receive: ((payload: string) => void) | undefined;
    let notifyClose: (() => void) | undefined;
    const socket = {
      send: vi.fn(),
      close: vi.fn(),
      onMessage: vi.fn((listener: (payload: string) => void) => {
        receive = listener;
        return vi.fn();
      }),
      onClose: vi.fn((listener: () => void) => {
        notifyClose = listener;
        return vi.fn();
      }),
    };
    const scheduled: Array<{
      callback: () => void;
      delayMs: number;
      cleared: boolean;
      fired: boolean;
    }> = [];
    const timers = {
      setTimeout: vi.fn((callback: () => void, delayMs: number) => {
        const handle = { callback, delayMs, cleared: false, fired: false };
        scheduled.push(handle);
        return handle;
      }),
      clearTimeout: vi.fn((handle: unknown) => {
        (handle as (typeof scheduled)[number]).cleared = true;
      }),
    };
    const activeDelay = (): number | undefined => scheduled.find((timer) => !timer.cleared && !timer.fired)?.delayMs;
    const fireActive = (): void => {
      const timer = scheduled.find((candidate) => !candidate.cleared && !candidate.fired);
      if (!timer) throw new Error('No active reconnect timer');
      timer.fired = true;
      timer.callback();
    };
    const openWebSocket = vi.fn().mockResolvedValueOnce(socket).mockRejectedValue(new Error('offline'));
    const client = new MattermostClient(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'reconnect-fixture-credential',
        instanceKey: 'primary',
      },
      {
        request: vi.fn().mockResolvedValue({ status: 200, body: { id: 'bot-user-id' } }),
        openWebSocket,
      },
      timers,
    );

    const setup = client.setup();
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
    receive?.(JSON.stringify({ status: 'OK', seq_reply: 1 }));
    await setup;
    notifyClose?.();

    for (const expectedDelay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      await vi.waitFor(() => expect(activeDelay()).toBe(expectedDelay));
      if (expectedDelay !== 30_000 || openWebSocket.mock.calls.length < 7) fireActive();
    }
    client.teardown();
    expect(activeDelay()).toBeUndefined();
  });

  it('continues exponential backoff across authenticated connections whose recovery fails', async () => {
    const first = reconnectableSocket();
    const second = reconnectableSocket();
    const { timers, fireReconnect, activeDelay } = reconnectTimers();
    const openWebSocket = vi.fn().mockResolvedValueOnce(first.socket).mockResolvedValueOnce(second.socket);
    const onSequenceGap = vi.fn().mockRejectedValue(new Error('injected unprovable recovery window'));
    const client = new MattermostClient(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'recovery-backoff-fixture-credential',
        instanceKey: 'primary',
      },
      {
        request: vi.fn().mockResolvedValue({ status: 200, body: { id: 'bot-user-id' } }),
        openWebSocket,
      },
      timers,
      { onSequenceGap },
    );

    const setup = client.setup(vi.fn());
    await vi.waitFor(() => expect(first.socket.send).toHaveBeenCalledOnce());
    first.emit(JSON.stringify({ status: 'OK', seq_reply: 1 }));
    await setup;
    first.emit(JSON.stringify({ event: 'hello', seq: 0, data: { connection_id: 'connection-a' } }));
    first.emit(JSON.stringify({ event: 'posted', seq: 2, data: { post: '{}' } }));
    await vi.waitFor(() => expect(first.socket.close).toHaveBeenCalledOnce());
    expect(activeDelay()).toBe(1_000);

    fireReconnect();
    await vi.waitFor(() => expect(second.socket.send).toHaveBeenCalledOnce());
    second.emit(JSON.stringify({ status: 'OK', seq_reply: 1 }));
    second.emit(JSON.stringify({ event: 'hello', seq: 0, data: { connection_id: 'connection-a' } }));
    second.emit(JSON.stringify({ event: 'posted', seq: 2, data: { post: '{}' } }));
    await vi.waitFor(() => expect(second.socket.close).toHaveBeenCalledOnce());

    expect(activeDelay()).toBe(2_000);
    client.teardown();
  });

  it('resumes the server connection id from the next expected sequence', async () => {
    const socketState = () => {
      let receive: ((payload: string) => void) | undefined;
      let notifyClose: (() => void) | undefined;
      const socket = {
        send: vi.fn(),
        close: vi.fn(),
        onMessage: vi.fn((listener: (payload: string) => void) => {
          receive = listener;
          return vi.fn();
        }),
        onClose: vi.fn((listener: () => void) => {
          notifyClose = listener;
          return vi.fn();
        }),
      };
      return { socket, emit: (payload: string) => receive?.(payload), close: () => notifyClose?.() };
    };
    const first = socketState();
    const second = socketState();
    const scheduled: Array<{ callback: () => void; cleared: boolean }> = [];
    const timers = {
      setTimeout: vi.fn((callback: () => void) => {
        const handle = { callback, cleared: false };
        scheduled.push(handle);
        return handle;
      }),
      clearTimeout: vi.fn((handle: unknown) => {
        (handle as (typeof scheduled)[number]).cleared = true;
      }),
    };
    const openWebSocket = vi.fn().mockResolvedValueOnce(first.socket).mockResolvedValueOnce(second.socket);
    const onEvent = vi.fn();
    const client = new MattermostClient(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'resume-fixture-credential',
        instanceKey: 'primary',
      },
      {
        request: vi.fn().mockResolvedValue({ status: 200, body: { id: 'bot-user-id' } }),
        openWebSocket,
      },
      timers,
    );

    const setup = client.setup(onEvent);
    await vi.waitFor(() => expect(first.socket.send).toHaveBeenCalledOnce());
    first.emit(JSON.stringify({ status: 'OK', seq_reply: 1 }));
    await setup;
    first.emit(JSON.stringify({ event: 'hello', seq: 0, data: { connection_id: 'connection-a' } }));
    first.emit(JSON.stringify({ event: 'posted', seq: 1, data: { post: '{}' } }));
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(2));
    first.close();
    const reconnectTimer = scheduled.find((timer) => !timer.cleared);
    if (!reconnectTimer) throw new Error('Reconnect timer was not scheduled');
    reconnectTimer.callback();
    await vi.waitFor(() => expect(openWebSocket).toHaveBeenCalledTimes(2));

    expect(openWebSocket).toHaveBeenLastCalledWith(
      'wss://mattermost.example.test/api/v4/websocket?connection_id=connection-a&sequence_number=2',
    );
    client.teardown();
  });

  it('replays a failed lifecycle sequence instead of resuming past it', async () => {
    const first = reconnectableSocket();
    const second = reconnectableSocket();
    const { timers, fireReconnect } = reconnectTimers();
    const openWebSocket = vi.fn().mockResolvedValueOnce(first.socket).mockResolvedValueOnce(second.socket);
    const onEvent = vi.fn((payload: string) => {
      const event = JSON.parse(payload) as { event?: string };
      return event.event === 'user_removed'
        ? Promise.reject(new Error('injected lifecycle failure'))
        : Promise.resolve();
    });
    const client = new MattermostClient(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'lifecycle-replay-fixture-credential',
        instanceKey: 'primary',
      },
      {
        request: vi.fn().mockResolvedValue({ status: 200, body: { id: 'bot-user-id' } }),
        openWebSocket,
      },
      timers,
    );

    const setup = client.setup(onEvent);
    await vi.waitFor(() => expect(first.socket.send).toHaveBeenCalledOnce());
    first.emit(JSON.stringify({ status: 'OK', seq_reply: 1 }));
    await setup;
    first.emit(JSON.stringify({ event: 'hello', seq: 0, data: { connection_id: 'connection-a' } }));
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledOnce());
    first.emit(
      JSON.stringify({
        event: 'user_removed',
        seq: 1,
        data: { channel_id: 'channel-a' },
        broadcast: { user_id: 'bot-user-id' },
      }),
    );
    await vi.waitFor(() => expect(first.socket.close).toHaveBeenCalledOnce());

    fireReconnect();
    await vi.waitFor(() => expect(openWebSocket).toHaveBeenCalledTimes(2));

    expect(openWebSocket).toHaveBeenLastCalledWith(
      'wss://mattermost.example.test/api/v4/websocket?connection_id=connection-a&sequence_number=1',
    );
    client.teardown();
  });

  it('does not commit a later sequence while an earlier handler is pending', async () => {
    const first = reconnectableSocket();
    const second = reconnectableSocket();
    const { timers, fireReconnect } = reconnectTimers();
    const firstHandler = deferredVoid();
    const openWebSocket = vi.fn().mockResolvedValueOnce(first.socket).mockResolvedValueOnce(second.socket);
    const onEvent = vi.fn((payload: string) => {
      const event = JSON.parse(payload) as { seq?: number };
      return event.seq === 1 ? firstHandler.promise : Promise.resolve();
    });
    const client = new MattermostClient(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'contiguous-pending-fixture-credential',
        instanceKey: 'primary',
      },
      {
        request: vi.fn().mockResolvedValue({ status: 200, body: { id: 'bot-user-id' } }),
        openWebSocket,
      },
      timers,
    );

    const setup = client.setup(onEvent);
    await vi.waitFor(() => expect(first.socket.send).toHaveBeenCalledOnce());
    first.emit(JSON.stringify({ status: 'OK', seq_reply: 1 }));
    await setup;
    first.emit(JSON.stringify({ event: 'hello', seq: 0, data: { connection_id: 'connection-a' } }));
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledOnce());
    first.emit(JSON.stringify({ event: 'posted', seq: 1, data: { post: '{}' } }));
    first.emit(JSON.stringify({ event: 'posted', seq: 2, data: { post: '{}' } }));
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(3));
    expect(onEvent.mock.calls.map(([payload]) => (JSON.parse(payload) as { seq: number }).seq)).toEqual([0, 1, 2]);

    first.terminate();
    fireReconnect();
    await vi.waitFor(() => expect(openWebSocket).toHaveBeenCalledTimes(2));

    expect(openWebSocket).toHaveBeenLastCalledWith(
      'wss://mattermost.example.test/api/v4/websocket?connection_id=connection-a&sequence_number=1',
    );
    firstHandler.resolve();
    client.teardown();
  });

  it('commits out-of-order successes once the contiguous predecessor settles', async () => {
    const first = reconnectableSocket();
    const second = reconnectableSocket();
    const { timers, fireReconnect } = reconnectTimers();
    const firstHandler = deferredVoid();
    const openWebSocket = vi.fn().mockResolvedValueOnce(first.socket).mockResolvedValueOnce(second.socket);
    const onEvent = vi.fn((payload: string) => {
      const event = JSON.parse(payload) as { seq?: number };
      return event.seq === 1 ? firstHandler.promise : Promise.resolve();
    });
    const client = new MattermostClient(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'contiguous-success-fixture-credential',
        instanceKey: 'primary',
      },
      {
        request: vi.fn().mockResolvedValue({ status: 200, body: { id: 'bot-user-id' } }),
        openWebSocket,
      },
      timers,
    );

    const setup = client.setup(onEvent);
    await vi.waitFor(() => expect(first.socket.send).toHaveBeenCalledOnce());
    first.emit(JSON.stringify({ status: 'OK', seq_reply: 1 }));
    await setup;
    first.emit(JSON.stringify({ event: 'hello', seq: 0, data: { connection_id: 'connection-a' } }));
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledOnce());
    first.emit(JSON.stringify({ event: 'posted', seq: 1, data: { post: '{}' } }));
    first.emit(JSON.stringify({ event: 'posted', seq: 2, data: { post: '{}' } }));
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(3));
    firstHandler.resolve();
    await Promise.resolve();
    await Promise.resolve();

    first.terminate();
    fireReconnect();
    await vi.waitFor(() => expect(openWebSocket).toHaveBeenCalledTimes(2));

    expect(openWebSocket).toHaveBeenLastCalledWith(
      'wss://mattermost.example.test/api/v4/websocket?connection_id=connection-a&sequence_number=3',
    );
    client.teardown();
  });

  it('prevents an old generation recovery from overwriting replacement resume state', async () => {
    const first = reconnectableSocket();
    const second = reconnectableSocket();
    const third = reconnectableSocket();
    const { timers, fireReconnect } = reconnectTimers();
    const oldRecovery = deferredVoid();
    const onSequenceGap = vi.fn(() => oldRecovery.promise);
    const onEvent = vi.fn().mockResolvedValue(undefined);
    const openWebSocket = vi
      .fn()
      .mockResolvedValueOnce(first.socket)
      .mockResolvedValueOnce(second.socket)
      .mockResolvedValueOnce(third.socket);
    const client = new MattermostClient(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'generation-resume-fixture-credential',
        instanceKey: 'primary',
      },
      {
        request: vi.fn().mockResolvedValue({ status: 200, body: { id: 'bot-user-id' } }),
        openWebSocket,
      },
      timers,
      { onSequenceGap },
    );

    const setup = client.setup(onEvent);
    await vi.waitFor(() => expect(first.socket.send).toHaveBeenCalledOnce());
    first.emit(JSON.stringify({ status: 'OK', seq_reply: 1 }));
    await setup;
    first.emit(JSON.stringify({ event: 'hello', seq: 0, data: { connection_id: 'connection-a' } }));
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledOnce());
    first.emit(JSON.stringify({ event: 'posted', seq: 3, data: { post: '{}' } }));
    await vi.waitFor(() => expect(onSequenceGap).toHaveBeenCalledOnce());

    first.terminate();
    fireReconnect();
    await vi.waitFor(() => expect(second.socket.send).toHaveBeenCalledOnce());
    expect(openWebSocket).toHaveBeenLastCalledWith(
      'wss://mattermost.example.test/api/v4/websocket?connection_id=connection-a&sequence_number=1',
    );
    second.emit(JSON.stringify({ status: 'OK', seq_reply: 1 }));
    second.emit(JSON.stringify({ event: 'hello', seq: 0, data: { connection_id: 'connection-b' } }));
    second.emit(JSON.stringify({ event: 'posted', seq: 1, data: { post: '{}' } }));
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(3));

    oldRecovery.resolve();
    await Promise.resolve();
    await Promise.resolve();
    second.terminate();
    fireReconnect();
    await vi.waitFor(() => expect(openWebSocket).toHaveBeenCalledTimes(3));

    expect(openWebSocket).toHaveBeenLastCalledWith(
      'wss://mattermost.example.test/api/v4/websocket?connection_id=connection-b&sequence_number=2',
    );
    client.teardown();
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
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledOnce());
    expect(onEvent).toHaveBeenCalledWith(rawEvent, { botUserId: 'authenticated-bot-id' });

    client.teardown();
    emit(rawEvent);
    await Promise.resolve();
    expect(onEvent).toHaveBeenCalledOnce();
  });

  it('tracks server event sequence and reports the exact missed window', async () => {
    let receive: ((payload: string) => void) | undefined;
    const socket = {
      send: vi.fn(),
      close: vi.fn(),
      onMessage: vi.fn((listener: (payload: string) => void) => {
        receive = listener;
        return vi.fn();
      }),
    };
    const onSequenceGap = vi.fn();
    const onEvent = vi.fn();
    const client = new MattermostClient(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'sequence-fixture-credential',
        instanceKey: 'primary',
      },
      {
        request: vi.fn().mockResolvedValue({ status: 200, body: { id: 'bot-user-id' } }),
        openWebSocket: vi.fn().mockResolvedValue(socket),
      },
      undefined,
      { onSequenceGap },
    );

    const setup = client.setup(onEvent);
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
    receive?.(JSON.stringify({ status: 'OK', seq_reply: 1 }));
    await setup;
    receive?.(JSON.stringify({ event: 'hello', seq: 0, data: {} }));
    receive?.(JSON.stringify({ event: 'posted', seq: 1, data: { post: '{}' } }));
    receive?.('not-json');
    receive?.(JSON.stringify({ event: 'posted', data: { post: '{}' } }));
    receive?.(JSON.stringify({ event: 'posted', seq: 3, data: { post: '{}' } }));
    receive?.(JSON.stringify({ event: 'posted', seq: 4, data: { post: '{}' } }));

    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(6));
    expect(onSequenceGap).toHaveBeenCalledOnce();
    expect(onSequenceGap).toHaveBeenCalledWith({ expected: 2, received: 3 });
  });

  it('holds live frames behind asynchronous sequence-gap recovery', async () => {
    let receive: ((payload: string) => void) | undefined;
    let releaseRecovery: (() => void) | undefined;
    const recovery = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    const socket = {
      send: vi.fn(),
      close: vi.fn(),
      onMessage: vi.fn((listener: (payload: string) => void) => {
        receive = listener;
        return vi.fn();
      }),
    };
    const onEvent = vi.fn();
    const onSequenceGap = vi.fn(() => recovery);
    const client = new MattermostClient(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'gap-barrier-fixture-credential',
        instanceKey: 'primary',
      },
      {
        request: vi.fn().mockResolvedValue({ status: 200, body: { id: 'bot-user-id' } }),
        openWebSocket: vi.fn().mockResolvedValue(socket),
      },
      undefined,
      { onSequenceGap },
    );
    const setup = client.setup(onEvent);
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
    receive?.(JSON.stringify({ status: 'OK', seq_reply: 1 }));
    await setup;
    receive?.(JSON.stringify({ event: 'hello', seq: 0, data: {} }));
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledOnce());
    onEvent.mockClear();

    receive?.(JSON.stringify({ event: 'posted', seq: 2, data: { post: '{}' } }));
    receive?.(JSON.stringify({ event: 'posted', seq: 3, data: { post: '{}' } }));
    await Promise.resolve();
    expect(onSequenceGap).toHaveBeenCalledWith({ expected: 1, received: 2 });
    expect(onEvent).not.toHaveBeenCalled();

    releaseRecovery?.();
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(2));
    expect(onEvent.mock.calls.map(([payload]) => JSON.parse(payload).seq)).toEqual([2, 3]);
  });

  it('holds a replacement connection behind catch-up before releasing live frames', async () => {
    const socketState = () => {
      let receive: ((payload: string) => void) | undefined;
      let notifyClose: (() => void) | undefined;
      const socket = {
        send: vi.fn(),
        close: vi.fn(),
        onMessage: vi.fn((listener: (payload: string) => void) => {
          receive = listener;
          return vi.fn();
        }),
        onClose: vi.fn((listener: () => void) => {
          notifyClose = listener;
          return vi.fn();
        }),
      };
      return { socket, emit: (payload: string) => receive?.(payload), close: () => notifyClose?.() };
    };
    const first = socketState();
    const second = socketState();
    const scheduled: Array<{ callback: () => void; cleared: boolean }> = [];
    const timers = {
      setTimeout: vi.fn((callback: () => void) => {
        const handle = { callback, cleared: false };
        scheduled.push(handle);
        return handle;
      }),
      clearTimeout: vi.fn((handle: unknown) => {
        (handle as (typeof scheduled)[number]).cleared = true;
      }),
    };
    let releaseRecovery: (() => void) | undefined;
    const recovery = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    const onConnectionReset = vi.fn(() => recovery);
    const onEvent = vi.fn();
    const client = new MattermostClient(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'connection-reset-fixture-credential',
        instanceKey: 'primary',
      },
      {
        request: vi.fn().mockResolvedValue({ status: 200, body: { id: 'bot-user-id' } }),
        openWebSocket: vi.fn().mockResolvedValueOnce(first.socket).mockResolvedValueOnce(second.socket),
      },
      timers,
      { onConnectionReset } as unknown as ConstructorParameters<typeof MattermostClient>[3],
    );
    const setup = client.setup(onEvent);
    await vi.waitFor(() => expect(first.socket.send).toHaveBeenCalledOnce());
    first.emit(JSON.stringify({ status: 'OK', seq_reply: 1 }));
    await setup;
    first.emit(JSON.stringify({ event: 'hello', seq: 0, data: { connection_id: 'connection-a' } }));
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledOnce());
    first.close();
    const reconnectTimer = scheduled.find((timer) => !timer.cleared);
    if (!reconnectTimer) throw new Error('Reconnect timer was not scheduled');
    reconnectTimer.callback();
    await vi.waitFor(() => expect(second.socket.send).toHaveBeenCalledOnce());
    second.emit(JSON.stringify({ status: 'OK', seq_reply: 1 }));
    second.emit(JSON.stringify({ event: 'hello', seq: 0, data: { connection_id: 'connection-b' } }));
    second.emit(JSON.stringify({ event: 'posted', seq: 1, data: { post: '{}' } }));

    await vi.waitFor(() => expect(onConnectionReset).toHaveBeenCalledOnce());
    expect(onConnectionReset).toHaveBeenCalledWith({
      previousConnectionId: 'connection-a',
      receivedConnectionId: 'connection-b',
    });
    expect(onEvent).toHaveBeenCalledOnce();

    releaseRecovery?.();
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(3));
    expect(onEvent.mock.calls.slice(1).map(([payload]) => JSON.parse(payload).seq)).toEqual([0, 1]);
    client.teardown();
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

  it('normalizes response headers and tolerates a non-JSON rate-limit body', async () => {
    const fetch = vi.fn().mockResolvedValue({
      status: 429,
      headers: new Headers({ 'Retry-After': '2', 'X-RateLimit-Reset': '7' }),
      json: vi.fn().mockRejectedValue(new SyntaxError('not json')),
    });
    const transport = new NodeMattermostTransport(fetch);

    const response = await transport.request({
      method: 'POST',
      url: 'https://mattermost.example.test/api/v4/posts',
      headers: { Authorization: 'Bearer fixture' },
      body: '{}',
    });

    expect(response).toEqual({
      status: 429,
      body: undefined,
      headers: { 'retry-after': '2', 'x-ratelimit-reset': '7' },
    });
  });

  it('passes multipart request bodies through without setting a content type', async () => {
    const fetch = vi.fn().mockResolvedValue({
      status: 201,
      json: vi.fn().mockResolvedValue({ file_infos: [{ id: 'uploaded-file-id' }] }),
    });
    const transport = new NodeMattermostTransport(fetch);
    const form = new FormData();
    form.append('files', new Blob([Buffer.from('fixture bytes')]), 'fixture.txt');

    const response = await transport.request({
      method: 'POST',
      url: 'https://mattermost.example.test/api/v4/files?channel_id=channel-id',
      headers: { Authorization: 'Bearer fixture' },
      body: form,
    });

    expect(fetch).toHaveBeenCalledWith('https://mattermost.example.test/api/v4/files?channel_id=channel-id', {
      method: 'POST',
      headers: { Authorization: 'Bearer fixture' },
      body: form,
    });
    expect(response.body).toEqual({ file_infos: [{ id: 'uploaded-file-id' }] });
  });

  it('returns authenticated binary response bytes without attempting JSON parsing', async () => {
    const bytes = Uint8Array.from([0, 1, 2, 254, 255]);
    const json = vi.fn();
    const fetch = vi.fn().mockResolvedValue({
      status: 200,
      json,
      arrayBuffer: vi.fn().mockResolvedValue(bytes.buffer),
    });
    const transport = new NodeMattermostTransport(fetch);

    const response = await transport.request({
      method: 'GET',
      url: 'https://mattermost.example.test/api/v4/files/file-id',
      headers: { Authorization: 'Bearer fixture' },
      responseType: 'binary',
    });

    expect(json).not.toHaveBeenCalled();
    expect(Buffer.isBuffer(response.body)).toBe(true);
    expect(response.body).toEqual(Buffer.from(bytes));
  });

  it('aborts a stalled binary body at the request timeout boundary', async () => {
    let observedSignal: AbortSignal | undefined;
    const fetch = vi.fn(async (_url: string, init: { signal?: AbortSignal }) => {
      observedSignal = init.signal;
      return {
        status: 200,
        json: vi.fn(),
        arrayBuffer: () =>
          new Promise<ArrayBuffer>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted fixture')), { once: true });
          }),
      };
    });
    const transport = new NodeMattermostTransport(fetch);

    await expect(
      transport.request({
        method: 'GET',
        url: 'https://mattermost.example.test/api/v4/files/file-id',
        headers: { Authorization: 'Bearer fixture' },
        responseType: 'binary',
        timeoutMs: 5,
      }),
    ).rejects.toThrow('aborted fixture');
    expect(observedSignal?.aborted).toBe(true);
  });

  it('reports a post-open error and close as one socket termination', async () => {
    class FakeWebSocket extends EventEmitter {
      static instances: FakeWebSocket[] = [];
      readonly send = vi.fn();
      readonly close = vi.fn();

      constructor(readonly url: string) {
        super();
        FakeWebSocket.instances.push(this);
      }
    }
    const transport = new NodeMattermostTransport(vi.fn(), FakeWebSocket);
    const opening = transport.openWebSocket('wss://mattermost.example.test/api/v4/websocket');
    const raw = FakeWebSocket.instances[0];
    if (!raw) throw new Error('Fake socket was not constructed');
    raw.emit('open');
    const socket = await opening;
    const terminated = vi.fn();
    socket.onClose?.(terminated);

    raw.emit('error', new Error('connection lost'));
    raw.emit('close');

    expect(terminated).toHaveBeenCalledOnce();
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
