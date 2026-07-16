import { describe, expect, it, vi } from 'vitest';

import { log } from '../log.js';
import { UnconfirmedAttachmentDeliveryError } from './adapter.js';
import type { MattermostTransport } from './mattermost-client.js';
import {
  buildMattermostPendingPostId,
  buildMattermostPostPayload,
  mattermostRetryDelayMs,
  MattermostOutboundDelivery,
} from './mattermost-outbound.js';

function outboundFile(filename: string, bytes: Buffer | string): { filename: string; data: Buffer } {
  return { filename, data: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes) };
}

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

  it('uploads one file with its exact display name and bytes before associating it to the post', async () => {
    const transport: MattermostTransport = {
      request: vi
        .fn()
        .mockResolvedValueOnce({ status: 201, body: { file_infos: [{ id: 'uploaded-file-id' }] } })
        .mockResolvedValueOnce({
          status: 201,
          body: { id: 'post-with-file-id', file_ids: ['uploaded-file-id'] },
        }),
      openWebSocket: vi.fn(),
    };
    const delivery = new MattermostOutboundDelivery(
      {
        baseUrl: 'https://mattermost.example.test/',
        botToken: 'file-fixture-credential',
        instanceKey: 'primary',
      },
      transport,
    );
    const bytes = Buffer.from([0, 1, 2, 3, 254, 255]);

    await expect(
      delivery.deliver('mattermost:primary:channel-id', null, {
        kind: 'chat',
        content: { text: 'Caption for the file' },
        files: [outboundFile('display name.bin', bytes)],
        deliveryId: 'file-outbox-id',
      }),
    ).resolves.toBe('post-with-file-id');

    expect(transport.request).toHaveBeenCalledTimes(2);
    const uploadRequest = vi.mocked(transport.request).mock.calls[0]![0];
    expect(uploadRequest).toMatchObject({
      method: 'POST',
      url: 'https://mattermost.example.test/api/v4/files?channel_id=channel-id',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer file-fixture-credential',
      },
    });
    expect(uploadRequest.headers).not.toHaveProperty('Content-Type');
    expect(uploadRequest.body).toBeInstanceOf(FormData);
    if (!(uploadRequest.body instanceof FormData)) throw new Error('Expected multipart upload body');
    const uploads = uploadRequest.body.getAll('files');
    expect(uploads).toHaveLength(1);
    const uploaded = uploads[0];
    expect(uploaded).toBeInstanceOf(Blob);
    if (!(uploaded instanceof Blob)) throw new Error('Expected uploaded file blob');
    expect((uploaded as File).name).toBe('display name.bin');
    expect(Buffer.from(await uploaded.arrayBuffer())).toEqual(bytes);

    const postRequest = vi.mocked(transport.request).mock.calls[1]![0];
    expect(JSON.parse(String(postRequest.body))).toMatchObject({
      channel_id: 'channel-id',
      message: 'Caption for the file',
      file_ids: ['uploaded-file-id'],
    });
  });

  it('uploads multiple files in order and supports a captionless threaded post', async () => {
    const transport: MattermostTransport = {
      request: vi
        .fn()
        .mockResolvedValueOnce({
          status: 201,
          body: { file_infos: [{ id: 'file-id-one' }, { id: 'file-id-two' }] },
        })
        .mockResolvedValueOnce({
          status: 201,
          body: { id: 'thread-file-post-id', file_ids: ['file-id-one', 'file-id-two'] },
        }),
      openWebSocket: vi.fn(),
    };
    const delivery = new MattermostOutboundDelivery(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'multiple-file-fixture-credential',
        instanceKey: 'primary',
      },
      transport,
    );

    await delivery.deliver('mattermost:primary:channel-id', 'root-post-id', {
      kind: 'chat',
      content: {},
      files: [outboundFile('first.txt', 'first bytes'), outboundFile('second.txt', 'second bytes')],
      deliveryId: 'multiple-file-outbox-id',
    });

    const uploadRequest = vi.mocked(transport.request).mock.calls[0]![0];
    if (!(uploadRequest.body instanceof FormData)) throw new Error('Expected multipart upload body');
    const uploaded = uploadRequest.body.getAll('files');
    expect(uploaded.map((file) => (file as File).name)).toEqual(['first.txt', 'second.txt']);
    await expect(
      Promise.all(uploaded.map(async (file) => Buffer.from(await (file as Blob).arrayBuffer()))),
    ).resolves.toEqual([Buffer.from('first bytes'), Buffer.from('second bytes')]);

    const postRequest = vi.mocked(transport.request).mock.calls[1]![0];
    expect(JSON.parse(String(postRequest.body))).toMatchObject({
      channel_id: 'channel-id',
      root_id: 'root-post-id',
      message: '',
      file_ids: ['file-id-one', 'file-id-two'],
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

  it('retries transient upload responses and reuses the same multipart body', async () => {
    const transport: MattermostTransport = {
      request: vi
        .fn()
        .mockResolvedValueOnce({ status: 429, body: undefined, headers: { 'retry-after': '2' } })
        .mockResolvedValueOnce({ status: 503, body: undefined })
        .mockResolvedValueOnce({ status: 201, body: { file_infos: [{ id: 'retried-file-id' }] } })
        .mockResolvedValueOnce({
          status: 201,
          body: { id: 'post-after-upload-retry', file_ids: ['retried-file-id'] },
        }),
      openWebSocket: vi.fn(),
    };
    const sleep = vi.fn().mockResolvedValue(undefined);
    const delivery = new MattermostOutboundDelivery(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'upload-retry-fixture-credential',
        instanceKey: 'primary',
      },
      transport,
      { sleep },
    );

    await delivery.deliver('mattermost:primary:channel-id', null, {
      kind: 'chat',
      content: { text: 'Upload retry' },
      files: [outboundFile('retry.txt', 'retry bytes')],
      deliveryId: 'upload-retry-outbox-id',
    });

    expect(sleep.mock.calls).toEqual([[2_000], [500]]);
    expect(transport.request).toHaveBeenCalledTimes(4);
    const requests = vi.mocked(transport.request).mock.calls.map(([request]) => request);
    expect(requests.slice(0, 3).every((request) => request.url.endsWith('/api/v4/files?channel_id=channel-id'))).toBe(
      true,
    );
    expect(requests[1]!.body).toBe(requests[0]!.body);
    expect(requests[2]!.body).toBe(requests[0]!.body);
  });

  it('uploads only once while retrying the post with stable file ids and pending id', async () => {
    const transport: MattermostTransport = {
      request: vi
        .fn()
        .mockResolvedValueOnce({ status: 201, body: { file_infos: [{ id: 'stable-file-id' }] } })
        .mockResolvedValueOnce({ status: 502, body: undefined })
        .mockResolvedValueOnce({
          status: 201,
          body: { id: 'post-after-post-retry', file_ids: ['stable-file-id'] },
        }),
      openWebSocket: vi.fn(),
    };
    const sleep = vi.fn().mockResolvedValue(undefined);
    const delivery = new MattermostOutboundDelivery(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'post-retry-file-fixture-credential',
        instanceKey: 'primary',
      },
      transport,
      { sleep },
    );

    await delivery.deliver('mattermost:primary:channel-id', null, {
      kind: 'chat',
      content: { text: 'Post retry' },
      files: [outboundFile('stable.txt', 'stable bytes')],
      deliveryId: 'post-retry-file-outbox-id',
    });

    const requests = vi.mocked(transport.request).mock.calls.map(([request]) => request);
    expect(requests.filter((request) => request.url.includes('/api/v4/files?'))).toHaveLength(1);
    expect(requests.filter((request) => request.url.endsWith('/api/v4/posts'))).toHaveLength(2);
    expect(requests[2]!.body).toBe(requests[1]!.body);
    const postPayloads = requests.slice(1).map((request) => JSON.parse(String(request.body)));
    expect(postPayloads[0].file_ids).toEqual(['stable-file-id']);
    expect(postPayloads[1].pending_post_id).toBe(postPayloads[0].pending_post_id);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it('rejects malformed upload responses before attempting to create a post', async () => {
    const malformedBodies: unknown[] = [
      undefined,
      {},
      { file_infos: [] },
      { file_infos: [{ id: '' }] },
      { file_infos: [{ id: 'unsafe/file-id' }] },
      { file_infos: [{ id: 'a'.repeat(129) }] },
      { file_infos: [{ id: 'duplicate-file-id' }, { id: 'duplicate-file-id' }] },
    ];

    for (const [index, body] of malformedBodies.entries()) {
      const transport: MattermostTransport = {
        request: vi.fn().mockResolvedValue({ status: 201, body }),
        openWebSocket: vi.fn(),
      };
      const delivery = new MattermostOutboundDelivery(
        {
          baseUrl: 'https://mattermost.example.test',
          botToken: 'malformed-upload-fixture-credential',
          instanceKey: 'primary',
        },
        transport,
      );

      await expect(
        delivery.deliver('mattermost:primary:channel-id', null, {
          kind: 'chat',
          content: {},
          files:
            index === malformedBodies.length - 1
              ? [outboundFile('one.txt', 'one'), outboundFile('two.txt', 'two')]
              : [outboundFile('one.txt', 'one')],
          deliveryId: `malformed-upload-${index}`,
        }),
      ).rejects.toThrow('Mattermost file upload response was invalid');
      expect(transport.request).toHaveBeenCalledOnce();
    }
  });

  it('does not retry a permanent upload failure or expose its response data', async () => {
    const transport: MattermostTransport = {
      request: vi.fn().mockResolvedValue({
        status: 400,
        body: { message: 'private-upload-error-fixture' },
      }),
      openWebSocket: vi.fn(),
    };
    const sleep = vi.fn().mockResolvedValue(undefined);
    const delivery = new MattermostOutboundDelivery(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'permanent-upload-fixture-credential',
        instanceKey: 'primary',
      },
      transport,
      { sleep },
    );

    const error = await delivery
      .deliver('mattermost:primary:channel-id', null, {
        kind: 'chat',
        content: {},
        files: [outboundFile('private-name.txt', 'private bytes')],
        deliveryId: 'permanent-upload-outbox-id',
      })
      .catch((reason: unknown) => reason);

    expect(transport.request).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(UnconfirmedAttachmentDeliveryError);
    expect((error as Error).message).toBe('Mattermost file upload failed (HTTP 400)');
    expect(String(error)).not.toContain('private-upload-error-fixture');
    expect(String(error)).not.toContain('private-name.txt');
    expect(String(error)).not.toContain('private bytes');
  });

  it('stops retryable upload failures at the configured attempt bound without posting', async () => {
    const transport: MattermostTransport = {
      request: vi.fn().mockResolvedValue({ status: 503, body: undefined }),
      openWebSocket: vi.fn(),
    };
    const sleep = vi.fn().mockResolvedValue(undefined);
    const delivery = new MattermostOutboundDelivery(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'upload-exhaustion-fixture-credential',
        instanceKey: 'primary',
      },
      transport,
      { sleep, maxAttempts: 3 },
    );

    await expect(
      delivery.deliver('mattermost:primary:channel-id', null, {
        kind: 'chat',
        content: {},
        files: [outboundFile('exhaust.txt', 'bytes')],
        deliveryId: 'upload-exhaustion-outbox-id',
      }),
    ).rejects.toThrow('Mattermost file upload failed (HTTP 503)');

    expect(transport.request).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[250], [500]]);
  });

  it('requires the successful post response to confirm the exact uploaded file associations', async () => {
    const unconfirmedPostBodies: unknown[] = [
      { id: 'post-without-file-ids' },
      { id: 'post-with-empty-file-ids', file_ids: [] },
      { id: 'post-with-other-file-id', file_ids: ['other-file-id'] },
      { id: 'post-with-extra-file-id', file_ids: ['associated-file-id', 'extra-file-id'] },
    ];

    for (const [index, postBody] of unconfirmedPostBodies.entries()) {
      const transport: MattermostTransport = {
        request: vi
          .fn()
          .mockResolvedValueOnce({ status: 201, body: { file_infos: [{ id: 'associated-file-id' }] } })
          .mockResolvedValueOnce({ status: 201, body: postBody }),
        openWebSocket: vi.fn(),
      };
      const delivery = new MattermostOutboundDelivery(
        {
          baseUrl: 'https://mattermost.example.test',
          botToken: 'association-fixture-credential',
          instanceKey: 'primary',
        },
        transport,
      );

      await expect(
        delivery.deliver('mattermost:primary:channel-id', null, {
          kind: 'chat',
          content: { text: 'Association required' },
          files: [outboundFile('association.txt', 'bytes')],
          deliveryId: `association-outbox-${index}`,
        }),
      ).rejects.toThrow('Mattermost delivery response did not confirm file associations');
      expect(transport.request).toHaveBeenCalledTimes(2);
    }
  });

  it('logs safe stage metrics and failure categories without filenames, bytes, credentials, or response bodies', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const transport: MattermostTransport = {
      request: vi
        .fn()
        .mockResolvedValueOnce({ status: 201, body: { file_infos: [{ id: 'observed-file-id' }] } })
        .mockResolvedValueOnce({
          status: 201,
          body: {
            id: 'observed-post-id',
            file_ids: [],
            message: 'private-response-body-fixture',
          },
        }),
      openWebSocket: vi.fn(),
    };
    const delivery = new MattermostOutboundDelivery(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'private-observability-token-fixture',
        instanceKey: 'primary',
      },
      transport,
    );

    try {
      await expect(
        delivery.deliver('mattermost:primary:channel-id', null, {
          kind: 'chat',
          content: { text: 'private-observability-caption-fixture' },
          files: [outboundFile('private-observability-name.txt', 'private-observability-bytes')],
          deliveryId: 'observed-delivery-id',
        }),
      ).rejects.toThrow('Mattermost delivery response did not confirm file associations');

      expect(info).toHaveBeenCalledWith('Mattermost outbound stage completed', {
        deliveryId: 'observed-delivery-id',
        stage: 'upload',
        attachmentCount: 1,
        byteTotal: Buffer.byteLength('private-observability-bytes'),
      });
      expect(warn).toHaveBeenCalledWith('Mattermost outbound delivery failed', {
        deliveryId: 'observed-delivery-id',
        postId: 'observed-post-id',
        stage: 'post',
        attachmentCount: 1,
        byteTotal: Buffer.byteLength('private-observability-bytes'),
        failureCategory: 'association_mismatch',
      });
      const renderedLogs = JSON.stringify({ info: info.mock.calls, warn: warn.mock.calls });
      expect(renderedLogs).not.toContain('private-observability-token-fixture');
      expect(renderedLogs).not.toContain('private-observability-name.txt');
      expect(renderedLogs).not.toContain('private-observability-bytes');
      expect(renderedLogs).not.toContain('private-observability-caption-fixture');
      expect(renderedLogs).not.toContain('private-response-body-fixture');
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
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

  it('rejects missing, unsafe, and overlong response post ids', async () => {
    for (const body of [{}, { id: 'unsafe/post-id' }, { id: 'a'.repeat(129) }]) {
      const transport: MattermostTransport = {
        request: vi.fn().mockResolvedValue({ status: 201, body }),
        openWebSocket: vi.fn(),
      };
      const delivery = new MattermostOutboundDelivery(
        {
          baseUrl: 'https://mattermost.example.test',
          botToken: 'invalid-post-id-fixture-credential',
          instanceKey: 'primary',
        },
        transport,
      );

      await expect(
        delivery.deliver('mattermost:primary:channel-id', null, {
          kind: 'chat',
          content: { text: 'Validate the post id' },
          deliveryId: 'invalid-response-post-id',
        }),
      ).rejects.toThrow('Mattermost delivery response was invalid');
    }
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
      `mattermost:primary:${'a'.repeat(129)}`,
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

  it('rejects more than the Mattermost five-file post limit before uploading', async () => {
    const transport: MattermostTransport = { request: vi.fn(), openWebSocket: vi.fn() };
    const delivery = new MattermostOutboundDelivery(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'file-limit-fixture-credential',
        instanceKey: 'primary',
      },
      transport,
    );

    await expect(
      delivery.deliver('mattermost:primary:channel-id', null, {
        kind: 'chat',
        content: {},
        files: Array.from({ length: 6 }, (_, index) => outboundFile(`file-${index}.txt`, `${index}`)),
        deliveryId: 'too-many-files-outbox-id',
      }),
    ).rejects.toThrow('Invalid Mattermost outbound files');
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
    const otherDelivery = buildMattermostPendingPostId('primary', 'channel-a', null, 'other-outbox-id');

    expect(repeated).toBe(first);
    expect(otherChannel).not.toBe(first);
    expect(otherDelivery).not.toBe(first);
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

  it('builds a captionless post payload when validated file ids are present', () => {
    const payload = buildMattermostPostPayload({
      instanceKey: 'primary',
      channelId: 'channel-id',
      threadId: null,
      deliveryId: 'file-component-outbox-id',
      content: {},
      allowMassMentions: false,
      fileIds: ['file-id-one', 'file-id-two'],
    });

    expect(payload).toMatchObject({
      channel_id: 'channel-id',
      message: '',
      file_ids: ['file-id-one', 'file-id-two'],
    });
  });

  it('rejects malformed or duplicate file ids while building a post payload', () => {
    for (const fileIds of [
      [''],
      ['unsafe/file-id'],
      ['a'.repeat(129)],
      ['duplicate-id', 'duplicate-id'],
      Array.from({ length: 6 }, (_, index) => `file-${index}`),
    ]) {
      expect(() =>
        buildMattermostPostPayload({
          instanceKey: 'primary',
          channelId: 'channel-id',
          threadId: null,
          deliveryId: 'invalid-file-id-outbox-id',
          content: {},
          allowMassMentions: false,
          fileIds,
        }),
      ).toThrow('Invalid Mattermost file ids');
    }
  });

  it('classifies retry delay independently of HTTP orchestration', () => {
    const policy = { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 30_000 };

    expect(mattermostRetryDelayMs({ status: 429, headers: { 'retry-after': '2' } }, 1, policy)).toBe(2_000);
    expect(mattermostRetryDelayMs({ status: 503 }, 2, policy)).toBe(500);
    expect(mattermostRetryDelayMs({ status: 400 }, 1, policy)).toBeNull();
    expect(mattermostRetryDelayMs({ status: 503 }, 3, policy)).toBeNull();
  });

  it('falls back to bounded exponential delay for a headerless rate limit', () => {
    const policy = { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 30_000 };

    expect(mattermostRetryDelayMs({ status: 429 }, 1, policy)).toBe(250);
    expect(mattermostRetryDelayMs({ status: 429, headers: { 'retry-after': 'invalid' } }, 2, policy)).toBe(500);
  });
});
