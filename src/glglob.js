import fs_promises from 'node:fs/promises';
import path from 'node:path';

function convert(segment) {
  const special = /[.+^${}()|[\]\\]/g;
  let str = '^';
  for (let ch of segment) {
    if (ch === '*') {
      str += '[^/]*';
    } else if (ch === '?') {
      str += '[^/]';
    } else {
      str += ch.replace(special, '\\$&');
    }
  }
  return new RegExp(str + '$');
}

function expand(segment) {
  const match = segment.match(/\{([^}]+)\}/);
  if (!match) {
    return [segment];
  }

  const [full, inner] = match;
  const variants = inner.split(',');
  const before = segment.slice(0, match.index);
  const after = segment.slice(match.index + full.length);

  return variants.flatMap(variant => expand(before + variant + after));
}

async function match(dir, segments, index, baseDir, results, memo, regexCache, includeDot) {
  // Memoize by pattern-index + directory to prevent exponential re-traversal
  // when ** causes the same directory to be visited at the same depth twice.
  const key = `${index}:${dir}`;
  if (memo.has(key)) {
    return;
  }
  memo.add(key);

  if (index >= segments.length) {
    return;
  }

  const segment = segments[index];

  if (segment === '**') {
    // Advance past ** to try matching the rest of the pattern in the current
    // directory (handles the zero-segments case).
    await match(dir, segments, index + 1, baseDir, results, memo, regexCache, includeDot);

    let entries;
    try {
      entries = await fs_promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(entries.map(async (entry) => {
      if (!includeDot && entry.name.startsWith('.')) return;
      if (entry.isDirectory()) {
        // Recurse with the same index so ** continues to match deeper levels.
        await match(
          path.join(dir, entry.name),
          segments,
          index,
          baseDir,
          results,
          memo,
          regexCache,
          includeDot,
        );
      }
    }));

    return;
  }

  const expanded = expand(segment);
  const regexes = expanded.map((exp) => {
    if (!regexCache.has(exp)) {
      regexCache.set(exp, convert(exp));
    }
    return regexCache.get(exp);
  });

  let entries;
  try {
    entries = await fs_promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const isLast = (index === segments.length - 1);

  await Promise.all(entries.map(async (entry) => {
    if (!includeDot && entry.name.startsWith('.')) {
      return;
    }

    for (let rx of regexes) {
      if (rx.test(entry.name)) {
        const fullPath = path.join(dir, entry.name);

        if (isLast) {
          if (entry.isFile()) {
            const rel = path.relative(baseDir, fullPath).replace(/\\/g, '/');
            results.push(rel);
          }
        } else {
          if (entry.isDirectory()) {
            await match(fullPath, segments, index + 1, baseDir, results, memo, regexCache, includeDot);
          }
        }

        break;
      }
    }
  }));
}

function validate(pattern) {
  if (pattern.includes('[') || pattern.includes(']')) {
    throw new Error('Character sets (e.g. [a-z]) are not supported.');
  }
  if (pattern.includes('!(') || pattern.includes('@(') || pattern.includes('+(')) {
    throw new Error('Extglobs like !(pattern) are not supported.');
  }
  if (pattern.includes('\0')) {
    throw new Error('Null characters are not allowed in glob patterns.');
  }
}

export default async function glob(pattern, baseDir = '', options = {}) {
  validate(pattern);

  baseDir = path.resolve(baseDir);
  const segments = pattern.replace(/\\/g, '/').split('/');
  const results = [];
  const memo = new Set();
  const regexCache = new Map();
  const includeDot = options.includeDot ?? false;

  await match(baseDir, segments, 0, baseDir, results, memo, regexCache, includeDot);
  return results;
}
