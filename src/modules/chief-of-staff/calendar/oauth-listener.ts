import http from 'node:http';
import { CalendarReadError } from './reader.js';
import {
  checkedClient,
  GoogleCalendarAuthorization,
  type GoogleOAuthClient,
  type GoogleCalendarTokens,
  type OAuthTransport,
} from './oauth.js';
export type CalendarAuthorizationListener = {
  authorizationUrl: string;
  result: Promise<GoogleCalendarTokens>;
  close(): Promise<void>;
};

/** Explicit operator action only. Binds IPv4 loopback; no redirect or account setup is initiated automatically. */
export async function startCalendarAuthorization(
  client: GoogleOAuthClient,
  options: OAuthTransport & { timeoutMs?: number } = {},
): Promise<CalendarAuthorizationListener> {
  const checked = checkedClient(client),
    timeoutMs = options.timeoutMs ?? 600000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000)
    throw new CalendarReadError('calendar_oauth_configuration_invalid');
  let resolve!: (tokens: GoogleCalendarTokens) => void, reject!: (error: CalendarReadError) => void;
  const result = new Promise<GoogleCalendarTokens>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // The operator may take time to open the browser. Attach a handler immediately without changing the returned promise.
  void result.catch(() => {});
  let flow: GoogleCalendarAuthorization,
    expectedHost = '',
    settled = false,
    processing = false;
  let timer: ReturnType<typeof setTimeout> | undefined, closing: Promise<void> | undefined;
  const cancellation = new AbortController();
  const server = http.createServer({ maxHeaderSize: 16384, requestTimeout: 15000, headersTimeout: 10000 });
  server.maxRequestsPerSocket = 1;
  const closeServer = (): Promise<void> => {
    cancellation.abort();
    if (!closing) {
      closing = new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      });
    }
    return closing;
  };
  const settle = (value: GoogleCalendarTokens | CalendarReadError) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (value instanceof CalendarReadError) reject(value);
    else resolve(value);
  };
  const send = (response: http.ServerResponse, status: number, message: string, close = false) => {
    if (response.destroyed) return;
    response.writeHead(status, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      Connection: 'close',
    });
    response.end(message, () => {
      if (close) void closeServer();
    });
  };
  server.on('request', (request, response) => {
    if (settled) {
      send(response, 410, 'This authorization attempt has ended.');
      return;
    }
    if (
      request.method !== 'GET' ||
      request.socket.remoteAddress !== '127.0.0.1' ||
      request.headers.host !== expectedHost ||
      !request.url?.startsWith('/?') ||
      request.url.length > 16384
    ) {
      send(response, 400, 'Invalid authorization callback.');
      return;
    }
    if (processing) {
      send(response, 409, 'Authorization is already being processed.');
      return;
    }
    processing = true;
    void (async () => {
      try {
        const tokens = await flow.exchange('http://' + expectedHost + request.url);
        settle(tokens);
        send(response, 200, 'Calendar authorization received. You can close this window.', true);
      } catch (error) {
        const classified =
          error instanceof CalendarReadError ? error : new CalendarReadError('calendar_oauth_exchange_uncertain');
        if (classified.code === 'calendar_oauth_callback_invalid' || classified.code === 'calendar_oauth_flow_used') {
          processing = false;
          send(response, 400, 'Invalid authorization callback.');
          return;
        }
        settle(classified);
        send(response, 400, 'Calendar authorization did not complete. Return to the operator command.', true);
      }
    })();
  });
  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  try {
    await new Promise<void>((yes, no) => {
      server.once('error', no);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', no);
        yes();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('listener_unavailable');
    expectedHost = '127.0.0.1:' + address.port;
    flow = new GoogleCalendarAuthorization(checked, 'http://' + expectedHost + '/', {
      now: options.now,
      fetch: (url, init) =>
        (options.fetch ?? globalThis.fetch)(url, {
          ...init,
          signal: init.signal ? AbortSignal.any([init.signal, cancellation.signal]) : cancellation.signal,
        }),
    });
    server.on('error', () => {
      settle(new CalendarReadError('calendar_oauth_listener_unavailable'));
      void closeServer();
    });
    timer = setTimeout(() => {
      settle(new CalendarReadError('calendar_oauth_flow_expired'));
      void closeServer();
    }, timeoutMs);
    return {
      authorizationUrl: flow.authorizationUrl,
      result,
      close: async () => {
        settle(new CalendarReadError('calendar_oauth_cancelled'));
        await closeServer();
      },
    };
  } catch {
    settle(new CalendarReadError('calendar_oauth_listener_unavailable'));
    await closeServer();
    throw new CalendarReadError('calendar_oauth_listener_unavailable');
  }
}
