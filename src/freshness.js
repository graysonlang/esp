import crypto from 'node:crypto';
import fs from 'node:fs';

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
  #fileHashes = new Map();
  #fileTimestamps = new Map();

  async check(filePathSet) {
    if (!setsAreSame(filePathSet, new Set(this.#fileHashes.keys()))) {
      return false;
    }
    const controller = new AbortController();
    const { signal } = controller;
    let fresh = true;
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
        if (!this.#fileHashes.has(filePath) || this.#fileHashes.get(filePath) !== newHash) {
          this.#fileHashes.set(filePath, newHash);
          this.#fileTimestamps.set(filePath, stat.mtimeMs);
          fresh = false;
          // Abort remaining in-flight hash computations; we already know the
          // set is stale so there's no value in finishing them.
          controller.abort();
        }
      } catch (error) {
        if (signal.aborted) return;
        console.error(`Error checking file ${filePath}:`, error);
        controller.abort();
      }
    });
    await Promise.allSettled(promises);
    return fresh;
  }

  async update(fileMapOrSet) {
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

    return { changed, removed };
  }
}
