/** CoS policy proved against Codex 0.158.0; ordinary NanoClaw profiles are unchanged. */
import { tomlBasicString } from './codex-app-server.js';

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

function validateProfile(model: string, effort?: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(model) || (effort !== undefined && !EFFORTS.has(effort)))
    throw new Error('invalid_subscription_profile');
}

/** No endpoint, credential, project config, MCP, or provider override is accepted here. */
export function subscriptionConfig(model: string, effort?: string): string {
  validateProfile(model, effort);
  return [
    `model = ${tomlBasicString(model)}`,
    ...(effort ? [`model_reasoning_effort = ${tomlBasicString(effort)}`] : []),
    'model_provider = "openai"',
    'forced_login_method = "chatgpt"',
    'cli_auth_credentials_store = "file"',
    'web_search = "disabled"',
    'check_for_update_on_startup = false',
    '[agents]',
    'enabled = false',
    '[analytics]',
    'enabled = false',
    '[feedback]',
    'enabled = false',
    '[features]',
    ...[
      'shell_tool',
      'unified_exec',
      'shell_snapshot',
      'multi_agent',
      'goals',
      'apps',
      'plugins',
      'remote_plugin',
      'hooks',
      'memories',
      'browser_use',
      'computer_use',
      'image_generation',
      'view_image',
      'code_mode',
      'sleep_tool',
      'skill_search',
      'skill_mcp_dependency_install',
      'workspace_dependencies',
    ].map((feature) => `${feature} = false`),
    // The model's built-in tool mode can still advertise this wrapper even when
    // features.code_mode=false. Its V8 isolate exposes only the admitted tools;
    // disabling its host would advertise CoS tools the model cannot invoke.
    'code_mode_host = true',
    '',
  ].join('\n');
}

/** Reapply on resume and every turn; persistent conversation is not an execution grant. */
export function subscriptionThreadParams(model: string, instructions: string) {
  validateProfile(model);
  return {
    model,
    modelProvider: 'openai',
    allowProviderModelFallback: false,
    environments: [],
    ephemeral: false,
    cwd: '/workspace/agent',
    sandbox: 'read-only',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    baseInstructions: instructions,
  } as const;
}
