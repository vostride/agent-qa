import { readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises'
import { dirname, basename } from 'node:path'
import { generateTestId } from '@vostride/agent-qa-ids'
import { parse as parseYaml } from 'yaml'
import {
  discoverWorkspaceFiles,
  resolveWorkspaceFileTarget,
  type ResolvedWorkspacePaths,
} from '@vostride/agent-qa-core'

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

export function extractTestFileMetadata(content: string): TestFileMetadata {
  let parsed: Record<string, unknown> | null = null

  try {
    const yamlValue = parseYaml(content)
    if (yamlValue && typeof yamlValue === 'object' && !Array.isArray(yamlValue)) {
      parsed = yamlValue as Record<string, unknown>
    }
  } catch {
    // fall back to regex extraction for partially-authored files
  }

  const config = parsed?.config
  const parsedConfig = config && typeof config === 'object' && !Array.isArray(config)
    ? config as Record<string, unknown>
    : null
  const use = parsed?.use
  const parsedUse = use && typeof use === 'object' && !Array.isArray(use)
    ? use as Record<string, unknown>
    : null

  const nameMatch = content.match(/^name:\s*(.+)$/m)
  const targetMatch = content.match(/^\s*target:\s*(.+)$/m)
  const testIdMatch = content.match(/^test-id:\s*(.+)$/m)
  const platformMatch = content.match(/^\s*platform:\s*(web|android|ios)\s*$/m)
  const parallelMatch = content.match(/^\s*parallel:\s*(true|false)\s*$/m)

  const name = typeof parsed?.name === 'string' && parsed.name.trim().length > 0
    ? parsed.name.trim()
    : nameMatch
      ? normalizeQuotedString(nameMatch[1])
      : null

  const targetName = typeof parsed?.target === 'string' && parsed.target.trim().length > 0
    ? parsed.target.trim()
    : targetMatch
      ? normalizeQuotedString(targetMatch[1])
      : null

  const testId = typeof parsed?.['test-id'] === 'string' && parsed['test-id'].trim().length > 0
    ? parsed['test-id'].trim()
    : testIdMatch
      ? normalizeQuotedString(testIdMatch[1])
      : null

  const platform = normalizePlatform(parsed?.platform)
    ?? normalizePlatform(parsedConfig?.platform)
    ?? normalizePlatform(platformMatch?.[1])

  const parallel = typeof parsedUse?.parallel === 'boolean'
    ? parsedUse.parallel
    : typeof parsed?.parallel === 'boolean'
      ? parsed.parallel
      : typeof parsedConfig?.parallel === 'boolean'
        ? parsedConfig.parallel
        : parallelMatch
          ? parallelMatch[1] === 'true'
          : null

  return {
    name,
    testId,
    targetName,
    platform,
    parallel,
  }
}

export class TestFileManager {
  constructor(private readonly workspace: ResolvedWorkspacePaths) {}

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
          try {
            let content = await readFile(record.absolutePath, 'utf-8')
            const metadata = extractTestFileMetadata(content)
            if (metadata.name) testName = metadata.name
            if (metadata.targetName) targetName = metadata.targetName
            if (metadata.platform) platform = metadata.platform
            if (metadata.testId) {
              testId = metadata.testId
            } else {
              testId = generateTestId()
              content = `test-id: ${testId}\n${content}`
              await writeFile(record.absolutePath, content, 'utf-8')
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
    await writeFile(target.absolutePath, content, 'utf-8')
  }

  async delete(relativePath: string): Promise<void> {
    const target = await this.resolveTarget(relativePath, true)
    await rm(target.absolutePath)
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
