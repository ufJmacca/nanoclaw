import { describe, expect, it } from 'vitest';
import { decodeSource, extractChunks, MAX_SOURCE_BYTES } from './text.js';

describe('S02 deterministic admitted text', () => {
  it('S02-T02: chunks resolve to the actual heading and line range without losing contradictory evidence', () => {
    const text = '# Pilot Alpha\nBlocked on supplier approval.\n\n## Update\nSupplier approval is complete.\n';
    const chunks = extractChunks(decodeSource(Buffer.from(text)));
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({
      text: '# Pilot Alpha\nBlocked on supplier approval.\n',
      startLine: 1,
      endLine: 3,
      heading: 'Pilot Alpha',
    });
    expect(chunks[1]).toEqual({
      text: '## Update\nSupplier approval is complete.',
      startLine: 4,
      endLine: 5,
      heading: 'Update',
    });
    for (const chunk of chunks)
      expect(
        text
          .split('\n')
          .slice(chunk.startLine - 1, chunk.endLine)
          .join('\n'),
      ).toBe(chunk.text);
  });
  it.each([
    Buffer.from([0xc3, 0x28]),
    Buffer.from('hello\0world'),
    Buffer.from('binary\x01data'),
    Buffer.alloc(MAX_SOURCE_BYTES + 1, 65),
  ])('S02-T04: malformed UTF-8, binary control bytes and oversized source are rejected', (bytes) => {
    expect(() => decodeSource(bytes)).toThrow('unsupported_source');
  });
  it('S02-T02: a long line is rejected rather than inventing a truncated line citation', () => {
    expect(() => extractChunks('a'.repeat(2001))).toThrow('source_line_too_long');
  });
  it('preserves UTF-8, normalizes line endings and bounds each chunk', () => {
    const text = decodeSource(Buffer.from('\ufeff# Status\r\nCafé ✓\r\n'));
    expect(text).toBe('# Status\nCafé ✓\n');
    const long = Array.from({ length: 50 }, (_, i) => 'line-' + i + ': ' + 'x'.repeat(120)).join('\n');
    const chunks = extractChunks(long);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((c) => c.text.length <= 2000)).toBe(true);
    expect(chunks.map((c) => c.text).join('\n')).toBe(long);
  });
});
