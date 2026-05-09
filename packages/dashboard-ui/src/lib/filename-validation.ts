const PATH_SEGMENT_RE = /^[a-zA-Z0-9._-]+$/
const YAML_EXT_RE = /\.(yaml|yml)$/

function normalizeWorkspacePath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '')
}

function globToRegex(glob: string): RegExp {
  const escaped = normalizeWorkspacePath(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const regex = escaped
    .replace(/\?/g, '.')
    .replace(/\*\*\//g, '__DIRSTAR__')
    .replace(/\*\*/g, '__DIRSTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DIRSTAR__/g, '(?:.*/)?')
  return new RegExp(`^${regex}$`)
}

function matchesAnyGlob(path: string, patterns: string[]): boolean {
  const normalizedPath = normalizeWorkspacePath(path)
  return patterns.some((pattern) => globToRegex(pattern).test(normalizedPath))
}

export function getFilenameError(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return 'Filename is required'
  if (trimmed.includes('..')) return "Path must not contain '..' segments"
  if (trimmed.startsWith('/')) return 'Path must be relative, not absolute'

  const segments = trimmed.split('/')
  for (const seg of segments) {
    if (!seg) return 'Path contains empty segment (double slash)'
    if (!PATH_SEGMENT_RE.test(seg))
      return 'Path must contain only letters, numbers, hyphens, dots, underscores, and forward slashes, ending with .yaml or .yml'
  }

  const filename = segments[segments.length - 1]
  if (!YAML_EXT_RE.test(filename))
    return 'File must end with .yaml or .yml'

  return null
}

export function getWorkspaceFilenameError(
  filename: string,
  patterns: string[] | undefined,
  label: 'testMatch' | 'suiteMatch',
): string | null {
  const base = getFilenameError(filename)
  if (base) return base

  const configuredPatterns = (patterns ?? []).map((pattern) => pattern.trim()).filter(Boolean)
  if (configuredPatterns.length === 0) {
    return `workspace.${label} must contain at least one pattern`
  }

  if (!matchesAnyGlob(filename.trim(), configuredPatterns)) {
    return `File path must match one of your workspace's ${label} patterns (${configuredPatterns.join(', ')})`
  }

  return null
}

export function isValidTestFilename(input: string): boolean {
  return getFilenameError(input) === null
}
