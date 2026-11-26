// Minimal Node typings for what the trusted worker uses. This plugin ships no node_modules (its
// symlinks break Orca's content hash), so @types/node is not available; keep this file lean.
declare const process: {
  env: Record<string, string | undefined>
}

declare module 'node:child_process' {
  export type ExecFileError = Error & { stdout?: string; stderr?: string }
  export type ExecFileOptions = {
    timeout?: number
    maxBuffer?: number
    windowsHide?: boolean
  }
  export function execFile(
    file: string,
    args: readonly string[],
    options: ExecFileOptions,
    callback: (error: ExecFileError | null, stdout: string, stderr: string) => void
  ): void
}