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
  body?: string | FormData;
  responseType?: 'json' | 'binary';
  /** Bound the complete response, including binary body consumption. */
  timeoutMs?: number;
}

export interface MattermostHttpResponse {
  status: number;
  body: unknown;
  headers?: Readonly<Record<string, string>>;
}

export interface MattermostWebSocket {
  send(payload: string): void;
  close(): void;
  onMessage(listener: (payload: string) => void): () => void;
  onClose?(listener: () => void): () => void;
}

export interface MattermostTransport {
  request(request: MattermostHttpRequest): Promise<MattermostHttpResponse>;
  openWebSocket(url: string): Promise<MattermostWebSocket>;
}

export interface MattermostEventContext {
  botUserId: string;
}

export type MattermostEventListener = (payload: string, context: MattermostEventContext) => void | Promise<void>;

export interface MattermostClientHooks {
  onSequenceGap?(gap: { expected: number; received: number }): void | Promise<void>;
  onConnectionReset?(reset: { previousConnectionId: string; receivedConnectionId: string }): void | Promise<void>;
  onConnectionStateChange?(connected: boolean): void;
}

export type MattermostFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string | FormData; signal?: AbortSignal },
) => Promise<{
  status: number;
  headers?: { forEach(callback: (value: string, key: string) => void): void };
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

const hostFetch: MattermostFetch = (url, init) => fetch(url, init);

export interface MattermostNodeWebSocket {
  send(payload: string): void;
  close(): void;
  once(event: 'open', listener: () => void): this;
  once(event: 'error', listener: (error: unknown) => void): this;
  on(event: 'message', listener: (data: { toString(): string }) => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: 'error', listener: (error: unknown) => void): this;
  off(event: 'open', listener: () => void): this;
  off(event: 'error', listener: (error: unknown) => void): this;
  off(event: 'message', listener: (data: { toString(): string }) => void): this;
  off(event: 'close', listener: () => void): this;
}

export type MattermostWebSocketConstructor = new (url: string) => MattermostNodeWebSocket;

const HostWebSocket = WebSocket as unknown as MattermostWebSocketConstructor;

export class NodeMattermostTransport implements MattermostTransport {
  constructor(
    private readonly fetchImpl: MattermostFetch = hostFetch,
    private readonly WebSocketConstructor: MattermostWebSocketConstructor = HostWebSocket,
  ) {}

  async request(request: MattermostHttpRequest): Promise<MattermostHttpResponse> {
    const timeoutMs = request.timeoutMs;
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new Error('Mattermost request timeout was invalid');
    }
    const controller = timeoutMs === undefined ? undefined : new AbortController();
    const timeout =
      controller === undefined ? undefined : setTimeout(() => controller.abort(), Math.min(timeoutMs!, 2_147_483_647));
    try {
      const response = await this.fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        ...(controller ? { signal: controller.signal } : {}),
      });
      let body: unknown;
      if (request.responseType === 'binary') {
        body = Buffer.from(await response.arrayBuffer());
      } else {
        try {
          body = await response.json();
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err;
          body = undefined;
        }
      }
      const headers = normalizeHeaders(response.headers);
      return { status: response.status, body, ...(headers ? { headers } : {}) };
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
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
          onClose: (listener) => {
            let terminated = false;
            const handleTermination = () => {
              if (terminated) return;
              terminated = true;
              listener();
            };
            rawSocket.on('error', handleTermination);
            rawSocket.on('close', handleTermination);
            return () => {
              rawSocket.off('error', handleTermination);
              rawSocket.off('close', handleTermination);
            };
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
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

type MattermostSequenceOutcome = 'pending' | 'succeeded' | 'failed';

interface MattermostRecoveredSequenceRange {
  start: number;
  end: number;
}

interface MattermostSequenceObservation {
  sequence: number | null;
  stale: boolean;
}

export class MattermostClient {
  private socket: MattermostWebSocket | null = null;
  private authenticationTimer: unknown | null = null;
  private removeAuthenticationListener: (() => void) | null = null;
  private removeEventListener: (() => void) | null = null;
  private removeCloseListener: (() => void) | null = null;
  private rejectAuthentication: ((reason?: unknown) => void) | null = null;
  private reconnectTimer: unknown | null = null;
  private reconnectAttempt = 0;
  private websocketUrl: string | null = null;
  private botUserId: string | null = null;
  private onEvent: MattermostEventListener | undefined;
  private tearingDown = false;
  private lastObservedServerSequence: number | null = null;
  private lastCommittedServerSequence: number | null = null;
  private readonly sequenceOutcomes = new Map<number, MattermostSequenceOutcome>();
  private recoveredSequenceRanges: MattermostRecoveredSequenceRange[] = [];
  private connectionId: string | null = null;
  private socketGeneration = 0;
  private eventTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: MattermostClientConfig,
    private readonly transport: MattermostTransport,
    private readonly timers: MattermostTimers = systemTimers,
    private readonly hooks: MattermostClientHooks = {},
  ) {}

  async setup(onEvent?: MattermostEventListener): Promise<MattermostEventContext> {
    this.tearingDown = false;
    this.onEvent = onEvent;
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
    const botUserId = authenticatedUserId(response.body);
    if (!botUserId) {
      throw new Error('Mattermost authentication identity response was invalid');
    }

    this.websocketUrl = `${baseUrl.replace(/^http/, 'ws')}/api/v4/websocket`;
    this.botUserId = botUserId;
    await this.connectWebSocket(this.websocketUrl, botUserId, onEvent);
    return { botUserId };
  }

  private async connectWebSocket(
    websocketUrl: string,
    botUserId: string,
    onEvent?: MattermostEventListener,
    preserveServerSequence = false,
  ): Promise<void> {
    const socket = await this.transport.openWebSocket(websocketUrl).catch(() => {
      throw new Error('Mattermost WebSocket connection failed');
    });
    if (this.tearingDown) {
      socket.close();
      throw new Error('Mattermost setup cancelled');
    }
    this.socket = socket;
    const generation = ++this.socketGeneration;
    this.eventTail = Promise.resolve();
    this.removeCloseListener =
      socket.onClose?.(() => {
        this.handleSocketTermination(socket);
      }) ?? null;
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
          if (!preserveServerSequence) {
            this.resetSequenceState(null, null);
          } else {
            this.prepareResumedGeneration();
          }
          if (onEvent) {
            this.removeEventListener = socket.onMessage((eventPayload) => {
              const execution = this.eventTail.then(async () => {
                if (this.tearingDown || this.socket !== socket || this.socketGeneration !== generation) return;
                const observation = await this.observeServerSequence(eventPayload, generation);
                if (observation.stale) return;
                if (this.tearingDown || this.socket !== socket || this.socketGeneration !== generation) return;
                const tracksSequence =
                  observation.sequence !== null && this.beginSequenceHandler(observation.sequence, generation);
                const handler = Promise.resolve().then(() => onEvent(eventPayload, { botUserId }));
                void handler.then(
                  () => {
                    if (
                      observation.sequence !== null &&
                      observation.sequence > 0 &&
                      this.socket === socket &&
                      this.socketGeneration === generation
                    ) {
                      this.reconnectAttempt = 0;
                    }
                    if (tracksSequence && observation.sequence !== null) {
                      this.settleSequenceHandler(observation.sequence, generation, 'succeeded');
                    }
                  },
                  () => {
                    if (tracksSequence && observation.sequence !== null) {
                      this.settleSequenceHandler(observation.sequence, generation, 'failed');
                    }
                    this.handleSocketTermination(socket);
                  },
                );
              });
              this.eventTail = execution.catch(() => {
                this.handleSocketTermination(socket);
              });
            });
          }
          this.hooks.onConnectionStateChange?.(true);
          resolve();
        } else {
          this.removeCloseListener?.();
          this.removeCloseListener = null;
          socket.close();
          this.socket = null;
          reject(new Error('Mattermost WebSocket authentication failed'));
        }
      });
      this.removeAuthenticationListener = removeListener;
      this.authenticationTimer = this.timers.setTimeout(() => {
        this.clearAuthenticationWait();
        this.removeCloseListener?.();
        this.removeCloseListener = null;
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
          this.removeCloseListener?.();
          this.removeCloseListener = null;
          socket.close();
          this.socket = null;
          rejectAuthentication?.(new Error('Mattermost WebSocket authentication challenge failed'));
        });
    });
  }

  teardown(): void {
    this.tearingDown = true;
    this.hooks.onConnectionStateChange?.(false);
    this.clearReconnectTimer();
    const rejectAuthentication = this.rejectAuthentication;
    this.clearAuthenticationWait();
    this.removeEventListener?.();
    this.removeEventListener = null;
    this.removeCloseListener?.();
    this.removeCloseListener = null;

    const socket = this.socket;
    this.socket = null;
    socket?.close();

    this.websocketUrl = null;
    this.botUserId = null;
    this.onEvent = undefined;
    this.resetSequenceState(null, null);
    this.socketGeneration += 1;
    this.eventTail = Promise.resolve();

    rejectAuthentication?.(new Error('Mattermost setup cancelled'));
  }

  private handleSocketTermination(socket: MattermostWebSocket): void {
    if (this.tearingDown || this.socket !== socket) return;
    this.hooks.onConnectionStateChange?.(false);
    const rejectAuthentication = this.rejectAuthentication;
    if (rejectAuthentication) {
      this.clearAuthenticationWait();
      this.removeCloseListener?.();
      this.removeCloseListener = null;
      this.socket = null;
      socket.close();
      rejectAuthentication(new Error('Mattermost WebSocket authentication interrupted'));
      return;
    }
    this.removeEventListener?.();
    this.removeEventListener = null;
    this.removeCloseListener?.();
    this.removeCloseListener = null;
    this.socket = null;
    socket.close();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.tearingDown || this.reconnectTimer !== null || this.websocketUrl === null || this.botUserId === null) {
      return;
    }
    const delayMs = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_DELAY_MS);
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.tearingDown || this.websocketUrl === null || this.botUserId === null) return;
      const canResume = this.connectionId !== null;
      const reconnectUrl = canResume ? this.buildResumeWebSocketUrl() : this.websocketUrl;
      void this.connectWebSocket(reconnectUrl, this.botUserId, this.onEvent, canResume).catch(() => {
        this.scheduleReconnect();
      });
    }, delayMs);
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

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return;
    this.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private async observeServerSequence(payload: string, generation: number): Promise<MattermostSequenceObservation> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch (err) {
      if (err instanceof SyntaxError) return { sequence: null, stale: false };
      throw err;
    }
    if (!parsed || typeof parsed !== 'object') return { sequence: null, stale: false };
    if (!this.isCurrentGeneration(generation)) return { sequence: null, stale: true };
    const event = parsed as Record<string, unknown>;
    if (event.event === 'hello' && event.data && typeof event.data === 'object') {
      const observedConnectionId = (event.data as Record<string, unknown>).connection_id;
      if (typeof observedConnectionId === 'string' && observedConnectionId.length > 0) {
        const previousConnectionId = this.connectionId;
        this.connectionId = observedConnectionId;
        if (previousConnectionId !== null && previousConnectionId !== observedConnectionId) {
          this.resetSequenceState(observedConnectionId, null);
          await this.hooks.onConnectionReset?.({
            previousConnectionId,
            receivedConnectionId: observedConnectionId,
          });
          if (!this.isCurrentGeneration(generation)) return { sequence: null, stale: true };
        }
      }
    }
    const sequence = event.seq;
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) {
      return { sequence: null, stale: false };
    }
    const expected = this.lastObservedServerSequence === null ? 0 : this.lastObservedServerSequence + 1;
    if (sequence > expected) {
      await this.hooks.onSequenceGap?.({ expected, received: sequence });
      if (!this.isCurrentGeneration(generation)) return { sequence: null, stale: true };
      this.addRecoveredSequenceRange(expected, sequence - 1);
    }
    if (this.lastObservedServerSequence === null || sequence > this.lastObservedServerSequence) {
      this.lastObservedServerSequence = sequence;
    }
    return { sequence, stale: false };
  }

  private buildResumeWebSocketUrl(): string {
    if (this.websocketUrl === null || this.connectionId === null) {
      throw new Error('Mattermost WebSocket resume state is incomplete');
    }
    const url = new URL(this.websocketUrl);
    url.searchParams.set('connection_id', this.connectionId);
    url.searchParams.set('sequence_number', String((this.lastCommittedServerSequence ?? -1) + 1));
    return url.toString();
  }

  private isCurrentGeneration(generation: number): boolean {
    return !this.tearingDown && this.socketGeneration === generation;
  }

  private resetSequenceState(connectionId: string | null, committedSequence: number | null): void {
    this.connectionId = connectionId;
    this.lastObservedServerSequence = committedSequence;
    this.lastCommittedServerSequence = committedSequence;
    this.sequenceOutcomes.clear();
    this.recoveredSequenceRanges = [];
  }

  private prepareResumedGeneration(): void {
    this.lastObservedServerSequence = this.lastCommittedServerSequence;
    this.sequenceOutcomes.clear();
    this.recoveredSequenceRanges = [];
  }

  private beginSequenceHandler(sequence: number, generation: number): boolean {
    if (!this.isCurrentGeneration(generation)) return false;
    if (this.lastCommittedServerSequence !== null && sequence <= this.lastCommittedServerSequence) return false;
    if (this.sequenceOutcomes.has(sequence)) return false;
    this.sequenceOutcomes.set(sequence, 'pending');
    return true;
  }

  private settleSequenceHandler(
    sequence: number,
    generation: number,
    outcome: Extract<MattermostSequenceOutcome, 'succeeded' | 'failed'>,
  ): void {
    if (!this.isCurrentGeneration(generation) || this.sequenceOutcomes.get(sequence) !== 'pending') return;
    this.sequenceOutcomes.set(sequence, outcome);
    if (outcome === 'succeeded') this.advanceCommittedSequence();
  }

  private addRecoveredSequenceRange(start: number, end: number): void {
    if (start > end) return;
    const previous = this.recoveredSequenceRanges.at(-1);
    if (previous && start <= previous.end + 1) previous.end = Math.max(previous.end, end);
    else this.recoveredSequenceRanges.push({ start, end });
    this.advanceCommittedSequence();
  }

  private advanceCommittedSequence(): void {
    while (true) {
      const next = (this.lastCommittedServerSequence ?? -1) + 1;
      const outcome = this.sequenceOutcomes.get(next);
      if (outcome === 'succeeded') {
        this.sequenceOutcomes.delete(next);
        this.lastCommittedServerSequence = next;
        continue;
      }
      if (outcome === 'pending' || outcome === 'failed') return;
      const recoveredIndex = this.recoveredSequenceRanges.findIndex(({ start, end }) => start <= next && next <= end);
      if (recoveredIndex < 0) return;
      const recovered = this.recoveredSequenceRanges[recoveredIndex];
      if (!recovered) return;
      this.lastCommittedServerSequence = recovered.end;
      this.recoveredSequenceRanges.splice(recoveredIndex, 1);
    }
  }
}

function normalizeHeaders(
  source: { forEach(callback: (value: string, key: string) => void): void } | undefined,
): Record<string, string> | undefined {
  if (!source) return undefined;
  const headers: Record<string, string> = {};
  source.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return headers;
}

function isAuthenticationResponse(value: unknown): value is { status: string; seq_reply: 1 } {
  if (!value || typeof value !== 'object') return false;
  const response = value as Record<string, unknown>;
  return response.seq_reply === 1 && typeof response.status === 'string';
}

function authenticatedUserId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const id = (value as Record<string, unknown>).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}
