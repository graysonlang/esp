import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';

import Freshness from './freshness.js';
import { computeUrlSafeBase64Digest, parsePathsString } from './helpers.js';

const execFileAsync = util.promisify(child_process.execFile);

const CACHE_VERSION = 1;
const DEFAULT_COMPILE_OPTIONS = ['-Os', '-sENVIRONMENT=web', '-sEXPORT_ES6=1', '-sMODULARIZE=1'];
const DEFAULT_CACHE_DIRECTORY = path.join('node_modules', '.cache', '@graysonlang', 'esp', 'emcc');

function getCompilerIdentity(emccPath, cwd) {
  const child = child_process.spawnSync(emccPath, ['--version'], {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });

  return {
    path: emccPath,
    status: child.status,
    version: `${child.stdout || ''}\n${child.stderr || ''}`.trim(),
    error: child.error?.message,
  };
}

/**
 * @param {object} [options]
 * @param {string | null} [options.cacheDirectory]
 * @param {string[]} [options.emccOptions]
 * @param {string} [options.emccPath]
 * @param {boolean} [options.verbose]
 * @param {(message: string) => void} [options.logger]
 */
export default function createPlugin({
  cacheDirectory = DEFAULT_CACHE_DIRECTORY,
  emccOptions = [],
  emccPath = 'emcc',
  verbose = false,
  logger,
} = {}) {
  const pluginNamespace = 'emcc';
  const resolveFilter = /\.c(?:c|(?:pp)|(?:xx))?$/i;

  let buildStartTime = 0;
  let lastOnResolveTime = 0;

  const _entryPoints = new Map();
  const _resolveDirs = new Map();
  const _freshnessCaches = new Map();
  const _compilerIdentities = new Map();
  return {
    name: 'emcc',
    setup(build) {
      build.onStart(() => {
        buildStartTime = Date.now();
        _entryPoints.clear();
        _resolveDirs.clear();
      });

      build.onResolve({ filter: resolveFilter }, args => {
        lastOnResolveTime = Date.now();
        logger?.(pluginNamespace);
        const filePath = path.relative('', path.join(args.resolveDir, args.path));
        _resolveDirs.set(filePath, args.resolveDir);
        return { path: filePath, namespace: pluginNamespace };
      });

      build.onLoad({ filter: /.*/, namespace: pluginNamespace }, async args => {
        const withDict = args.with || {};
        const options = withDict.options || '';
        const sources = withDict.sources ? parsePathsString(withDict.sources) : [];

        const allOptions = [...emccOptions, ...options.split(/\s+/).filter(Boolean)];

        const importingDir = _resolveDirs.get(args.path);
        const primarySource = path.relative(importingDir, path.resolve('', args.path));
        const primarySources = [primarySource, ...sources];
        const compileOptions = [...DEFAULT_COMPILE_OPTIONS, ...allOptions];

        const outDir = path.resolve(
          build.initialOptions.absWorkingDir || '',
          build.initialOptions.outdir || path.dirname(build.initialOptions.outfile),
        );

        const parsed = path.parse(args.path);
        // Hash the source path to avoid output filename collisions when the
        // same filename (e.g. foo.c) appears in multiple directories.
        const suffix = computeUrlSafeBase64Digest(args.path);
        const outFile = path.join(outDir, `${parsed.base}.${suffix}.mjs`);

        // Check if output will include a separate .wasm file
        const isSingleFile = allOptions.includes('-sSINGLE_FILE=1');
        if (!_compilerIdentities.has(importingDir)) {
          _compilerIdentities.set(importingDir, getCompilerIdentity(emccPath, importingDir));
        }
        const cacheKey = computeUrlSafeBase64Digest(
          JSON.stringify({
            version: CACHE_VERSION,
            compiler: _compilerIdentities.get(importingDir),
            environment: {
              EMCC_CFLAGS: process.env.EMCC_CFLAGS,
              EM_CONFIG: process.env.EM_CONFIG,
              EM_CACHE: process.env.EM_CACHE,
              EMSDK: process.env.EMSDK,
              PATH: process.env.PATH,
            },
            sources: primarySources.map(source => path.resolve(importingDir, source)),
            outFile,
            options: compileOptions,
          }),
        );
        const resolvedCacheDirectory =
          cacheDirectory === null
            ? null
            : path.resolve(build.initialOptions.absWorkingDir || '', cacheDirectory);
        const cacheFile = resolvedCacheDirectory
          ? path.join(
              resolvedCacheDirectory,
              `${computeUrlSafeBase64Digest(path.resolve(outFile))}.json`,
            )
          : undefined;
        const freshnessId = `${cacheFile || args.path}\0${cacheKey}`;
        let freshness = _freshnessCaches.get(freshnessId);
        if (!freshness) {
          freshness = new Freshness({ cacheFile, cacheKey });
          _freshnessCaches.set(freshnessId, freshness);
        }

        let watchFilesSet = await freshness.trackedFiles();
        const needsRecompile = watchFilesSet.size === 0 || !(await freshness.check(watchFilesSet));
        if (needsRecompile) {
          watchFilesSet = new Set();
          for (const source of primarySources) {
            // -MM emits Makefile-style dependency info listing all transitively
            // included headers. -MP adds phony targets so make doesn't error on
            // deleted headers. -MT sets the target name used in that output.
            const child = child_process.spawnSync(
              emccPath,
              [`-MT${source}`, '-MP', '-MM', source, ...allOptions],
              // On Windows, Emscripten's `emcc` is a .bat/.cmd wrapper, which
              // spawnSync only resolves through a shell. (Source paths with spaces
              // would need quoting under shell mode, but project sources rarely do.)
              { cwd: importingDir, encoding: 'utf8', shell: process.platform === 'win32' },
            );
            if (child.error) {
              throw child.error;
            }
            if (child.status !== 0) {
              throw new Error(
                `Error discovering dependencies for '${source}': ${String(child.stderr || '').trim()}`,
              );
            }
            const makefile = child.stdout
              .toString()
              .replace(/\\\n/g, '')
              .replace(/:.*[\n$]+/g, '\n')
              .trim();
            const foundFiles = makefile.split('\n').filter(Boolean);

            foundFiles.forEach(file => {
              watchFilesSet.add(path.resolve(importingDir, file));
            });
          }

          watchFilesSet.add(outFile);
          if (!isSingleFile) {
            watchFilesSet.add(path.join(outDir, `${parsed.base}.${suffix}.wasm`));
          }

          if (verbose) {
            console.log('[emcc] watchFilesSet:', [...watchFilesSet]);
          }

          if (verbose) {
            const compilingPaths = primarySources.map(source =>
              path.relative('', path.resolve(importingDir, source)),
            );
            console.log(`Compiling: ${compilingPaths.join(' ')}`);
            logger?.(`⚙️ Compiling: ${compilingPaths.join(' ')}`);
          }
          const finalFlags = [
            ...primarySources,
            '-o',
            `${path.relative(importingDir, outFile)}`,
            ...compileOptions,
          ];
          try {
            await fs.promises.mkdir(outDir, { recursive: true });
            await execFileAsync(emccPath, finalFlags, { cwd: importingDir });
          } catch (error) {
            console.error(`Error compiling '${args.path}':`, error);
            throw error;
          }
        } else {
          if (verbose) {
            console.log(`Skipping compilation: ${primarySource}`);
            logger?.('⏭️ Skipping compilation');
          }
        }

        _entryPoints.set(path.relative('', args.path), { freshness, watchFilesSet });

        return {
          contents: await fs.promises.readFile(outFile, 'utf8'),
          watchFiles: [...watchFilesSet],
          loader: 'js',
        };
      });

      build.onEnd(async () => {
        // If no C/C++ files were resolved this build (e.g. a rebuild triggered
        // by an unrelated file change), skip the freshness update.
        if (buildStartTime > lastOnResolveTime) {
          return;
        }

        await Promise.all(
          [..._entryPoints.values()].map(({ freshness, watchFilesSet }) =>
            freshness.update(watchFilesSet),
          ),
        );
      });
    },
  };
}
