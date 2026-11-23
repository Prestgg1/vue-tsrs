import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkProject, formatDiagnostics } from '../src/index.js';

const cli = fileURLToPath(new URL('../bin/vue-tsrs.js', import.meta.url));

function fixture(t, entries, options = {}) {
  const cwd = mkdtempSync(fileURLToPath(new URL('../.fixture-', import.meta.url)));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const config = {
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, skipLibCheck: true },
    vueCompilerOptions: { strictTemplates: true },
    ...options,
  };
  for (const [name, contents] of Object.entries({ 'tsconfig.json': JSON.stringify(config), ...entries })) {
    const file = join(cwd, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  return cwd;
}

test('accepts a Vue-only project and does not write virtual files or emit output', t => {
  const cwd = fixture(t, {
    'src/App.vue': '<script setup lang="ts">\nconst count: number = 2\n</script>\n<template>{{ count.toFixed() }}</template>',
    'excluded/Bad.vue': '<template>{{ missing }}</template>',
  }, { include: ['**/*.vue'], exclude: ['excluded'] });
  assert.deepEqual(checkProject({ cwd }), []);
  assert.deepEqual(readdirSync(join(cwd, 'src')), ['App.vue']);
});

test('maps Rust diagnostics to UTF-16 Vue script and template locations', t => {
  const line = '<template>💚 {{ count.toUpperCase() }}</template>';
  const cwd = fixture(t, {
    'App.vue': '<script setup lang="ts">\r\nconst count: number = "bad"\r\n</script>\r\n' + line,
    'main.ts': 'const label: string = 42;',
  });
  const diagnostics = checkProject({ cwd });
  assert.equal(diagnostics.length, 3, formatDiagnostics(diagnostics, cwd));
  const template = diagnostics.find(d => d.code === 2339);
  assert.equal(template.fileName, join(cwd, 'App.vue').replaceAll('\\', '/'));
  assert.deepEqual(template.startPosition, { line: 3, character: line.indexOf('toUpperCase') });
  assert.match(formatDiagnostics(diagnostics, cwd), /App\.vue\(2,7\): error TS2322/);
  assert.match(formatDiagnostics(diagnostics, cwd), /main\.ts\(1,7\): error TS2322/);
});

test('follows aliased Vue imports outside include and checks component props', t => {
  const cwd = fixture(t, {
    'src/Parent.vue': '<script setup lang="ts">\nimport Child from "@/Child.vue"\n</script>\n<template><Child :count="\'bad\'" /></template>',
    'src/Child.vue': '<script setup lang="ts">\ndefineProps<{ count: number }>()\n</script>\n<template>{{ count.toFixed() }}</template>',
  }, {
    include: ['src/Parent.vue'],
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, skipLibCheck: true, paths: { '@/*': ['./src/*'] } },
  });
  const diagnostics = checkProject({ cwd });
  assert.equal(diagnostics.length, 1, formatDiagnostics(diagnostics, cwd));
  assert.match(formatDiagnostics(diagnostics, cwd), /Parent\.vue\(4,\d+\): error TS2322/);
});

test('reports invalid Vue markup', t => {
  const cwd = fixture(t, { 'App.vue': '<template><div></template>' });
  assert.ok(checkProject({ cwd }).some(d => d.source === 'VUE' && /end tag/i.test(d.text)));
});

test('CLI returns different exit codes for diagnostics and incorrect invocation', t => {
  const cwd = fixture(t, { 'main.ts': 'const answer: string = 42;' });
  const invoke = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
  const failed = invoke('-p', '.', '--noEmit');
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stdout, /TS2322/);
  assert.equal(invoke('--watch').status, 2);
  assert.equal(invoke('--help').status, 0);
});
