import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { parse as parseYaml, LineCounter, parseDocument } from 'yaml'
import { glob } from 'glob'
import { AgentQaConfigSchema } from '../schema/config-schema.js'
import { SuiteDefinitionSchema } from '../schema/suite-schema.js'
import { parseTestFile } from '../parser/yaml-parser.js'
import { parseHooksFile } from '../hooks/parser.js'
import { isPathInsideDir } from '../utils/path-validation.js'
import {
  discoverWorkspaceFiles,
  isWorkspacePathMatch,
  resolveWorkspaceFileTarget,
  type ResolvedWorkspacePaths,
  type WorkspaceFileKind,
} from '../workspace/workspace-paths.js'

export interface ValidationDiagnostic {
  file: string
  line: number
  column: number
  message: string
  severity: 'error' | 'warning'
}

export interface ValidationResult {
  diagnostics: ValidationDiagnostic[]
  fileCount: number
  errorCount: number
  warningCount: number
}

export const VALID_FILENAME_RE = /^[a-zA-Z0-9._-]+\.(suite\.)?(yaml|yml)$/

export async function validateConfig(configPath: string): Promise<ValidationDiagnostic[]> {
  const diagnostics: ValidationDiagnostic[] = []

  let content: string
  try {
    content = await readFile(configPath, 'utf-8')
  } catch (err) {
    diagnostics.push({
      file: configPath,
      line: 1,
      column: 1,
      message: `Cannot read config file: ${(err as Error).message}`,
      severity: 'error',
    })
    return diagnostics
  }

  let parsed: unknown
  try {
    parsed = parseYaml(content)
  } catch (err) {
    diagnostics.push({
      file: configPath,
      line: 1,
      column: 1,
      message: `YAML syntax error: ${(err as Error).message}`,
      severity: 'error',
    })
    return diagnostics
  }

  const result = AgentQaConfigSchema.safeParse(parsed)
  if (!result.success) {
    for (const issue of result.error.issues) {
      diagnostics.push({
        file: configPath,
        line: 1,
        column: 1,
        message: `${issue.path.join('.')}: ${issue.message}`,
        severity: 'error',
      })
    }
  }

  return diagnostics
}

function buildDiagnostic(file: string, message: string, severity: 'error' | 'warning' = 'error'): ValidationDiagnostic {
  return {
    file,
    line: 1,
    column: 1,
    message,
    severity,
  }
}

export function validateTestFile(filePath: string, content: string): ValidationDiagnostic[] {
  const result = parseTestFile(content, filePath)
  return result.errors.map((e) => ({
    file: e.file,
    line: e.line,
    column: e.column,
    message: e.message,
    severity: e.severity,
  }))
}

export function validateSuiteFile(filePath: string, content: string, basedir: string): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = []

  const lineCounter = new LineCounter()
  let parsed: unknown
  try {
    parsed = parseYaml(content, { lineCounter })
  } catch (err) {
    diagnostics.push({
      file: filePath,
      line: 1,
      column: 1,
      message: `YAML syntax error: ${(err as Error).message}`,
      severity: 'error',
    })
    return diagnostics
  }

  const result = SuiteDefinitionSchema.safeParse(parsed)
  if (!result.success) {
    for (const issue of result.error.issues) {
      diagnostics.push({
        file: filePath,
        line: 1,
        column: 1,
        message: `${issue.path.join('.')}: ${issue.message}`,
        severity: 'error',
      })
    }
    return diagnostics
  }

  // Check test references exist on disk
  const doc = parseDocument(content, { lineCounter })
  const testsNode = doc.contents && 'get' in doc.contents ? (doc.contents as { get: (key: string, keepScalar?: boolean) => unknown }).get('tests', true) : undefined

  const tests = result.data.tests
  for (let i = 0; i < tests.length; i++) {
    const entry = tests[i]
    const testPath = entry.test

    if (!isPathInsideDir(testPath, basedir)) {
      diagnostics.push({
        file: filePath, line: 1, column: 1,
        message: `Path traversal rejected: ${testPath}`,
        severity: 'error',
      })
      continue
    }

    const resolved = path.resolve(basedir, testPath)
    if (!existsSync(resolved)) {
      let line = 1
      let column = 1
      const seqNode = testsNode as { items?: { range?: [number, number] }[] } | undefined
      if (seqNode?.items?.[i]?.range) {
        const pos = lineCounter.linePos(seqNode.items[i].range![0])
        line = pos.line
        column = pos.col
      }
      diagnostics.push({
        file: filePath,
        line,
        column,
        message: `Test reference not found: ${testPath} (resolved: ${resolved})`,
        severity: 'error',
      })
    }
  }

  return diagnostics
}

export function validateFilename(filePath: string): ValidationDiagnostic[] {
  const basename = path.basename(filePath)
  if (!VALID_FILENAME_RE.test(basename)) {
    return [{
      file: filePath,
      line: 1,
      column: 1,
      message: `Invalid filename "${basename}" — expected pattern: [a-zA-Z0-9._-]+.(suite.)?(yaml|yml)`,
      severity: 'warning',
    }]
  }
  return []
}

export async function validateHooksFile(
  hooksFilePath: string,
  options: { required?: boolean } = {},
): Promise<ValidationDiagnostic[]> {
  const diagnostics: ValidationDiagnostic[] = []

  if (!existsSync(hooksFilePath)) {
    if (options.required) {
      return [buildDiagnostic(hooksFilePath, `Configured hooks file not found: ${hooksFilePath}`)]
    }
    return []
  }

  const { hooks, errors } = await parseHooksFile(hooksFilePath)
  if (errors.length > 0) {
    for (const err of errors) {
      diagnostics.push({
        file: hooksFilePath,
        line: 1,
        column: 1,
        message: err,
        severity: 'error',
      })
    }
    return diagnostics
  }

  for (const hook of hooks) {
    if (!existsSync(hook.file)) {
      diagnostics.push({
        file: hooksFilePath,
        line: 1,
        column: 1,
        message: `Hook "${hook.name}": script file not found: ${hook.file}`,
        severity: 'error',
      })
    }

    for (const dep of hook.deps) {
      if (!existsSync(dep)) {
        diagnostics.push({
          file: hooksFilePath,
          line: 1,
          column: 1,
          message: `Hook "${hook.name}": dependency file not found: ${dep}`,
          severity: 'error',
        })
      }
    }

    if (hook.packageFile && !existsSync(hook.packageFile)) {
      diagnostics.push({
        file: hooksFilePath,
        line: 1,
        column: 1,
        message: `Hook "${hook.name}": package file not found: ${hook.packageFile}`,
        severity: 'error',
      })
    }
  }

  return diagnostics
}

export function validateHookReferences(
  setupOrTeardown: string[],
  hookIds: Set<string>,
  filePath: string,
  context: string,
): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = []
  for (const hookId of setupOrTeardown) {
    if (!hookIds.has(hookId)) {
      diagnostics.push({
        file: filePath,
        line: 1,
        column: 1,
        message: `Hook ID "${hookId}" referenced in ${context} but not defined in the configured hooks file`,
        severity: 'warning',
      })
    }
  }
  return diagnostics
}

export async function detectGlobOverlap(
  testMatch: string[],
  suiteMatch: string[],
  ignore: string[],
  cwd?: string,
): Promise<string[]> {
  if (testMatch.length === 0 || suiteMatch.length === 0) return []
  const globOptions = {
    ignore,
    absolute: true,
    ...(cwd ? { cwd } : {}),
  }
  const [testFiles, suiteFiles] = await Promise.all([
    glob(testMatch, globOptions),
    glob(suiteMatch, globOptions),
  ])
  const testSet = new Set(testFiles)
  return suiteFiles.filter((f) => testSet.has(f))
}

function isSuiteFile(filePath: string): boolean {
  return /\.suite\.(yaml|yml)$/.test(filePath)
}

export async function validateFiles(
  filePaths: string[],
  configPath?: string,
  options: { basedir?: string } = {},
): Promise<ValidationResult> {
  const diagnostics: ValidationDiagnostic[] = []

  if (configPath) {
    diagnostics.push(...await validateConfig(configPath))
  }

  for (const filePath of filePaths) {
    diagnostics.push(...validateFilename(filePath))

    let content: string
    try {
      content = await readFile(filePath, 'utf-8')
    } catch (err) {
      diagnostics.push({
        file: filePath,
        line: 1,
        column: 1,
        message: `Cannot read file: ${(err as Error).message}`,
        severity: 'error',
      })
      continue
    }

    if (isSuiteFile(filePath)) {
      diagnostics.push(...validateSuiteFile(filePath, content, options.basedir ?? process.cwd()))
    } else {
      diagnostics.push(...validateTestFile(filePath, content))
    }
  }

  const errorCount = diagnostics.filter((d) => d.severity === 'error').length
  const warningCount = diagnostics.filter((d) => d.severity === 'warning').length
  const files = new Set(diagnostics.map((d) => d.file))

  return {
    diagnostics,
    fileCount: filePaths.length,
    errorCount,
    warningCount,
  }
}

async function resolveExplicitWorkspaceFile(
  workspace: ResolvedWorkspacePaths,
  filePath: string,
): Promise<{ record?: { absolutePath: string }; diagnostic?: ValidationDiagnostic }> {
  const preferredKinds: WorkspaceFileKind[] = isSuiteFile(filePath)
    ? ['suite', 'test']
    : ['test', 'suite']

  for (const kind of preferredKinds) {
    try {
      const record = await resolveWorkspaceFileTarget({
        workspace,
        kind,
        filePath,
        requireExisting: true,
      })
      return { record }
    } catch {
      // Try the other configured file kind before reporting the path as invalid.
    }
  }

  return {
    diagnostic: buildDiagnostic(
      filePath,
      `File is not matched by configured workspace testMatch or suiteMatch patterns: ${filePath}`,
    ),
  }
}

function appendDiagnostics(result: ValidationResult, diagnostics: ValidationDiagnostic[]): void {
  for (const diagnostic of diagnostics) {
    result.diagnostics.push(diagnostic)
    if (diagnostic.severity === 'error') result.errorCount++
    else result.warningCount++
  }
}

function validateRequiredWorkspaceFiles(workspace: ResolvedWorkspacePaths): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = []
  for (const [key, file] of [
    ['workspace.agentRules', workspace.agentRules],
    ['workspace.envFile', workspace.envFile],
    ['workspace.secretsFile', workspace.secretsFile],
  ] as const) {
    if (!existsSync(file.absolutePath)) {
      diagnostics.push(buildDiagnostic(file.absolutePath, `Configured workspace file not found: ${key} -> ${file.absolutePath}`))
    }
  }
  return diagnostics
}

export async function validateProject(options: {
  configPath?: string
  files?: string[]
  testMatch?: string[]
  testPathIgnore?: string[]
  suiteMatch?: string[]
  hooksFile?: string
  workspace?: ResolvedWorkspacePaths
} = {}): Promise<ValidationResult> {
  let filePaths: string[]
  const preDiagnostics: ValidationDiagnostic[] = []

  if (options.files && options.files.length > 0 && options.workspace) {
    const resolvedFiles: string[] = []
    for (const file of options.files) {
      const { record, diagnostic } = await resolveExplicitWorkspaceFile(options.workspace, file)
      if (record) resolvedFiles.push(record.absolutePath)
      if (diagnostic) preDiagnostics.push(diagnostic)
    }
    filePaths = resolvedFiles
  } else if (options.files && options.files.length > 0) {
    filePaths = options.files.map((f) => path.resolve(f))
  } else if (options.workspace) {
    const [testFiles, suiteFiles] = await Promise.all([
      discoverWorkspaceFiles({ workspace: options.workspace, kind: 'test' }),
      discoverWorkspaceFiles({ workspace: options.workspace, kind: 'suite' }),
    ])
    filePaths = [...testFiles, ...suiteFiles].map(file => file.absolutePath)
  } else {
    const testPatterns = options.testMatch ?? []
    const suitePatterns = options.suiteMatch ?? []
    const allPatterns = [...testPatterns, ...suitePatterns]
    const ignore = options.testPathIgnore ?? []
    filePaths = allPatterns.length > 0
      ? await glob(allPatterns, { ignore, absolute: true })
      : []
  }

  const configPath = options.configPath ?? options.workspace?.configPath

  const result = await validateFiles(filePaths, configPath, {
    basedir: options.workspace?.configDir,
  })
  appendDiagnostics(result, preDiagnostics)

  const testPatterns = options.workspace?.testMatch ?? options.testMatch ?? []
  const suitePatterns = options.workspace?.suiteMatch ?? options.suiteMatch ?? []
  if (testPatterns.length > 0 && suitePatterns.length > 0) {
    const ignore = options.workspace?.testPathIgnore ?? options.testPathIgnore ?? []
    const overlapping = await detectGlobOverlap(testPatterns, suitePatterns, ignore, options.workspace?.configDir)
    for (const filePath of overlapping) {
      result.diagnostics.push({
        file: filePath,
        line: 1,
        column: 1,
        message: 'File matched by both testMatch and suiteMatch — may cause duplicate validation',
        severity: 'warning',
      })
      result.warningCount++
    }
  }

  appendDiagnostics(result, options.workspace ? validateRequiredWorkspaceFiles(options.workspace) : [])

  const hooksFilePath = options.workspace?.hooksFile.absolutePath ?? options.hooksFile
  const hooksDiags = hooksFilePath
    ? await validateHooksFile(hooksFilePath, { required: Boolean(options.workspace) })
    : []
  for (const d of hooksDiags) {
    result.diagnostics.push(d)
    if (d.severity === 'error') result.errorCount++
    else result.warningCount++
  }

  // Check hook ID references in test/suite files
  if (hooksFilePath && hooksDiags.length === 0 && existsSync(hooksFilePath)) {
    const { hooks } = await parseHooksFile(hooksFilePath)
    const hookIds = new Set(hooks.map(h => h.id))

    for (const filePath of filePaths) {
      const workspaceRelativePath = options.workspace
        ? path.relative(options.workspace.configDir, filePath).split(path.sep).join('/')
        : filePath
      const isWorkspaceFile = options.workspace
        ? isWorkspacePathMatch({ workspace: options.workspace, kind: isSuiteFile(filePath) ? 'suite' : 'test', workspaceRelativePath })
        : true
      if (!isWorkspaceFile) continue

      try {
        const content = await readFile(filePath, 'utf-8')
        const parsed = parseYaml(content)
        if (parsed && typeof parsed === 'object') {
          const setup = (parsed as Record<string, unknown>).setup as string[] | undefined
          const teardown = (parsed as Record<string, unknown>).teardown as string[] | undefined
          if (setup?.length) {
            const refDiags = validateHookReferences(setup, hookIds, filePath, 'setup')
            for (const d of refDiags) { result.diagnostics.push(d); result.warningCount++ }
          }
          if (teardown?.length) {
            const refDiags = validateHookReferences(teardown, hookIds, filePath, 'teardown')
            for (const d of refDiags) { result.diagnostics.push(d); result.warningCount++ }
          }
        }
      } catch { /* skip files that can't be parsed */ }
    }
  }

  return result
}
