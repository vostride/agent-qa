import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { z } from 'zod'
import { generateHookId, isCanonicalHookId } from '@vostride/agent-qa-ids'
import { AgentQaConfigSchema } from '../schema/config-schema.js'
import { discoverWorkspaceFiles, resolveWorkspacePaths } from '../workspace/workspace-paths.js'
import type { HookRuntime } from './types.js'

const DEFAULT_CLEANUP_TARGETS = [
  '.agent-qa',
] as const

const HOOK_INLINE_RE = /\{\{runHook:"([^"]+)"\}\}/g

const MigratableHookDefinitionSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  runtime: z.enum(['node', 'bun', 'python', 'bash']),
  file: z.string().min(1),
  deps: z.array(z.string()).optional(),
  packageFile: z.string().optional(),
  timeout: z.string().min(1),
  network: z.boolean().optional(),
}).strict()

const MigratableHooksFileSchema = z.object({
  hooks: z.array(MigratableHookDefinitionSchema).min(1),
}).strict()

type CleanupTarget = (typeof DEFAULT_CLEANUP_TARGETS)[number]
type MigratableHookDefinition = z.infer<typeof MigratableHookDefinitionSchema>

export interface HookReferenceRewriteFile {
  path: string
  content: string
}

export interface HookReferenceMigrationSuccess {
  ok: true
  hookNameToId: Record<string, string>
  rewriteFiles: HookReferenceRewriteFile[]
  cleanupTargets: CleanupTarget[]
}

export interface HookReferenceMigrationFailure {
  ok: false
  errors: string[]
  rewriteFiles: []
  cleanupTargets: []
}

export type HookReferenceMigrationAudit =
  | HookReferenceMigrationSuccess
  | HookReferenceMigrationFailure

export interface HookReferenceMigrationOptions {
  workspaceDir: string
  configPath?: string
  generateId?: () => string
}

export class HookReferenceMigrationError extends Error {
  readonly errors: string[]

  constructor(errors: string[]) {
    super(`Hook reference migration aborted:\n${errors.map((error) => `- ${error}`).join('\n')}`)
    this.name = 'HookReferenceMigrationError'
    this.errors = errors
  }
}

interface WorkspaceMigrationContext {
  configDir: string
  hooksFilePath: string
  targetFiles: string[]
}

function normalizeHookDefinition(hook: MigratableHookDefinition, id: string): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    id,
    name: hook.name,
    runtime: hook.runtime,
    file: hook.file,
  }
  if (hook.deps !== undefined) normalized.deps = hook.deps
  if (hook.packageFile !== undefined) normalized.packageFile = hook.packageFile
  normalized.timeout = hook.timeout
  if (hook.network !== undefined) normalized.network = hook.network
  return normalized
}

function ensureUniqueGeneratedHookId(
  usedIds: Set<string>,
  generateId: () => string,
): string {
  let nextId = generateId()
  while (usedIds.has(nextId)) {
    nextId = generateId()
  }
  return nextId
}

function resolveHookReference(
  value: string,
  hookNameToId: Record<string, string>,
  hookIds: Set<string>,
  filePath: string,
  context: string,
  errors: string[],
): string {
  if (hookIds.has(value)) return value

  const resolvedId = hookNameToId[value]
  if (resolvedId) return resolvedId

  errors.push(`${filePath}: ${context} references "${value}" which is not defined in the configured hooks file`)
  return value
}

function rewriteHookList(
  owner: Record<string, unknown>,
  key: 'setup' | 'teardown',
  filePath: string,
  hookNameToId: Record<string, string>,
  hookIds: Set<string>,
  errors: string[],
): boolean {
  const current = owner[key]
  if (!Array.isArray(current)) return false

  let changed = false

  owner[key] = current.map((value, index) => {
    if (typeof value !== 'string') {
      errors.push(`${filePath}: ${key}[${index}] must be a string hook reference`)
      return value
    }
    const nextValue = resolveHookReference(value, hookNameToId, hookIds, filePath, key, errors)
    if (nextValue !== value) changed = true
    return nextValue
  })

  return changed
}

function rewriteInlineHookCalls(
  text: string,
  filePath: string,
  hookNameToId: Record<string, string>,
  hookIds: Set<string>,
  errors: string[],
): { text: string; changed: boolean } {
  let changed = false
  const rewrittenText = text.replace(HOOK_INLINE_RE, (_fullMatch, rawValue: string) => {
    const rewritten = resolveHookReference(rawValue, hookNameToId, hookIds, filePath, 'inline runHook', errors)
    if (rewritten !== rawValue) changed = true
    return `{{runHook:"${rewritten}"}}`
  })
  return { text: rewrittenText, changed }
}

function rewriteSteps(
  owner: Record<string, unknown>,
  filePath: string,
  hookNameToId: Record<string, string>,
  hookIds: Set<string>,
  errors: string[],
): boolean {
  const current = owner.steps
  if (!Array.isArray(current)) return false

  let changed = false

  owner.steps = current.map((entry, index) => {
    if (typeof entry === 'string') {
      const rewritten = rewriteInlineHookCalls(entry, filePath, hookNameToId, hookIds, errors)
      if (rewritten.changed) changed = true
      return rewritten.text
    }

    if (!entry || typeof entry !== 'object') {
      errors.push(`${filePath}: steps[${index}] must be a string or object step`)
      return entry
    }

    const stepEntry = entry as Record<string, unknown>
    if (typeof stepEntry.step === 'string') {
      const rewritten = rewriteInlineHookCalls(stepEntry.step, filePath, hookNameToId, hookIds, errors)
      if (rewritten.changed) changed = true
      stepEntry.step = rewritten.text
    }
    return stepEntry
  })

  return changed
}

async function resolveWorkspaceMigrationContext(
  workspaceDir: string,
  configPath?: string,
): Promise<WorkspaceMigrationContext> {
  const resolvedConfigPath = configPath ? resolve(configPath) : resolve(workspaceDir, 'agent-qa.config.yaml')
  const rawConfig = await readFile(resolvedConfigPath, 'utf-8')
  const parsedConfig = parseYaml(rawConfig)
  const configResult = AgentQaConfigSchema.safeParse(parsedConfig)

  if (!configResult.success) {
    const issues = configResult.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    throw new HookReferenceMigrationError([
      `${resolvedConfigPath}: invalid workspace config`,
      ...issues,
    ])
  }

  const workspace = resolveWorkspacePaths({
    config: configResult.data,
    configPath: resolvedConfigPath,
  })
  const [testFiles, suiteFiles] = await Promise.all([
    discoverWorkspaceFiles({ workspace, kind: 'test' }),
    discoverWorkspaceFiles({ workspace, kind: 'suite' }),
  ])
  const matches = [...testFiles, ...suiteFiles].map(file => file.workspaceRelativePath)

  return {
    configDir: workspace.configDir,
    hooksFilePath: workspace.hooksFile.absolutePath,
    targetFiles: [...new Set(matches)].sort(),
  }
}

export async function auditWorkspaceHookReferenceMigration(
  options: HookReferenceMigrationOptions,
): Promise<HookReferenceMigrationAudit> {
  const workspaceDir = resolve(options.workspaceDir)
  const errors: string[] = []

  let context: WorkspaceMigrationContext
  try {
    context = await resolveWorkspaceMigrationContext(workspaceDir, options.configPath)
  } catch (error) {
    if (error instanceof HookReferenceMigrationError) {
      return { ok: false, errors: error.errors, rewriteFiles: [], cleanupTargets: [] }
    }
    return {
      ok: false,
      errors: [`${workspaceDir}: ${(error as Error).message}`],
      rewriteFiles: [],
      cleanupTargets: [],
    }
  }

  let parsedHooksFile: unknown
  try {
    parsedHooksFile = parseYaml(await readFile(context.hooksFilePath, 'utf-8'))
  } catch (error) {
    return {
      ok: false,
      errors: [`${context.hooksFilePath}: ${(error as Error).message}`],
      rewriteFiles: [],
      cleanupTargets: [],
    }
  }

  const hooksResult = MigratableHooksFileSchema.safeParse(parsedHooksFile)
  if (!hooksResult.success) {
    return {
      ok: false,
      errors: hooksResult.error.issues.map((issue) => `${context.hooksFilePath}: ${issue.path.join('.')}: ${issue.message}`),
      rewriteFiles: [],
      cleanupTargets: [],
    }
  }

  const hookNameToId: Record<string, string> = {}
  const usedIds = new Set<string>()
  const generateId = options.generateId ?? generateHookId
  let hooksChanged = false
  const normalizedHooks = hooksResult.data.hooks.map((hook) => {
    if (hook.name in hookNameToId) {
      errors.push(`${context.hooksFilePath}: duplicate hook name "${hook.name}"`)
    }

    let id = hook.id
    if (id !== undefined) {
      if (!isCanonicalHookId(id)) {
        errors.push(`${context.hooksFilePath}: hook "${hook.name}" has invalid hook id "${id}"`)
      } else if (usedIds.has(id)) {
        errors.push(`${context.hooksFilePath}: duplicate hook id "${id}"`)
      }
    } else {
      id = ensureUniqueGeneratedHookId(usedIds, generateId)
      hooksChanged = true
    }

    if (id !== undefined) usedIds.add(id)
    hookNameToId[hook.name] = id ?? ''
    return normalizeHookDefinition(hook, id ?? '')
  })

  const rewriteFiles: HookReferenceRewriteFile[] = []
  const hookIds = new Set(Object.values(hookNameToId))

  if (hooksChanged) {
    rewriteFiles.push({
      path: relative(context.configDir, context.hooksFilePath),
      content: stringifyYaml({ hooks: normalizedHooks }),
    })
  }

  for (const relativePath of context.targetFiles) {
    const absolutePath = resolve(context.configDir, relativePath)

    let parsedFile: unknown
    try {
      parsedFile = parseYaml(await readFile(absolutePath, 'utf-8'))
    } catch (error) {
      errors.push(`${relativePath}: ${(error as Error).message}`)
      continue
    }

    if (!parsedFile || typeof parsedFile !== 'object') {
      errors.push(`${relativePath}: expected a YAML object at the root`)
      continue
    }

    const writableDoc = parsedFile as Record<string, unknown>
    const setupChanged = rewriteHookList(writableDoc, 'setup', relativePath, hookNameToId, hookIds, errors)
    const teardownChanged = rewriteHookList(writableDoc, 'teardown', relativePath, hookNameToId, hookIds, errors)
    const stepsChanged = rewriteSteps(writableDoc, relativePath, hookNameToId, hookIds, errors)

    if (setupChanged || teardownChanged || stepsChanged) {
      const rewrittenContent = stringifyYaml(writableDoc)
      rewriteFiles.push({ path: relativePath, content: rewrittenContent })
    }
  }

  if (errors.length > 0) {
    return {
      ok: false,
      errors,
      rewriteFiles: [],
      cleanupTargets: [],
    }
  }

  return {
    ok: true,
    hookNameToId,
    rewriteFiles,
    cleanupTargets: [...DEFAULT_CLEANUP_TARGETS],
  }
}

export async function applyWorkspaceHookReferenceMigration(
  options: HookReferenceMigrationOptions,
): Promise<HookReferenceMigrationSuccess> {
  const audit = await auditWorkspaceHookReferenceMigration(options)
  if (!audit.ok) {
    throw new HookReferenceMigrationError(audit.errors)
  }

  const workspaceDir = options.configPath
    ? dirname(resolve(options.configPath))
    : resolve(options.workspaceDir)
  for (const rewrite of audit.rewriteFiles) {
    const outputPath = resolve(workspaceDir, rewrite.path)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, rewrite.content, 'utf-8')
  }

  for (const cleanupTarget of audit.cleanupTargets) {
    await rm(resolve(workspaceDir, cleanupTarget), { recursive: true, force: true })
  }

  return audit
}

export type { CleanupTarget, HookRuntime }
