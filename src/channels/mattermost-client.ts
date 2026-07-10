import WebSocket from 'ws';

export interface MattermostClientConfig {
  baseUrl: string;
  botToken: string;
  instanceKey: string;
}

export interface MattermostHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface MattermostHttpResponse {
  status: number;
  body: unknown;
}

export interface MattermostWebSocket {
  send(payload: string): void;
  close(): void;
  onMessage(listener: (payload: string) => void): () => void;
}

export interface MattermostTransport {
  request(request: MattermostHttpRequest): Promise<MattermostHttpResponse>;
  openWebSocket(url: string): Promise<MattermostWebSocket>;
}

export type MattermostFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; json(): Promise<unknown> }>;

const hostFetch: MattermostFetch = (url, init) => fetch(url, init);

export interface MattermostNodeWebSocket {
  send(payload: string): void;
  close(): void;
  once(event: 'open', listener: () => void): this;
  once(event: 'error', listener: (error: unknown) => void): this;
  on(event: 'message', listener: (data: { toString(): string }) => void): this;
  off(event: 'open', listener: () => void): this;
  off(event: 'error', listener: (error: unknown) => void): this;
  off(event: 'message', listener: (data: { toString(): string }) => void): this;
}

export type MattermostWebSocketConstructor = new (url: string) => MattermostNodeWebSocket;

const HostWebSocket = WebSocket as unknown as MattermostWebSocketConstructor;

export class NodeMattermostTransport implements MattermostTransport {
  constructor(
    private readonly fetchImpl: MattermostFetch = hostFetch,
    private readonly WebSocketConstructor: MattermostWebSocketConstructor = HostWebSocket,
  ) {}

  async request(request: MattermostHttpRequest): Promise<MattermostHttpResponse> {
    const response = await this.fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
    return { status: response.status, body: await response.json() };
  }

  openWebSocket(url: string): Promise<MattermostWebSocket> {
    return new Promise((resolve, reject) => {
      const rawSocket = new this.WebSocketConstructor(url);
      const handleError = () => {
        rawSocket.off('open', handleOpen);
        reject(new Error('Mattermost WebSocket connection failed'));
      };
      const handleOpen = () => {
        rawSocket.off('error', handleError);
        resolve({
          send: (payload) => rawSocket.send(payload),
          close: () => rawSocket.close(),
          onMessage: (listener) => {
            const handleMessage = (data: { toString(): string }) => listener(data.toString());
            rawSocket.on('message', handleMessage);
            return () => rawSocket.off('message', handleMessage);
          },
        });
      };
      rawSocket.once('open', handleOpen);
      rawSocket.once('error', handleError);
    });
  }
}

export interface MattermostTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemTimers: MattermostTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const AUTHENTICATION_TIMEOUT_MS = 10_000;

export class MattermostClient {
  private socket: MattermostWebSocket | null = null;
  private authenticationTimer: unknown | null = null;
  private removeAuthenticationListener: (() => void) | null = null;
  private rejectAuthentication: ((reason?: unknown) => void) | null = null;

  constructor(
    private readonly config: MattermostClientConfig,
    private readonly transport: MattermostTransport,
    private readonly timers: MattermostTimers = systemTimers,
  ) {}

  async setup(): Promise<void> {
    const baseUrl = this.config.baseUrl.replace(/\/+$/, '');
    const response = await this.transport
      .request({
        method: 'GET',
        url: `${baseUrl}/api/v4/users/me`,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.config.botToken}`,
        },
      })
      .catch(() => {
        throw new Error('Mattermost authentication request failed');
      });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Mattermost authentication failed (HTTP ${response.status})`);
    }

    const websocketUrl = `${baseUrl.replace(/^http/, 'ws')}/api/v4/websocket`;
    const socket = await this.transport.openWebSocket(websocketUrl).catch(() => {
      throw new Error('Mattermost WebSocket connection failed');
    });
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      this.rejectAuthentication = reject;
      const removeListener = socket.onMessage((payload) => {
        let response: unknown;
        try {
          response = JSON.parse(payload);
        } catch (err) {
          if (err instanceof SyntaxError) return;
          throw err;
        }
        if (!isAuthenticationResponse(response)) return;
        this.clearAuthenticationWait();
        if (response.status === 'OK') {
          resolve();
        } else {
          socket.close();
          this.socket = null;
          reject(new Error('Mattermost WebSocket authentication failed'));
        }
      });
      this.removeAuthenticationListener = removeListener;
      this.authenticationTimer = this.timers.setTimeout(() => {
        this.clearAuthenticationWait();
        socket.close();
        this.socket = null;
        reject(new Error('Mattermost WebSocket authentication timed out'));
      }, AUTHENTICATION_TIMEOUT_MS);
      const challenge = JSON.stringify({
        seq: 1,
        action: 'authentication_challenge',
        data: { token: this.config.botToken },
      });
      void Promise.resolve()
        .then(() => {
          if (this.socket !== socket) return;
          socket.send(challenge);
        })
        .catch(() => {
          const rejectAuthentication = this.rejectAuthentication;
          this.clearAuthenticationWait();
          socket.close();
          this.socket = null;
          rejectAuthentication?.(new Error('Mattermost WebSocket authentication challenge failed'));
        });
    });
  }

  teardown(): void {
    const rejectAuthentication = this.rejectAuthentication;
    this.clearAuthenticationWait();

    const socket = this.socket;
    this.socket = null;
    socket?.close();

    rejectAuthentication?.(new Error('Mattermost setup cancelled'));
  }

  private clearAuthenticationWait(): void {
    this.removeAuthenticationListener?.();
    this.removeAuthenticationListener = null;
    this.rejectAuthentication = null;
    this.clearAuthenticationTimer();
  }

  private clearAuthenticationTimer(): void {
    if (this.authenticationTimer === null) return;
    this.timers.clearTimeout(this.authenticationTimer);
    this.authenticationTimer = null;
  }
}

function isAuthenticationResponse(value: unknown): value is { status: string; seq_reply: 1 } {
  if (!value || typeof value !== 'object') return false;
  const response = value as Record<string, unknown>;
  return response.seq_reply === 1 && typeof response.status === 'string';
}
