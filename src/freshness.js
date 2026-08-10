import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CACHE_VERSION = 1;

export function computeFileHash(filePath, algorithm = 'sha1', signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(`Aborted: Skipping hash computation for ${filePath}`));
      return;
    }
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => {
      if (signal?.aborted) {
        stream.destroy();
        reject(new Error(`Aborted: Skipping hash computation for ${filePath}`));
        return;
      }
      hash.update(chunk);
    });
    stream.on('end', () => resolve(hash.digest('hex')));
    // An Error rather than a string, with the original attached: callers
    // inspect `code` to tell an expected disappearance from a real failure, and
    // a rejected string carries neither a `code` nor a stack.
    stream.on('error', error =>
      reject(new Error(`Error reading file ${filePath}: ${error.message}`, { cause: error })),
    );
  });
}

export async function computeFileHashes(filePaths, algorithm = 'sha1') {
  return new Map(
    await Promise.all(filePaths.map(async p => [p, await computeFileHash(p, algorithm)])),
  );
}

function setsAreSame(s1, s2) {
  return s1.size === s2.size && [...s1].every(x => s2.has(x));
}

export default class Freshness {
  #cacheFile;
  #cacheKey;
  #fileHashes = new Map();
  #fileTimestamps = new Map();
  #loaded = false;

  /**
   * @param {object} [options]
   * @param {string} [options.cacheFile]
   * @param {string} [options.cacheKey]
   */
  constructor({ cacheFile, cacheKey = '' } = {}) {
    this.#cacheFile = cacheFile;
    this.#cacheKey = cacheKey;
  }

  async #load() {
    if (this.#loaded) return;
    this.#loaded = true;
    if (!this.#cacheFile) return;

    try {
      const cache = JSON.parse(await fs.promises.readFile(this.#cacheFile, 'utf8'));
      if (
        cache.version !== CACHE_VERSION ||
        cache.key !== this.#cacheKey ||
        !Array.isArray(cache.files)
      ) {
        return;
      }

      for (const entry of cache.files) {
        if (
          !Array.isArray(entry) ||
          entry.length !== 3 ||
          typeof entry[0] !== 'string' ||
          typeof entry[1] !== 'string' ||
          typeof entry[2] !== 'number'
        ) {
          this.#fileHashes.clear();
          this.#fileTimestamps.clear();
          return;
        }
        this.#fileHashes.set(entry[0], entry[1]);
        this.#fileTimestamps.set(entry[0], entry[2]);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
        console.error(`Error loading freshness cache ${this.#cacheFile}:`, error);
      }
    }
  }

  async #save() {
    if (!this.#cacheFile) return;

    const files = [...this.#fileHashes]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([file, hash]) => [file, hash, this.#fileTimestamps.get(file)]);
    const contents = `${JSON.stringify({ version: CACHE_VERSION, key: this.#cacheKey, files })}\n`;
    const temporary = `${this.#cacheFile}.${process.pid}.${crypto.randomUUID()}.tmp`;

    await fs.promises.mkdir(path.dirname(this.#cacheFile), { recursive: true });
    try {
      await fs.promises.writeFile(temporary, contents);
      await fs.promises.rename(temporary, this.#cacheFile);
    } finally {
      await fs.promises.rm(temporary, { force: true });
    }
  }

  async trackedFiles() {
    await this.#load();
    return new Set(this.#fileHashes.keys());
  }

  async check(filePathSet) {
    await this.#load();
    if (!setsAreSame(filePathSet, new Set(this.#fileHashes.keys()))) {
      return false;
    }
    const controller = new AbortController();
    const { signal } = controller;
    let fresh = true;
    let cacheChanged = false;
    const promises = [...filePathSet].map(async filePath => {
      if (!fresh) return false;
      try {
        const stat = await fs.promises.stat(filePath);
        // mtime fast-path: unchanged mtime means the file content can't have
        // changed, so skip the more expensive hash computation.
        if (this.#fileTimestamps.get(filePath) === stat.mtimeMs) {
          return;
        }
        const newHash = await computeFileHash(filePath, 'sha1', signal);
        const previousHash = this.#fileHashes.get(filePath);
        this.#fileHashes.set(filePath, newHash);
        this.#fileTimestamps.set(filePath, stat.mtimeMs);
        cacheChanged = true;
        if (previousHash !== newHash) {
          fresh = false;
          // Abort remaining in-flight hash computations; we already know the
          // set is stale so there's no value in finishing them.
          controller.abort();
        }
      } catch (error) {
        if (signal.aborted) return;
        fresh = false;
        controller.abort();
        if ((error?.code ?? error?.cause?.code) !== 'ENOENT') {
          console.error(`Error checking file ${filePath}:`, error);
        }
      }
    });
    await Promise.allSettled(promises);
    if (fresh && cacheChanged) await this.#save();
    return fresh;
  }

  async update(fileMapOrSet) {
    await this.#load();
    const isMap = fileMapOrSet instanceof Map;
    const fileSet = isMap ? new Set(fileMapOrSet.keys()) : fileMapOrSet;

    const changed = isMap ? new Map() : new Set();
    const removed = isMap ? new Map() : new Set();

    for (const key of [...this.#fileHashes.keys()]) {
      if (!fileSet.has(key)) {
        this.#fileHashes.delete(key);
        this.#fileTimestamps.delete(key);
        if (isMap) {
          removed.set(key, undefined);
        } else {
          removed.add(key);
        }
      }
    }

    for (const file of fileSet) {
      // Per-file rather than one try around the loop: a single unreadable file
      // must not stop the rest of the set from being tracked. It used to, which
      // meant one deleted source silently froze freshness for every file after
      // it and incremental work stopped happening.
      try {
        const stat = await fs.promises.stat(file);
        const mtime = stat.mtimeMs;
        const prevMtime = this.#fileTimestamps.get(file);
        if (prevMtime !== mtime) {
          const hash = await computeFileHash(file);
          if (this.#fileHashes.get(file) !== hash) {
            if (isMap) {
              changed.set(file, fileMapOrSet.get(file));
            } else {
              changed.add(file);
            }
          }
          this.#fileHashes.set(file, hash);
          this.#fileTimestamps.set(file, mtime);
        }
      } catch (error) {
        // Gone between being collected and being hashed - an ordinary race
        // while watching. Forget it and report it as removed so callers can
        // forget it too.
        this.#fileHashes.delete(file);
        this.#fileTimestamps.delete(file);
        if (isMap) {
          removed.set(file, fileMapOrSet.get(file));
        } else {
          removed.add(file);
        }
        // A vanished file is expected; anything else is worth surfacing. The
        // `cause` covers losing the race a step later, when stat succeeded and
        // the read stream is what found the file gone.
        if ((error?.code ?? error?.cause?.code) !== 'ENOENT') {
          console.error(`Error updating file hash for ${file}:`, error);
        }
      }
    }

    await this.#save();
    return { changed, removed };
  }
}
