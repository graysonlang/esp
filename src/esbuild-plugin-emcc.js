import child_process from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';

import Freshness from './freshness.js';
import {
  computeUrlSafeBase64Digest,
  parsePathsString,
} from './helpers.js';

const execFileAsync = util.promisify(child_process.execFile);

export default function createPlugin({
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
  const _freshness = new Freshness();
  return {
    name: 'emcc',
    setup(build) {
      build.onStart(() => {
        buildStartTime = Date.now();
        _entryPoints.clear();
        _resolveDirs.clear();
      });

      build.onResolve({ filter: resolveFilter }, (args) => {
        console.log('resolve');
        lastOnResolveTime = Date.now();
        logger?.(pluginNamespace);
        const filePath = path.relative('', path.join(args.resolveDir, args.path));
        _resolveDirs.set(filePath, args.resolveDir);
        return { path: filePath, namespace: pluginNamespace };
      });

      build.onLoad({ filter: /.*/, namespace: pluginNamespace }, async (args) => {
        const withDict = args.with || {};
        const options = withDict.options || '';
        const sources = withDict.sources ? parsePathsString(withDict.sources) : [];

        const allOptions = [...emccOptions, ...(options.split(/\s+/))];

        const importingDir = _resolveDirs.get(args.path);
        const primarySource = path.relative(importingDir, path.resolve('', args.path));
        const primarySources = [primarySource, ...sources];

        const watchFilesSet = new Set();
        for (const source of primarySources) {
          const relPath = path.relative('', path.resolve(importingDir, source));

          // -MM emits Makefile-style dependency info listing all transitively
          // included headers. -MP adds phony targets so make doesn't error on
          // deleted headers. -MT sets the target name used in that output.
          const child = child_process.spawnSync(
            emccPath,
            [`-MT${source}`, '-MP', '-MM', source, ...allOptions],
            { cwd: importingDir, encoding: 'utf8' },
          );
          if (child.error) {
            console.log(`ERROR: ${child.error}`);
          }
          let makefile = child.stdout.toString().replace(/\\\n/g, '').replace(/:.*[\n$]+/g, '\n').trim();
          let foundFiles = makefile.split('\n');

          foundFiles.forEach((file) => {
            watchFilesSet.add(path.relative('', path.resolve(importingDir, file)));
          });
        }

        const outDir = path.resolve('', build.initialOptions.outdir || path.dirname(build.initialOptions.outfile));

        const parsed = path.parse(args.path);
        // Hash the source path to avoid output filename collisions when the
        // same filename (e.g. foo.c) appears in multiple directories.
        const suffix = computeUrlSafeBase64Digest(args.path);
        const outFile = path.join(outDir, `${parsed.base}.${suffix}.mjs`);
        watchFilesSet.add(path.relative('', outFile));

        // Check if output will include a separate .wasm file
        const isSingleFile = allOptions.includes('-sSINGLE_FILE=1');
        if (!isSingleFile) {
          const wasmFile = path.join(outDir, `${parsed.base}.${suffix}.wasm`);
          watchFilesSet.add(path.relative('', wasmFile));
        }

        if (verbose) {
          console.log('[emcc] watchFilesSet:', [...watchFilesSet]);
        }

        const needsRecompile = !(await _freshness.check(watchFilesSet));
        if (needsRecompile) {
          if (verbose) {
            const compilingPaths = primarySources.map(source => path.relative('', path.resolve(importingDir, source)));
            console.log(`Compiling: ${compilingPaths.join(' ')}`);
            logger?.(`⚙️ Compiling: ${compilingPaths.join(' ')}`);
          }
          const finalFlags = [
            ...primarySources,
            '-o', `${path.relative(importingDir, outFile)}`,
            '-Os',
            '-sENVIRONMENT=web',
            '-sEXPORT_ES6=1',
            '-sMODULARIZE=1',
            ...allOptions,
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
            logger?.(`⏭️ Skipping compilation`);
          }
        }

        _entryPoints.set(path.relative('', args.path), new Set(watchFilesSet));

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

        _freshness.update(new Set([..._entryPoints.values()].flatMap(set => [...set])));
      });
    },
  };
}
