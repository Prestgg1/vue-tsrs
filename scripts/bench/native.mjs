import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseDiagnostics, compareDiagnostics } from './compare.mjs';

const [directory, config, count = '5'] = process.argv.slice(2);
const samples = Number(count);
if (!directory || !config || !Number.isSafeInteger(samples) || samples < 1 || process.platform !== 'linux') {
  throw new Error('Usage (Linux + GNU time): node scripts/bench/native.mjs <project> <leaf-tsconfig> [samples=5]');
}
const cwd = path.resolve(directory);
const original = path.resolve(cwd, config);
readFileSync(original);
const overlay = path.join(path.dirname(original), `.vue-tsrs-native-${process.pid}.json`);
const repo = fileURLToPath(new URL('../../', import.meta.url));
const projectRequire = createRequire(path.join(cwd, 'package.json'));
const repoRequire = createRequire(path.join(repo, 'package.json'));
const versions = {
  node: process.version,
  vize: JSON.parse(readFileSync(path.join(cwd, 'node_modules/vize/package.json'), 'utf8')).version,
  vueTsc: projectRequire('vue-tsc/package.json').version,
  tsrs: repoRequire('tsrs/package.json').version,
  adapter: repoRequire('./package.json').version,
};
const temp = mkdtempSync(path.join(os.tmpdir(), 'vue-native-'));
const timer = path.join(temp, 'time');
const compiler = path.join(repo, 'node_modules/tsrs/bin/tsrs');
const native = [compiler, '--runExternalCode', '--noEmit', '--pretty', 'false', '-p', overlay];
const commands = {
  oracle: [path.join(cwd, 'node_modules/vue-tsc/bin/vue-tsc.js'), '--noEmit', '--pretty', 'false', '-p', original],
  adapter: [path.join(repo, 'bin/vue-tsrs.js'), '--noEmit', '-p', original],
  native,
  fast: [...native, '--fast'],
};
const results = Object.fromEntries(Object.keys(commands).map(name => [name, []]));
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
};
let overlayCreated = false;
try {
  writeFileSync(overlay, JSON.stringify({
    extends: `./${path.basename(original)}`,
    contentMappers: [{ package: 'vize', extensions: ['.vue'] }],
  }), { flag: 'wx' });
  overlayCreated = true;
  const settings = spawnSync(process.execPath, [...commands.oracle, '--showConfig'], { cwd, encoding: 'utf8' });
  if (settings.error) throw settings.error;
  if (settings.status === 0) {
    const { compilerOptions } = JSON.parse(settings.stdout);
    if (compilerOptions?.incremental || compilerOptions?.composite) {
      for (const name of ['oracle', 'native', 'fast']) commands[name].push('--tsBuildInfoFile', path.join(temp, `${name}.tsbuildinfo`));
    }
  }
  const names = Object.keys(commands);
  for (let i = -1; i < samples; i++) {
    for (const name of i % 2 === 1 ? [...names].reverse() : names) {
      rmSync(path.join(temp, `${name}.tsbuildinfo`), { force: true });
      const child = spawnSync('/usr/bin/time', ['-q', '-f', '%e %M', '-o', timer, process.execPath, ...commands[name]], {
        cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
      });
      if (child.error) throw child.error;
      if (i < 0) continue;
      const [seconds, rssKiB] = readFileSync(timer, 'utf8').trim().split(/\s+/).map(Number);
      const parsed = parseDiagnostics(child.stdout, cwd);
      const unexpected = [...parsed.unknown, ...child.stderr.trim().split('\n').filter(Boolean)];
      const mapperFailed = /\bTS18069:/.test(child.stdout);
      const usable = (child.status === 0 && !parsed.diagnostics.length || [1, 2].includes(child.status) && parsed.diagnostics.length > 0) && !unexpected.length && !mapperFailed;
      results[name].push({ status: child.status, seconds, rssKiB, ...parsed, unexpected, usable, stdout: child.stdout, stderr: child.stderr });
    }
  }
  const stable = name => results[name].every(run => run.usable && JSON.stringify(run.diagnostics) === JSON.stringify(results[name][0].diagnostics));
  const summary = Object.fromEntries(Object.entries(results).map(([name, runs]) => [name, {
    stable: stable(name), diagnostics: runs[0].diagnostics.length,
    seconds: median(runs.map(run => run.seconds)), rssKiB: median(runs.map(run => run.rssKiB)),
    parity: stable(name) && stable('oracle') ? compareDiagnostics(results.oracle[0].diagnostics, runs[0].diagnostics) : null,
  }]));
  console.log(JSON.stringify({ config, samples, versions, summary, results }, null, 2));
  process.exitCode = !summary.oracle.stable || Object.values(summary).some(row => !row.stable) ? 2
    : Object.values(summary).some(row => !row.parity.equal) ? 1 : 0;
} finally {
  if (overlayCreated) rmSync(overlay, { force: true });
  rmSync(temp, { recursive: true, force: true });
}
