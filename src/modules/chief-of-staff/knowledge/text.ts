export type TextChunk = { text: string; startLine: number; endLine: number; heading: string };
export const MAX_SOURCE_BYTES = 1024 * 1024;
export function decodeSource(bytes: Buffer): string {
  if (bytes.length > MAX_SOURCE_BYTES) throw new Error('unsupported_source');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error('unsupported_source', { cause: error });
  }
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if ((code < 32 && ![9, 10, 13].includes(code)) || (code >= 127 && code <= 159))
      throw new Error('unsupported_source');
  }
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}
/** Locators address normalized UTF-8 text; raw bytes retain their own SHA-256. */
export function extractChunks(text: string): TextChunk[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const chunks: TextChunk[] = [];
  let start = 0,
    heading = '',
    selected: string[] = [];
  const flush = () => {
    if (selected.length && chunks.length >= 512) throw new Error('source_too_many_chunks');
    if (selected.length)
      chunks.push({ text: selected.join('\n'), startLine: start + 1, endLine: start + selected.length, heading });
    selected = [];
  };
  for (const [index, line] of lines.entries()) {
    if (line.length > 2000) throw new Error('source_line_too_long');
    const title = /^#{1,6}\s+(.+)$/.exec(line);
    if (selected.length && (title || selected.join('\n').length + 1 + line.length > 2000)) flush();
    if (!selected.length) start = index;
    if (title) heading = title[1].slice(0, 200);
    selected.push(line);
  }
  flush();
  return chunks;
}
