import { describe, expect, it, vi } from 'vitest';

import type { MattermostTransport } from './mattermost-client.js';
import {
  buildMattermostPendingPostId,
  buildMattermostPostPayload,
  mattermostRetryDelayMs,
  MattermostOutboundDelivery,
} from './mattermost-outbound.js';

describe('MattermostOutboundDelivery', () => {
  it('posts a normal reply to the exact Mattermost channel', async () => {
    const transport: MattermostTransport = {
      request: vi.fn().mockResolvedValue({ status: 201, body: { id: 'mattermost-post-id' } }),
      openWebSocket: vi.fn(),
    };
    const delivery = new MattermostOutboundDelivery(
      {
        baseUrl: 'https://mattermost.example.test/',
        botToken: 'outbound-fixture-credential',
        instanceKey: 'primary',
      },
      transport,
    );

    await expect(
      delivery.deliver('mattermost:primary:channel-id', null, {
        kind: 'chat',
        content: { text: 'Hello from NanoClaw' },
        deliveryId: 'outbound-message-id',
      }),
    ).resolves.toBe('mattermost-post-id');

    expect(transport.request).toHaveBeenCalledOnce();
    const request = (transport.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(request).toMatchObject({
      method: 'POST',
      url: 'https://mattermost.example.test/api/v4/posts',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer outbound-fixture-credential',
        'Content-Type': 'application/json',
      },
    });
    expect(JSON.parse(request.body)).toMatchObject({
      channel_id: 'channel-id',
      message: 'Hello from NanoClaw',
    });
  });

  it('includes the original root id for a thread reply', async () => {
    const transport: MattermostTransport = {
      request: vi.fn().mockResolvedValue({ status: 201, body: { id: 'thread-reply-id' } }),
      openWebSocket: vi.fn(),
    };
    const delivery = new MattermostOutboundDelivery(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'thread-fixture-credential',
        instanceKey: 'primary',
      },
      transport,
    );

    await delivery.deliver('mattermost:primary:channel-id', 'root-post-id', {
      kind: 'chat',
      content: { text: 'Thread response' },
      deliveryId: 'thread-outbound-id',
    });

    const request = (transport.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(JSON.parse(request.body)).toMatchObject({ root_id: 'root-post-id' });
  });

  it('uses a stable pending post id for repeated delivery of one outbox message', async () => {
    const transport: MattermostTransport = {
      request: vi.fn().mockResolvedValue({ status: 201, body: { id: 'server-post-id' } }),
      openWebSocket: vi.fn(),
    };
    const delivery = new MattermostOutboundDelivery(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'idempotency-fixture-credential',
        instanceKey: 'primary',
      },
      transport,
    );
    const outbound = {
      kind: 'chat',
      content: { text: 'Retry-safe response' },
      deliveryId: 'stable-outbox-id',
    };

    await delivery.deliver('mattermost:primary:channel-id', 'root-post-id', outbound);
    await delivery.deliver('mattermost:primary:channel-id', 'root-post-id', outbound);

    const pendingIds = (transport.request as ReturnType<typeof vi.fn>).mock.calls.map(
      ([request]) => JSON.parse(request.body).pending_post_id,
    );
    expect(pendingIds[0]).toMatch(/^nanoclaw-[a-f0-9]+$/);
    expect(pendingIds[1]).toBe(pendingIds[0]);
  });

  it('honors Retry-After guidance before retrying a rate-limited post', async () => {
    const transport: MattermostTransport = {
      request: vi
        .fn()
        .mockResolvedValueOnce({ status: 429, body: undefined, headers: { 'retry-after': '2' } })
        .mockResolvedValueOnce({ status: 201, body: { id: 'post-after-retry' } }),
      openWebSocket: vi.fn(),
    };
    const sleep = vi.fn().mockResolvedValue(undefined);
    const delivery = new MattermostOutboundDelivery(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'rate-limit-fixture-credential',
        instanceKey: 'primary',
      },
      transport,
      { sleep },
    );

    await expect(
      delivery.deliver('mattermost:primary:channel-id', null, {
        kind: 'chat',
        content: { text: 'Retry me' },
        deliveryId: 'rate-limited-outbox-id',
      }),
    ).resolves.toBe('post-after-retry');

    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(transport.request).toHaveBeenCalledTimes(2);
    const bodies = (transport.request as ReturnType<typeof vi.fn>).mock.calls.map(([request]) => request.body);
    expect(bodies[1]).toBe(bodies[0]);
  });

  it('falls back to Mattermost X-RateLimit-Reset guidance', async () => {
    const transport: MattermostTransport = {
      request: vi
        .fn()
        .mockResolvedValueOnce({ status: 429, body: undefined, headers: { 'x-ratelimit-reset': '3' } })
        .mockResolvedValueOnce({ status: 201, body: { id: 'post-after-reset' } }),
      openWebSocket: vi.fn(),
    };
    const sleep = vi.fn().mockResolvedValue(undefined);
    const delivery = new MattermostOutboundDelivery(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'reset-fixture-credential',
        instanceKey: 'primary',
      },
      transport,
      { sleep },
    );

    await delivery.deliver('mattermost:primary:channel-id', null, {
      kind: 'chat',
      content: { text: 'Reset-guided retry' },
      deliveryId: 'reset-guided-outbox-id',
    });

    expect(sleep).toHaveBeenCalledWith(3_000);
    expect(transport.request).toHaveBeenCalledTimes(2);
  });

  it('clamps untrusted rate-limit delays to a bounded maximum', async () => {
    const transport: MattermostTransport = {
      request: vi
        .fn()
        .mockResolvedValueOnce({ status: 429, body: undefined, headers: { 'retry-after': '999999' } })
        .mockResolvedValueOnce({ status: 201, body: { id: 'bounded-retry-post' } }),
      openWebSocket: vi.fn(),
    };
    const sleep = vi.fn().mockResolvedValue(undefined);
    const delivery = new MattermostOutboundDelivery(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'bounded-delay-fixture-credential',
        instanceKey: 'primary',
      },
      transport,
      { sleep },
    );

    await delivery.deliver('mattermost:primary:channel-id', null, {
      kind: 'chat',
      content: { text: 'Bound this retry' },
      deliveryId: 'bounded-delay-outbox-id',
    });

    expect(sleep).toHaveBeenCalledWith(30_000);
  });

  it('retries transient 5xx failures with bounded exponential backoff', async () => {
    const transport: MattermostTransport = {
      request: vi
        .fn()
        .mockResolvedValueOnce({ status: 500, body: undefined })
        .mockResolvedValueOnce({ status: 502, body: undefined })
        .mockResolvedValueOnce({ status: 201, body: { id: 'post-after-5xx' } }),
      openWebSocket: vi.fn(),
    };
    const sleep = vi.fn().mockResolvedValue(undefined);
    const delivery = new MattermostOutboundDelivery(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'transient-fixture-credential',
        instanceKey: 'primary',
      },
      transport,
      { sleep },
    );

    await expect(
      delivery.deliver('mattermost:primary:channel-id', null, {
        kind: 'chat',
        content: { text: 'Transient recovery' },
        deliveryId: 'transient-outbox-id',
      }),
    ).resolves.toBe('post-after-5xx');

    expect(sleep.mock.calls).toEqual([[250], [500]]);
    expect(transport.request).toHaveBeenCalledTimes(3);
    const bodies = (transport.request as ReturnType<typeof vi.fn>).mock.calls.map(([request]) => request.body);
    expect(new Set(bodies).size).toBe(1);
  });

  it('does not retry permanent failures or expose response and credential data', async () => {
    const transport: MattermostTransport = {
      request: vi.fn().mockResolvedValue({
        status: 400,
        body: { message: 'private-server-error-fixture' },
      }),
      openWebSocket: vi.fn(),
    };
    const sleep = vi.fn().mockResolvedValue(undefined);
    const credential = 'permanent-failure-fixture-credential';
    const privateContent = 'private-outbound-content-fixture';
    const delivery = new MattermostOutboundDelivery(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: credential,
        instanceKey: 'primary',
      },
      transport,
      { sleep, maxAttempts: 99 },
    );

    const error = await delivery
      .deliver('mattermost:primary:channel-id', null, {
        kind: 'chat',
        content: { text: privateContent },
        deliveryId: 'permanent-failure-outbox-id',
      })
      .catch((reason: unknown) => reason);

    expect(transport.request).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
    const rendered = String(error);
    expect(rendered).toContain('HTTP 400');
    expect(rendered).not.toContain(credential);
    expect(rendered).not.toContain(privateContent);
    expect(rendered).not.toContain('private-server-error-fixture');
  });

  it('stops retryable failures at the configured attempt bound', async () => {
    const transport: MattermostTransport = {
      request: vi.fn().mockResolvedValue({ status: 503, body: undefined }),
      openWebSocket: vi.fn(),
    };
    const sleep = vi.fn().mockResolvedValue(undefined);
    const delivery = new MattermostOutboundDelivery(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'exhaustion-fixture-credential',
        instanceKey: 'primary',
      },
      transport,
      { sleep, maxAttempts: 3 },
    );

    await expect(
      delivery.deliver('mattermost:primary:channel-id', null, {
        kind: 'chat',
        content: { text: 'Bounded failure' },
        deliveryId: 'exhaustion-outbox-id',
      }),
    ).rejects.toThrow('Mattermost delivery failed (HTTP 503)');

    expect(transport.request).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[250], [500]]);
  });

  it('neutralizes dangerous mass mentions by default', async () => {
    const transport: MattermostTransport = {
      request: vi.fn().mockResolvedValue({ status: 201, body: { id: 'safe-mention-post' } }),
      openWebSocket: vi.fn(),
    };
    const delivery = new MattermostOutboundDelivery(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'mention-fixture-credential',
        instanceKey: 'primary',
      },
      transport,
    );

    await delivery.deliver('mattermost:primary:channel-id', null, {
      kind: 'chat',
      content: { text: '@channel @ALL @here ＠channel @ada' },
      deliveryId: 'mention-outbox-id',
    });

    const request = (transport.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(JSON.parse(request.body).message).toBe('@\u200bchannel @\u200bALL @\u200bhere ＠\u200bchannel @ada');
  });

  it('allows mass mentions only with explicit host opt-in', async () => {
    const transport: MattermostTransport = {
      request: vi.fn().mockResolvedValue({ status: 201, body: { id: 'enabled-mention-post' } }),
      openWebSocket: vi.fn(),
    };
    const delivery = new MattermostOutboundDelivery(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'enabled-mention-fixture-credential',
        instanceKey: 'primary',
        allowMassMentions: true,
      },
      transport,
    );

    await delivery.deliver('mattermost:primary:channel-id', null, {
      kind: 'chat',
      content: { text: '@channel explicitly enabled' },
      deliveryId: 'enabled-mention-outbox-id',
    });

    const request = (transport.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(JSON.parse(request.body).message).toBe('@channel explicitly enabled');
  });

  it('prefers Markdown content and falls back to plain text predictably', async () => {
    const transport: MattermostTransport = {
      request: vi.fn().mockResolvedValue({ status: 201, body: { id: 'markdown-post' } }),
      openWebSocket: vi.fn(),
    };
    const delivery = new MattermostOutboundDelivery(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'format-fixture-credential',
        instanceKey: 'primary',
      },
      transport,
    );

    await delivery.deliver('mattermost:primary:channel-id', null, {
      kind: 'chat',
      content: { markdown: '**Markdown response**', text: 'Plain response' },
      deliveryId: 'format-outbox-id',
    });

    const request = (transport.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(JSON.parse(request.body).message).toBe('**Markdown response**');
  });

  it('rejects missing, non-string, or empty content before HTTP', async () => {
    const invalidContent: unknown[] = [{}, { text: 42 }, { text: '' }, { markdown: '' }];

    for (const [index, content] of invalidContent.entries()) {
      const transport: MattermostTransport = {
        request: vi.fn().mockResolvedValue({ status: 201, body: { id: 'should-not-post' } }),
        openWebSocket: vi.fn(),
      };
      const delivery = new MattermostOutboundDelivery(
        {
          baseUrl: 'https://mattermost.example.test',
          botToken: 'invalid-content-fixture-credential',
          instanceKey: 'primary',
        },
        transport,
      );

      await expect(
        delivery.deliver('mattermost:primary:channel-id', null, {
          kind: 'chat',
          content,
          deliveryId: `invalid-content-${index}`,
        }),
      ).rejects.toThrow('Invalid Mattermost outbound content');
      expect(transport.request).not.toHaveBeenCalled();
    }
  });

  it('enforces the 16383 Unicode code-point limit before HTTP', async () => {
    const transport: MattermostTransport = {
      request: vi.fn().mockResolvedValue({ status: 201, body: { id: 'boundary-post' } }),
      openWebSocket: vi.fn(),
    };
    const delivery = new MattermostOutboundDelivery(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'length-fixture-credential',
        instanceKey: 'primary',
      },
      transport,
    );

    await delivery.deliver('mattermost:primary:channel-id', null, {
      kind: 'chat',
      content: { text: '😀'.repeat(16_383) },
      deliveryId: 'boundary-outbox-id',
    });
    await expect(
      delivery.deliver('mattermost:primary:channel-id', null, {
        kind: 'chat',
        content: { text: '😀'.repeat(16_384) },
        deliveryId: 'oversized-outbox-id',
      }),
    ).rejects.toThrow('Mattermost outbound content exceeds 16383 code points');

    expect(transport.request).toHaveBeenCalledOnce();
  });

  it('fails closed for cross-instance and ambiguous destinations before HTTP', async () => {
    for (const platformId of [
      'mattermost:secondary:channel-id',
      'mattermost:primary:channel:id',
      'mattermost:primary:',
      'mattermost:primary:channel id',
      'mattermost:primary:../channel-id',
      'mattermost:primary:channel\nid',
    ]) {
      const transport: MattermostTransport = {
        request: vi.fn().mockResolvedValue({ status: 201, body: { id: 'should-not-post' } }),
        openWebSocket: vi.fn(),
      };
      const delivery = new MattermostOutboundDelivery(
        {
          baseUrl: 'https://mattermost.example.test',
          botToken: 'destination-fixture-credential',
          instanceKey: 'primary',
        },
        transport,
      );

      await expect(
        delivery.deliver(platformId, null, {
          kind: 'chat',
          content: { text: 'Do not misroute' },
          deliveryId: 'destination-outbox-id',
        }),
      ).rejects.toThrow('Invalid Mattermost delivery destination');
      expect(transport.request).not.toHaveBeenCalled();
    }
  });

  it('rejects an ambiguous configured instance key before HTTP', async () => {
    const transport: MattermostTransport = {
      request: vi.fn().mockResolvedValue({ status: 201, body: { id: 'should-not-post' } }),
      openWebSocket: vi.fn(),
    };
    const delivery = new MattermostOutboundDelivery(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'ambiguous-config-fixture-credential',
        instanceKey: 'primary:shadow',
      },
      transport,
    );

    await expect(
      delivery.deliver('mattermost:primary:shadow:channel-id', null, {
        kind: 'chat',
        content: { text: 'Do not route ambiguous configuration' },
        deliveryId: 'ambiguous-config-outbox-id',
      }),
    ).rejects.toThrow('Invalid Mattermost instance key');
    expect(transport.request).not.toHaveBeenCalled();
  });

  it('refuses delivery without the durable host outbox identity', async () => {
    const transport: MattermostTransport = {
      request: vi.fn().mockResolvedValue({ status: 201, body: { id: 'should-not-post' } }),
      openWebSocket: vi.fn(),
    };
    const delivery = new MattermostOutboundDelivery(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'missing-id-fixture-credential',
        instanceKey: 'primary',
      },
      transport,
    );

    await expect(
      delivery.deliver('mattermost:primary:channel-id', null, {
        kind: 'chat',
        content: { text: 'No unstable idempotency' },
      }),
    ).rejects.toThrow('Mattermost delivery requires a stable delivery id');
    expect(transport.request).not.toHaveBeenCalled();
  });

  it('redacts credential and content from transport failures', async () => {
    const credential = 'outbound-transport-fixture-credential';
    const privateContent = 'private-transport-content-fixture';
    const transport: MattermostTransport = {
      request: vi
        .fn()
        .mockRejectedValue(new Error(`failed Authorization: Bearer ${credential}; body=${privateContent}`)),
      openWebSocket: vi.fn(),
    };
    const delivery = new MattermostOutboundDelivery(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: credential,
        instanceKey: 'primary',
      },
      transport,
    );

    const error = await delivery
      .deliver('mattermost:primary:channel-id', null, {
        kind: 'chat',
        content: { text: privateContent },
        deliveryId: 'transport-failure-outbox-id',
      })
      .catch((reason: unknown) => reason);

    const rendered = JSON.stringify(error, Object.getOwnPropertyNames(error));
    expect(rendered).toContain('Mattermost delivery request failed');
    expect(rendered).not.toContain(credential);
    expect(rendered).not.toContain(privateContent);
    expect(rendered).not.toContain('Authorization');
  });
});

describe('Mattermost outbound pure components', () => {
  it('derives idempotency identity independently of payload content', () => {
    const first = buildMattermostPendingPostId('primary', 'channel-a', null, 'outbox-id');
    const repeated = buildMattermostPendingPostId('primary', 'channel-a', null, 'outbox-id');
    const otherChannel = buildMattermostPendingPostId('primary', 'channel-b', null, 'outbox-id');

    expect(repeated).toBe(first);
    expect(otherChannel).not.toBe(first);
    expect(first).not.toContain('channel-a');
    expect(first).not.toContain('outbox-id');
  });

  it('builds a validated post payload independently of HTTP delivery', () => {
    const payload = buildMattermostPostPayload({
      instanceKey: 'primary',
      channelId: 'channel-id',
      threadId: 'root-post-id',
      deliveryId: 'component-outbox-id',
      content: { markdown: '**Hello @channel**' },
      allowMassMentions: false,
    });

    expect(payload).toMatchObject({
      channel_id: 'channel-id',
      root_id: 'root-post-id',
      message: '**Hello @\u200bchannel**',
    });
    expect(payload.pending_post_id).toMatch(/^nanoclaw-[a-f0-9]+$/);
  });

  it('classifies retry delay independently of HTTP orchestration', () => {
    const policy = { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 30_000 };

    expect(mattermostRetryDelayMs({ status: 429, headers: { 'retry-after': '2' } }, 1, policy)).toBe(2_000);
    expect(mattermostRetryDelayMs({ status: 503 }, 2, policy)).toBe(500);
    expect(mattermostRetryDelayMs({ status: 400 }, 1, policy)).toBeNull();
    expect(mattermostRetryDelayMs({ status: 503 }, 3, policy)).toBeNull();
  });
});
