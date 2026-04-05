export interface ProviderCapabilities {
  persistentSessions: boolean;
  projectMemory: boolean;
  remoteControl: boolean;
  agentTeams: boolean;
  providerSkills: boolean;
}

export interface ProviderRuntimeInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  providerData?: Record<string, unknown>;
}

export interface PrepareWorkspaceContext {
  providerHomeDir: string;
  workspaceDir: string;
  globalMemoryDir?: string;
  sessionId?: string;
  runtimeInput: ProviderRuntimeInput;
}

export interface PreparedWorkspace {
  files: Array<{
    sourcePath?: string;
    targetPath: string;
    content?: string;
  }>;
  providerState?: Record<string, unknown>;
}

export type AgentEvent =
  | { type: 'session_started'; sessionId: string }
  | { type: 'result'; text: string | null }
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string }
  | { type: 'provider_state'; state: Record<string, unknown> };

export interface ContainerInput {
  providerId: string;
  runtimeInput: ProviderRuntimeInput;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface ContainerProviderContext {
  input: ProviderRuntimeInput;
  abortSignal: AbortSignal;
  mcpServerPath: string;
  preparedWorkspace: PreparedWorkspace;
}

export interface ContainerAgentProvider {
  id: string;
  displayName: string;
  capabilities: ProviderCapabilities;
  providerHomeDir: string;
  prepareWorkspace(
    ctx: PrepareWorkspaceContext,
  ): PreparedWorkspace | Promise<PreparedWorkspace>;
  run(
    ctx: ContainerProviderContext,
  ): AsyncIterable<AgentEvent> | Promise<AsyncIterable<AgentEvent>>;
}
