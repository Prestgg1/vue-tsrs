import type { Diagnostic } from 'tsrs/sync';

export interface CheckOptions {
  cwd?: string;
  project?: string;
}

export function checkProject(options?: CheckOptions): Diagnostic[];
export function formatDiagnostics(diagnostics: readonly Diagnostic[], cwd?: string): string;
