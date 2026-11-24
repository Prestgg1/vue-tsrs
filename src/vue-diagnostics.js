import ts from 'typescript';

export function unusedImportRange(block, offset) {
  if (!block || offset < block.loc.start.offset || offset >= block.loc.end.offset) return;
  const base = block.loc.start.offset;
  const lang = block.lang ?? 'js';
  const file = ts.createSourceFile(`script.${lang}`, block.content, ts.ScriptTarget.Latest);
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const { name, namedBindings } = statement.importClause;
    const names = name ? [name] : [];
    if (namedBindings) {
      if (ts.isNamespaceImport(namedBindings)) names.push(namedBindings.name);
      else names.push(...namedBindings.elements.map(element => element.name));
    }
    if (names.length === 1 && names[0].getStart(file) + base === offset) {
      return [statement.getStart(file) + base, statement.end + base];
    }
  }
}

export function cleanVizeMessage(message) {
  // Preserve the surrounding error and user type information; these aliases do not exist in the source.
  return message.replace(/(?<![\w$])\$TemplateInstance\b/g, 'Vue component instance')
    .replace(/(?<![\w$])\$ComponentCheckProps\b/g, 'Vue component props')
    .replace(/\bComponentPropsForTemplate(?=<)/g, 'Vue component props')
    .replace(/\b__([\w$]+)_CheckProps_\d+\b/g, '$1 props')
    .replace(/\bVueTemplatePublicAttrsType\b/g, 'Vue public attributes');
}
