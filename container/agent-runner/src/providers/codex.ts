import type { ContainerAgentProvider } from '../provider-types.js';

export const codexProvider: ContainerAgentProvider = {
  id: 'codex',
  displayName: 'Codex',
  capabilities: {
    persistentSessions: true,
    projectMemory: true,
    remoteControl: false,
    agentTeams: true,
    providerSkills: true,
  },
  providerHomeDir: '/home/node/.codex',
  prepareWorkspace() {
    return {
      files: [],
    };
  },
  async *run() {
    yield {
      type: 'error',
      message: 'The Codex container runner is not implemented yet.',
    };
  },
};
