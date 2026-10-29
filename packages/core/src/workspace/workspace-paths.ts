import { existsSync } from 'node:fs'
import path from 'node:path'
import { glob } from 'glob'
import type { AgentQaConfig } from '../types/config.js'

export type WorkspaceFileKind = 'test' | 'suite'

export interface ResolvedWorkspaceFile {
  configuredPath: string
  absolutePath: string
  workspaceRelativePath: string
}

export interface WorkspaceFileRecord {
  kind: WorkspaceFileKind
  absolutePath: string
  workspaceRelativePath: string
}

export interface ResolvedWorkspacePaths {
  configPath: string
  configDir: string
  testMatch: string[]
  suiteMatch: string[]
  testPathIgnore: string[]
  hooksFile: ResolvedWorkspaceFile
  envFile: ResolvedWorkspaceFile
  secretsFile: ResolvedWorkspaceFile
}

interface ResolveWorkspacePathsInput {
  config: AgentQaConfig
  configPath: string
  requireExistingFiles?: boolean
}

function toForwardSlash(value: string): string {
  return value.split(path.sep).join('/')
}

function trimLeadingCurrentDir(value: string): string {
  return toForwardSlash(value).replace(/^\.\//, '')
}

function assertNonEmptyArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || item.trim().length === 0)) {
    throw new Error(`Missing required workspace config key: ${key}`)
  }
  return value
}

function assertNonEmptyString(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing required workspace config key: ${key}`)
  }
  return value
}

function resolveWorkspaceScalar(configDir: string, key: string, configuredPath: unknown): ResolvedWorkspaceFile {
  const value = assertNonEmptyString(configuredPath, key)
  const absolutePath = path.isAbsolute(value) ? path.resolve(value) : path.resolve(configDir, value)
  return {
    configuredPath: value,
    absolutePath,
    workspaceRelativePath: trimLeadingCurrentDir(path.relative(configDir, absolutePath)),
  }
}

function assertInsideWorkspace(configDir: string, absolutePath: string, filePath: string): string {
  const relativePath = path.relative(configDir, absolutePath)
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`Workspace file path escapes config directory: ${filePath}`)
  }
  return trimLeadingCurrentDir(relativePath)
}

/**
 * The ONE spelling of the durable workspace-relative IDENTITY recipe.
 *
 * `configDir`-rooted, forward-slashed, `./`-trimmed, and escape-refusing — literally
 * {@link assertInsideWorkspace} with {@link resolveWorkspaceFileTarget}'s resolution step in front,
 * exported rather than re-derived so no second spelling of the rule can drift from this one.
 *
 * WHY IT EXISTS: the committed `quarantine.jsonl` keys entries on this string and compares it with
 * `===`. An absolute path is bytes only the machine that wrote them can produce, so a ledger
 * carrying absolute identities could never match on a fresh CI checkout — it would be committed for
 * an inheritance it structurally cannot deliver. These bytes are IDENTITY ONLY and are never used
 * for file access; readers keep the absolute path they already resolved.
 *
 * Accepting an already-relative input (resolved against `configDir`, as
 * {@link resolveWorkspaceFileTarget} does) makes the mint idempotent: handing an identity through a
 * second layer cannot silently re-anchor it on `process.cwd()`.
 *
 * @throws when the path resolves outside `configDir` — an escaping file cannot mint an identity.
 */
export function workspaceRelativeIdentityPath(configDir: string, filePath: string): string {
  const absolutePath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(configDir, filePath)
  return assertInsideWorkspace(configDir, absolutePath, filePath)
}

function escapeRegexChar(char: string): string {
  return char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}

function globToRegex(pattern: string): RegExp {
  const normalized = trimLeadingCurrentDir(pattern)
  let source = ''

  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i]
    const next = normalized[i + 1]

    if (char === '*') {
      if (next === '*') {
        const afterGlobstar = normalized[i + 2]
        if (afterGlobstar === '/') {
          source += '(?:.*/)?'
          i += 2
        } else {
          source += '.*'
          i += 1
        }
      } else {
        source += '[^/]*'
      }
      continue
    }

    if (char === '?') {
      source += '[^/]'
      continue
    }

    if (char === '{') {
      const end = normalized.indexOf('}', i + 1)
      if (end !== -1) {
        const alternatives = normalized
          .slice(i + 1, end)
          .split(',')
          .map(part => part.split('').map(escapeRegexChar).join(''))
        source += `(?:${alternatives.join('|')})`
        i = end
        continue
      }
    }

    source += escapeRegexChar(char)
  }

  return new RegExp(`^${source}$`)
}

function matchesAnyPattern(workspaceRelativePath: string, patterns: string[]): boolean {
  const normalized = trimLeadingCurrentDir(workspaceRelativePath)
  return patterns.some(pattern => globToRegex(pattern).test(normalized))
}

function getKindPatterns(workspace: ResolvedWorkspacePaths, kind: WorkspaceFileKind): string[] {
  return kind === 'test' ? workspace.testMatch : workspace.suiteMatch
}

function isIgnored(workspace: ResolvedWorkspacePaths, workspaceRelativePath: string): boolean {
  return workspace.testPathIgnore.length > 0 && matchesAnyPattern(workspaceRelativePath, workspace.testPathIgnore)
}

export function resolveWorkspacePaths(input: ResolveWorkspacePathsInput): ResolvedWorkspacePaths {
  const configPath = path.resolve(input.configPath)
  const configDir = path.dirname(configPath)
  const workspace = input.config.workspace

  if (!workspace) {
    throw new Error('Missing required workspace config key: workspace')
  }

  const resolved: ResolvedWorkspacePaths = {
    configPath,
    configDir,
    testMatch: assertNonEmptyArray(workspace.testMatch, 'workspace.testMatch'),
    suiteMatch: assertNonEmptyArray(workspace.suiteMatch, 'workspace.suiteMatch'),
    testPathIgnore: workspace.testPathIgnore ?? [],
    hooksFile: resolveWorkspaceScalar(configDir, 'workspace.hooksFile', workspace.hooksFile),
    envFile: resolveWorkspaceScalar(configDir, 'workspace.envFile', workspace.envFile),
    secretsFile: resolveWorkspaceScalar(configDir, 'workspace.secretsFile', workspace.secretsFile),
  }

  if (input.requireExistingFiles) {
    // The workspace agent-rules file was retired in Phase 373 — rules return as
    // committed agent-qa-knowledge/policies/ files via Reader L0 in Phase 380.
    for (const [key, file] of [
      ['workspace.hooksFile', resolved.hooksFile],
      ['workspace.envFile', resolved.envFile],
      ['workspace.secretsFile', resolved.secretsFile],
    ] as const) {
      if (!existsSync(file.absolutePath)) {
        throw new Error(`Configured workspace file not found: ${key} -> ${file.absolutePath}`)
      }
    }
  }

  return resolved
}

export async function discoverWorkspaceFiles(input: {
  workspace: ResolvedWorkspacePaths
  kind: WorkspaceFileKind
}): Promise<WorkspaceFileRecord[]> {
  const patterns = getKindPatterns(input.workspace, input.kind)
  const matches = await glob(patterns, {
    cwd: input.workspace.configDir,
    ignore: input.workspace.testPathIgnore,
    absolute: true,
    nodir: true,
  })

  return matches
    .map(match => path.resolve(match))
    .map(absolutePath => ({
      kind: input.kind,
      absolutePath,
      workspaceRelativePath: trimLeadingCurrentDir(path.relative(input.workspace.configDir, absolutePath)),
    }))
    .sort((a, b) => a.workspaceRelativePath.localeCompare(b.workspaceRelativePath))
}

export async function resolveWorkspaceFileTarget(input: {
  workspace: ResolvedWorkspacePaths
  kind: WorkspaceFileKind
  filePath: string
  requireExisting?: boolean
}): Promise<WorkspaceFileRecord> {
  const absolutePath = path.isAbsolute(input.filePath)
    ? path.resolve(input.filePath)
    : path.resolve(input.workspace.configDir, input.filePath)
  const workspaceRelativePath = assertInsideWorkspace(input.workspace.configDir, absolutePath, input.filePath)

  if (!isWorkspacePathMatch({
    workspace: input.workspace,
    kind: input.kind,
    workspaceRelativePath,
  })) {
    throw new Error(`Workspace ${input.kind} file is not matched by configured workspace patterns: ${workspaceRelativePath}`)
  }

  if (input.requireExisting && !existsSync(absolutePath)) {
    throw new Error(`Workspace ${input.kind} file not found: ${workspaceRelativePath}`)
  }

  return {
    kind: input.kind,
    absolutePath,
    workspaceRelativePath,
  }
}

export function isWorkspacePathMatch(input: {
  workspace: ResolvedWorkspacePaths
  kind: WorkspaceFileKind
  workspaceRelativePath: string
}): boolean {
  return matchesAnyPattern(input.workspaceRelativePath, getKindPatterns(input.workspace, input.kind))
    && !isIgnored(input.workspace, input.workspaceRelativePath)
}
