import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function computeFileHash(filePath, signal, algorithm = 'sha1') {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(`Aborted: Skipping hash computation for ${filePath}`));
      return;
    }
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => {
      if (signal?.aborted) {
        stream.destroy();
        reject(new Error(`Aborted: Skipping hash computation for ${filePath}`));
        return;
      }
      hash.update(chunk);
    });
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', (error) => reject(`Error reading file ${filePath}: ${error.message}`));
  });
}

export async function computeFileHashes(filePaths, algorithm = 'sha1') {
  return new Map(await Promise.all(filePaths.map(async p => [p, await computeFileHash(p, algorithm)])));
}

function setsAreSame(s1, s2) { return s1.size === s2.size && [...s1].every((x) => s2.has(x)); }

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
    const promises = [...filePathSet].map(async (filePath) => {
      if (!fresh) return false;
      try {
        const stat = await fs.promises.stat(filePath);
        if (this.#fileTimestamps.get(filePath) === stat.mtimeMs) {
          return; // Timestamp unchanged; skip hashing
        }
        const newHash = await computeFileHash(filePath, signal);
        if (!this.#fileHashes.has(filePath) || this.#fileHashes.get(filePath) !== newHash) {
          this.#fileHashes.set(filePath, newHash);
          this.#fileTimestamps.set(filePath, stat.mtimeMs);
          fresh = false;
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

    try {
      for (const file of fileSet) {
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
      }
    } catch (error) {
      console.error('Error updating file hashes:', error);
    }

    return { changed, removed };
  }
}
