# Source maps & VS Code breakpoints

When debugging an esp dev build in VS Code (the Chrome debugger driven by `.vscode/launch.json`), breakpoints in `.ts`/`.js` sources can fail to bind — they show hollow/grey ("unverified") and never hit. Setting `webRoot` to `"${workspaceFolder}/src"` appears to fix it, but only by coincidence. This is a structural interaction between esbuild's source maps and vscode-js-debug, not a misconfiguration. The sections below explain it and give esp's recommended configuration.

## Root cause

Binding fails when three independently-correct behaviors compose:

1. **esbuild writes `sources` relative to the output directory.** With `outdir: dist` sitting beside the `src/` and `app/` roots, every entry comes out as `../src/...` / `../app/...`. This is pure relative-path arithmetic and is spec-correct: per the Source Map v3 spec, `sources` resolve relative to the `.map` file's own location, and `dist/main.js.map` genuinely reaches `src/` by going up one level.

   ```
   outdir: "dist"  ->  sources: ["../src/util.ts", "../app/main.ts"]
   outdir: "."     ->  sources: ["src/util.ts",    "app/main.ts"]     (no ..)
   ```

   The `../` exists only because the output dir is a sibling of the sources; nothing passed to esbuild removes it short of emitting into the project root.

2. **`sourceRoot` does not remove the `../`.** Per the spec, `sourceRoot` is a string *prepended* to each source, not a path transform. esbuild emits the same `sources` array regardless of its value, so the `../` remains.

3. **The dev server serves `dist/` as the web root, and vscode-js-debug resolves a source by joining it onto `webRoot`, keeping the `..`.** With `webRoot: "${workspaceFolder}"`, `../src/util.ts` resolves to `<workspaceFolder>/../src/util.ts` — one level *above* the repo — so the file isn't found and the breakpoint can't bind. `webRoot: "${workspaceFolder}/src"` only "works" because `…/src/../src/util.ts` collapses back to `…/src/util.ts` (and `…/src/../app/main.ts` to `…/app/main.ts`); it cancels the `../` and nothing more.

By contrast, Vite binds with `webRoot: "${workspaceFolder}"` because its dev server serves the source files themselves at `/src/...` URLs — the served tree mirrors disk from the project root. esp deliberately serves only `dist/` (a clean artifact boundary that mirrors production), which is what exposes the offset.

Chrome DevTools resolves these maps correctly through its own workspace mapping; the friction is specific to vscode-js-debug and the way `launch.json` exposes `webRoot`.

## Where it can be fixed

The offset between "`dist/` is the web root" and "the sources live above `dist/`" has to be absorbed somewhere. There is no free lunch — only a choice of which layer owns it:

| Layer | Fix | Trade-off |
|-------|-----|-----------|
| **Producer** (esbuild output) | A post-build plugin rewrites `sources` to project-root-relative (`src/...`), the `outdir: '.'` shape. | Ergonomic, a common community choice. But makes the map *less* spec-pure: sources no longer resolve relative to the `.map`'s own location. Safe only because `sourcesContent` is embedded, so content-based consumers are unaffected. Bakes in `webRoot == project root`. |
| **Serve shape** (esp) | Serve the project root and load `/dist/main.js`, so the served tree mirrors disk and `../src` resolves correctly. | Fully spec-correct, no plugin. But the dev server then exposes the whole tree (`node_modules`, `.git`, raw sources), defeating the clean dist-only boundary. |
| **Consumer** (`launch.json`) | `sourceMapPathOverrides` remaps the source paths in the debugger only. | Leaves the esbuild map pristine and spec-correct (Chrome DevTools keeps working). The compromise lives entirely in per-project debug config — which is also the layer that holds the divergent assumption. |

## Recommended configuration

esp fixes it in the consumer, keeping esbuild's output spec-correct and correcting the resolution where the divergent assumption lives — vscode-js-debug. Because the friction is VS-Code-specific (Chrome DevTools is already fine), the fix belongs in `launch.json`, not in the build output or the serve model:

```jsonc
{
  "webRoot": "${workspaceFolder}",
  // esbuild emits sources as `../src/...` (relative to outdir `dist/`). Strip the
  // leading `../` and rebase onto the project root, where the files actually are.
  "sourceMapPathOverrides": { "../*": "${workspaceFolder}/*" }
}
```

`../src/util.ts` → `${workspaceFolder}/src/util.ts`, `../app/main.ts` → `${workspaceFolder}/app/main.ts`. A single rule covers every top-level source directory because `outdir` sits one level below the project root, so every source begins with one `../`. (If `outdir` is nested deeper — e.g. `build/web` — match the extra depth: `"../../*"`.)

Apply it to each `chrome` configuration (launch and attach).

## Why not rewrite the source map

A producer-side plugin that rewrites `sources` to project-root-relative also binds breakpoints, and is what many esbuild setups reach for. The cost is that it corrupts an otherwise-correct artifact to satisfy one consumer, and quietly depends on `sourcesContent` always being present and on `webRoot` always being the project root. The consumer-side override achieves the same binding while leaving the map correct for every other tool, so it is the default esp recommends. The producer-side rewrite is better kept as an explicit opt-in for the rare consumer that ignores `sourcesContent`.
