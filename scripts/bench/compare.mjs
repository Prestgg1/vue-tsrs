#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, cpus, release, totalmem } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(process.env.VUE_TSRS_ROOT ?? fileURLToPath(new URL('../../', import.meta.url)));
const usage = 'Usage: node scripts/bench/compare.mjs <project-dir> <leaf-tsconfig> <new-output-dir> [samples=5]';
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
};

// Compare primary diagnostic identities, not text, spans, formatting or order.
// Preserve multiplicity, and never silently treat unknown output as a clean run.
export function parseDiagnostics(text, cwd = process.cwd()) {
  const diagnostics = [];
  const unknown = [];
  let active = false;
  for (const line of text.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^(?:(.*)\((\d+),(\d+)\): )?(error|warning|message|suggestion) TS(\d+):/.exec(line);
    if (match) {
      const [, file, row, column, category, code] = match;
      diagnostics.push(JSON.stringify([file ? path.relative(cwd, path.resolve(cwd, file)) : null, Number(row) || null, Number(column) || null, category, Number(code)]));
      active = true;
    } else if (!active || !/^\s/.test(line)) {
      unknown.push(line);
      active = false;
    }
  }
  return { diagnostics: diagnostics.sort(), unknown };
}

function subtract(left, right) {
  const counts = new Map();
  for (const value of right) counts.set(value, (counts.get(value) ?? 0) + 1);
  return left.filter(value => {
    const count = counts.get(value) ?? 0;
    if (count) counts.set(value, count - 1);
    return !count;
  }).map(value => JSON.parse(value));
}

export function compareDiagnostics(oracle, candidate) {
  const oracleOnly = subtract(oracle, candidate);
  const candidateOnly = subtract(candidate, oracle);
  return { equal: oracleOnly.length === 0 && candidateOnly.length === 0, oracleOnly, candidateOnly };
}

function main(args) {
  if (args.length < 3 || args.length > 4) throw new Error(usage);
  if (process.platform !== 'linux') throw new Error('Linux and GNU /usr/bin/time are required.');
  const [directory, config, output, samples = '5'] = args;
  const count = Number(samples);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('Samples must be a positive integer.');
  const cwd = path.resolve(directory);
  const project = path.resolve(cwd, config);
  const out = path.resolve(output);
  const tools = {
    'vue-tsc': [path.join(cwd, 'node_modules/vue-tsc/bin/vue-tsc.js'), '--pretty', 'false'],
    'vue-tsrs': [path.join(root, 'bin/vue-tsrs.js')],
  };
  const packageVersion = (base, name) => JSON.parse(readFileSync(path.join(base, 'node_modules', name, 'package.json'))).version;
  const oracleRequire = createRequire(tools['vue-tsc'][0]);
  const io = { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C', NO_COLOR: '1', FORCE_COLOR: '0' } };
  const capture = (command, args) => spawnSync(command, args, io);
  const timer = capture('/usr/bin/time', ['--version']);
  if (timer.status !== 0 || !/GNU/i.test(timer.stdout)) throw new Error('GNU /usr/bin/time is required.');
  const digests = {};
  for (const name of [project, path.join(cwd, 'package-lock.json'), path.join(cwd, 'pnpm-lock.yaml'), path.join(cwd, 'yarn.lock'), path.join(root, 'package-lock.json')]) {
    try { digests[name] = createHash('sha256').update(readFileSync(name)).digest('hex'); }
    catch (error) { if (error.code !== 'ENOENT' || name === project) throw error; }
  }
  const revision = dir => {
    const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    const rev = git('rev-parse', 'HEAD');
    return rev.status === 0 ? { head: rev.stdout.trim(), dirty: Boolean(git('status', '--porcelain').stdout?.trim()) } : null;
  };
  const report = {
    cwd, project, samples: count, warmupsPerTool: 1, digests,
    environment: { node: process.version, os: release(), arch: arch(), cpu: cpus()[0]?.model, logicalCPUs: cpus().length, memoryBytes: totalmem(), timer: timer.stdout.split('\n')[0] },
    revisions: { project: revision(cwd), checker: revision(root) },
    versions: {
      'vue-tsc': packageVersion(cwd, 'vue-tsc'), oracleTypeScript: oracleRequire('typescript/package.json').version,
      oracleVueLanguageCore: oracleRequire('@vue/language-core/package.json').version,
      'vue-tsrs': JSON.parse(readFileSync(path.join(root, 'package.json'))).version,
      candidateTypeScript: packageVersion(root, 'typescript'), tsrs: packageVersion(root, 'tsrs'),
      candidateVueLanguageCore: packageVersion(root, '@vue/language-core'),
    },
    commands: {}, runs: [],
  };
  for (const [name, entry] of Object.entries(tools)) {
    readFileSync(entry[0]);
    report.commands[name] = [process.execPath, ...entry, '--noEmit', '-p', project];
  }
  const configProbe = capture(process.execPath, [...report.commands['vue-tsc'].slice(1), '--showConfig']);
  if (configProbe.error) throw configProbe.error;
  report.oracleConfigProbeStatus = configProbe.status;
  let oracleOptions;
  if (configProbe.status === 0) {
    oracleOptions = JSON.parse(configProbe.stdout).compilerOptions;
  }
  report.oracleBuildInfoIsolated = !!(oracleOptions?.incremental || oracleOptions?.composite);
  mkdirSync(out);
  const keys = Object.keys(tools);
  for (let trial = 0; trial <= count; trial++) {
    for (const name of trial % 2 === 0 ? keys : [...keys].reverse()) {
      const prefix = path.join(out, `${trial}-${name}`);
      const timing = `${prefix}.time`;
      const command = [...report.commands[name]];
      if (name === 'vue-tsc' && report.oracleBuildInfoIsolated) command.push('--tsBuildInfoFile', `${prefix}.tsbuildinfo`);
      const child = capture('/usr/bin/time', ['-f', 'wall_seconds=%e\npeak_rss_kib=%M', '-o', timing, ...command]);
      writeFileSync(`${prefix}.stdout`, child.stdout ?? '');
      writeFileSync(`${prefix}.stderr`, child.stderr ?? '');
      const stdout = parseDiagnostics(child.stdout ?? '', cwd);
      const stderr = parseDiagnostics(child.stderr ?? '', cwd);
      const diagnostics = [...stdout.diagnostics, ...stderr.diagnostics].sort();
      const unknown = [...stdout.unknown, ...stderr.unknown];
      const status = child.status;
      const timingText = child.error && !child.pid ? '' : readFileSync(timing, 'utf8');
      const wall = /wall_seconds=([\d.]+)/.exec(timingText);
      const rss = /peak_rss_kib=(\d+)/.exec(timingText);
      const hasErrors = diagnostics.some(key => JSON.parse(key)[3] === 'error');
      // TypeScript may use exit 2 for diagnostics with output skipped; vue-tsrs reserves it for runtime errors.
      const validExit = hasErrors ? status === 1 || (name === 'vue-tsc' && status === 2) : status === 0;
      report.runs.push({ name, trial, command, status, signal: child.signal, error: child.error?.message, diagnostics, unknown,
        wallSeconds: wall ? Number(wall[1]) : null, peakRssKiB: rss ? Number(rss[1]) : null,
        valid: !child.error && !child.signal && validExit && unknown.length === 0 && !!wall && !!rss });
    }
  }
  report.summary = {};
  for (const name of keys) {
    const [warmup, ...runs] = report.runs.filter(run => run.name === name);
    const stable = [warmup, ...runs].every(run => run.valid && JSON.stringify(run.diagnostics) === JSON.stringify(runs[0].diagnostics));
    report.summary[name] = { stable, diagnosticCount: runs[0].diagnostics.length,
      medianWallSeconds: stable ? median(runs.map(run => run.wallSeconds)) : null,
      medianPeakRssKiB: stable ? median(runs.map(run => run.peakRssKiB)) : null };
  }
  if (keys.every(name => report.summary[name].stable)) {
    const [oracle, candidate] = keys.map(name => report.runs.find(run => run.name === name && run.trial === 1).diagnostics);
    report.parity = compareDiagnostics(oracle, candidate);
  } else report.parity = null;
  writeFileSync(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ summary: report.summary, parity: report.parity?.equal ?? null, report: path.join(out, 'report.json') }, null, 2));
  process.exitCode = report.parity ? Number(!report.parity.equal) : 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === '--help') console.log(usage);
    else main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
