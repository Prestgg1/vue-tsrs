# vue-tsrs

An experimental Vue 3 type checker inspired by [vue-tsgo](https://github.com/NikhilVerma/vue-tsgo), powered by [tsrs](https://github.com/oxc-project/tsrs), the Rust TypeScript compiler described in the [Cloudflare announcement](https://blog.cloudflare.com/typescript-rust-port/).

Vue Language Tools generates TypeScript for Vue single-file components. `vue-tsrs` passes those virtual files to the Rust checker in memory and maps diagnostics back to the original `.vue` source. It checks ordinary TypeScript files in the same project and does not modify source files or emit output.

## Usage

Requires Node.js 22 or later and a Vue 3.4+ project. Install from GitHub (this version is not published to npm):

```sh
npm install -D github:Prestgg1/vue-tsrs
npx vue-tsrs --noEmit -p tsconfig.app.json
```

Run without `-p` to use the nearest `tsconfig.json`. For Vue template checks, enable `vueCompilerOptions.strictTemplates` in the project's tsconfig. CLI exit codes: `0` on success, `1` for type or configuration errors, `2` for invocation or runtime errors.

```js
import { checkProject, formatDiagnostics } from 'vue-tsrs';

const diagnostics = checkProject({ project: 'tsconfig.app.json' });
console.log(formatDiagnostics(diagnostics));
```

## Scope

This is a one-shot, no-emit checker, not a drop-in replacement for `vue-tsc`. Watch mode, build mode, declaration output, and editor integration are not supported. For a solution tsconfig using project references, check each leaf configuration separately. Both code generation and the native compiler API are version-pinned. Diagnostic parity and performance relative to `vue-tsc` are not guaranteed.

Run `npm ci && npm test` to exercise the Rust compiler on real Vue fixtures.
