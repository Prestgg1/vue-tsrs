import path from 'node:path';
import ts from 'typescript';
import vue from '@vue/language-core';
import { API, DiagnosticCategory, formatDiagnostics as formatNative } from 'tsrs/sync';
import { serverFS } from 'tsrs/fs';

const normalize = file => file.replaceAll(path.sep, '/');
const canonical = file => ts.sys.useCaseSensitiveFileNames ? normalize(file) : normalize(file).toLowerCase();

export function checkProject({ cwd = process.cwd(), project } = {}) {
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
    const errors = (native.errors ?? []).filter(d => ![18002, 18003].includes(d.code) || files.length === 0);
    if (errors.some(d => d.category === DiagnosticCategory.Error)) return errors;
    if (parsed?.projectReferences?.length || native.projectReferences?.length) {
      throw new Error('Project references are not supported. Check each leaf tsconfig separately.');
    }

    const options = { ...native.options, noEmit: true, allowJs: native.options.allowJs ?? true };
    // Resolve Vue imports without changing source text or intercepting normal TS imports.
    const resolutionOptions = { ...parsed?.options, allowArbitraryExtensions: true };
    const resolutionCache = ts.createModuleResolutionCache(path.dirname(config), canonical, resolutionOptions);
    const nativeResolver = api.createModuleResolver(options);
    const resolver = api.createModuleResolver(options, {
      resolveModuleName(specifier, directory, mode, context) {
        const fallback = () => nativeResolver.resolveModuleName(specifier, directory, mode, context).resolvedModule;
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
        const entry = generate(normalize(resolved.slice(0, -probeSuffix.length) + ext));
        return entry ? { resolvedFileName: entry.name } : fallback();
      },
    });
    const program = api.createProgram(files, options, { moduleResolver: resolver });
    const nativeDiagnostics = [
      ...errors, ...program.getProgramDiagnostics(), ...program.getGlobalDiagnostics(),
      ...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics(),
    ];
    diagnostics.push(...nativeDiagnostics.map(d => mapDiagnostic(d, virtual)).filter(Boolean));
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
