export interface MattermostContractResponse {
  status: number;
  headers?: {
    get(name: string): string | null;
  };
  json(): Promise<unknown>;
  arrayBuffer?(): Promise<ArrayBuffer>;
}

export interface MattermostContractRequestInit {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers: Record<string, string>;
  body?: string | FormData;
  signal: AbortSignal;
}

export type MattermostContractFetch = (
  url: string,
  init: MattermostContractRequestInit,
) => Promise<MattermostContractResponse>;

export interface MattermostContractApiConfig {
  baseUrl: string;
  adminToken?: string;
}

export interface MattermostContractApiDependencies {
  fetch?: MattermostContractFetch;
  sleep?: (delayMs: number) => Promise<void>;
  requestTimeoutMs?: number;
  maxRequestAttempts?: number;
  retryBaseDelayMs?: number;
  maxRetryDelayMs?: number;
}

export interface MattermostReadinessOptions {
  maxAttempts: number;
  delayMs: number;
}

export interface MattermostContractUser {
  id: string;
  username: string;
}

export interface MattermostCreateUserInput {
  email: string;
  username: string;
  password: string;
}

export interface MattermostLoginInput {
  loginId: string;
  password: string;
}

export interface MattermostLoginResult {
  user: MattermostContractUser;
  token: string;
}

export interface MattermostCreateTeamInput {
  name: string;
  displayName: string;
}

export interface MattermostContractTeam {
  id: string;
  name: string;
  displayName: string;
}

export interface MattermostCreateChannelInput {
  teamId: string;
  name: string;
  displayName: string;
}

export interface MattermostContractChannel {
  id: string;
  teamId: string;
  name: string;
  displayName: string;
  type: 'O' | 'P';
}

export interface MattermostCreateBotInput {
  username: string;
  displayName: string;
  description?: string;
}

export interface MattermostContractBot {
  userId: string;
  username: string;
  displayName: string;
}

export interface MattermostContractPersonalAccessToken {
  id: string;
  token: string;
}

export interface MattermostContractTeamMember {
  teamId: string;
  userId: string;
  roles: string;
}

export interface MattermostContractChannelMember {
  channelId: string;
  userId: string;
  roles: string;
}

export interface MattermostCreatePostInput {
  channelId: string;
  message: string;
  rootId?: string;
  pendingPostId?: string;
  fileIds?: readonly string[];
}

export interface MattermostContractPost {
  id: string;
  channelId: string;
  userId: string;
  rootId: string;
  message: string;
  createAt: number;
  fileIds: string[];
}

export interface MattermostContractUploadFile {
  filename: string;
  mimeType: string;
  data: Buffer;
}

export interface MattermostContractFileInfo {
  id: string;
  postId: string;
  channelId: string;
  name: string;
  mimeType: string;
  size: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REQUEST_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_MAX_RETRY_DELAY_MS = 2_000;
const hostFetch: MattermostContractFetch = (url, init) => fetch(url, init);
const systemSleep = (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs));

export class MattermostContractApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: MattermostContractFetch;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly requestTimeoutMs: number;
  private readonly maxRequestAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxRetryDelayMs: number;

  constructor(
    private readonly config: MattermostContractApiConfig,
    dependencies: MattermostContractApiDependencies = {},
  ) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.fetchImpl = dependencies.fetch ?? hostFetch;
    this.sleep = dependencies.sleep ?? systemSleep;
    this.requestTimeoutMs = boundedInteger(
      dependencies.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      'request timeout',
      1,
      60_000,
    );
    this.maxRequestAttempts = boundedInteger(
      dependencies.maxRequestAttempts ?? DEFAULT_MAX_REQUEST_ATTEMPTS,
      'request attempts',
      1,
      5,
    );
    this.retryBaseDelayMs = boundedInteger(
      dependencies.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
      'retry base delay',
      0,
      10_000,
    );
    this.maxRetryDelayMs = boundedInteger(
      dependencies.maxRetryDelayMs ?? Math.max(DEFAULT_MAX_RETRY_DELAY_MS, this.retryBaseDelayMs),
      'maximum retry delay',
      this.retryBaseDelayMs,
      60_000,
    );
  }

  async waitUntilReady(options: MattermostReadinessOptions): Promise<void> {
    const maxAttempts = boundedInteger(options.maxAttempts, 'readiness attempts', 1, 600);
    const delayMs = boundedInteger(options.delayMs, 'readiness delay', 0, 60_000);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const response = await this.rawRequest('GET', '/api/v4/system/ping').then(
        (value) => value,
        () => null,
      );
      if (response && response.status >= 200 && response.status < 300) {
        const body = await response.json().then(
          (value) => value,
          () => null,
        );
        if (isRecord(body) && body.status === 'OK') return;
      }
      if (attempt < maxAttempts) await this.sleep(delayMs);
    }
    throw new Error(`Mattermost contract readiness failed after ${maxAttempts} attempts`);
  }

  async createInitialAdmin(input: MattermostCreateUserInput): Promise<MattermostContractUser> {
    assertCreateUserInput(input);
    const response = await this.rawRequest('POST', '/api/v4/users', input);
    assertSuccessfulResponse(response, 'create initial administrator');
    return parseUser(await parseJson(response, 'create initial administrator'));
  }

  async login(input: MattermostLoginInput): Promise<MattermostLoginResult> {
    assertNonEmptyString(input.loginId, 'login id');
    assertNonEmptyString(input.password, 'login password');
    const response = await this.rawRequest('POST', '/api/v4/users/login', {
      login_id: input.loginId,
      password: input.password,
    });
    assertSuccessfulResponse(response, 'administrator login');
    const token = response.headers?.get('token');
    if (!token) throw new Error('Mattermost contract administrator login token was invalid');
    return {
      user: parseUser(await parseJson(response, 'administrator login')),
      token,
    };
  }

  async createUser(input: MattermostCreateUserInput): Promise<MattermostContractUser> {
    assertCreateUserInput(input);
    const response = await this.rawRequest('POST', '/api/v4/users', input, true);
    assertSuccessfulResponse(response, 'create user');
    return parseUser(await parseJson(response, 'create user'));
  }

  async createTeam(input: MattermostCreateTeamInput): Promise<MattermostContractTeam> {
    assertNonEmptyString(input.name, 'team name');
    assertNonEmptyString(input.displayName, 'team display name');
    const response = await this.rawRequest(
      'POST',
      '/api/v4/teams',
      { name: input.name, display_name: input.displayName, type: 'O' },
      true,
    );
    assertSuccessfulResponse(response, 'create team');
    return parseTeam(await parseJson(response, 'create team'));
  }

  async createChannel(input: MattermostCreateChannelInput): Promise<MattermostContractChannel> {
    responseId(input.teamId, 'team');
    assertNonEmptyString(input.name, 'channel name');
    assertNonEmptyString(input.displayName, 'channel display name');
    const response = await this.rawRequest(
      'POST',
      '/api/v4/channels',
      {
        team_id: input.teamId,
        name: input.name,
        display_name: input.displayName,
        type: 'O',
      },
      true,
    );
    assertSuccessfulResponse(response, 'create channel');
    const channel = parseChannel(await parseJson(response, 'create channel'));
    if (channel.teamId !== input.teamId) {
      throw new Error('Mattermost contract created channel response identity was invalid');
    }
    return channel;
  }

  async createBot(input: MattermostCreateBotInput): Promise<MattermostContractBot> {
    assertNonEmptyString(input.username, 'bot username');
    assertNonEmptyString(input.displayName, 'bot display name');
    const response = await this.rawRequest(
      'POST',
      '/api/v4/bots',
      {
        username: input.username,
        display_name: input.displayName,
        ...(input.description === undefined ? {} : { description: input.description }),
      },
      true,
    );
    assertSuccessfulResponse(response, 'create bot');
    return parseBot(await parseJson(response, 'create bot'));
  }

  async createPersonalAccessToken(userId: string, description: string): Promise<MattermostContractPersonalAccessToken> {
    assertNonEmptyString(description, 'token description');
    const response = await this.rawRequest(
      'POST',
      `/api/v4/users/${encodedId(userId, 'user')}/tokens`,
      { description },
      true,
    );
    assertSuccessfulResponse(response, 'create personal access token');
    const body = await parseJson(response, 'create personal access token');
    if (!isRecord(body)) throw new Error('Mattermost contract personal access token response was invalid');
    return {
      id: responseId(body.id, 'personal access token'),
      token: responseString(body.token, 'personal access token'),
    };
  }

  async addTeamMember(teamId: string, userId: string): Promise<MattermostContractTeamMember> {
    const response = await this.rawRequest(
      'POST',
      `/api/v4/teams/${encodedId(teamId, 'team')}/members`,
      { team_id: teamId, user_id: userId },
      true,
    );
    assertSuccessfulResponse(response, 'add team member');
    const body = await parseJson(response, 'add team member');
    if (!isRecord(body)) throw new Error('Mattermost contract team membership response was invalid');
    const member = {
      teamId: responseId(body.team_id, 'team'),
      userId: responseId(body.user_id, 'user'),
      roles: responseString(body.roles, 'team membership roles'),
    };
    assertMatchingMembership(member.teamId, teamId, member.userId, userId, 'team');
    return member;
  }

  async addChannelMember(channelId: string, userId: string): Promise<MattermostContractChannelMember> {
    const response = await this.rawRequest(
      'POST',
      `/api/v4/channels/${encodedId(channelId, 'channel')}/members`,
      { user_id: userId },
      true,
    );
    assertSuccessfulResponse(response, 'add channel member');
    const member = parseChannelMember(await parseJson(response, 'add channel member'));
    assertMatchingMembership(member.channelId, channelId, member.userId, userId, 'channel');
    return member;
  }

  async createPost(input: MattermostCreatePostInput): Promise<MattermostContractPost> {
    responseId(input.channelId, 'channel');
    if (typeof input.message !== 'string') throw new Error('Mattermost contract post message is invalid');
    if (input.rootId !== undefined) responseId(input.rootId, 'root post');
    if (input.pendingPostId !== undefined) assertNonEmptyString(input.pendingPostId, 'pending post id');
    const fileIds = validateFileIds(input.fileIds ?? []);
    if (input.message.length === 0 && fileIds.length === 0) {
      throw new Error('Mattermost contract post message is invalid');
    }
    const response = await this.rawRequest(
      'POST',
      '/api/v4/posts',
      {
        channel_id: input.channelId,
        message: input.message,
        ...(input.rootId === undefined ? {} : { root_id: input.rootId }),
        ...(input.pendingPostId === undefined ? {} : { pending_post_id: input.pendingPostId }),
        ...(fileIds.length === 0 ? {} : { file_ids: fileIds }),
      },
      true,
    );
    assertSuccessfulResponse(response, 'create post');
    const post = parsePost(await parseJson(response, 'create post'));
    if (
      post.channelId !== input.channelId ||
      post.rootId !== (input.rootId ?? '') ||
      post.message !== input.message ||
      !sameStringArray(post.fileIds, fileIds)
    ) {
      throw new Error('Mattermost contract created post response identity was invalid');
    }
    return post;
  }

  async uploadFiles(channelId: string, files: readonly MattermostContractUploadFile[]): Promise<string[]> {
    responseId(channelId, 'channel');
    if (files.length < 1 || files.length > 5) throw new Error('Mattermost contract upload files are invalid');
    const form = new FormData();
    for (const file of files) {
      validateUploadFile(file);
      form.append('files', new Blob([file.data], { type: file.mimeType }), file.filename);
    }
    const response = await this.rawRequest(
      'POST',
      `/api/v4/files?channel_id=${encodeURIComponent(channelId)}`,
      form,
      true,
    );
    assertSuccessfulResponse(response, 'upload files');
    const body = await parseJson(response, 'upload files');
    if (!isRecord(body) || !Array.isArray(body.file_infos) || body.file_infos.length !== files.length) {
      throw new Error('Mattermost contract upload files response was invalid');
    }
    const fileIds = body.file_infos.map((value) => {
      if (!isRecord(value)) throw new Error('Mattermost contract upload files response was invalid');
      return responseId(value.id, 'file');
    });
    if (new Set(fileIds).size !== fileIds.length) {
      throw new Error('Mattermost contract upload files response was invalid');
    }
    return fileIds;
  }

  async getFileInfo(fileId: string): Promise<MattermostContractFileInfo> {
    const response = await this.rawRequest('GET', `/api/v4/files/${encodedId(fileId, 'file')}/info`, undefined, true);
    assertSuccessfulResponse(response, 'get file info');
    const info = parseFileInfo(await parseJson(response, 'get file info'));
    if (info.id !== fileId) throw new Error('Mattermost contract file info response identity was invalid');
    return info;
  }

  async downloadFile(fileId: string): Promise<Buffer> {
    const response = await this.rawRequest(
      'GET',
      `/api/v4/files/${encodedId(fileId, 'file')}`,
      undefined,
      true,
      'binary',
    );
    assertSuccessfulResponse(response, 'download file');
    if (typeof response.arrayBuffer !== 'function') {
      throw new Error('Mattermost contract download file response was invalid');
    }
    const body = await response.arrayBuffer().then(
      (value) => value,
      () => {
        throw new Error('Mattermost contract download file response was invalid');
      },
    );
    if (!(body instanceof ArrayBuffer)) throw new Error('Mattermost contract download file response was invalid');
    return Buffer.from(body);
  }

  async getPost(postId: string): Promise<MattermostContractPost> {
    const response = await this.rawRequest('GET', `/api/v4/posts/${encodedId(postId, 'post')}`, undefined, true);
    assertSuccessfulResponse(response, 'get post');
    const post = parsePost(await parseJson(response, 'get post'));
    if (post.id !== postId) throw new Error('Mattermost contract post response identity was invalid');
    return post;
  }

  async getChannel(channelId: string): Promise<MattermostContractChannel> {
    const response = await this.rawRequest(
      'GET',
      `/api/v4/channels/${encodedId(channelId, 'channel')}`,
      undefined,
      true,
    );
    assertSuccessfulResponse(response, 'get channel');
    const channel = parseChannel(await parseJson(response, 'get channel'));
    if (channel.id !== channelId) {
      throw new Error('Mattermost contract channel response identity was invalid');
    }
    return channel;
  }

  async getChannelMember(channelId: string, userId: string): Promise<MattermostContractChannelMember> {
    const response = await this.rawRequest(
      'GET',
      `/api/v4/channels/${encodedId(channelId, 'channel')}/members/${encodedId(userId, 'user')}`,
      undefined,
      true,
    );
    assertSuccessfulResponse(response, 'get channel member');
    const member = parseChannelMember(await parseJson(response, 'get channel member'));
    assertMatchingMembership(member.channelId, channelId, member.userId, userId, 'channel');
    return member;
  }

  deletePost(postId: string): Promise<void> {
    return this.mutateWithoutResult('DELETE', `/api/v4/posts/${encodedId(postId, 'post')}`, 'delete post');
  }

  removeChannelMember(channelId: string, userId: string): Promise<void> {
    return this.mutateWithoutResult(
      'DELETE',
      `/api/v4/channels/${encodedId(channelId, 'channel')}/members/${encodedId(userId, 'user')}`,
      'remove channel member',
    );
  }

  deleteChannel(channelId: string): Promise<void> {
    return this.mutateWithoutResult('DELETE', `/api/v4/channels/${encodedId(channelId, 'channel')}`, 'delete channel');
  }

  deleteTeam(teamId: string): Promise<void> {
    return this.mutateWithoutResult('DELETE', `/api/v4/teams/${encodedId(teamId, 'team')}`, 'delete team');
  }

  deactivateUser(userId: string): Promise<void> {
    return this.mutateWithoutResult('PUT', `/api/v4/users/${encodedId(userId, 'user')}/active`, 'deactivate user', {
      active: false,
    });
  }

  disableBot(botUserId: string): Promise<void> {
    return this.mutateWithoutResult('POST', `/api/v4/bots/${encodedId(botUserId, 'bot user')}/disable`, 'disable bot');
  }

  revokePersonalAccessToken(tokenId: string): Promise<void> {
    return this.mutateWithoutResult('POST', '/api/v4/users/tokens/revoke', 'revoke personal access token', {
      token_id: responseId(tokenId, 'personal access token'),
    });
  }

  private async mutateWithoutResult(
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    operation: string,
    body?: unknown,
  ): Promise<void> {
    const response = await this.rawRequest(method, path, body, true);
    assertSuccessfulResponse(response, operation);
  }

  private async rawRequest(
    method: MattermostContractRequestInit['method'],
    path: string,
    body?: unknown,
    authenticated = false,
    responseType: 'json' | 'binary' = 'json',
  ): Promise<MattermostContractResponse> {
    const token = authenticated ? requiredAdminToken(this.config.adminToken) : null;
    for (let attempt = 1; attempt <= this.maxRequestAttempts; attempt += 1) {
      const response = await this.singleRequest(method, path, body, token, responseType).then(
        (value) => value,
        () => null,
      );
      if (response) {
        assertHttpResponse(response);
        if (!isRetryableStatus(response.status) || attempt === this.maxRequestAttempts) return response;
        await this.sleep(exponentialDelayMs(attempt, this.retryBaseDelayMs, this.maxRetryDelayMs));
        continue;
      }
      const retryableMethod = method === 'GET' || method === 'DELETE';
      if (!retryableMethod || attempt === this.maxRequestAttempts) {
        throw new Error(`Mattermost contract request failed (${method} ${path})`);
      }
      await this.sleep(exponentialDelayMs(attempt, this.retryBaseDelayMs, this.maxRetryDelayMs));
    }
    throw new Error(`Mattermost contract request attempts exhausted (${method} ${path})`);
  }

  private async singleRequest(
    method: MattermostContractRequestInit['method'],
    path: string,
    body: unknown,
    token: string | null,
    responseType: 'json' | 'binary',
  ): Promise<MattermostContractResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const multipart = body instanceof FormData;
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Accept: responseType === 'binary' ? '*/*' : 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body === undefined || multipart ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

function normalizeBaseUrl(value: string): string {
  const normalized = value.replace(/\/+$/, '');
  if (!URL.canParse(normalized)) throw new Error('Mattermost contract base URL is invalid');
  const parsed = new URL(normalized);
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('Mattermost contract base URL is invalid');
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error('Mattermost contract base URL must be loopback-only');
  }
  return normalized;
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Mattermost contract ${label} is invalid`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertSuccessfulResponse(response: MattermostContractResponse, operation: string): void {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Mattermost contract ${operation} failed (HTTP ${response.status})`);
  }
}

function assertHttpResponse(response: MattermostContractResponse): void {
  if (
    !Number.isSafeInteger(response.status) ||
    response.status < 100 ||
    response.status > 599 ||
    typeof response.json !== 'function' ||
    (response.headers !== undefined && typeof response.headers.get !== 'function')
  ) {
    throw new Error('Mattermost contract HTTP response was invalid');
  }
}

async function parseJson(response: MattermostContractResponse, operation: string): Promise<unknown> {
  return response.json().then(
    (body) => body,
    () => {
      throw new Error(`Mattermost contract ${operation} response was invalid`);
    },
  );
}

function parseUser(value: unknown): MattermostContractUser {
  if (!isRecord(value)) throw new Error('Mattermost contract user response was invalid');
  return {
    id: responseId(value.id, 'user'),
    username: responseString(value.username, 'user username'),
  };
}

function parseTeam(value: unknown): MattermostContractTeam {
  if (!isRecord(value)) throw new Error('Mattermost contract team response was invalid');
  return {
    id: responseId(value.id, 'team'),
    name: responseString(value.name, 'team name'),
    displayName: responseString(value.display_name, 'team display name'),
  };
}

function parseBot(value: unknown): MattermostContractBot {
  if (!isRecord(value)) throw new Error('Mattermost contract bot response was invalid');
  return {
    userId: responseId(value.user_id, 'bot user'),
    username: responseString(value.username, 'bot username'),
    displayName: responseString(value.display_name, 'bot display name'),
  };
}

function parseChannel(value: unknown): MattermostContractChannel {
  if (!isRecord(value) || (value.type !== 'O' && value.type !== 'P')) {
    throw new Error('Mattermost contract channel response was invalid');
  }
  return {
    id: responseId(value.id, 'channel'),
    teamId: responseId(value.team_id, 'team'),
    name: responseString(value.name, 'channel name'),
    displayName: responseString(value.display_name, 'channel display name'),
    type: value.type,
  };
}

function parsePost(value: unknown): MattermostContractPost {
  if (!isRecord(value)) throw new Error('Mattermost contract post response was invalid');
  const createAt = value.create_at;
  if (typeof createAt !== 'number' || !Number.isSafeInteger(createAt) || createAt < 0) {
    throw new Error('Mattermost contract post timestamp response was invalid');
  }
  return {
    id: responseId(value.id, 'post'),
    channelId: responseId(value.channel_id, 'channel'),
    userId: responseId(value.user_id, 'user'),
    rootId: value.root_id === '' ? '' : responseId(value.root_id, 'root post'),
    message: responseText(value.message, 'post message'),
    createAt,
    fileIds: value.file_ids === undefined || value.file_ids === null ? [] : validateFileIds(value.file_ids),
  };
}

function parseFileInfo(value: unknown): MattermostContractFileInfo {
  if (!isRecord(value)) throw new Error('Mattermost contract file info response was invalid');
  const size = value.size;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
    throw new Error('Mattermost contract file size response was invalid');
  }
  return {
    id: responseId(value.id, 'file'),
    postId: responseId(value.post_id, 'post'),
    channelId: responseId(value.channel_id, 'channel'),
    name: responseString(value.name, 'file name'),
    mimeType: responseString(value.mime_type, 'file MIME type'),
    size,
  };
}

function parseChannelMember(value: unknown): MattermostContractChannelMember {
  if (!isRecord(value)) throw new Error('Mattermost contract channel membership response was invalid');
  return {
    channelId: responseId(value.channel_id, 'channel'),
    userId: responseId(value.user_id, 'user'),
    roles: responseString(value.roles, 'channel membership roles'),
  };
}

function responseId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`Mattermost contract ${label} id response was invalid`);
  }
  return value;
}

function encodedId(value: string, label: string): string {
  return encodeURIComponent(responseId(value, label));
}

function responseString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Mattermost contract ${label} response was invalid`);
  }
  return value;
}

function responseText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Mattermost contract ${label} response was invalid`);
  return value;
}

function validateFileIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 5) {
    throw new Error('Mattermost contract file ids are invalid');
  }
  const ids = value.map((id) => responseId(id, 'file'));
  if (new Set(ids).size !== ids.length) throw new Error('Mattermost contract file ids are invalid');
  return ids;
}

function validateUploadFile(file: MattermostContractUploadFile): void {
  if (
    !file ||
    typeof file !== 'object' ||
    !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,239}$/.test(file.filename) ||
    !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(file.mimeType) ||
    !Buffer.isBuffer(file.data)
  ) {
    throw new Error('Mattermost contract upload file is invalid');
  }
}

function sameStringArray(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Mattermost contract ${label} is invalid`);
  }
}

function assertCreateUserInput(input: MattermostCreateUserInput): void {
  assertNonEmptyString(input.email, 'user email');
  assertNonEmptyString(input.username, 'username');
  assertNonEmptyString(input.password, 'user password');
}

function requiredAdminToken(value: string | undefined): string {
  if (!value) throw new Error('Mattermost contract administrator token is required');
  return value;
}

function assertMatchingMembership(
  actualContainerId: string,
  expectedContainerId: string,
  actualUserId: string,
  expectedUserId: string,
  label: string,
): void {
  if (actualContainerId !== expectedContainerId || actualUserId !== expectedUserId) {
    throw new Error(`Mattermost contract ${label} membership response identity was invalid`);
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function exponentialDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
}
