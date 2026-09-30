import { describe, expect, it } from 'bun:test';
import { subscriptionConfig, subscriptionThreadParams } from './codex-subscription-policy.js';

describe('CoS subscription execution policy', () => {
  it('uses native ChatGPT auth without an API or custom-provider fallback', () => {
    const config = Bun.TOML.parse(subscriptionConfig('gpt-6-astra', 'medium')) as any;
    expect(config.model_provider).toBe('openai');
    expect(config.forced_login_method).toBe('chatgpt');
    expect(config.model_reasoning_effort).toBe('medium');
    expect(config.cli_auth_credentials_store).toBe('file');
    expect(config.model_providers).toBeUndefined();
    expect(config.openai_base_url).toBeUndefined();
    expect(config.chatgpt_base_url).toBeUndefined();
    expect(config.mcp_servers).toBeUndefined();
    expect(config.web_search).toBe('disabled');
    for (const feature of [
      'shell_tool',
      'unified_exec',
      'apps',
      'plugins',
      'hooks',
      'multi_agent',
      'memories',
      'goals',
      'browser_use',
      'computer_use',
      'image_generation',
      'view_image',
    ])
      expect(config.features[feature]).toBe(false);
    // Astra exposes dynamic tools through the isolated V8 wrapper. It must work,
    // while an absent execution environment prevents native shell/file tools.
    expect(config.features.code_mode_host).toBe(true);
  });

  it('retains native thread persistence without an execution environment or automatic reviewer', () => {
    const params = subscriptionThreadParams('gpt-6-astra', 'Owner-scoped CoS instructions');
    expect(params.environments).toEqual([]);
    expect(params.ephemeral).toBe(false);
    expect(params.sandbox).toBe('read-only');
    expect(params.approvalPolicy).toBe('never');
    expect(params.approvalsReviewer).toBe('user');
    expect(params.allowProviderModelFallback).toBe(false);
    expect(params.modelProvider).toBe('openai');
  });

  it('rejects malformed model and effort values before writing configuration', () => {
    for (const model of ['', 'gpt\nmodel_provider="other"', '../other'])
      expect(() => subscriptionConfig(model)).toThrow('invalid_subscription_profile');
    expect(() => subscriptionConfig('gpt-6-astra', 'invented')).toThrow('invalid_subscription_profile');
  });
});
