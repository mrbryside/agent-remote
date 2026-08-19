import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

const ignoredDirectories = new Set(['.git', 'node_modules', 'target', 'dist', 'build', '.next']);

function fuzzyScore(path, query) {
  if (!query) return path.split('/').length * 10 + path.length / 100;
  const candidate = path.toLowerCase();
  const needle = query.toLowerCase();
  const file = basename(candidate);
  if (file === needle) return -1000;
  if (file.startsWith(needle)) return -700 + file.length;
  const contained = candidate.indexOf(needle);
  if (contained >= 0) return -400 + contained + candidate.length / 100;
  let cursor = 0;
  let gaps = 0;
  for (const character of needle) {
    const found = candidate.indexOf(character, cursor);
    if (found < 0) return undefined;
    gaps += found - cursor;
    cursor = found + 1;
  }
  return gaps + candidate.length / 10;
}

export async function searchProjectFiles(root, query = '', { limit = 20, maximumEntries = 25_000 } = {}) {
  const normalizedQuery = String(query).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160);
  const queue = [root];
  const matches = [];
  let visited = 0;
  while (queue.length && visited < maximumEntries) {
    const directory = queue.shift();
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (++visited > maximumEntries) break;
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) queue.push(join(directory, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const path = relative(root, join(directory, entry.name)).split(sep).join('/');
      const score = fuzzyScore(path, normalizedQuery);
      if (score === undefined) continue;
      matches.push({ path, name: entry.name, directory: dirname(path) === '.' ? '' : dirname(path), score });
    }
  }
  return matches.sort((left, right) => left.score - right.score || left.path.localeCompare(right.path))
    .slice(0, Math.max(1, Math.min(50, limit)))
    .map(({ score: _score, ...entry }) => entry);
}

export async function resolveProjectFiles(root, paths) {
  const canonicalRoot = await realpath(root);
  const resolved = [];
  for (const value of paths) {
    if (typeof value !== 'string' || !value || value.length > 1024 || isAbsolute(value) ||
        value.split(/[\\/]/).some((segment) => segment === '..' || segment === '')) {
      const error = new Error('File mention is invalid');
      error.code = 'FILE_MENTION_INVALID';
      throw error;
    }
    const candidate = await realpath(join(canonicalRoot, value));
    if (candidate !== canonicalRoot && !candidate.startsWith(`${canonicalRoot}${sep}`)) {
      const error = new Error('File mention escapes the project');
      error.code = 'FILE_MENTION_INVALID';
      throw error;
    }
    if (!(await stat(candidate)).isFile()) {
      const error = new Error('File mention must point to a file');
      error.code = 'FILE_MENTION_INVALID';
      throw error;
    }
    resolved.push({ path: value.split('\\').join('/'), absolutePath: candidate });
  }
  return resolved;
}

export async function readProjectFile(root, path, { maximumBytes = 512 * 1024 } = {}) {
  const [resolved] = await resolveProjectFiles(root, [path]);
  const info = await stat(resolved.absolutePath);
  if (info.size > maximumBytes) {
    const error = new Error('File is too large to preview');
    error.code = 'FILE_PREVIEW_TOO_LARGE';
    throw error;
  }
  const data = await readFile(resolved.absolutePath);
  if (data.includes(0)) {
    const error = new Error('Binary files cannot be previewed as text');
    error.code = 'FILE_PREVIEW_BINARY';
    throw error;
  }
  const content = data.toString('utf8');
  return {
    path: resolved.path,
    content,
    size: data.length,
    totalLines: content ? content.replace(/\n$/, '').split('\n').length : 0,
    startLine: 1,
  };
}
