function subsequenceScore(name, query) {
  let cursor = 0;
  let gaps = 0;
  for (const character of query) {
    const next = name.indexOf(character, cursor);
    if (next < 0) return Number.POSITIVE_INFINITY;
    gaps += next - cursor;
    cursor = next + 1;
  }
  return gaps + name.length / 1_000;
}

export function rankedCommands(commands, query) {
  const needle = query.trim().toLowerCase();
  const entries = commands.map((command, index) => ({
    command, index, name: String(command.name || '').toLowerCase(),
  }));
  if (!needle) return entries.map(({ command }) => command);
  const sorted = (matches, score) => matches.sort((left, right) =>
    score(left) - score(right) || left.name.length - right.name.length || left.index - right.index)
    .map(({ command }) => command);
  const exact = entries.filter(({ name }) => name === needle);
  if (exact.length) return exact.map(({ command }) => command);
  const prefixes = entries.filter(({ name }) => name.startsWith(needle));
  if (prefixes.length) return sorted(prefixes, () => 0);
  const contained = entries.filter(({ name }) => name.includes(needle));
  if (contained.length) return sorted(contained, ({ name }) => name.indexOf(needle));
  return sorted(entries.filter(({ name }) => Number.isFinite(subsequenceScore(name, needle))),
    ({ name }) => subsequenceScore(name, needle));
}

export function composerCompletion(value, caret = value.length) {
  const before = value.slice(0, caret);
  const slash = before.match(/(?:^|\n)(\s*)\/([^\s]*)$/);
  if (slash) return { kind: 'command', query: slash[2], start: caret - slash[2].length - 1, end: caret };
  const file = before.match(/(?:^|\s)@([^\s]*)$/);
  if (file) return { kind: 'file', query: file[1], start: caret - file[1].length - 1, end: caret };
  return undefined;
}
