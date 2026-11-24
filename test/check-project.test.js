import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkProject, formatDiagnostics } from '../src/index.js';
import { normalizeVizeOutput, nativeExitCode } from '../src/native.js';

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
  assert.equal(failed.status, 2, failed.stderr);
  assert.match(failed.stdout, /TS2322/);
  assert.equal(invoke('--unknown-flag').status, 1);
  assert.equal(invoke('--help').status, 0);
  assert.match(invoke('--noEmit', '--emitDeclarationOnly').stderr, /cannot be combined/);
});

test('Vize is optional and experimental flags cannot affect default checks', t => {
  const cwd = fixture(t, { 'App.vue': '<template><div /></template>' });
  const invoke = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
  assert.match(invoke('--fast').stderr, /requires --backend vize/);
  assert.match(invoke('--backend', 'unknown').stderr, /expects volar or vize/);
  for (const mode of ['--watch', '--build', '--emitDeclarationOnly']) {
    const result = invoke('--backend', 'vize', mode);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /one-shot no-emit/);
  }
  assert.equal(invoke('--backend', 'volar').status, 0);
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
  assert.equal(result.status, 2, result.stderr);
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
  assert.equal(result.status, 1);
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

test('TS6133 points to the import keyword for one unused Vue import, not a partial import or local', async t => {
  const cwd = fixture(t, {
    'Parent.vue': [
      '<script setup lang="ts">', 'import { ref } from "vue"', 'const n = ref(1)',
      'import { nothing } from "~/does/not/exist"', 'import { computed, shallowRef } from "vue"',
      'const doubled = computed(() => n.value * 2)', 'const unused = 1', '</script>',
      '<template>{{ doubled }}</template>',
    ].join('\n'),
  }, { compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noUnusedLocals: true } });
  const output = formatDiagnostics(checkProject({ cwd }), cwd);
  const unused = output.split('\n').filter(line => line.includes('TS6133')).join('\n');
  assert.match(unused, /Parent\.vue\(4,1\): error TS6133: 'nothing'/);
  assert.match(unused, /Parent\.vue\(5,20\): error TS6133: 'shallowRef'/);
  assert.match(unused, /Parent\.vue\(7,7\): error TS6133: 'unused'/);
  const input = [
    "Parent.vue(4,10): error TS6133: 'nothing' is declared but its value is never read.",
    "Parent.vue(5,20): error TS6133: 'shallowRef' is declared but its value is never read.",
    "Parent.vue(7,7): error TS6133: 'unused' is declared but its value is never read.",
  ].join('\n');
  assert.equal(await normalizeVizeOutput(input, cwd), input.replace('(4,10)', '(4,1)'));
});

test('Vize diagnostics hide generated template and child prop type names', async t => {
  const cwd = fixture(t, {});
  const input = [
    "Parent.vue(12,11): error TS2339: Property 'missing' does not exist on type '$TemplateInstance'.",
    "Parent.vue(11,4): error TS2345: Argument of type '{ count: number; }' is not assignable to parameter of type '$ComponentCheckProps<__Child_CheckProps_1, VueTemplatePublicAttrsType & Record<string, unknown>>'.",
    "  Type 'ComponentPropsForTemplate<__Child_CheckProps_1>' requires a 'label' property.",
    "plain.ts(1,1): error TS2339: Property 'x' does not exist on type '$TemplateInstance'.",
  ].join('\n');
  const [instance, props, related, plain] = (await normalizeVizeOutput(input, cwd)).split('\n');
  assert.match(instance, /'missing'.*Vue component instance/);
  assert.match(props, /'\{ count: number; \}'.*Child props/);
  assert.doesNotMatch(instance + props + related, /\$TemplateInstance|\$ComponentCheckProps|__Child|VueTemplatePublicAttrsType|ComponentPropsForTemplate/);
  assert.equal(plain, input.split('\n')[3]);
});

test('native diagnostic exits match vue-tsc', () => {
  assert.equal(nativeExitCode(0, ''), 0);
  assert.equal(nativeExitCode(2, 'Parent.vue(4,1): error TS6133: Unused import.'), 2);
  assert.equal(nativeExitCode(1, 'Parent.vue(4,1): error TS6133: Unused import.'), 2);
  assert.equal(nativeExitCode(1, 'native launcher failed'), 1);
});
