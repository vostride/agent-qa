import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'

import { HooksFileSchema, isPathInsideDir, parseHooksFile, resolveWorkspacePaths } from '@vostride/agent-qa-core'
import type { AgentQaConfig, HooksFileConfig } from '@vostride/agent-qa-core'
import { generateHookId } from '@vostride/agent-qa-ids'
import { parse as parseYaml, parseDocument } from 'yaml'

import type { ConfigManager } from '../config/config-manager.js'
import type {
  HookCatalogResponse,
  HookCatalogRow,
  HookDeleteResult,
  HookDetailResponse,
  HookDraftValidationResult,
  HookFieldError,
  HookFieldName,
  HookMutationRequest,
  HookPrepareResult,
  HookRegistryReadError,
} from './hook-registry-types.js'
import { scanHookReferences } from './hook-reference-scan.js'

type ParsedHookDefinition = HooksFileConfig['hooks'][number]
type AuthoredHookDefinition = Omit<ParsedHookDefinition, 'timeout'> & {
  timeout: string
}
type HooksFileParseData = { hooks: ParsedHookDefinition[] }
type ZodIssueLike = { path: PropertyKey[]; message: string }

interface HookRegistryLocation {
  filePath: string
  resolvedFilePath: string
  hooksBaseDir: string
}

interface HookRegistryState extends HookRegistryLocation {
  hooks: ParsedHookDefinition[]
  errors: HookRegistryReadError[]
  missing: boolean
}

interface HookRegistryMutationState extends HookRegistryLocation {
  hooks: AuthoredHookDefinition[]
  raw: string | null
  existed: boolean
}

interface HookFileState {
  resolvedFilePath: string | null
  fileMissing: boolean
  fieldErrors: HookFieldError[]
}

interface HookMutationResolvedPayload {
  hook: Record<string, unknown> & { id: string }
  source: string
}

interface HookMutationPlan {
  nextHook: ParsedHookDefinition
  nextSourcePath: string
  oldSourcePath: string | null
  oldSourceContent: string | null
  oldSourceExisted: boolean
  removeOldSourcePath: boolean
  projectedHooks: AuthoredHookDefinition[]
}

class HookRegistryMutationError extends Error {
  readonly code: string
  readonly fieldErrors: HookFieldError[]

  constructor(code: string, fieldErrors: HookFieldError[], message = code) {
    super(message)
    this.code = code
    this.fieldErrors = fieldErrors
  }
}

export function isHookRegistryMutationError(error: unknown): error is {
  code: string
  fieldErrors: HookFieldError[]
} {
  return error instanceof HookRegistryMutationError
}

export class HookRegistryManager {
  constructor(
    private readonly configManager: ConfigManager,
    private readonly configPath: string,
  ) {}

  async readCatalog(): Promise<HookCatalogResponse> {
    const registry = await this.readRegistryState()
    if (registry.missing || registry.errors.length > 0) {
      return {
        hooks: [],
        filePath: registry.filePath,
        errors: registry.errors.map((error) => error.message),
        missing: registry.missing,
      }
    }

    const hooks = await Promise.all(
      registry.hooks.map(async (hook) => {
        const fileState = await this.inspectHookFile(hook.file, registry.hooksBaseDir)
        return this.toCatalogRow(hook, fileState.fileMissing)
      }),
    )

    return {
      hooks,
      filePath: registry.filePath,
      errors: [],
      missing: false,
    }
  }

  async readHook(hookId: string): Promise<HookDetailResponse | null> {
    const registry = await this.readRegistryState()
    if (registry.missing || registry.errors.length > 0) {
      return null
    }

    const hook = registry.hooks.find((candidate) => candidate.id === hookId)
    if (!hook) {
      return null
    }

    const fileState = await this.inspectHookFile(hook.file, registry.hooksBaseDir)
    let source: string | null = null

    if (fileState.resolvedFilePath && fileState.fieldErrors.length === 0) {
      source = await readFile(fileState.resolvedFilePath, 'utf-8')
    }

    return {
      hook: this.toCatalogRow(hook, fileState.fileMissing),
      source,
      fieldErrors: fileState.fieldErrors,
    }
  }

  async createHook(payload: HookMutationRequest): Promise<HookDetailResponse> {
    const registry = await this.readRegistryForMutation()
    const resolvedPayload = this.resolveMutationPayload(payload, {
      generatedId: generateHookId(),
    })
    const plan = await this.planHookMutation(registry, resolvedPayload.hook.id, resolvedPayload, 'create')

    await this.persistHookMutation(registry, plan, resolvedPayload.source)

    return {
      hook: this.toCatalogRow(plan.nextHook, false),
      source: resolvedPayload.source,
      fieldErrors: [],
    }
  }

  async updateHook(hookId: string, payload: HookMutationRequest): Promise<HookDetailResponse> {
    const registry = await this.readRegistryForMutation()
    const existingHook = registry.hooks.find((candidate) => candidate.id === hookId)
    if (!existingHook) {
      throw new HookRegistryMutationError('hook_not_found', [
        {
          field: 'id',
          code: 'hook_not_found',
          message: 'Hook not found',
        },
      ])
    }

    const resolvedPayload = this.resolveMutationPayload(payload, {
      expectedId: hookId,
      generatedId: hookId,
    })
    const plan = await this.planHookMutation(registry, hookId, resolvedPayload, 'update')

    await this.persistHookMutation(registry, plan, resolvedPayload.source)

    return {
      hook: this.toCatalogRow(plan.nextHook, false),
      source: resolvedPayload.source,
      fieldErrors: [],
    }
  }

  async deleteHook(
    hookId: string,
    options: { force?: boolean } = {},
  ): Promise<HookDeleteResult> {
    const registry = await this.readRegistryForMutation()
    const existingHook = registry.hooks.find((candidate) => candidate.id === hookId)
    if (!existingHook) {
      throw new HookRegistryMutationError('hook_not_found', [
        {
          field: 'id',
          code: 'hook_not_found',
          message: 'Hook not found',
        },
      ])
    }

    const references = await scanHookReferences(dirname(this.configPath), this.configPath, hookId)
    if (references.length > 0 && !options.force) {
      return {
        deleted: false,
        references,
      }
    }

    const nextHooks = registry.hooks.filter((candidate) => candidate.id !== hookId)
    const nextRegistryContent = nextHooks.length > 0
      ? this.serializeHooksDocument(registry.raw, nextHooks)
      : null
    const sourcePath = resolve(registry.hooksBaseDir, existingHook.file)
    const sourceSnapshot = await this.readOptionalFile(sourcePath)
    const sourcePathStillReferenced = nextHooks.some(
      (candidate) => resolve(registry.hooksBaseDir, candidate.file) === sourcePath,
    )

    try {
      if (nextRegistryContent === null) {
        await rm(registry.resolvedFilePath, { force: true })
      } else {
        await mkdir(dirname(registry.resolvedFilePath), { recursive: true })
        await writeFile(registry.resolvedFilePath, nextRegistryContent, 'utf-8')
      }

      if (sourceSnapshot.exists && !sourcePathStillReferenced) {
        await rm(sourcePath, { force: true })
      }

      return {
        deleted: true,
        references,
      }
    } catch (error) {
      await this.restoreRegistrySnapshot(registry)

      if (sourceSnapshot.exists && sourceSnapshot.content !== null) {
        await mkdir(dirname(sourcePath), { recursive: true })
        await writeFile(sourcePath, sourceSnapshot.content, 'utf-8')
      }

      throw error
    }
  }

  async validateDraft(draft: unknown): Promise<HookDraftValidationResult> {
    const location = await this.resolveRegistryLocation()
    const normalizedDraft = this.normalizeDraftForSchema(draft)
    const result = HooksFileSchema.safeParse(normalizedDraft)

    if (!result.success) {
      return {
        valid: false,
        fieldErrors: result.error.issues.map((issue: ZodIssueLike) => this.toValidationFieldError(issue.path, issue.message)),
        warnings: [],
      }
    }
    const hooksFile = result.data as HooksFileParseData

    const fieldErrors: HookFieldError[] = []
    const warnings: HookFieldError[] = []

    for (const hook of hooksFile.hooks) {
      if (isAbsolute(hook.file)) {
        fieldErrors.push({
          field: 'file',
          code: 'absolute_path',
          message: 'Hook file must be relative to the configured hooks file',
        })
        continue
      }

      if (!isPathInsideDir(hook.file, location.hooksBaseDir)) {
        fieldErrors.push({
          field: 'file',
          code: 'unsafe_path',
          message: 'Hook file must stay inside the configured hooks file directory',
        })
        continue
      }

      const fileState = await this.inspectHookFile(hook.file, location.hooksBaseDir)
      warnings.push(...fileState.fieldErrors.filter((error) => error.code === 'file_missing'))
    }

    return {
      valid: fieldErrors.length === 0,
      fieldErrors,
      warnings,
    }
  }

  async prepareForExecution(): Promise<HookPrepareResult> {
    const registry = await this.readRegistryState()
    if (registry.missing) {
      return {
        resolvedHooks: new Map(),
        authoringIssuesById: new Map(),
      }
    }

    if (registry.errors.length > 0) {
      return {
        resolvedHooks: new Map(),
        hookRegistryError: registry.errors.map((error) => error.message).join('; '),
        authoringIssuesById: new Map(),
      }
    }

    const parsedHooks = await parseHooksFile(registry.resolvedFilePath)
    if (parsedHooks.errors.length > 0) {
      return {
        resolvedHooks: new Map(),
        hookRegistryError: parsedHooks.errors.join('; '),
        authoringIssuesById: new Map(),
      }
    }

    const resolvedHooksById = new Map(parsedHooks.hooks.map((hook) => [hook.id, hook]))
    const resolvedHooks = new Map<typeof resolvedHooksById extends Map<infer K, infer V> ? K : never, typeof resolvedHooksById extends Map<infer K, infer V> ? V : never>()
    const authoringIssuesById = new Map<string, HookFieldError[]>()

    for (const hook of registry.hooks) {
      const fileState = await this.inspectHookFile(hook.file, registry.hooksBaseDir)
      const resolvedHook = resolvedHooksById.get(hook.id)
      if (!resolvedHook) {
        continue
      }

      if (fileState.fieldErrors.length > 0) {
        authoringIssuesById.set(hook.id, fileState.fieldErrors)
        continue
      }

      resolvedHooks.set(hook.id, resolvedHook)
    }

    return {
      resolvedHooks,
      authoringIssuesById,
    }
  }

  private async readRegistryForMutation(): Promise<HookRegistryMutationState> {
    const location = await this.resolveRegistryLocation()

    let raw: string | null = null
    try {
      raw = await readFile(location.resolvedFilePath, 'utf-8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          ...location,
          hooks: [],
          raw: null,
          existed: false,
        }
      }
      throw error
    }

    let parsed: unknown
    try {
      parsed = parseYaml(raw)
    } catch (error: unknown) {
      throw new HookRegistryMutationError('validation_failed', [
        {
          field: 'registry',
          code: 'invalid_registry',
          message: `Invalid YAML in hooks file: ${(error as Error).message}`,
        },
      ])
    }

    const result = HooksFileSchema.safeParse(parsed)
    if (!result.success) {
      throw new HookRegistryMutationError(
        'validation_failed',
        result.error.issues.map((issue: ZodIssueLike) => this.toValidationFieldError(issue.path, issue.message)),
      )
    }

    const hooksFile = result.data as HooksFileParseData
    const pathErrors = hooksFile.hooks.flatMap((hook, index) => {
      const error = this.getAuthoredPathReadError(hook.file, location.hooksBaseDir, index)
      return error ? [this.toMutationFieldError(error)] : []
    })
    if (pathErrors.length > 0) {
      throw new HookRegistryMutationError('validation_failed', pathErrors)
    }

    return {
      ...location,
      hooks: this.toAuthoredHookDefinitions(parsed, hooksFile.hooks),
      raw,
      existed: true,
    }
  }

  private resolveMutationPayload(
    payload: HookMutationRequest,
    options: { expectedId?: string; generatedId: string },
  ): HookMutationResolvedPayload {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new HookRegistryMutationError('validation_failed', [
        {
          field: 'registry',
          code: 'invalid_payload',
          message: 'Hook mutation payload is required',
        },
      ])
    }

    if (typeof payload.source !== 'string') {
      throw new HookRegistryMutationError('validation_failed', [
        {
          field: 'registry',
          code: 'invalid_source',
          message: 'Hook source must be a string',
        },
      ])
    }

    const hookValue = payload.hook
    if (!hookValue || typeof hookValue !== 'object' || Array.isArray(hookValue)) {
      throw new HookRegistryMutationError('validation_failed', [
        {
          field: 'registry',
          code: 'invalid_hook',
          message: 'Hook payload is required',
        },
      ])
    }

    const providedId = typeof hookValue.id === 'string' && hookValue.id.trim().length > 0
      ? hookValue.id.trim()
      : undefined
    if (options.expectedId && providedId && providedId !== options.expectedId) {
      throw new HookRegistryMutationError('validation_failed', [
        {
          field: 'id',
          code: 'id_mismatch',
          message: 'Hook id in body must match the route parameter',
        },
      ])
    }

    return {
      hook: {
        id: providedId ?? options.generatedId,
        name: hookValue.name as string,
        runtime: hookValue.runtime as ParsedHookDefinition['runtime'],
        file: hookValue.file as string,
        timeout: hookValue.timeout as string | number,
        network: hookValue.network as boolean | undefined,
      },
      source: payload.source,
    }
  }

  private async planHookMutation(
    registry: HookRegistryMutationState,
    hookId: string,
    payload: HookMutationResolvedPayload,
    mode: 'create' | 'update',
  ): Promise<HookMutationPlan> {
    const existingHook = mode === 'update'
      ? registry.hooks.find((candidate) => candidate.id === hookId) ?? null
      : null

    const projectedHooks: Array<Record<string, unknown> | AuthoredHookDefinition> = mode === 'update'
      ? [...registry.hooks.filter((candidate) => candidate.id !== hookId), payload.hook]
      : [...registry.hooks, payload.hook]
    const validated = this.validateProjectedHooks(projectedHooks, registry.hooksBaseDir)
    if (!validated.valid) {
      throw new HookRegistryMutationError('validation_failed', validated.fieldErrors)
    }

    const nextHook = validated.parsedHooks.find((candidate) => candidate.id === payload.hook.id)
    if (!nextHook) {
      throw new HookRegistryMutationError('validation_failed', [
        {
          field: 'registry',
          code: 'invalid_registry',
          message: 'Hook could not be projected into the configured hooks file',
        },
      ])
    }

    const nextSourcePath = resolve(registry.hooksBaseDir, nextHook.file)
    const oldSourcePath = existingHook ? resolve(registry.hooksBaseDir, existingHook.file) : null
    const oldSourceSnapshot = existingHook && oldSourcePath
      ? await this.readOptionalFile(oldSourcePath)
      : { exists: false, content: null as string | null }

    if (mode === 'create') {
      const nextExists = await this.readOptionalFile(nextSourcePath)
      if (nextExists.exists) {
        throw new HookRegistryMutationError('validation_failed', [
          {
            field: 'file',
            code: 'collision',
            message: 'Hook file already exists at that path',
          },
        ])
      }
    }

    if (mode === 'update' && oldSourcePath !== nextSourcePath) {
      const nextExists = await this.readOptionalFile(nextSourcePath)
      if (nextExists.exists) {
        throw new HookRegistryMutationError('validation_failed', [
          {
            field: 'file',
            code: 'collision',
            message: 'Hook file already exists at that path',
          },
        ])
      }
    }

    return {
      nextHook,
      nextSourcePath,
      oldSourcePath,
      oldSourceContent: oldSourceSnapshot.content,
      oldSourceExisted: oldSourceSnapshot.exists,
      removeOldSourcePath: Boolean(
        oldSourcePath &&
        oldSourcePath !== nextSourcePath &&
        oldSourceSnapshot.exists &&
        !validated.authoredHooks.some(
          (candidate) =>
            candidate.id !== hookId &&
            resolve(registry.hooksBaseDir, candidate.file) === oldSourcePath,
        ),
      ),
      projectedHooks: validated.authoredHooks,
    }
  }

  private validateProjectedHooks(
    hooks: Array<Record<string, unknown> | AuthoredHookDefinition>,
    hooksBaseDir: string,
  ): {
    valid: boolean
    parsedHooks: ParsedHookDefinition[]
    authoredHooks: AuthoredHookDefinition[]
    fieldErrors: HookFieldError[]
  } {
    const rawFieldErrors = this.collectRawHookFieldErrors(hooks, hooksBaseDir)
    const normalizedDraft = this.normalizeDraftForSchema({ hooks })
    const result = HooksFileSchema.safeParse(normalizedDraft)

    if (!result.success) {
      return {
        valid: false,
        parsedHooks: [],
        authoredHooks: [],
        fieldErrors: this.dedupeFieldErrors([
          ...rawFieldErrors,
          ...result.error.issues.map((issue: ZodIssueLike) => this.toValidationFieldError(issue.path, issue.message)),
        ]),
      }
    }

    const hooksFile = result.data as HooksFileParseData
    const pathErrors = hooksFile.hooks.flatMap((hook, index) => {
      const error = this.getAuthoredPathReadError(hook.file, hooksBaseDir, index)
      return error ? [this.toMutationFieldError(error)] : []
    })

    return {
      valid: pathErrors.length === 0,
      parsedHooks: hooksFile.hooks,
      authoredHooks: this.toAuthoredHookDefinitions({ hooks }, hooksFile.hooks),
      fieldErrors: this.dedupeFieldErrors([
        ...rawFieldErrors,
        ...pathErrors,
      ]),
    }
  }

  private async persistHookMutation(
    registry: HookRegistryMutationState,
    plan: HookMutationPlan,
    source: string,
  ): Promise<void> {
    const nextRegistryContent = this.serializeHooksDocument(registry.raw, plan.projectedHooks)

    try {
      await mkdir(dirname(plan.nextSourcePath), { recursive: true })
      await writeFile(plan.nextSourcePath, source, 'utf-8')
      await mkdir(dirname(registry.resolvedFilePath), { recursive: true })
      await writeFile(registry.resolvedFilePath, nextRegistryContent, 'utf-8')

      if (plan.removeOldSourcePath && plan.oldSourcePath) {
        await rm(plan.oldSourcePath)
      }
    } catch (error) {
      await this.restoreRegistrySnapshot(registry)
      await this.restoreSourceSnapshot(plan)
      throw error
    }
  }

  private async restoreRegistrySnapshot(registry: HookRegistryMutationState): Promise<void> {
    if (!registry.existed || registry.raw === null) {
      await rm(registry.resolvedFilePath, { force: true })
      return
    }

    await writeFile(registry.resolvedFilePath, registry.raw, 'utf-8')
  }

  private async restoreSourceSnapshot(plan: HookMutationPlan): Promise<void> {
    if (plan.oldSourcePath === plan.nextSourcePath) {
      if (plan.oldSourceExisted && plan.oldSourceContent !== null) {
        await mkdir(dirname(plan.nextSourcePath), { recursive: true })
        await writeFile(plan.nextSourcePath, plan.oldSourceContent, 'utf-8')
        return
      }

      await rm(plan.nextSourcePath, { force: true })
      return
    }

    await rm(plan.nextSourcePath, { force: true })
  }

  private serializeHooksDocument(
    raw: string | null,
    hooks: AuthoredHookDefinition[],
  ): string {
    const doc = parseDocument(raw ?? '{}')
    doc.setIn(['hooks'], doc.createNode(hooks))
    return doc.toString()
  }

  private async readOptionalFile(path: string): Promise<{ exists: boolean; content: string | null }> {
    try {
      return {
        exists: true,
        content: await readFile(path, 'utf-8'),
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          exists: false,
          content: null,
        }
      }
      throw error
    }
  }

  private collectRawHookFieldErrors(
    hooks: Array<Record<string, unknown> | AuthoredHookDefinition>,
    hooksBaseDir: string,
  ): HookFieldError[] {
    const fieldErrors: HookFieldError[] = []
    const ids = new Set<string>()
    const names = new Set<string>()

    for (const hook of hooks) {
      if (!hook || typeof hook !== 'object' || Array.isArray(hook)) {
        continue
      }

      const hookRecord = hook as Record<string, unknown>
      if (typeof hookRecord.id === 'string') {
        if (ids.has(hookRecord.id)) {
          fieldErrors.push({
            field: 'id',
            code: 'duplicate_id',
            message: `Duplicate hook id: "${hookRecord.id}"`,
          })
        } else {
          ids.add(hookRecord.id)
        }
      }

      if (typeof hookRecord.name === 'string') {
        if (names.has(hookRecord.name)) {
          fieldErrors.push({
            field: 'name',
            code: 'duplicate_name',
            message: `Duplicate hook name: "${hookRecord.name}"`,
          })
        } else {
          names.add(hookRecord.name)
        }
      }

      if (typeof hookRecord.file === 'string') {
        if (isAbsolute(hookRecord.file)) {
          fieldErrors.push({
            field: 'file',
            code: 'absolute_path',
            message: 'Hook file must be relative to the configured hooks file',
          })
        } else if (!isPathInsideDir(hookRecord.file, hooksBaseDir)) {
          fieldErrors.push({
            field: 'file',
            code: 'unsafe_path',
            message: 'Hook file must stay inside the configured hooks file directory',
          })
        }
      }
    }

    return fieldErrors
  }

  private dedupeFieldErrors(fieldErrors: HookFieldError[]): HookFieldError[] {
    const seen = new Set<string>()
    return fieldErrors.filter((error) => {
      const key = `${error.field}:${error.code}:${error.message}`
      if (seen.has(key)) {
        return false
      }
      seen.add(key)
      return true
    })
  }

  private async readRegistryState(): Promise<HookRegistryState> {
    const location = await this.resolveRegistryLocation()

    try {
      await stat(location.resolvedFilePath)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          ...location,
          hooks: [],
          errors: [{ code: 'hooks_file_missing', message: `configured hooks file not found: ${location.filePath}` }],
          missing: true,
        }
      }
      throw err
    }

    const raw = await readFile(location.resolvedFilePath, 'utf-8')

    let parsed: unknown
    try {
      parsed = parseYaml(raw)
    } catch (err: unknown) {
      return {
        ...location,
        hooks: [],
        errors: [{ code: 'invalid_yaml', message: `Invalid YAML in hooks file: ${(err as Error).message}` }],
        missing: false,
      }
    }

    const result = HooksFileSchema.safeParse(parsed)
    if (!result.success) {
      return {
        ...location,
        hooks: [],
        errors: result.error.issues.map((issue: ZodIssueLike) => ({
          code: 'invalid_registry',
          message: `${issue.path.map(String).join('.')}: ${issue.message}`,
        })),
        missing: false,
      }
    }

    const hooksFile = result.data as HooksFileParseData
    const pathErrors = hooksFile.hooks
      .map((hook, index) => this.getAuthoredPathReadError(hook.file, location.hooksBaseDir, index))
      .filter((error): error is HookRegistryReadError => error !== null)

    if (pathErrors.length > 0) {
      return {
        ...location,
        hooks: [],
        errors: pathErrors,
        missing: false,
      }
    }

    return {
      ...location,
      hooks: hooksFile.hooks,
      errors: [],
      missing: false,
    }
  }

  private async resolveRegistryLocation(): Promise<HookRegistryLocation> {
    const config = await this.configManager.read() as AgentQaConfig
    const workspacePaths = resolveWorkspacePaths({ config, configPath: this.configPath })
    const configuredPath = workspacePaths.hooksFile.configuredPath
    const resolvedFilePath = workspacePaths.hooksFile.absolutePath

    return {
      filePath: this.toDisplayPath(configuredPath, resolvedFilePath),
      resolvedFilePath,
      hooksBaseDir: dirname(resolvedFilePath),
    }
  }

  private getAuthoredPathReadError(filePath: string, hooksBaseDir: string, index: number): HookRegistryReadError | null {
    if (isAbsolute(filePath)) {
      return {
        code: 'absolute_path',
        message: `hooks.${index}.file: Hook file must be relative to the configured hooks file`,
      }
    }

    if (!isPathInsideDir(filePath, hooksBaseDir)) {
      return {
        code: 'unsafe_path',
        message: `hooks.${index}.file: Hook file must stay inside the configured hooks file directory`,
      }
    }

    return null
  }

  private async inspectHookFile(filePath: string, hooksBaseDir: string): Promise<HookFileState> {
    if (isAbsolute(filePath) || !isPathInsideDir(filePath, hooksBaseDir)) {
      return {
        resolvedFilePath: null,
        fileMissing: true,
        fieldErrors: [
          {
            field: 'file',
            code: 'unsafe_path',
            message: 'Hook file must stay inside the configured hooks file directory',
          },
        ],
      }
    }

    const resolvedFilePath = resolve(hooksBaseDir, filePath)
    try {
      await stat(resolvedFilePath)
      return {
        resolvedFilePath,
        fileMissing: false,
        fieldErrors: [],
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          resolvedFilePath: null,
          fileMissing: true,
          fieldErrors: [
            {
              field: 'file',
              code: 'file_missing',
              message: 'Hook file missing',
            },
          ],
        }
      }
      throw err
    }
  }

  private normalizeDraftForSchema(draft: unknown): unknown {
    const rawHooks = this.getRawHooksFromDraft(draft)
    if (rawHooks === null) {
      return draft
    }

    return {
      ...(draft as Record<string, unknown>),
      hooks: rawHooks.map((hook) => {
        if (!hook || typeof hook !== 'object' || Array.isArray(hook)) {
          return hook
        }

        const hookRecord = hook as Record<string, unknown>
        return {
          ...hookRecord,
          timeout: this.normalizeTimeoutValue(hookRecord.timeout),
        }
      }),
    }
  }

  private toAuthoredHookDefinitions(
    draft: unknown,
    parsedHooks: ParsedHookDefinition[],
  ): AuthoredHookDefinition[] {
    const rawHooks = this.getRawHooksFromDraft(draft) ?? []
    return parsedHooks.map((hook, index) => this.toAuthoredHookDefinition(rawHooks[index], hook))
  }

  private toAuthoredHookDefinition(
    rawHook: unknown,
    parsedHook: ParsedHookDefinition,
  ): AuthoredHookDefinition {
    const rawTimeout = rawHook && typeof rawHook === 'object' && !Array.isArray(rawHook)
      ? (rawHook as Record<string, unknown>).timeout
      : parsedHook.timeout
    const normalizedTimeout = this.normalizeTimeoutValue(rawTimeout)

    return {
      ...parsedHook,
      timeout: typeof normalizedTimeout === 'string'
        ? normalizedTimeout
        : this.formatDurationToken(parsedHook.timeout),
    }
  }

  private getRawHooksFromDraft(draft: unknown): unknown[] | null {
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
      return null
    }

    const hooks = (draft as { hooks?: unknown }).hooks
    return Array.isArray(hooks) ? hooks : null
  }

  private normalizeTimeoutValue(timeout: unknown): unknown {
    if (typeof timeout === 'number') {
      return this.formatDurationToken(timeout)
    }

    if (typeof timeout !== 'string') {
      return timeout
    }

    const trimmedTimeout = timeout.trim()
    if (trimmedTimeout.length === 0) {
      return trimmedTimeout
    }

    if (/^\d+$/.test(trimmedTimeout)) {
      return this.formatDurationToken(Number.parseInt(trimmedTimeout, 10))
    }

    const millisecondTimeout = trimmedTimeout.match(/^(\d+)ms$/i)
    if (millisecondTimeout) {
      return this.formatDurationToken(Number.parseInt(millisecondTimeout[1], 10))
    }

    return trimmedTimeout
  }

  private formatDurationToken(durationMs: number): string {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      return `${durationMs}`
    }

    if (durationMs === 0) {
      return '0ms'
    }

    const durationUnits = [
      { suffix: 'd', value: 86_400_000 },
      { suffix: 'h', value: 3_600_000 },
      { suffix: 'm', value: 60_000 },
      { suffix: 's', value: 1_000 },
    ] as const

    for (const unit of durationUnits) {
      if (durationMs % unit.value === 0) {
        return `${durationMs / unit.value}${unit.suffix}`
      }
    }

    return `${durationMs}ms`
  }

  private toValidationFieldError(path: PropertyKey[], message: string): HookFieldError {
    const field = this.getFieldName(path)

    if (field === 'id' && message.includes('Duplicate hook id')) {
      return { field, code: 'duplicate_id', message }
    }

    if (field === 'name' && message.includes('Duplicate hook name')) {
      return { field, code: 'duplicate_name', message }
    }

    if (field === 'runtime') {
      return { field, code: 'invalid_runtime', message }
    }

    if (field === 'timeout') {
      return { field, code: 'invalid_timeout', message }
    }

    if (field === 'network') {
      return { field, code: 'invalid_network', message }
    }

    if (field === 'file') {
      return { field, code: 'invalid_file', message }
    }

    if (field === 'id') {
      return { field, code: 'invalid_id', message }
    }

    if (field === 'name') {
      return { field, code: 'invalid_name', message }
    }

    return { field, code: 'invalid_registry', message }
  }

  private toMutationFieldError(error: HookRegistryReadError): HookFieldError {
    if (error.code === 'absolute_path') {
      return {
        field: 'file',
        code: 'absolute_path',
        message: 'Hook file must be relative to the configured hooks file',
      }
    }

    if (error.code === 'unsafe_path') {
      return {
        field: 'file',
        code: 'unsafe_path',
        message: 'Hook file must stay inside the configured hooks file directory',
      }
    }

    return {
      field: 'registry',
      code: error.code,
      message: error.message,
    }
  }

  private getFieldName(path: PropertyKey[]): HookFieldName {
    const field = path[path.length - 1]
    if (
      field === 'id' ||
      field === 'name' ||
      field === 'runtime' ||
      field === 'file' ||
      field === 'timeout' ||
      field === 'network'
    ) {
      return field
    }

    return 'registry'
  }

  private toCatalogRow(hook: ParsedHookDefinition, fileMissing: boolean): HookCatalogRow {
    return {
      id: hook.id,
      name: hook.name,
      runtime: hook.runtime,
      file: hook.file,
      timeout: hook.timeout,
      network: hook.network,
      fileMissing,
    }
  }

  private toDisplayPath(configuredPath: string, resolvedFilePath: string): string {
    if (!isAbsolute(configuredPath)) {
      return configuredPath
    }

    const relativeToConfig = relative(dirname(this.configPath), resolvedFilePath)
    if (relativeToConfig && !relativeToConfig.startsWith('..') && !isAbsolute(relativeToConfig)) {
      return relativeToConfig.startsWith('.') ? relativeToConfig : `./${relativeToConfig}`
    }

    return `./${basename(resolvedFilePath)}`
  }
}
