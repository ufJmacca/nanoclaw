export type MailDraftCreateInput = { writer_binding_id: string; source_message_id: string; reply_text: string };
export type MailDraftStatusInput = { operation_id: string };
export const mailDraftCreateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['writer_binding_id', 'source_message_id', 'reply_text'],
  properties: {
    writer_binding_id: { type: 'string', format: 'uuid' },
    source_message_id: { type: 'string', pattern: '^[a-f0-9]{1,128}$' },
    reply_text: { type: 'string', minLength: 1, maxLength: 16384 },
  },
};
export const mailDraftStatusSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['operation_id'],
  properties: { operation_id: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export function validMailDraftCreateInput(value: unknown): value is MailDraftCreateInput {
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !== 'reply_text,source_message_id,writer_binding_id' ||
    typeof value.writer_binding_id !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.writer_binding_id) ||
    typeof value.source_message_id !== 'string' ||
    !/^[a-f0-9]{1,128}$/.test(value.source_message_id) ||
    typeof value.reply_text !== 'string' ||
    value.reply_text.length > 16384 ||
    !value.reply_text.trim()
  )
    return false;
  const text = value.reply_text;
  return (
    Buffer.byteLength(text.replace(/\r\n?/g, '\n').replaceAll('\n', '\r\n')) <= 16384 &&
    [...text].every((character) => {
      const code = character.codePointAt(0)!;
      return (
        !(code < 32 && ![9, 10, 13].includes(code)) &&
        !(code >= 127 && code <= 159) &&
        !(code >= 0xd800 && code <= 0xdfff)
      );
    })
  );
}
export function validMailDraftStatusInput(value: unknown): value is MailDraftStatusInput {
  return (
    object(value) &&
    Object.keys(value).join(',') === 'operation_id' &&
    typeof value.operation_id === 'string' &&
    /^[a-f0-9]{64}$/.test(value.operation_id)
  );
}
