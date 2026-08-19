import { readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

function containedBy(path, root) {
  const child = relative(root, path);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

async function existingRoots(roots) {
  const resolved = await Promise.all(roots.map((root) => realpath(root).catch(() => null)));
  return [...new Set(resolved.filter(Boolean))];
}

export async function resolveAllowedDirectory(requestedPath, configuredRoots) {
  const roots = await existingRoots(configuredRoots);
  if (roots.length === 0) throw new Error('No allowed folder roots are available');

  const candidate = await realpath(resolve(requestedPath || roots[0])).catch(() => null);
  if (!candidate || !roots.some((root) => containedBy(candidate, root))) {
    throw new Error('Folder is outside the allowed roots or does not exist');
  }
  const info = await stat(candidate);
  if (!info.isDirectory()) throw new Error('Selected path is not a folder');
  return { path: candidate, roots };
}

export async function browseDirectories(requestedPath, configuredRoots) {
  const { path, roots } = await resolveAllowedDirectory(requestedPath, configuredRoots);
  const entries = await readdir(path, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 500);
  const parentPath = resolve(path, '..');

  return {
    path,
    parent: roots.some((root) => containedBy(parentPath, root)) ? parentPath : null,
    roots,
    directories,
  };
}
