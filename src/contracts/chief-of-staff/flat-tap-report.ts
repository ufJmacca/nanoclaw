/** Exact complete named flat TAP coverage. Aggregate counts alone never supply a gate. */
export function verifyExactFlatTap(text: string, required: readonly string[]): { actualCases: number } {
  try {
    if (
      typeof text !== 'string' ||
      Buffer.byteLength(text) > 1024 ** 2 ||
      !Array.isArray(required) ||
      required.length < 1 ||
      required.length > 500 ||
      required.some((name) => typeof name !== 'string' || !name || name.length > 1000) ||
      /^\s*not ok\b/m.test(text) ||
      /^\s*Bail out!/im.test(text) ||
      /^\s+(?:ok|not ok)\b/m.test(text)
    )
      throw Error('report');
    const lines = text.split(/\r?\n/),
      records = lines.filter((line) => /^(?:ok|not ok)\b/.test(line)),
      count = required.length,
      names = new Set<string>(),
      ids = new Set<number>();
    if (records.length !== count || new Set(required).size !== count) throw Error('coverage');
    for (const line of records) {
      const match = /^ok ([1-9][0-9]*) - (.+)$/.exec(line);
      if (!match) throw Error('case');
      const id = Number(match[1]),
        name = match[2];
      if (id > count || ids.has(id) || names.has(name) || !required.includes(name)) throw Error('case');
      ids.add(id);
      names.add(name);
    }
    for (const [pattern, expected] of [
      [/^TAP version .*$/, 'TAP version 13'],
      [/^[0-9]+\.\.[0-9]+$/, '1..' + count],
      [/^# tests .*$/, '# tests ' + count],
      [/^# suites .*$/, '# suites 0'],
      [/^# pass .*$/, '# pass ' + count],
      [/^# fail .*$/, '# fail 0'],
      [/^# cancelled .*$/, '# cancelled 0'],
      [/^# skipped .*$/, '# skipped 0'],
      [/^# todo .*$/, '# todo 0'],
    ] as const) {
      const found = lines.filter((line) => pattern.test(line));
      if (found.length !== 1 || found[0] !== expected) throw Error('summary');
    }
    return { actualCases: count };
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private database and fixture diagnostics do not leave this fixed gate error.
    throw Error('fixture_tap_report_unverified');
  }
}
