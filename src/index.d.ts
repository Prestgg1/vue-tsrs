import type { Diagnostic } from 'tsrs/sync';

export interface CheckOptions {
  cwd?: string;
  project?: string;
  emitDeclarationOnly?: boolean;
  /** Overrides the configured declaration output directory, relative to cwd. */
  outDir?: string;
}

export function checkProject(options?: CheckOptions): Diagnostic[];
export function formatDiagnostics(diagnostics: readonly Diagnostic[], cwd?: string): string;
