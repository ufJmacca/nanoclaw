import { randomUUID } from 'node:crypto';
import { COS_PROTOCOL, validRequest, type CosRequest, type CosResponse } from './generated/cos-protocol.js';
import { mailDraftCreateSchema, mailDraftStatusSchema } from './generated/mail-draft-protocol.js';
import type { McpToolDefinition } from './types.js';
const definitions = {
  cos_mail_draft_create: {
    required: ['request_id', ...mailDraftCreateSchema.required],
    properties: { request_id: { type: 'string', format: 'uuid' }, ...mailDraftCreateSchema.properties },
    description:
      'Save one unsent plain-text reply to a currently selected Inbox/Sent message. Use writer_binding_id from the current cos_context_get mail_draft_writers.items and source_message_id from Mail evidence. The host chooses the source recipient and threading, checks for existing drafts or later replies, and applies the standing five-new-drafts-per-Sydney-day limit. Individual saves need no approval. Supply a stable request_id and reuse it only for the identical request. Only verified confirms saved content. For pending or uncertain results use cos_mail_draft_status with the original operation_id; never blindly create another draft. An existing result refers to the original saved operation and does not apply revised text. No sends, edits, deletions, attachments, reply-all or unrelated new messages.',
  },
  cos_mail_draft_status: {
    required: [...mailDraftStatusSchema.required],
    properties: mailDraftStatusSchema.properties,
    description:
      'Check the original owner-scoped draft operation through bounded readback. Only verified confirms its saved content. Uncertain is unresolved; edited content belongs to the human; missing may mean sent or deleted. This tool cannot recreate, update, delete, retry creation or send a draft.',
  },
} as const;
export const mailDraftToolNames = ['cos_mail_draft_create', 'cos_mail_draft_status'] as const;
export function mailDraftCoordinatorRequest(tool: unknown, args: unknown): CosRequest | null {
  if (
    typeof tool !== 'string' ||
    !Object.hasOwn(definitions, tool) ||
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args)
  )
    return null;
  const definition = definitions[tool as keyof typeof definitions],
    values = args as Record<string, unknown>;
  if (
    Object.keys(values).some((key) => !Object.hasOwn(definition.properties, key)) ||
    (definition.required as readonly string[]).some((key) => !Object.hasOwn(values, key))
  )
    return null;
  const request = {
    protocol: COS_PROTOCOL,
    request_id: values.request_id ?? randomUUID(),
    method: tool,
    params: Object.fromEntries(Object.entries(values).filter(([key]) => key !== 'request_id')),
  };
  return validRequest(request) ? request : null;
}
export function createMailDraftTools(execute: (request: CosRequest) => Promise<CosResponse>): McpToolDefinition[] {
  return Object.entries(definitions).map(([method, definition]) => ({
    tool: {
      name: method,
      description: definition.description,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: [...definition.required],
        properties: definition.properties,
      },
    },
    async handler(args) {
      const request = mailDraftCoordinatorRequest(method, args),
        result = request
          ? await execute(request)
          : { protocol: COS_PROTOCOL, request_id: randomUUID(), status: 'denied' };
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  }));
}
