import { readFile, writeFile, mkdir, stat, rm } from 'node:fs/promises'
import { dirname, basename } from 'node:path'
import { generateSuiteId } from '@vostride/agent-qa-ids'
import { parse as parseYaml } from 'yaml'
import { discoverWorkspaceFiles, resolveWorkspaceFileTarget, SuiteDefinitionSchema } from '@vostride/agent-qa-core'
import type { ResolvedWorkspacePaths, SuiteDefinition } from '@vostride/agent-qa-core'
import type { TestFileManager } from './test-file-manager.js'

interface SuiteFileInfo {
  path: string
  suiteId: string | null
  name: string
  testCount: number
  modified: string
  platform: string | null
}

interface SuiteValidationResult {
  valid: boolean
  errors: { message: string; line?: number; column?: number; suggestion?: string }[]
  missingTests?: Array<{ index: number; test: string; id: string }>
}

export class SuiteFileManager {
  private testFileManager: TestFileManager | undefined

  constructor(
    private readonly workspace: ResolvedWorkspacePaths,
    testFileManager?: TestFileManager,
  ) {
    this.testFileManager = testFileManager
  }

  async list(): Promise<SuiteFileInfo[]> {
    const records = await discoverWorkspaceFiles({ workspace: this.workspace, kind: 'suite' })
    const files: SuiteFileInfo[] = []

    for (const record of records) {
      try {
        const s = await stat(record.absolutePath)
        if (s.isFile()) {
          let suiteName = basename(record.workspaceRelativePath)
          let testCount = 0
          let platform: string | null = null
          let suiteId: string | null = null
          try {
            let content = await readFile(record.absolutePath, 'utf-8')
            const parsed = parseYaml(content)
            if (parsed?.name) suiteName = parsed.name
            if (Array.isArray(parsed?.tests)) testCount = parsed.tests.length
            platform = parsed?.config?.platform ?? null
            const suiteIdMatch = content.match(/^suite-id:\s*(.+)$/m)
            if (suiteIdMatch) {
              suiteId = suiteIdMatch[1].trim().replace(/^["'](.*)["']$/, '$1')
            } else {
              suiteId = generateSuiteId()
              content = `suite-id: ${suiteId}\n${content}`
              await writeFile(record.absolutePath, content, 'utf-8')
            }
          } catch { /* fall back to filename */ }
          files.push({
            path: record.workspaceRelativePath,
            suiteId,
            name: suiteName,
            testCount,
            modified: s.mtime.toISOString(),
            platform,
          })
        }
      } catch {
        // skip inaccessible files
      }
    }

    files.sort((a, b) => b.modified.localeCompare(a.modified))
    return files
  }

  async findBySuiteId(suiteId: string): Promise<{ path: string; content: string } | null> {
    const files = await this.list()
    const match = files.find(f => f.suiteId === suiteId)
    if (!match) return null
    const content = await this.read(match.path)
    return { path: match.path, content }
  }

  async resolvePath(filePath: string, requireExisting = true): Promise<{ storagePath: string; executionPath: string }> {
    const trimmedPath = filePath.trim()
    if (!trimmedPath) {
      throw new Error('Suite path is required')
    }

    const target = await resolveWorkspaceFileTarget({
      workspace: this.workspace,
      kind: 'suite',
      filePath: trimmedPath,
      requireExisting,
    })
    return { storagePath: target.workspaceRelativePath, executionPath: target.absolutePath }
  }

  async read(relativePath: string): Promise<string> {
    const target = await this.resolveTarget(relativePath, true)
    return readFile(target.absolutePath, 'utf-8')
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

  async validate(content: string): Promise<SuiteValidationResult> {
    try {
      const parsed = parseYaml(content)
      const result = SuiteDefinitionSchema.safeParse(parsed)

      if (!result.success) {
        return {
          valid: false,
          errors: result.error.issues.map((issue: { path: PropertyKey[]; message: string }) => ({
            message: `${issue.path.map(String).join('.')}: ${issue.message}`,
          })),
        }
      }

      // Save-time fail-fast: verify every referenced test path resolves (Phase 181 D-32/D-33)
      if (this.testFileManager) {
        const suite = result.data as SuiteDefinition
        const available = await this.testFileManager.list()
        const availablePaths = new Set(available.map((f) => f.path))
        const missingTests: Array<{ index: number; test: string; id: string }> = []
        suite.tests.forEach((entry: SuiteDefinition['tests'][number], index: number) => {
          if (!availablePaths.has(entry.test)) {
            // Report the ORIGINAL entry.test so the user sees what they wrote
            missingTests.push({ index, test: entry.test, id: entry.id })
          }
        })
        if (missingTests.length > 0) {
          return {
            valid: false,
            errors: [{
              message: `Cannot save — referenced tests not found: ${missingTests.map(m => m.test).join(', ')}`,
            }],
            missingTests,
          }
        }
      }

      return { valid: true, errors: [] }
    } catch (err) {
      return {
        valid: false,
        errors: [{ message: err instanceof Error ? err.message : 'Failed to parse YAML' }],
      }
    }
  }

  private async resolveTarget(relativePath: string, requireExisting: boolean) {
    return resolveWorkspaceFileTarget({
      workspace: this.workspace,
      kind: 'suite',
      filePath: relativePath,
      requireExisting,
    })
  }
}
