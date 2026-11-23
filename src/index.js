import path from 'node:path';
import ts from 'typescript';
import vue from '@vue/language-core';
import { API, DiagnosticCategory, EmitOnly, formatDiagnostics as formatNative } from 'tsrs/sync';
import { serverFS } from 'tsrs/fs';

const normalize = file => file.replaceAll(path.sep, '/');
const canonical = file => ts.sys.useCaseSensitiveFileNames ? normalize(file) : normalize(file).toLowerCase();

export function checkProject({ cwd = process.cwd(), project, emitDeclarationOnly = false, outDir,
  followReferences = false, referenceDeclarations, emittedDeclarations } = {}) {
  cwd = path.resolve(cwd);
  let config = project ? path.resolve(cwd, project) : ts.findConfigFile(cwd, ts.sys.fileExists);
  if (config && ts.sys.directoryExists(config)) config = path.join(config, 'tsconfig.json');
  if (!config || !ts.sys.fileExists(config)) throw new Error(`Cannot find tsconfig.json${project ? ` at ${project}` : ''}`);
  config = normalize(config);

  const { vueOptions } = vue.createParsedCommandLine(ts, ts.sys, config);
  const extensions = vue.getAllExtensions(vueOptions).sort((a, b) => b.length - a.length);
  const extensionOf = file => extensions.find(ext => canonical(file).endsWith(ext));
  const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: () => {},
    readDirectory: (directory, exts, ...rest) => ts.sys.readDirectory(directory, [...(exts ?? []), ...extensions], ...rest),
  }, undefined, undefined, extensions.map(ext => ({ extension: ext, isMixedContent: true, scriptKind: ts.ScriptKind.Deferred })));

  const virtual = new Map();
  const bySource = new Map();
  const diagnostics = [];
  const plugin = vue.createVueLanguagePlugin(ts, parsed?.options ?? {}, vueOptions, file => file);
  const language = vue.createLanguage([plugin], new Map(), () => {});

  function generate(file) {
    const key = canonical(file);
    if (bySource.has(key)) return bySource.get(key);
    const source = ts.sys.readFile(file);
    if (source === undefined) return;
    const script = language.scripts.set(file, ts.ScriptSnapshot.fromString(source));
    const root = script?.generated?.root;
    const service = root && plugin.typescript.getServiceScript(root);
    if (!service) return;
    const name = `${file}.__vue_tsrs${service.extension}`;
    if (ts.sys.fileExists(name)) throw new Error(`Virtual file conflicts with an existing file: ${name}`);
    const text = service.code.snapshot.getText(0, service.code.snapshot.getLength());
    const entry = {
      name, text, file,
      generatedLines: lineIndex(text),
      sourceLines: lineIndex(source),
      mapper: language.maps.get(service.code, script),
    };
    virtual.set(canonical(name), entry);
    bySource.set(key, entry);
    const template = root.sfc.template;
    for (const error of root.vueSfc?.errors ?? []) {
      addVueError(entry, error, 0);
    }
    for (const error of template?.errors ?? []) {
      addVueError(entry, error, template.startTagEnd);
    }
    return entry;
  }

  function addVueError(entry, error, base) {
    const start = base + (error.loc?.start.offset ?? 0);
    const end = base + (error.loc?.end.offset ?? error.loc?.start.offset ?? 0);
    diagnostics.push({
      fileName: entry.file, pos: start, end,
      startPosition: entry.sourceLines.position(start), endPosition: entry.sourceLines.position(end),
      code: error.code ?? 0, source: 'VUE', category: DiagnosticCategory.Error,
      text: typeof error === 'string' ? error : error.message,
    });
  }

  const api = new API({
    cwd: path.dirname(config),
    fs: {
      directoryExists: serverFS.useOS, getAccessibleEntries: serverFS.useOS,
      fileExists: file => virtual.has(canonical(file)) || serverFS.useOS,
      readFile: file => virtual.get(canonical(file))?.text ?? serverFS.useOS,
      realpath: file => virtual.has(canonical(file)) ? serverFS.identity : serverFS.useOS,
      stat: file => {
        const entry = virtual.get(canonical(file));
        return entry ? { mode: 0o100644, size: Buffer.byteLength(entry.text), mtime: new Date(0) } : serverFS.useOS;
      },
      writeFile: serverFS.noop, removeFile: serverFS.noop,
    },
  });
  try {
    const native = api.parseConfigFile(config);
    const roots = (parsed?.fileNames ?? []).filter(extensionOf).map(file => generate(normalize(file))?.name).filter(Boolean);
    const files = [...new Set([...(native.fileNames ?? []).filter(file => !extensionOf(file)), ...roots])];
    const hasReferences = Boolean(parsed?.projectReferences?.length || native.projectReferences?.length);
    const errors = (native.errors ?? []).filter(d => ![18002, 18003].includes(d.code) || (!files.length && !(followReferences && hasReferences)));
    if (errors.some(d => d.category === DiagnosticCategory.Error)) return errors;
    if (hasReferences) {
      if (!followReferences) throw new Error('Use --build to check a tsconfig with project references.');
      if (!files.length) return errors;
    }

    const options = { ...native.options, noEmit: !emitDeclarationOnly, allowJs: native.options.allowJs ?? true };
    if (hasReferences && !emitDeclarationOnly) {
      // A no-emit graph checks referenced source directly, not a prebuilt declaration redirect.
      options.composite = false;
      delete options.rootDir;
    }
    if (emitDeclarationOnly) {
      Object.assign(options, { declaration: true, emitDeclarationOnly: true });
      if (outDir !== undefined) {
        options.outDir = normalize(path.resolve(cwd, outDir));
        options.declarationDir = options.outDir;
      }
    }
    // Resolve Vue imports without changing source text or intercepting normal TS imports.
    const resolutionOptions = { ...parsed?.options, allowArbitraryExtensions: true };
    const resolutionCache = ts.createModuleResolutionCache(path.dirname(config), canonical, resolutionOptions);
    const nativeResolver = api.createModuleResolver(options);
    const ordinaryModules = new Map();
    const resolver = api.createModuleResolver(options, {
      resolveModuleName(specifier, directory, mode, context) {
        const fallback = () => {
          const key = JSON.stringify([directory, mode, specifier]);
          if (!ordinaryModules.has(key)) {
            const result = nativeResolver.resolveModuleName(specifier, directory, mode, context).resolvedModule;
            const declaration = result?.resolvedFileName && referenceDeclarations?.get(canonical(result.resolvedFileName));
            ordinaryModules.set(key, declaration ? { resolvedFileName: declaration } : result);
          }
          return ordinaryModules.get(key);
        };
        const ext = extensionOf(specifier);
        if (!ext) return fallback();
        const probeSuffix = `.d${ext}.ts`;
        const result = ts.resolveModuleName(specifier, path.join(directory, '__vue_tsrs_resolve.ts'), resolutionOptions, {
          ...ts.sys,
          fileExists(file) {
            return file.endsWith(probeSuffix)
              ? ts.sys.fileExists(file.slice(0, -probeSuffix.length) + ext)
              : ts.sys.fileExists(file);
          },
        }, resolutionCache, undefined, mode || undefined).resolvedModule;
        const resolved = result?.resolvedFileName;
        if (!resolved?.endsWith(probeSuffix)) return fallback();
        const source = normalize(resolved.slice(0, -probeSuffix.length) + ext);
        const declaration = referenceDeclarations?.get(canonical(source));
        if (declaration) return { resolvedFileName: declaration };
        const entry = generate(source);
        return entry ? { resolvedFileName: entry.name } : fallback();
      },
    });
    const program = api.createProgram(files, options, { moduleResolver: resolver });
    const nativeDiagnostics = [
      ...errors, ...program.getProgramDiagnostics(), ...program.getGlobalDiagnostics(),
      ...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics(),
    ];
    diagnostics.push(...nativeDiagnostics.map(d => mapDiagnostic(d, virtual)).filter(Boolean));
    if (emitDeclarationOnly && !diagnostics.some(d => d.category === DiagnosticCategory.Error)) {
      const output = program.emitToString(EmitOnly.OnlyDts);
      // Declaration diagnostics may be attached to synthetic Vue code. Do not silently drop them.
      diagnostics.push(...output.diagnostics.map(d => mapDiagnostic(d, virtual) ?? declarationDiagnostic(d, virtual)));
      if (!output.emitSkipped && !diagnostics.some(d => d.category === DiagnosticCategory.Error)) {
        diagnostics.push(...writeDeclarations(output.outputFiles, program, virtual, emittedDeclarations));
      }
    }
    const seen = new Set();
    return diagnostics.filter(d => {
      const key = JSON.stringify([d.fileName, d.startPosition, d.code, d.source, d.text]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } finally {
    try {
      api.close();
    } finally {
      for (const { file } of bySource.values()) language.scripts.delete(file);
    }
  }
}

function declarationDiagnostic(diagnostic, virtual) {
  const entry = virtual.get(canonical(diagnostic.fileName));
  return {
    ...diagnostic, fileName: entry.file, pos: undefined, end: undefined,
    startPosition: undefined, endPosition: undefined, sourceLines: undefined,
    relatedInformation: diagnostic.relatedInformation?.map(d => mapDiagnostic(d, virtual) ?? declarationDiagnostic(d, virtual)),
  };
}

function writeDeclarations(outputFiles, program, virtual, emittedDeclarations) {
  const virtualStems = new Set([...virtual.values()].map(entry => canonical(path.basename(entry.name).replace(/\.[jt]sx?$/, ''))));
  const cleanName = name => {
    const stem = name.replace(/\.[jt]sx?$/, '');
    return virtualStems.has(canonical(path.basename(stem))) ? stem.slice(0, -'.__vue_tsrs'.length) : name;
  };
  const inputs = new Set(program.getSourceFileNames().map(canonical));
  const files = new Map();
  const redirects = new Map();
  const destinations = new Set();
  const diagnostics = [];
  for (const [name, { text, sourceFileName }] of outputFiles) {
    if (!/\.d\.[cm]?ts$/.test(name)) continue;
    const isVue = sourceFileName && virtual.has(canonical(sourceFileName));
    const file = isVue ? name.replace(/\.__vue_tsrs(?=\.d\.ts$)/, '') : name;
    const key = canonical(file);
    if (inputs.has(key) || destinations.has(key)) {
      diagnostics.push({
        code: inputs.has(key) ? 5055 : 5056, category: DiagnosticCategory.Error,
        text: `Cannot write file '${file}' because it would overwrite ${inputs.has(key) ? 'an input file' : 'another output file'}.`,
      });
      continue;
    }
    destinations.add(key);
    if (sourceFileName) redirects.set(canonical(isVue ? virtual.get(canonical(sourceFileName)).file : sourceFileName), file);
    const declaration = cleanDeclaration(text, name, cleanName);
    const map = outputFiles.get(`${name}.map`);
    // Native maps describe virtual Vue text (and pre-rewrite declarations).
    // Keep ordinary TS declaration maps only when neither side was modified.
    if (map && !isVue && declaration === text && !map.text.includes('.__vue_tsrs')) {
      files.set(`${file}.map`, map.text);
      files.set(file, declaration);
    } else {
      files.set(file, declaration.replace(/^\/\/# sourceMappingURL=.*(?:\r?\n|$)/gm, ''));
    }
  }
  if (!diagnostics.length) {
    for (const [file, text] of files) ts.sys.writeFile(file, text);
    if (emittedDeclarations) for (const [source, declaration] of redirects) emittedDeclarations.set(source, declaration);
  }
  return diagnostics;
}

function cleanDeclaration(text, name, cleanName) {
  if (!text.includes('.__vue_tsrs')) return text;
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const edits = [];
  function visit(node) {
    if (ts.isStringLiteral(node) && (
      node.parent.moduleSpecifier === node ||
      ts.isExternalModuleReference(node.parent) ||
      (ts.isLiteralTypeNode(node.parent) && ts.isImportTypeNode(node.parent.parent)) ||
      (ts.isModuleDeclaration(node.parent) && node.parent.name === node)
    )) {
      const raw = node.getText(source);
      const moduleName = raw.slice(1, -1);
      const cleaned = raw[0] + cleanName(moduleName) + raw.at(-1);
      if (cleaned !== raw) edits.push([node.getStart(source), node.end, cleaned]);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const [start, end, replacement] of edits.reverse()) {
    text = text.slice(0, start) + replacement + text.slice(end);
  }
  return text;
}

function lineIndex(text) {
  const starts = [0];
  for (const match of text.matchAll(/\r\n|[\r\n\u2028\u2029]/g)) starts.push(match.index + match[0].length);
  return {
    offset: ({ line, character }) => starts[line] + character,
    position(offset) {
      let low = 0;
      let high = starts.length;
      while (high - low > 1) {
        const mid = Math.floor((low + high) / 2);
        if (starts[mid] <= offset) low = mid;
        else high = mid;
      }
      return { line: low, character: offset - starts[low] };
    },
  };
}

function mapDiagnostic(diagnostic, virtual) {
  const entry = diagnostic.fileName && virtual.get(canonical(diagnostic.fileName));
  const relatedInformation = diagnostic.relatedInformation?.map(d => mapDiagnostic(d, virtual)).filter(Boolean);
  if (!entry) return { ...diagnostic, relatedInformation };
  if (!diagnostic.startPosition) return;
  const start = entry.generatedLines.offset(diagnostic.startPosition);
  const end = diagnostic.endPosition ? entry.generatedLines.offset(diagnostic.endPosition) : start;
  const range = entry.mapper.toSourceRange(start, end, true, data => {
    const rule = data.verification;
    return !!rule && (typeof rule !== 'object' || (rule.shouldReport?.(diagnostic.source, diagnostic.code) ?? true));
  }).next().value;
  if (!range) return;
  const [pos, mappedEnd] = range;
  return {
    ...diagnostic, fileName: entry.file, pos, end: mappedEnd,
    startPosition: entry.sourceLines.position(pos), endPosition: entry.sourceLines.position(mappedEnd),
    sourceLines: undefined, relatedInformation,
  };
}

export function formatDiagnostics(diagnostics, cwd = process.cwd()) {
  return formatNative(diagnostics, {
    getCurrentDirectory: () => normalize(path.resolve(cwd)),
    getCanonicalFileName: canonical,
    getNewLine: () => '\n',
  });
}
