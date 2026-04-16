import crypto from 'node:crypto';

export function computeUrlSafeBase64Digest(input, algorithm = 'sha1') {
  const hash = crypto.createHash(algorithm).update(input, 'utf8').digest('base64');
  return hash.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function consolidateDirs(dirs) {
  if (!dirs || dirs.size === 0) return [];

  const trie = {};
  for (const dir of dirs) {
    if (!dir) continue;
    const parts = dir.split('/');
    let node = trie;
    for (const part of parts) {
      if (!node[part]) {
        node[part] = {};
      }
      node = node[part];
    }
  }

  const result = [];

  function collect(node, prefix) {
    const keys = Object.keys(node);
    if (keys.length === 0) {
      if (prefix) result.push(prefix);
      return;
    }
    for (const key of keys) {
      collect(node[key], prefix ? `${prefix}/${key}` : key);
    }
  }

  collect(trie, '');
  return result;
}

export function parsePathsString(input = '') {
  const elementRegex = /"([^\"]*)"|'([^']*)'|[^\s]+/g;
  const result = [];
  let match;
  while ((match = elementRegex.exec(input)) !== null) {
    let token = match[0];
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith('\'') && token.endsWith('\''))) {
      token = token.slice(1, -1);
    } else {
      token = token.replace(/\\ /g, ' ');
    }
    result.push(token);
  }
  return result;
}
