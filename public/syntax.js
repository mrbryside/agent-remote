import hljs from '/vendor/highlight.js';

const aliases = new Map([
  ['c++', 'cpp'], ['c#', 'csharp'], ['cs', 'csharp'], ['golang', 'go'],
  ['html', 'xml'], ['jsx', 'javascript'], ['js', 'javascript'], ['md', 'markdown'],
  ['py', 'python'], ['rb', 'ruby'], ['rs', 'rust'], ['sh', 'bash'], ['shell', 'bash'],
  ['ts', 'typescript'], ['tsx', 'typescript'], ['vue', 'xml'], ['yml', 'yaml'], ['zsh', 'bash'],
]);

const extensions = new Map([
  ['bash', 'bash'], ['c', 'c'], ['cc', 'cpp'], ['cpp', 'cpp'], ['cs', 'csharp'],
  ['css', 'css'], ['go', 'go'], ['h', 'cpp'], ['hpp', 'cpp'], ['html', 'xml'],
  ['java', 'java'], ['js', 'javascript'], ['jsx', 'javascript'], ['json', 'json'],
  ['kt', 'kotlin'], ['kts', 'kotlin'], ['md', 'markdown'], ['mjs', 'javascript'],
  ['py', 'python'], ['rb', 'ruby'], ['rs', 'rust'], ['scss', 'scss'], ['sh', 'bash'],
  ['sql', 'sql'], ['swift', 'swift'], ['toml', 'ini'], ['ts', 'typescript'],
  ['tsx', 'typescript'], ['xml', 'xml'], ['yaml', 'yaml'], ['yml', 'yaml'], ['zsh', 'bash'],
]);

const autoLanguages = [
  'bash', 'c', 'cpp', 'csharp', 'css', 'go', 'java', 'javascript', 'json',
  'markdown', 'python', 'ruby', 'rust', 'sql', 'typescript', 'xml', 'yaml',
].filter((language) => hljs.getLanguage(language));
const highlightCache = new Map();

function remember(key, result) {
  highlightCache.set(key, result);
  if (highlightCache.size > 2_000) highlightCache.delete(highlightCache.keys().next().value);
  return result;
}

function supportedLanguage(value) {
  const supplied = String(value || '').trim().toLowerCase().replace(/^language-/, '');
  const language = aliases.get(supplied) || supplied;
  return language && hljs.getLanguage(language) ? language : undefined;
}

export function languageForPath(path) {
  const name = String(path || '').split(/[\\/]/).at(-1)?.toLowerCase() || '';
  if (name === 'dockerfile') return supportedLanguage('dockerfile');
  return supportedLanguage(extensions.get(name.split('.').at(-1)));
}

export function highlightCodeNode(node, source, hint) {
  const code = String(source ?? '');
  node.textContent = code;
  node.classList.add('hljs');
  if (!code.trim()) return node;
  try {
    const language = supportedLanguage(hint);
    const cacheKey = `${language || 'auto'}\u0000${code}`;
    const result = highlightCache.get(cacheKey) || remember(cacheKey, language
      ? hljs.highlight(code, { language, ignoreIllegals: true })
      : code.length <= 32_000 ? hljs.highlightAuto(code, autoLanguages) : undefined);
    if (!result) return node;
    node.innerHTML = result.value;
    if (result.language) node.dataset.language = result.language;
  } catch {
    node.textContent = code;
  }
  return node;
}
