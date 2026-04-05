import { claudeCodeProvider } from './claude-code.js';
import { codexProvider } from './codex.js';
import type { ContainerAgentProvider } from '../provider-types.js';

export class ContainerProviderRegistry {
  private readonly providers = new Map<string, ContainerAgentProvider>();

  constructor(providers: Iterable<ContainerAgentProvider>) {
    for (const provider of providers) {
      if (this.providers.has(provider.id)) {
        throw new Error(
          `Container provider "${provider.id}" is already registered.`,
        );
      }
      this.providers.set(provider.id, provider);
    }
  }

  getProvider(providerId: string): ContainerAgentProvider {
    const provider = this.providers.get(providerId);

    if (provider) {
      return provider;
    }

    const knownProviders = [...this.providers.keys()].sort().join(', ');
    throw new Error(
      `Unknown container provider "${providerId}". Registered providers: ${knownProviders}.`,
    );
  }
}

export const builtInContainerProviders: readonly ContainerAgentProvider[] = [
  claudeCodeProvider,
  codexProvider,
];

export function createContainerProviderRegistry(
  providers: Iterable<ContainerAgentProvider> = builtInContainerProviders,
): ContainerProviderRegistry {
  return new ContainerProviderRegistry(providers);
}
