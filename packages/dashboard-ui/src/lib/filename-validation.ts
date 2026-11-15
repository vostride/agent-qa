import { t } from '@/i18n'

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
  if (!trimmed) return t('common.filename.required')
  if (trimmed.includes('..')) return t('common.filename.parentSegment')
  if (trimmed.startsWith('/')) return t('common.filename.absolute')

  const segments = trimmed.split('/')
  for (const seg of segments) {
    if (!seg) return t('common.filename.emptySegment')
    if (!PATH_SEGMENT_RE.test(seg))
      return t('common.filename.characters')
  }

  const filename = segments[segments.length - 1]
  if (!YAML_EXT_RE.test(filename))
    return t('common.filename.extension')

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
    return t('common.filename.noPattern', { key: `workspace.${label}` })
  }

  if (!matchesAnyGlob(filename.trim(), configuredPatterns)) {
    return t('common.filename.noMatch', { label, patterns: configuredPatterns.join(', ') })
  }

  return null
}

export function isValidTestFilename(input: string): boolean {
  return getFilenameError(input) === null
}
