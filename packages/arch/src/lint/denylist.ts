// Frozen core source-level host and storage debt; not a general allowance.
export const HOST_EXTERNALS = new Set(['glob', 'posthog-node']) as ReadonlySet<string>

export function matchesDenylistEntry(pkgName: string, entry: string): boolean {
  return (
    pkgName === entry ||
    pkgName.startsWith(`${entry}-`) ||
    pkgName.startsWith(`@${entry}/`)
  )
}
