#!/usr/bin/env node
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
try {
  const options = { projects: [], cwd: process.cwd() };
  let projectFlag = false;
  let noEmit = false;
  let watch = false;
  let backend = 'volar';
  let fast = false;
  let output;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      output = 'Usage: vue-tsrs [-p <tsconfig or directory>] [--noEmit | --emitDeclarationOnly]\n' +
        '       vue-tsrs --build [<tsconfig or directory> ...] [--noEmit | --emitDeclarationOnly]\n' +
        'Options: -p, --project    -b, --build    -w, --watch    --outDir <directory>\n' +
        'Experimental no-emit backend: --backend vize [--fast] (trusted projects only).\n' +
        'Checks Vue 3 SFCs and TypeScript. No output is emitted by default.\n';
    } else if (arg === '--version' || arg === '-v') {
      output = `${require('../package.json').version}\n`;
    } else if (arg === '--project' || arg === '-p') {
      const project = args[++i];
      if (!project || project.startsWith('-')) throw new Error(`${arg} requires a path.`);
      if (projectFlag) throw new Error(`${arg} may only be specified once.`);
      projectFlag = true;
      options.projects.push(project);
    } else if (arg === '--build' || arg === '-b') {
      options.build = true;
    } else if (arg === '--watch' || arg === '-w') {
      watch = true;
    } else if (arg === '--noEmit') {
      noEmit = true;
    } else if (arg === '--backend') {
      backend = args[++i];
      if (!['volar', 'vize'].includes(backend)) throw new Error('--backend expects volar or vize.');
    } else if (arg === '--fast') {
      fast = true;
    } else if (arg === '--emitDeclarationOnly') {
      options.emitDeclarationOnly = true;
    } else if (arg === '--outDir') {
      const dir = args[++i];
      if (!dir || dir.startsWith('-')) throw new Error(`${arg} requires a path.`);
      options.outDir = path.resolve(dir);
    } else if (!arg.startsWith('-')) {
      options.projects.push(arg);
    } else {
      throw new Error(`Unsupported argument: ${arg}`);
    }
  }
  if (output !== undefined) {
    process.stdout.write(output);
  } else {
    if (options.build && projectFlag) throw new Error('Use positional configs instead of --project with --build.');
    if (!options.build && options.projects.length !== Number(projectFlag)) throw new Error('Positional configs require --build.');
    if (noEmit && options.emitDeclarationOnly) throw new Error('--noEmit and --emitDeclarationOnly cannot be combined.');
    if (options.outDir && !options.emitDeclarationOnly) throw new Error('--outDir requires --emitDeclarationOnly.');
    if (options.outDir && options.build) throw new Error('Configure output directories per project when using --build.');
    if (watch && options.emitDeclarationOnly) throw new Error('--watch currently supports no-emit checking only.');
    if (fast && backend !== 'vize') throw new Error('--fast requires --backend vize.');
    if (backend === 'vize' && (watch || options.build || options.emitDeclarationOnly)) {
      throw new Error('--backend vize supports one-shot no-emit checking only.');
    }
    if (backend === 'vize') {
      const { runNative } = await import('../src/native.js');
      process.exitCode = await runNative({ cwd: options.cwd, project: options.projects[0], fast });
    } else {
      const { checkProject, formatDiagnostics } = await import('../src/index.js');
      const { checkGraph, projectGraph, watchProjects } = await import('../src/projects.js');
      const report = diagnostics => {
        process.stdout.write(formatDiagnostics(diagnostics));
        process.exitCode = diagnostics.some(d => d.category === 1) ? 2 : 0;
        if (watch) process.stdout.write(`vue-tsrs: ${diagnostics.length} diagnostic(s). Watching for changes.\n`);
      };
      if (watch) {
        const controller = new AbortController();
        for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
        watchProjects(options, { onResult: report, onError: reportError, closeSignal: controller.signal });
      } else if (options.build) {
        report(checkGraph(projectGraph(options), options));
      } else {
        report(checkProject({ ...options, project: options.projects[0] }));
      }
    }
  }
} catch (error) {
  reportError(error);
}

function reportError(error) {
  console.error(`vue-tsrs: ${error.message}`);
  process.exitCode = 1;
}
