import { readFile, mkdir, rm, stat } from 'node:fs/promises'
import { dirname, basename } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { generateTestId } from '@vostride/agent-qa-ids'
import { parseAllDocuments, parse as parseYaml } from 'yaml'
import {
  discoverWorkspaceFiles,
  resolveWorkspaceFileTarget,
  type ResolvedWorkspacePaths,
} from '@vostride/agent-qa-core'
import { createPathLock, replaceFileAtomic } from './replace-file-atomic.js'

export interface TestFileInfo {
  path: string
  name: string
  testId: string | null
  targetName: string | null
  platform: string | null
  modified: string
}

export type SupportedPlatform = 'web' | 'android' | 'ios'

export interface TestFileMetadata {
  name: string | null
  testId: string | null
  targetName: string | null
  platform: SupportedPlatform | null
  parallel: boolean | null
}

export interface TestValidationError {
  message: string
  line?: number
  column?: number
  suggestion?: string
}

export interface TestValidationResult {
  valid: boolean
  errors: TestValidationError[]
}

function normalizeQuotedString(value: string): string {
  return value.trim().replace(/^["'](.*)["']$/, '$1')
}

function normalizePlatform(value: unknown): SupportedPlatform | null {
  if (value !== 'web' && value !== 'android' && value !== 'ios') return null
  return value
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function presentText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text === '' ? null : text
}

// only a file that does not parse is read line by line, each key from its own line.
function valueOnLine(match: RegExpMatchArray | null): string | null {
  if (match === null) return null
  const value = normalizeQuotedString(match[1])
  return value.trim() === '' ? null : value
}

// a bare, blank or comment-only id key is filled in place; otherwise the id line goes after a
// leading byte-order mark and the stream's first --- marker, or first, in the file's own line ending.
export function withIdLine(content: string, key: 'test-id' | 'suite-id', id: string): string {
  const bom = content.startsWith('\uFEFF') ? '\uFEFF' : ''
  const rest = content.slice(bom.length)
  const firstBreak = rest.indexOf('\n')
  const eol = firstBreak > 0 && rest[firstBreak - 1] === '\r' ? '\r\n' : '\n'
  const line = `${key}: ${id}`
  const blankKey = new RegExp(`^${key}:(?:[ \\t]*(["'])[ \\t]*\\1)?(?:[ \\t]+#[^\\r\\n]*)?[ \\t]*$`, 'm')
  if (blankKey.test(rest)) return bom + rest.replace(blankKey, () => line)
  const marker = rest.match(/^(?:(?:[ \t]*(?:#[^\r\n]*)?|%[^\r\n]*)\r?\n)*---[ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)/)
  if (marker === null) return `${bom}${line}${eol}${rest}`
  const head = marker[0].endsWith('\n') ? marker[0] : `${marker[0]}${eol}`
  return `${bom}${head}${line}${eol}${rest.slice(marker[0].length)}`
}

// an id write lands only if it parses, as one document, to the old mapping plus the id.
export function idWriteText(content: string, key: 'test-id' | 'suite-id', id: string): string | null {
  let old: unknown
  try {
    old = parseYaml(content)
  } catch {
    return null
  }
  if (!isMapping(old)) return null
  const next = withIdLine(content, key, id)
  let written: unknown
  try {
    written = parseYaml(next)
  } catch {
    return null
  }
  return isDeepStrictEqual(written, { ...old, [key]: id }) ? next : null
}

function lineMetadata(content: string): TestFileMetadata {
  const nameMatch = content.match(/^name:[ \t]*(\S.*)$/m)
  const targetMatch = content.match(/^[ \t]*target:[ \t]*(\S.*)$/m)
  const testIdMatch = content.match(/^test-id:[ \t]*(\S.*)$/m)
  const platformMatch = content.match(/^[ \t]*platform:[ \t]*(web|android|ios)[ \t]*$/m)
  const parallelMatch = content.match(/^[ \t]*parallel:[ \t]*(true|false)[ \t]*$/m)
  return {
    name: valueOnLine(nameMatch),
    testId: valueOnLine(testIdMatch),
    targetName: valueOnLine(targetMatch),
    platform: normalizePlatform(platformMatch?.[1]),
    parallel: parallelMatch ? parallelMatch[1] === 'true' : null,
  }
}

// a file that parses is read from its mapping, where a null, empty or blank value is absent.
export function extractTestFileMetadata(content: string): TestFileMetadata {
  let parsed: unknown
  try {
    parsed = parseYaml(content)
  } catch {
    return lineMetadata(content.replace(/^\uFEFF/, ''))
  }
  if (!isMapping(parsed)) return { name: null, testId: null, targetName: null, platform: null, parallel: null }

  const config = isMapping(parsed.config) ? parsed.config : null
  const use = isMapping(parsed.use) ? parsed.use : null
  const parallel = typeof use?.parallel === 'boolean'
    ? use.parallel
    : typeof parsed.parallel === 'boolean'
      ? parsed.parallel
      : typeof config?.parallel === 'boolean'
        ? config.parallel
        : null

  return {
    name: presentText(parsed.name),
    testId: presentText(parsed['test-id']),
    targetName: presentText(parsed.target),
    platform: normalizePlatform(parsed.platform) ?? normalizePlatform(config?.platform),
    parallel,
  }
}

// a mint reads bytes that decode losslessly, or it does not write.
export function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch (err) {
    if (err instanceof TypeError) return undefined
    throw err
  }
}

// every document's target is read, and the line pattern reads only top-level target lines.
export function targetsForMarkerCheck(content: string): unknown[] {
  const targets: unknown[] = []
  try {
    for (const doc of parseAllDocuments(content)) {
      if (doc.errors.length === 0) {
        const value: unknown = doc.toJS()
        if (isMapping(value)) targets.push(value.target)
      }
    }
  } catch { /* the line pattern below still reads it */ }
  for (const match of content.matchAll(/^target:[ \t]*(\S.*)$/gm)) targets.push(match[1])
  return targets
}

export class TestFileManager {
  constructor(private readonly workspace: ResolvedWorkspacePaths) {}

  // each list call reads the workspace itself; each file is written whole and one writer at a time.
  private readonly underLock = createPathLock()

  async list(): Promise<TestFileInfo[]> {
    const records = await discoverWorkspaceFiles({ workspace: this.workspace, kind: 'test' })
    const files: TestFileInfo[] = []

    for (const record of records) {
      try {
        const s = await stat(record.absolutePath)
        if (s.isFile()) {
          let testName = basename(record.workspaceRelativePath)
          let platform: string | null = null
          let targetName: string | null = null
          let testId: string | null = null
          const take = (metadata: TestFileMetadata): void => {
            testName = metadata.name || basename(record.workspaceRelativePath)
            targetName = metadata.targetName || null
            platform = metadata.platform
            testId = metadata.testId
          }
          try {
            const first = extractTestFileMetadata(await readFile(record.absolutePath, 'utf-8'))
            take(first)
            if (!first.testId) {
              take(await this.underLock(record.absolutePath, async () => {
                const content = decodeUtf8(await readFile(record.absolutePath))
                if (content === undefined) return first
                const current = extractTestFileMetadata(content)
                if (current.testId) return current
                // an empty file may be an outside save mid-write; it is never minted.
                if (content.trim() === '') return current
                const minted = generateTestId()
                const next = idWriteText(content, 'test-id', minted)
                if (next === null) return current
                await replaceFileAtomic(record.absolutePath, next)
                return { ...current, testId: minted }
              }))
            }
          } catch { /* fall back to filename */ }
          files.push({
            path: record.workspaceRelativePath,
            name: testName,
            testId,
            targetName,
            platform,
            modified: s.mtime.toISOString(),
          })
        }
      } catch {
        // skip inaccessible files
      }
    }

    files.sort((a, b) => b.modified.localeCompare(a.modified))
    return files
  }

  async read(relativePath: string): Promise<string> {
    const target = await this.resolveTarget(relativePath, true)
    return readFile(target.absolutePath, 'utf-8')
  }

  async findByTestId(testId: string): Promise<{ path: string; content: string } | null> {
    const files = await this.list()
    const match = files.find(f => f.testId === testId)
    if (!match) return null
    const content = await this.read(match.path)
    return { path: match.path, content }
  }

  async write(relativePath: string, content: string): Promise<void> {
    const target = await this.resolveTarget(relativePath, false)
    await mkdir(dirname(target.absolutePath), { recursive: true })
    await this.underLock(target.absolutePath, () => replaceFileAtomic(target.absolutePath, content))
  }

  async delete(relativePath: string): Promise<void> {
    const target = await this.resolveTarget(relativePath, true)
    await this.underLock(target.absolutePath, () => rm(target.absolutePath))
  }

  async validate(content: string): Promise<TestValidationResult> {
    try {
      const { parseTestFile } = await import('@vostride/agent-qa-core')
      const result = parseTestFile(content, '<editor>')

      if (result.errors.length === 0) {
        return { valid: true, errors: [] }
      }

      return {
        valid: false,
        errors: result.errors.map(e => ({
          message: e.message,
          line: e.line,
          column: e.column,
          suggestion: e.suggestion,
        })),
      }
    } catch (err) {
      return {
        valid: false,
        errors: [{ message: err instanceof Error ? err.message : 'Failed to validate' }],
      }
    }
  }

  private async resolveTarget(relativePath: string, requireExisting: boolean) {
    return resolveWorkspaceFileTarget({
      workspace: this.workspace,
      kind: 'test',
      filePath: relativePath,
      requireExisting,
    })
  }
}
