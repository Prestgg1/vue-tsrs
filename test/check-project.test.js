import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
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
  assert.equal(invoke('--unknown-flag').status, 2);
  assert.equal(invoke('--help').status, 0);
  assert.match(invoke('--noEmit', '--emitDeclarationOnly').stderr, /cannot be combined/);
});

test('build declaration mode emits referenced package types into their own directories', t => {
  const compilerOptions = { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, composite: true, outDir: 'types' };
  const cwd = fixture(t, {
    'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './lib' }, { path: './app' }] }),
    'lib/tsconfig.json': JSON.stringify({ compilerOptions, include: ['*.vue', '*.ts'] }),
    'lib/Widget.vue': '<script setup lang="ts">\ndefineProps<{ title: string }>()\n</script>',
    'lib/strings.ts': 'export const label = "example";',
    'app/tsconfig.json': JSON.stringify({ compilerOptions, include: ['*.ts'], references: [{ path: '../lib' }] }),
    'app/index.ts': 'export { default as Widget } from "../lib/Widget.vue"; export { label } from "../lib/strings";',
  });
  const result = spawnSync(process.execPath, [cli, '--build', '--emitDeclarationOnly'], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.deepEqual(readdirSync(join(cwd, 'lib/types')).sort(), ['Widget.vue.d.ts', 'strings.d.ts']);
  assert.deepEqual(readdirSync(join(cwd, 'app/types')), ['index.d.ts']);
});

test('build traverses references in dependency order and checks a root solution', t => {
  const options = { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, composite: true };
  const cwd = fixture(t, {
    'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './app/tsconfig.app.json' }, { path: './lib' }] }),
    'app/tsconfig.app.json': JSON.stringify({ compilerOptions: options, include: ['*.vue'], references: [{ path: '../lib' }] }),
    'lib/tsconfig.json': JSON.stringify({ compilerOptions: options, files: ['number.ts'] }),
    'app/App.vue': '<script setup lang="ts">\nimport { amount } from "../lib/number"\nconst str: string = amount\n</script>\n<template>{{ str }}</template>',
    'lib/number.ts': 'export const amount: number = "wrong";',
  });
  const result = spawnSync(process.execPath, [cli, '-b', '--noEmit'], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  const files = result.stdout.split('\n').filter(line => line.includes('TS2322')).map(line => line.split('(')[0].replaceAll('\\', '/'));
  assert.deepEqual(files, ['lib/number.ts', 'app/App.vue'], result.stdout);
  assert.doesNotMatch(result.stdout, /TS18002|TS18003/);
});

test('build rejects circular project references', t => {
  const cwd = fixture(t, {
    'tsconfig.json': '{"files":[],"references":[{"path":"./app"}]}',
    'app/tsconfig.json': '{"files":[],"references":[{"path":".."}]}',
  });
  const result = spawnSync(process.execPath, [cli, '--build', '.'], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Circular project references.*tsconfig\.json/);
});

test('watch reports errors after editing a Vue source and recovers after deleting it', { timeout: 20_000 }, async t => {
  const cwd = fixture(t, { 'App.vue': '<template><div /></template>' });
  const child = spawn(process.execPath, [cli, '--watch'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await exit;
  });
  const matches = [];
  let buffer = '';
  let notify;
  child.stdout.setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const detected = /vue-tsrs: (\d+) diagnostic/.exec(line);
      if (detected) matches.push(Number(detected[1]));
    }
    notify?.();
  });
  const waitFor = async (index, count) => {
    while (matches.length <= index) {
      await Promise.race([
        new Promise(resolve => { notify = resolve; }),
        exit.then(([code]) => { throw new Error(`Watch exited unexpectedly: ${code}`); }),
      ]);
    }
    assert.equal(matches[index], count);
  };
  await waitFor(0, 0);
  writeFileSync(join(cwd, 'Broken.vue'), '<template>{{ missing }}</template>');
  await waitFor(1, 1);
  rmSync(join(cwd, 'Broken.vue'));
  await waitFor(2, 0);
});
