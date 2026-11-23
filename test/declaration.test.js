import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkProject, formatDiagnostics } from '../src/index.js';

function fixture(t, entries, compilerOptions = {}) {
  const cwd = mkdtempSync(fileURLToPath(new URL('../.fixture-', import.meta.url)));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const config = {
    compilerOptions: {
      target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, skipLibCheck: true,
      noEmit: true, rootDir: 'src', outDir: 'configured', ...compilerOptions,
    },
    include: ['src'],
  };
  for (const [name, contents] of Object.entries({ 'tsconfig.json': JSON.stringify(config), ...entries })) {
    const file = join(cwd, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  return cwd;
}

test('emits only declarations with stable Vue filenames and imports', t => {
  const cwd = fixture(t, {
    'src/components/Child.vue': '<script setup lang="ts">defineProps<{ count: number }>()</script>',
    'src/components/Model.vue': '<script lang="ts">export class Model { private value = 0 }; export const model = new Model();</script>',
    'src/Parent.vue': '<script setup>import Child from "./components/Child.vue"</script><template><Child :count="1" /></template>',
    'src/index.ts': `import Child from './components/Child.vue';
      import { model } from './components/Model.vue';
      export { default as Parent } from './Parent.vue';
      export { Child };
      export const components = { Child };
      export const inferred = model;
      export const literal = 'keep.__vue_tsrs';`,
  });
  const diagnostics = checkProject({ cwd, emitDeclarationOnly: true, outDir: 'types' });
  assert.deepEqual(diagnostics, [], formatDiagnostics(diagnostics, cwd));
  assert.deepEqual(readdirSync(join(cwd, 'types')).sort(), ['Parent.vue.d.ts', 'components', 'index.d.ts']);
  assert.deepEqual(readdirSync(join(cwd, 'types/components')).sort(), ['Child.vue.d.ts', 'Model.vue.d.ts']);
  assert.ok(!existsSync(join(cwd, 'configured')));
  const child = readFileSync(join(cwd, 'types/components/Child.vue.d.ts'), 'utf8');
  assert.match(child, /count: number/);
  const index = readFileSync(join(cwd, 'types/index.d.ts'), 'utf8');
  assert.match(index, /\.\/Parent\.vue['"]/);
  assert.match(index, /\.\/components\/Child\.vue['"]/);
  assert.match(index, /import\(['"]\.\/components\/Model\.vue['"]\)\.Model/);
  assert.match(index, /keep\.__vue_tsrs/);
  assert.doesNotMatch(index, /\.vue\.__vue_tsrs/);
});

test('does not write partial outputs on declaration emit errors', t => {
  const cwd = fixture(t, {
    'src/valid.ts': 'export const valid = true;',
    'src/bad.ts': 'const value = 1; export function inferred() { return value; }',
  }, { isolatedDeclarations: true, allowJs: false });
  const diagnostics = checkProject({ cwd, emitDeclarationOnly: true });
  assert.ok(diagnostics.some(d => d.code === 9039), formatDiagnostics(diagnostics, cwd));
  assert.ok(!existsSync(join(cwd, 'configured')));
});

test('rejects colliding Vue and TypeScript declaration destinations before writing', t => {
  const cwd = fixture(t, {
    'src/App.vue': '<template>Hello</template>',
    'src/App.vue.ts': 'export const value = 42;',
  });
  const diagnostics = checkProject({ cwd, emitDeclarationOnly: true });
  assert.ok(diagnostics.some(d => d.code === 5056), formatDiagnostics(diagnostics, cwd));
  assert.ok(!existsSync(join(cwd, 'configured')));
});

test('preserves ordinary declaration maps without leaking virtual Vue source paths', t => {
  const cwd = fixture(t, {
    'src/App.vue': '<template>Hello</template>',
    'src/index.ts': 'export const greeting = "Hello";',
  }, { declarationMap: true });
  const diagnostics = checkProject({ cwd, emitDeclarationOnly: true });
  assert.deepEqual(diagnostics, [], formatDiagnostics(diagnostics, cwd));
  assert.deepEqual(readdirSync(join(cwd, 'configured')).sort(), ['App.vue.d.ts', 'index.d.ts', 'index.d.ts.map']);
  assert.doesNotMatch(readFileSync(join(cwd, 'configured/App.vue.d.ts'), 'utf8'), /sourceMappingURL|\.__vue_tsrs/);
});

test('uses configured declaration directory when outDir is omitted', t => {
  const cwd = fixture(t, { 'src/App.vue': '<template>Hello</template>' }, { declarationDir: 'declarations' });
  assert.deepEqual(checkProject({ cwd, emitDeclarationOnly: true }), []);
  assert.deepEqual(readdirSync(join(cwd, 'declarations')), ['App.vue.d.ts']);
  assert.ok(!existsSync(join(cwd, 'configured')));
});

test('does not emit any declarations on Vue or TypeScript errors', t => {
  const cwd = fixture(t, {
    'src/App.vue': '<script setup lang="ts">const count: number = "bad"</script>',
    'src/index.ts': 'export const valid = true;',
    'src/bad.ts': 'export const bad: string = 42;',
  });
  const diagnostics = checkProject({ cwd, emitDeclarationOnly: true });
  assert.deepEqual(diagnostics.map(d => d.code), [2322, 2322], formatDiagnostics(diagnostics, cwd));
  assert.ok(!existsSync(join(cwd, 'configured')));
});
