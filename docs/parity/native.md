# Native Vue mapper experiment

The current `vue-tsrs` adapter generates virtual TypeScript in Vue Language Core and checks it through the Rust `tsrs` API. This experiment compares it against the same `tsrs` binary invoking Vize as a Vue content mapper, with and without `--fast`. Vize uses Rust for Vue code generation but its published mapper starts through a Node launcher. This is not a Node-free implementation.

## Reproduce

Use Linux, GNU `/usr/bin/time`, and a trusted scratch checkout. `--runExternalCode` executes the configured mapper, so do not run this experiment against untrusted projects or mapper packages.

1. Run `npm ci` in this repository and recreate the pinned Vite, Simple Sheet, and Nuxt inputs using the [parity setup](README.md#recreate-the-inputs). Add `scripts/bench/Probe.vue` to the Vite fixture as described there.
2. Install `vize@0.790.0` in a separate temporary npm project, then symlink its `node_modules/vize` into each benchmark project's `node_modules`. This leaves the fixture dependency locks unchanged. Run `node <scratch>/node_modules/vize/bin/vize --version` before benchmarking to verify the native addon loads.
3. Run the following from the `vue-tsrs` checkout, replacing `projects` with the fixture directory:

```sh
node scripts/bench/native.mjs projects/vite tsconfig.app.json 3
node scripts/bench/native.mjs projects/sheet tsconfig.app.json 3
node scripts/bench/native.mjs projects/nuxt .nuxt/tsconfig.app.json 3
```

The harness creates a temporary config alongside the leaf config, extends it, and adds only the content mapper. Each tool gets an untimed warm-up, then fresh invocations in alternating order. It reports diagnostic tuple differences, elapsed time, peak RSS, and raw output. Exit `0` means all methods matched `vue-tsc`, `1` means a diagnostic mismatch, and `2` means a result was inconclusive, for example if the native mapper failed to run. Peak RSS is GNU time's high-water mark, not aggregate concurrent-process memory.

## Results (November 24, 2026)

Three timed runs per input on Linux x86-64 (i5-1235U, Node 24.18.0), using `tsrs@7.1.0-beta.tsrs4`, `vize@0.790.0`, `vue-tsc@3.2.9` and adapter `v0.2.0`. Entries show median elapsed seconds / peak RSS KiB.

| Input | vue-tsc | vue-tsrs adapter | Rust mapper | Rust mapper, `--fast` |
| --- | ---: | ---: | ---: | ---: |
| Vite with injected errors | 3.13 / 298,440 | 2.19 / 141,852 | 0.62 / 79,348 | 0.69 / 79,608 |
| Simple Sheet | 4.52 / 356,968 | 2.56 / 140,232 | 0.89 / 78,520 | 0.80 / 78,164 |
| Nuxt starter app | 5.14 / 420,968 | 3.54 / 157,832 | 0.91 / 92,380 | 0.74 / 87,248 |

All four methods matched the observed diagnostic tuples on all three leaf configs, including both seeded script/template errors in the Vite fixture. The Rust mapper without `--fast` was 2.9–3.9× faster than the adapter. `--fast` helped Simple Sheet and Nuxt in these runs but not Vite. These are leaf-config end-to-end results, not evidence of general diagnostic parity, large-project throughput, edit-to-diagnostic latency, reference-build parity, or declaration emit parity.

**Decision:** Prototype the mapper as an explicit opt-in for no-emit CI checks, not a default replacement. Keep the adapter until larger and error-rich fixtures validate the mapper, and benchmark persistent incremental checking separately for watch mode.
