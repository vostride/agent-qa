// Host modules only one core file may import. Each stays debt until its file moves to a host
// package that core reaches through a port; the regenerated core-wide baseline never lists them.
export interface ScopedHostBaselineEntry {
  target: string
  // Repository-relative, with forward slashes.
  file: string
  reason: string
}

export const AGENT_QA_CORE_SCOPED_HOST_BASELINE: readonly ScopedHostBaselineEntry[] = [
  {
    target: 'node:child_process',
    file: 'packages/core/src/remote/plugins/plugin-process.ts',
    reason: 'the plugin host starts one process per plugins entry',
  },
]

export function inScopedHostBaseline(
  hit: { specifier: string; file: string },
  scoped: readonly ScopedHostBaselineEntry[],
): boolean {
  const file = hit.file.replaceAll('\\', '/')
  return scoped.some(
    (entry) =>
      entry.target === hit.specifier && (file === entry.file || file.endsWith(`/${entry.file}`)),
  )
}
