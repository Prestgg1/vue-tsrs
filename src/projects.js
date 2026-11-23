import { watch } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { checkProject } from './index.js';

export function resolveConfig(project, cwd = process.cwd()) {
  let candidate = project ? path.resolve(cwd, project) : ts.findConfigFile(cwd, ts.sys.fileExists);
  if (candidate && ts.sys.directoryExists(candidate)) candidate = path.join(candidate, 'tsconfig.json');
  if (!candidate || !ts.sys.fileExists(candidate)) throw new Error(`Cannot find tsconfig.json${project ? ` at ${project}` : ''}`);
  return ts.sys.realpath?.(candidate) ?? path.resolve(candidate);
}

export function projectGraph({ projects = [], cwd = process.cwd(), build = false } = {}) {
  const configs = [];
  const visiting = [];
  const visited = new Set();
  const watchRoots = new Set();
  const outputRoots = new Set();
  const references = new Map();
  function visit(config) {
    const cycle = visiting.indexOf(config);
    if (cycle >= 0) throw new Error(`Circular project references: ${[...visiting.slice(cycle), config].map(p => path.relative(cwd, p)).join(' -> ')}`);
    if (visited.has(config)) return;
    visiting.push(config);
    const directory = path.dirname(config);
    watchRoots.add(directory);
    const configInputs = new Set();
    const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => {},
      readFile(file) {
        if (path.isAbsolute(file)) configInputs.add(file);
        return ts.sys.readFile(file);
      },
    }, undefined, undefined, [{ extension: '.vue', isMixedContent: true, scriptKind: ts.ScriptKind.Deferred }]);
    for (const file of [...configInputs, ...(parsed?.fileNames ?? [])]) {
      if (ts.sys.fileExists(file) && !isWithin(directory, file) && !hasDependencyDirectory(file)) watchRoots.add(path.dirname(file));
    }
    for (const out of [parsed?.options.outDir, parsed?.options.declarationDir]) {
      if (out && !isWithin(out, directory)) outputRoots.add(path.resolve(out));
    }
    if (build) {
      const dependencies = [];
      for (const reference of parsed?.projectReferences ?? []) {
        const dependency = resolveConfig(ts.resolveProjectReferencePath(reference), directory);
        visit(dependency);
        dependencies.push(dependency);
      }
      references.set(config, dependencies);
    }
    visiting.pop();
    visited.add(config);
    configs.push(config);
  }
  for (const project of projects.length ? projects : [undefined]) visit(resolveConfig(project, cwd));
  const roots = [...watchRoots].sort((a, b) => a.length - b.length).filter((root, i, all) => !all.slice(0, i).some(parent => isWithin(parent, root)));
  return { configs, references, watchRoots: roots, outputRoots };
}

function hasDependencyDirectory(file) {
  return file.split(/[\\/]/).some(part => part === 'node_modules' || part === '.git');
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function checkGraph(graph, { cwd = process.cwd(), build = false, emitDeclarationOnly = false, outDir } = {}) {
  const diagnostics = [];
  const seen = new Set();
  const declarations = new Map();
  for (const project of graph.configs) {
    const referenceDeclarations = new Map();
    if (emitDeclarationOnly) {
      for (const reference of graph.references.get(project) ?? []) {
        for (const [source, declaration] of declarations.get(reference) ?? []) referenceDeclarations.set(source, declaration);
      }
    }
    const result = checkProject({ cwd, project, followReferences: build, emitDeclarationOnly, outDir,
      referenceDeclarations, emittedDeclarations: referenceDeclarations });
    declarations.set(project, referenceDeclarations);
    for (const diagnostic of result) {
      const key = JSON.stringify([diagnostic.fileName ?? project, diagnostic.startPosition, diagnostic.code, diagnostic.source, diagnostic.text]);
      if (!seen.has(key)) {
        seen.add(key);
        diagnostics.push(diagnostic);
      }
    }
    if (emitDeclarationOnly && result.some(d => d.category === 1)) break;
  }
  return diagnostics;
}

export function watchProjects(options, { onResult, onError, closeSignal }) {
  const watchers = new Map();
  let pending;
  let graph;
  function updateWatchers(roots) {
    for (const dir of roots) {
      if (watchers.has(dir)) continue;
      const watcher = watch(dir, { recursive: true }, (_event, relative) => {
        if (relative && hasDependencyDirectory(relative)) return;
        if (relative && [...(graph?.outputRoots ?? [])].some(out => isWithin(out, path.resolve(dir, relative)))) return;
        clearTimeout(pending);
        pending = setTimeout(run, 120);
      });
      watcher.on('error', error => {
        watcher.close();
        watchers.delete(dir);
        onError(error);
      });
      watchers.set(dir, watcher);
    }
    for (const [dir, watcher] of watchers) {
      if (!roots.includes(dir)) {
        watcher.close();
        watchers.delete(dir);
      }
    }
  }

  function run() {
    try {
      graph = projectGraph(options);
      updateWatchers(graph.watchRoots);
      onResult(checkGraph(graph, options));
    } catch (error) {
      onError(error);
    }
  }

  closeSignal?.addEventListener('abort', () => {
    clearTimeout(pending);
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  }, { once: true });
  // Keep watching the initial config directory even if a reference is temporarily invalid.
  try {
    updateWatchers((options.projects.length ? options.projects : [undefined]).map(p => path.dirname(resolveConfig(p, options.cwd))));
    run();
  } catch (error) {
    for (const watcher of watchers.values()) watcher.close();
    throw error;
  }
}
