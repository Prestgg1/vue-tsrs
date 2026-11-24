# vue-tsrs

An experimental Vue 3 type checker inspired by [vue-tsgo](https://github.com/NikhilVerma/vue-tsgo), powered by [tsrs](https://github.com/oxc-project/tsrs), the Rust TypeScript compiler described in the [Cloudflare announcement](https://blog.cloudflare.com/typescript-rust-port/).

Vue Language Tools generates TypeScript for Vue single-file components. `vue-tsrs` passes those virtual files to the Rust checker in memory and maps diagnostics back to the original `.vue` source. It checks ordinary TypeScript files in the same project without writing output unless declaration emit is requested.

## Usage

Requires Node.js 22 or later and a Vue 3.4+ project. Install from GitHub (this version is not published to npm):

```sh
npm install -D github:Prestgg1/vue-tsrs
npx vue-tsrs --noEmit -p tsconfig.app.json
npx vue-tsrs --watch -p tsconfig.app.json
npx vue-tsrs --build --noEmit
npx vue-tsrs --build --watch
npx vue-tsrs --emitDeclarationOnly -p tsconfig.lib.json --outDir dist/types
```

Run without `-p` to use the nearest `tsconfig.json`. For Vue template checks, enable `vueCompilerOptions.strictTemplates` in the project's tsconfig. CLI exit codes: `0` on success, `2` when the checker reports error diagnostics, and `1` for invocation or runtime failures.

`--build` (`-b`) follows `references` in dependency order, once per config. Pass a solution config or one or more positional configs. `--watch` (`-w`) reruns checks after changes in project directories and can be combined with `--build`. `--emitDeclarationOnly` emits `.d.ts` and `.vue.d.ts`, not JavaScript. For declaration builds, use `--build --emitDeclarationOnly` and set output directories in each config. Watch mode does not emit declarations. Vue declaration source maps are not emitted.

```js
import { checkProject, formatDiagnostics } from 'vue-tsrs';

const diagnostics = checkProject({ project: 'tsconfig.app.json' });
console.log(formatDiagnostics(diagnostics));
```

## Scope

This is not a drop-in replacement for `vue-tsc`. Build and watch currently run full per-project checks rather than using incremental `.tsbuildinfo` caches. No-emit builds check source without recreating TypeScript's full project-reference redirect semantics. Packages that resolve dependencies via generated declarations may need those outputs built first. Declaration builds can redirect source imports to declarations produced for earlier references, but they do not rewrite your import specifiers for package publishing. Editor integration is not included. Both code generation and the native compiler API are version-pinned.

Run `npm ci && npm test` to exercise the Rust compiler on real Vue fixtures.

## Experimental Vize backend

For one-shot CI checks, opt in to Rust Vue code generation:

```sh
npm install -D --save-exact vize@0.790.0
npx vue-tsrs --backend vize --noEmit -p tsconfig.app.json
```

The Vize backend runs an external mapper. Use it only with trusted projects and dependencies. It accepts one leaf tsconfig without project references; continue using the default backend for watch, builds, declarations, and the JavaScript API. Vize generates and checks Vue code differently from Volar, so diagnostic parity is not guaranteed. `--fast` is separately opt-in and can change compiler behavior. See the [native mapper comparison](docs/parity/native.md).

## Compare against vue-tsc

On Linux with GNU `time`, install `vue-tsc` in the project under test, then run from this repository:

```sh
npm run bench -- /path/to/project tsconfig.app.json /path/to/new-results-dir 5
```

The report includes diagnostic differences, wall time, and peak RSS with versions and raw run output. See [real-project results and reproduction steps](docs/parity/README.md).
