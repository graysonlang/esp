# TODO

Two sections, deliberately distinct: **Open** is work someone could pick up,
**Settled** records decisions that look like gaps but aren't, so they don't get
re-litigated. Everything here was found during a review, judged real, and
consciously handled — none of it is an oversight.

Not published: `files` in package.json ships only `src/` and the cert script.

## Open

### Chunk the file list passed to the biome CLI

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

## Settled

### The `engines` floor, and why it is only smoke-tested below 22.13

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

**Verified.** The `engines-floor` job in `.github/workflows/ci.yml` runs on
22.4.0 exactly — it imports every published entry point and asserts that `--no-`
flags still negate. It has run green on `main`, alongside the `test` matrix on
Node 22, 24 and 26. The floor is measured, not reasoned.

**Accepted gap:** that job cannot run the test suite, because eslint 10 declares
`^20.19.0 || ^22.13.0 || >=24` — esp's *development* floor is higher than its
*runtime* floor. The `test` matrix therefore starts at Node 22, so 22.4–22.12
is covered by the smoke check alone. Closing it would mean dropping eslint from
devDependencies and losing the eslint driver's tests, which is the worse trade:
a consumer on 22.4 using the biome driver never loads eslint at all.

Revisit only if esp starts using a Node API newer than `allowNegative`, or if
the eslint driver is dropped.

### `biome.jsonc`, not `biome.json`

The config is `biome.jsonc` on purpose. A comment in a file named `biome.json`
makes biome **silently discard the entire config** and fall back to defaults —
no error, no warning, exit 0, and `npm run lint` keeps reporting success while
none of the configured rules apply. The `.jsonc` name makes that failure
impossible rather than merely detectable.

Do not rename it back. If a `biome.json` ever reappears here, `JSON.parse` on it
is the cheap check: if it throws, the config is already being ignored.

`src/esbuild-runner.js` resolves both names (`BIOME_CONFIG_FILES`), so consumer
projects may use either.
