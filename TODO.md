# TODO

Known-and-deferred items. Each was found during a review, judged real, and
consciously left for later — not oversights. Not published (`files` in
package.json ships only `src/` and the cert script).

## Chunk the file list passed to the biome CLI

`src/lint-driver-biome.js` spreads the whole file list into argv:

```js
const args = [command, '--reporter=json', '--colors=off', ...biomeArgs, ...files];
```

A large first build can therefore blow the command-line length limit. The
binding limit is Windows: `cmd.exe` caps a command line at 8191 characters,
which the `.cmd` shim in `node_modules/.bin` goes through, so roughly 100 file
paths is enough. POSIX `E2BIG` is far higher (~1 MB on macOS) and unlikely to be
reached in practice.

Deferred because the `node_modules` exclusion already cut the file count
substantially, and this repo is not developed on Windows.

**Fix:** batch `files` into chunks that keep the joined length under a
conservative cap, run biome once per chunk, and concatenate the diagnostics.
Chunking is safe because the reporter emits one independent JSON document per
run and the driver already merges into a flat array.

**Test:** a stub executable that records its argv (see the severity-map test in
`test/lint-drivers.test.mjs`) driven with several hundred paths, asserting no
single invocation exceeds the cap and that every path is covered exactly once.

## Verify the `engines` floor on a Node that is actually at it

`engines.node` is `>=22.4.0`, set from the capability floor rather than a
support policy: `src/esbuild-runner.js` passes `allowNegative` to `node:util`'s
`parseArgs`, which landed in v22.4.0 and was backported to v20.16.0. Below that
the negated flags (`--no-minify`) quietly stop negating instead of failing, so
the floor exists to turn a silent wrong result into a loud one.

The 20.x line is excluded deliberately — 20.16 has the API, but the line is past
end-of-life, so claiming it would mean supporting an unmaintained runtime. State
it as `^20.16.0 || >=22.4.0` if that ever changes.

Kept as a floor rather than a range on purpose: an upper bound would start
warning on every new Node release.

Now covered by the `engines-floor` job in `.github/workflows/ci.yml`, which
runs on 22.4.0 exactly, imports every entry point and asserts that `--no-`
flags still negate.

**Remaining gap:** that job cannot run the test suite, because eslint 10
declares `^20.19.0 || ^22.13.0 || >=24` — esp's *development* floor is higher
than its *runtime* floor. The `test` matrix therefore starts at Node 22, so
22.4–22.12 is covered by the smoke check alone, not by the suite. Closing that
would mean either dropping eslint from devDependencies (losing the eslint
driver's tests) or accepting the gap. The gap is probably correct: a consumer on
22.4 who uses the biome driver never loads eslint at all.
