import fs_promises from 'node:fs/promises';
import path from 'node:path';

import Freshness from './freshness.js';
import glob from './glglob.js';
import { consolidateDirs } from './helpers.js';

export default function createPlugin({
  sideEffects = false,
  verbose = false,
  logger = undefined,
} = {}) {
  const pluginNamespace = 'glob-copy';

  const _freshness = new Freshness();
  const _sourceToDest = new Map();
  const _resolveDirs = new Map();

  let buildStartTime = 0;
  let lastOnResolveTime = 0;

  return {
    name: 'glob-copy',
    setup(build) {
      build.onStart(() => {
        buildStartTime = Date.now();
        _sourceToDest.clear();
        _resolveDirs.clear();
      });

      build.onResolve({ filter: /^virtual:glob$/ }, (args) => {
        lastOnResolveTime = Date.now();
        const filePath = path.relative('', path.join(args.resolveDir, args.path));
        _resolveDirs.set(filePath, args.resolveDir);
        return { path: filePath, namespace: pluginNamespace, sideEffects };
      });

      build.onLoad({ filter: /.*/, namespace: pluginNamespace }, async (args) => {
        const withDict = args.with || {};
        const dest = args.dest || '';
        const baseDir = withDict.baseDir || '';
        const pattern = withDict.pattern || '';
        if (!pattern) {
          console.error('Error: glob pattern is empty.');
        }
        const resolveDir = path.join(_resolveDirs.get(args.path), baseDir);

        const matches = await glob(pattern, resolveDir);
        const paths = matches.map(f => path.relative('', path.resolve(resolveDir, f)));
        const outdir = path.relative('', path.resolve('', build.initialOptions.outdir || path.dirname(build.initialOptions.outfile)));

        const watchFilesSet = new Set();

        for (const src of paths) {
          const dest = path.join(outdir, src);
          _sourceToDest.set(src, dest);
          watchFilesSet.add(src);
        };

        return {
          contents: `
export const paths = ${JSON.stringify(paths)};
export default function getPaths() { return paths; }
`,
          loader: 'js',
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
          dirsToMake.forEach((dir) => {
            console.log(`mkdir: ${dir}`);
          });
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
