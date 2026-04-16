import pluginGlobCopy from '@graysonlang/esp/esbuild-plugin-glob-copy';
import pluginImp from '@graysonlang/esp/esbuild-plugin-imp';
import { runBuild } from '@graysonlang/esp/esbuild-runner';

// getOptions receives (extraArgs, verbose, logger) from runBuild.
// extraArgs contains resolved CLI flags (minify, banner, etc.) to spread in.
// verbose and logger are passed through to plugins that support them.
function getOptions(args, verbose, logger) {
  return {
    assetNames: '[name]',
    bundle: true,
    entryPoints: {
      index: 'example/src/index.js',
      main: 'example/app/main.js',
    },
    format: 'esm',
    loader: {
      '.html': 'file',
    },
    outdir: 'dist',
    plugins: [
      pluginGlobCopy({ logger }),
      pluginImp({ logger, verbose }),
    ],
    sourcemap: true,
    target: ['esnext'],
    ...args,
  };
}

runBuild(getOptions);
