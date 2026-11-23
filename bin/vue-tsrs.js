#!/usr/bin/env node
import { createRequire } from 'node:module';
import { checkProject, formatDiagnostics } from '../src/index.js';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
try {
  let project;
  let output;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      output = 'Usage: vue-tsrs [-p, --project <tsconfig or directory>] [--noEmit]\nChecks Vue 3 SFCs and TypeScript without emitting files.\n';
    } else if (arg === '--version' || arg === '-v') {
      output = `${require('../package.json').version}\n`;
    } else if (arg === '--project' || arg === '-p') {
      project = args[++i];
      if (!project || project.startsWith('-')) throw new Error(`${arg} requires a path.`);
    } else if (arg !== '--noEmit') {
      throw new Error(`Unsupported argument: ${arg}`);
    }
  }
  if (output !== undefined) {
    process.stdout.write(output);
  } else {
    const diagnostics = checkProject({ project });
    process.stdout.write(formatDiagnostics(diagnostics));
    process.exitCode = diagnostics.some(d => d.category === 1) ? 1 : 0;
  }
} catch (error) {
  console.error(`vue-tsrs: ${error.message}`);
  process.exitCode = 2;
}
