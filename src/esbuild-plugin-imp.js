import fs_promises from 'node:fs/promises';
import path from 'node:path';

import Freshness from './freshness.js';
import { consolidateDirs } from './helpers.js'

export default function createPlugin({
  verbose = false,
  logger,
} = {}) {
  const pluginNamespace = 'imp';

  let buildStartTime = 0;
  let lastOnResolveTime = 0;

  const _freshness = new Freshness();
  const _sourceToDest = new Map();
  const _resolveDirs = new Map();

  return {
    name: 'imp',
    setup(build) {
      build.onStart(() => {
        buildStartTime = Date.now();
        _sourceToDest.clear();
      });

      build.onResolve({ filter: /^virtual:copy$/ }, (args) => {
        lastOnResolveTime = Date.now();
        console.log(`resolve: ${pluginNamespace}`)
        logger?.(pluginNamespace);

        const withDict = args.with || {};
        const srcPath = withDict.path || '';
        if (!srcPath) {
          console.error("Error: path is unspecified or empty.");
        }
        const filePath = path.relative('', path.join(args.resolveDir, srcPath));
        return { path: filePath, namespace: pluginNamespace, sideEffects: false };
      });

      build.onLoad({ filter: /.*/, namespace: pluginNamespace }, async (args) => {
        const withDict = args.with || {};

        const outdir = path.relative('', path.resolve('', build.initialOptions.outdir || path.dirname(build.initialOptions.outfile)));
        const dstPath = path.join(outdir, withDict.dest || path.dirname(args.path), path.basename(args.path));

        const watchFilesSet = new Set();
        _sourceToDest.set(args.path, dstPath);
        watchFilesSet.add(args.path).add(dstPath);
        console.log(watchFilesSet)

        return {
          contents: '',
          loader: 'file',
          watchFiles: [...watchFilesSet],
        };
      });

      build.onEnd(async () => {
        if (buildStartTime > lastOnResolveTime) {
          return;
        }

        const updates = await _freshness.update(_sourceToDest);

        const dirs = new Set();
        for (const [, dst] of updates.changed) {
          const dir = path.dirname(dst);
          if (dir) dirs.add(dir);
        }

        const dirsToMake = consolidateDirs(dirs);
        if (verbose) {
          dirsToMake.forEach(dir => { console.log(`mkdir: ${dir}`)});
        }
        await Promise.all(dirsToMake.map(dir => fs_promises.mkdir(dir, { recursive: true })));

        const copies = [];
        for (const [src, dst] of updates.changed) {
          if (verbose) {
            console.log(`copying: ${src} -> ${dst}`);
          }
          copies.push(fs_promises.copyFile(src, dst));
        }

        await Promise.all(copies);
      });
    },
  };
}
