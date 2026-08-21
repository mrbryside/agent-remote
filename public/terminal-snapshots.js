function readSnapshots(storage, key) {
  try {
    const stored = JSON.parse(storage.getItem(key) || '{}');
    return new Map(Object.entries(stored).filter(([, snapshot]) =>
      snapshot?.format === 2 && Array.isArray(snapshot.ansiLines) && Number.isFinite(snapshot.savedAt)));
  } catch {
    return new Map();
  }
}

function paletteCode(color, background) {
  if (color < 8) return String((background ? 40 : 30) + color);
  if (color < 16) return String((background ? 100 : 90) + color - 8);
  return `${background ? 48 : 38};5;${color}`;
}

function rgbCode(color, background) {
  return `${background ? 48 : 38};2;${(color >> 16) & 255};${(color >> 8) & 255};${color & 255}`;
}

function cellStyle(cell) {
  const codes = [];
  if (cell.isBold()) codes.push('1');
  if (cell.isDim()) codes.push('2');
  if (cell.isItalic()) codes.push('3');
  if (cell.isUnderline()) codes.push('4');
  if (cell.isBlink()) codes.push('5');
  if (cell.isInverse()) codes.push('7');
  if (cell.isInvisible()) codes.push('8');
  if (cell.isStrikethrough()) codes.push('9');
  if (cell.isOverline()) codes.push('53');
  if (cell.isFgPalette()) codes.push(paletteCode(cell.getFgColor(), false));
  else if (cell.isFgRGB()) codes.push(rgbCode(cell.getFgColor(), false));
  if (cell.isBgPalette()) codes.push(paletteCode(cell.getBgColor(), true));
  else if (cell.isBgRGB()) codes.push(rgbCode(cell.getBgColor(), true));
  return codes.join(';');
}

function serializeLine(line, columns) {
  if (!line) return '';
  let lastVisibleCell = -1;
  for (let column = 0; column < columns; column += 1) {
    const cell = line.getCell(column);
    if (!cell || cell.getWidth() === 0) continue;
    if (cell.getChars() || !cell.isAttributeDefault()) lastVisibleCell = column;
  }
  if (lastVisibleCell < 0) return '';

  let output = '';
  let previousStyle;
  for (let column = 0; column <= lastVisibleCell; column += 1) {
    const cell = line.getCell(column);
    if (!cell || cell.getWidth() === 0) continue;
    const style = cellStyle(cell);
    if (style !== previousStyle) {
      output += style ? `\x1b[0;${style}m` : '\x1b[0m';
      previousStyle = style;
    }
    output += cell.getChars() || ' '.repeat(Math.max(1, cell.getWidth()));
  }
  return `${output}\x1b[0m`;
}

export function createTerminalSnapshotCache({
  storage,
  key,
  maximumEntries = 12,
  maximumSnapshotBytes = 200_000,
  debounceMilliseconds = 220,
}) {
  const snapshots = readSnapshots(storage, key);

  function save() {
    try {
      const newest = [...snapshots.entries()]
        .sort((left, right) => right[1].savedAt - left[1].savedAt)
        .slice(0, maximumEntries);
      snapshots.clear();
      for (const [name, snapshot] of newest) snapshots.set(name, snapshot);
      storage.setItem(key, JSON.stringify(Object.fromEntries(newest)));
    } catch {
      // Snapshot caching only accelerates rendering. Storage limits must not
      // interrupt the live PTY.
    }
  }

  function remove(sessionName) {
    if (!snapshots.delete(sessionName)) return;
    save();
  }

  function restoreSequence(snapshot) {
    const rows = snapshot.ansiLines.slice(0, Math.max(1, snapshot.rows || snapshot.ansiLines.length));
    const screen = rows.map((line, index) => `\x1b[${index + 1};1H${line}`).join('');
    const cursorRow = Math.max(1, Math.min(rows.length || 1, snapshot.cursorRow || 1));
    const cursorColumn = Math.max(1, Math.min(snapshot.cols || 1, snapshot.cursorColumn || 1));
    return `\x1b[0m\x1b[2J\x1b[H${screen}\x1b[0m\x1b[${cursorRow};${cursorColumn}H`;
  }

  function persist(runtime) {
    if (runtime.disposed || !runtime.hasOutput) return;
    const buffer = runtime.terminal.buffer.active;
    const ansiLines = [];
    const rowCount = Math.max(1, runtime.terminal.rows);
    for (let row = 0; row < rowCount; row += 1) {
      const line = buffer.getLine(buffer.viewportY + row);
      ansiLines.push(serializeLine(line, runtime.terminal.cols));
    }
    const snapshot = {
      format: 2,
      ansiLines,
      cols: runtime.terminal.cols,
      rows: rowCount,
      cursorRow: buffer.baseY + buffer.cursorY - buffer.viewportY + 1,
      cursorColumn: buffer.cursorX + 1,
      savedAt: Date.now(),
    };
    if (JSON.stringify(snapshot).length > maximumSnapshotBytes) return;
    snapshots.set(runtime.name, snapshot);
    save();
  }

  function schedule(runtime) {
    clearTimeout(runtime.snapshotTimer);
    runtime.snapshotTimer = setTimeout(() => persist(runtime), debounceMilliseconds);
  }

  return { snapshots, persist, remove, restoreSequence, schedule };
}
