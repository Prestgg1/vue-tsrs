import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const require = createRequire(import.meta.url);

export function runNative({ cwd, project, fast }) {
  let config = project ? path.resolve(cwd, project) : ts.findConfigFile(cwd, ts.sys.fileExists);
  if (config && ts.sys.directoryExists(config)) config = path.join(config, 'tsconfig.json');
  if (!config || !ts.sys.fileExists(config)) throw new Error(`Cannot find tsconfig.json${project ? ` at ${project}` : ''}`);

  const directory = path.dirname(config);
  const projectRequire = createRequire(config);
  if (!projectRequire.resolve.paths('vize')?.some(dir => ts.sys.fileExists(path.join(dir, 'vize/package.json')))) {
    throw new Error('Vize is not installed for this project. Run npm install -D vize@0.790.0.');
  }
  const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, {
    ...ts.sys,
    readDirectory: () => [], // Only resolve config options and references; tsrs enumerates sources.
    onUnRecoverableConfigFileDiagnostic: () => {},
  });
  if (parsed?.projectReferences?.length) {
    throw new Error('The Vize backend requires a leaf tsconfig without project references. Use the default backend with --build.');
  }

  const overlay = path.join(directory, `.vue-tsrs-vize-${randomUUID()}.json`);
  const scratch = parsed?.options.incremental || parsed?.options.composite
    ? mkdtempSync(path.join(os.tmpdir(), 'vue-tsrs-native-')) : undefined;
  let created = false;
  try {
    writeFileSync(overlay, JSON.stringify({
      extends: `./${path.basename(config)}`,
      contentMappers: [{ package: 'vize', extensions: ['.vue'] }],
    }), { flag: 'wx' });
    created = true;
    const compiler = path.join(path.dirname(require.resolve('tsrs/package.json')), 'bin/tsrs');
    const args = [compiler, '--runExternalCode', '--noEmit', '--pretty', 'false', '-p', overlay];
    if (scratch) args.push('--tsBuildInfoFile', path.join(scratch, 'check.tsbuildinfo'));
    if (fast) args.push('--fast');
    const child = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (child.error) throw child.error;
    // Show config diagnostics against the public config, never the transient wrapper.
    const display = text => text.replaceAll(path.basename(overlay), path.basename(config));
    process.stdout.write(display(child.stdout));
    process.stderr.write(display(child.stderr));
    if (child.signal) throw new Error(`tsrs was terminated by ${child.signal}.`);
    if (/\bTS18069:/.test(child.stdout + child.stderr)) throw new Error('Vize could not transform one or more Vue files. Check the mapper installation or use the default backend.');
    return child.status === 0 ? 0 : [1, 2].includes(child.status) ? 1 : 2;
  } finally {
    if (created) rmSync(overlay, { force: true });
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}
