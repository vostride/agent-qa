import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

import {
  AgentQaConfigSchema,
  discoverWorkspaceFiles,
  listObservations,
  parseObservation,
  resolveMemoryRoot,
  resolveWorkspacePaths,
  scanContent,
  type BaseObservation,
  type SuiteObservation,
} from '@vostride/agent-qa-core'
import { parse as parseYaml } from 'yaml'

import type { ConfigManager } from '../config/index.js'
import { extractTestFileMetadata } from '../tests/test-file-manager.js'

export type MemoryScope = 'product' | 'suite' | 'test'

type MemoryTier = 'products' | 'suites' | 'tests'
type MemoryObservation = BaseObservation | SuiteObservation

export interface MemoryScopeCounts {
  product: number
  suite: number
  test: number
}

export interface MemoryCatalogSourceCounts {
  suite: number
  test: number
}

export interface MemoryCatalogProduct {
  productKey: string
  observationCount: number
  scopeCounts: MemoryScopeCounts
  targetReferences: string[]
  sourceCounts: MemoryCatalogSourceCounts
  freshness: string | null
  sourceCoverage: number
}

export interface MemoryScopeSummary {
  scope: MemoryScope
  observationCount: number
  freshness: string | null
  sourceCoverage: number
  scopeIds: string[]
}

export interface MemoryAtlasObservation {
  id: string
  title: string
  content: string
  trust: number
  created: string
  last_confirmed: string
  confirmed_count: number
  contradicted_count: number
  source_test: string
  scope: MemoryScope
  scopeId: string
}

export interface MemoryObservationReference {
  kind: 'suite' | 'test' | 'source_test'
  id: string
  label: string
  targetName: string | null
  href: string | null
}

export interface MemoryWorkspaceObservation extends MemoryAtlasObservation {
  updated: string
  scopeRef: MemoryObservationReference | null
  sourceTestRef: MemoryObservationReference | null
}

export interface MemoryInvalidFile {
  scope: MemoryScope
  scopeId: string
  filename: string
  code: string
  message: string
}

export interface MemoryProductDetail extends MemoryCatalogProduct {
  scopes: Record<MemoryScope, MemoryScopeSummary>
  observations: MemoryWorkspaceObservation[]
  invalidFiles: MemoryInvalidFile[]
}

export interface MemoryCatalogResponse {
  products: MemoryCatalogProduct[]
}

export interface MemoryScopeReadResponse {
  scope: MemoryScope
  scopeId: string
  observations: MemoryObservation[]
  invalidFiles: MemoryInvalidFile[]
}

interface MemoryCatalogManagerOptions {
  configManager?: ConfigManager
  configPath?: string
}

interface WorkspaceContext {
  workspaceDir: string
  memoryRoot: string
  targetToProduct: Map<string, string>
  productToTargets: Map<string, string[]>
  suiteMetadataById: Map<string, WorkspaceEntityMetadata>
  testMetadataById: Map<string, WorkspaceEntityMetadata>
}

interface WorkspaceEntityMetadata {
  id: string
  label: string
  targetName: string | null
  productKey: string | null
  href: string | null
}

interface ProductAccumulator {
  productKey: string
  observationCount: number
  scopeCounts: MemoryScopeCounts
  targetReferences: string[]
  freshness: string | null
  sourceTests: Set<string>
  scopes: Record<MemoryScope, ScopeAccumulator>
  observations: MemoryWorkspaceObservation[]
  invalidFiles: MemoryInvalidFile[]
}

interface ObservationRecord {
  observation: MemoryObservation
  updated: string
}

interface ScopeAccumulator {
  observationCount: number
  freshness: string | null
  sourceTests: Set<string>
  scopeIds: Set<string>
}

const MEMORY_SCOPE_TO_TIER: Record<MemoryScope, MemoryTier> = {
  product: 'products',
  suite: 'suites',
  test: 'tests',
}

const MEMORY_SCOPE_ORDER: Record<MemoryScope, number> = {
  product: 0,
  suite: 1,
  test: 2,
}

const EMPTY_SCOPE_COUNTS: MemoryScopeCounts = {
  product: 0,
  suite: 0,
  test: 0,
}

export class MemoryCatalogManager {
  private readonly configManager?: ConfigManager
  private readonly configPath?: string

  constructor(options: MemoryCatalogManagerOptions = {}) {
    this.configManager = options.configManager
    this.configPath = options.configPath
  }

  async readCatalog(): Promise<MemoryCatalogResponse> {
    const products = await this.readProducts()
    return {
      products: products
        .map((product) => this.toProductSummary(product))
        .sort(compareProducts),
    }
  }

  async readProductDetail(productKey: string): Promise<MemoryProductDetail | null> {
    if (!isValidMemoryScopeId(productKey)) {
      return null
    }

    const products = await this.readProducts()
    const match = products.find((product) => product.productKey === productKey)
    return match ? this.toProductDetail(match) : null
  }

  async readScopedObservations(scope: MemoryScope, scopeId: string): Promise<MemoryScopeReadResponse | null> {
    if (!isValidMemoryScopeId(scopeId)) {
      return null
    }

    const { memoryRoot } = await this.loadWorkspaceContext()
    const tierRoot = resolve(join(memoryRoot, MEMORY_SCOPE_TO_TIER[scope]))
    const dir = resolve(join(tierRoot, scopeId))
    if (!dir.startsWith(`${tierRoot}${sep}`)) {
      return null
    }

    try {
      const info = await stat(dir)
      if (!info.isDirectory()) {
        return null
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw error
    }

    const context = await this.loadWorkspaceContext()
    const { observations, invalidFiles } = await readObservationDirectory(scope, scopeId, dir)

    return {
      scope,
      scopeId,
      observations: observations.map((record) => toMemoryWorkspaceObservation(scope, scopeId, record, context)),
      invalidFiles,
    }
  }

  private async readProducts(): Promise<ProductAccumulator[]> {
    const context = await this.loadWorkspaceContext()
    const products = new Map<string, ProductAccumulator>()

    await this.collectTier(context.memoryRoot, context.productToTargets, 'products', (scopeId) => scopeId, products, context)
    await this.collectTier(
      context.memoryRoot,
      context.productToTargets,
      'suites',
      (scopeId) => context.suiteMetadataById.get(scopeId)?.productKey ?? null,
      products,
      context,
    )
    await this.collectTier(
      context.memoryRoot,
      context.productToTargets,
      'tests',
      (scopeId) => context.testMetadataById.get(scopeId)?.productKey ?? null,
      products,
      context,
    )

    return Array.from(products.values())
  }

  private async collectTier(
    memoryRoot: string,
    productToTargets: Map<string, string[]>,
    tier: MemoryTier,
    resolveProductKey: (scopeId: string) => string | null,
    products: Map<string, ProductAccumulator>,
    context: WorkspaceContext,
  ): Promise<void> {
    const tierRoot = join(memoryRoot, tier)
    let entries: Array<{ isDirectory(): boolean; name: string }>
    try {
      const dirEntries = await readdir(tierRoot, { withFileTypes: true, encoding: 'utf8' })
      entries = dirEntries.map((entry) => ({
        isDirectory: () => entry.isDirectory(),
        name: String(entry.name),
      }))
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return
      }
      throw error
    }

    const scope = tierToScope(tier)

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const scopeId = entry.name
      const productKey = resolveProductKey(scopeId)
      if (!productKey || !isValidMemoryScopeId(productKey)) continue

      const { observations, invalidFiles } = await readObservationDirectory(scope, scopeId, join(tierRoot, scopeId))
      if (observations.length === 0 && invalidFiles.length === 0) continue

      const accumulator = products.get(productKey) ?? createProductAccumulator(
        productKey,
        productToTargets.get(productKey) ?? [],
      )
      accumulator.invalidFiles.push(...invalidFiles)
      for (const record of observations) {
        const observation = toMemoryWorkspaceObservation(scope, scopeId, record, context)
        accumulator.observationCount += 1
        accumulator.scopeCounts[scope] += 1
        accumulator.freshness = pickFreshest(accumulator.freshness, observation.last_confirmed)
        accumulator.sourceTests.add(observation.source_test)
        accumulator.observations.push(observation)

        const scopeAccumulator = accumulator.scopes[scope]
        scopeAccumulator.observationCount += 1
        scopeAccumulator.freshness = pickFreshest(scopeAccumulator.freshness, observation.last_confirmed)
        scopeAccumulator.sourceTests.add(observation.source_test)
        scopeAccumulator.scopeIds.add(scopeId)
      }

      products.set(productKey, accumulator)
    }
  }

  private async loadWorkspaceContext(): Promise<WorkspaceContext> {
    const workspaceDir = this.configPath ? dirname(resolve(this.configPath)) : process.cwd()
    const config = await this.readConfig()
    const targetToProduct = getTargetToProductMap(config)
    const productToTargets = getProductToTargetsMap(targetToProduct)
    const configResult = AgentQaConfigSchema.safeParse(config)
    const memoryRoot = configResult.success
      ? resolveMemoryRoot(configResult.data, workspaceDir)
      : resolveMemoryRoot(undefined, workspaceDir)
    const workspacePaths = configResult.success
      ? resolveWorkspacePaths({
          config: configResult.data,
          configPath: this.configPath ? resolve(this.configPath) : resolve(workspaceDir, 'agent-qa.config.yaml'),
        })
      : null
    const [testFiles, suiteFiles] = workspacePaths
      ? await Promise.all([
          discoverWorkspaceFiles({ workspace: workspacePaths, kind: 'test' }),
          discoverWorkspaceFiles({ workspace: workspacePaths, kind: 'suite' }),
        ])
      : [[], []]

    const testMetadataById = new Map<string, WorkspaceEntityMetadata>()
    for (const file of testFiles) {
      const content = await readFile(file.absolutePath, 'utf-8').catch(() => null)
      if (!content) continue
      const metadata = extractTestFileMetadata(content)
      if (!metadata.testId) continue
      const targetName = metadata.targetName ?? null
      const productKey = targetName ? targetToProduct.get(targetName) ?? null : null
      testMetadataById.set(metadata.testId, {
        id: metadata.testId,
        label: metadata.name?.trim() || metadata.testId,
        targetName,
        productKey,
        href: `/test/${metadata.testId}`,
      })
    }

    const suiteMetadataById = new Map<string, WorkspaceEntityMetadata>()
    for (const file of suiteFiles) {
      const content = await readFile(file.absolutePath, 'utf-8').catch(() => null)
      if (!content) continue
      const metadata = extractSuiteFileMetadata(content)
      if (!metadata.suiteId) continue
      const targetName = metadata.targetName ?? null
      const productKey = targetName ? targetToProduct.get(targetName) ?? null : null
      suiteMetadataById.set(metadata.suiteId, {
        id: metadata.suiteId,
        label: metadata.name?.trim() || metadata.suiteId,
        targetName,
        productKey,
        href: `/suite/${metadata.suiteId}`,
      })
    }

    return {
      workspaceDir,
      memoryRoot,
      targetToProduct,
      productToTargets,
      suiteMetadataById,
      testMetadataById,
    }
  }

  private async readConfig(): Promise<Record<string, unknown>> {
    if (!this.configManager) {
      return {}
    }

    try {
      return await this.configManager.read()
    } catch {
      return {}
    }
  }

  private toProductSummary(product: ProductAccumulator): MemoryCatalogProduct {
    return {
      productKey: product.productKey,
      observationCount: product.observationCount,
      scopeCounts: { ...product.scopeCounts },
      targetReferences: [...product.targetReferences],
      sourceCounts: {
        suite: product.scopes.suite.scopeIds.size,
        test: product.sourceTests.size,
      },
      freshness: product.freshness,
      sourceCoverage: product.sourceTests.size,
    }
  }

  private toProductDetail(product: ProductAccumulator): MemoryProductDetail {
    return {
      ...this.toProductSummary(product),
      scopes: {
        product: toScopeSummary('product', product.scopes.product),
        suite: toScopeSummary('suite', product.scopes.suite),
        test: toScopeSummary('test', product.scopes.test),
      },
      observations: [...product.observations].sort(compareMemoryWorkspaceObservations),
      invalidFiles: [...product.invalidFiles].sort(compareInvalidFiles),
    }
  }
}

function tierToScope(tier: MemoryTier): MemoryScope {
  switch (tier) {
    case 'products':
      return 'product'
    case 'suites':
      return 'suite'
    case 'tests':
      return 'test'
  }
}

function createProductAccumulator(productKey: string, targetReferences: string[]): ProductAccumulator {
  return {
    productKey,
    observationCount: 0,
    scopeCounts: { ...EMPTY_SCOPE_COUNTS },
    targetReferences: [...targetReferences],
    freshness: null,
    sourceTests: new Set<string>(),
    scopes: {
      product: createScopeAccumulator(),
      suite: createScopeAccumulator(),
      test: createScopeAccumulator(),
    },
    observations: [],
    invalidFiles: [],
  }
}

function createScopeAccumulator(): ScopeAccumulator {
  return {
    observationCount: 0,
    freshness: null,
    sourceTests: new Set<string>(),
    scopeIds: new Set<string>(),
  }
}

function toScopeSummary(scope: MemoryScope, accumulator: ScopeAccumulator): MemoryScopeSummary {
  return {
    scope,
    observationCount: accumulator.observationCount,
    freshness: accumulator.freshness,
    sourceCoverage: accumulator.sourceTests.size,
    scopeIds: Array.from(accumulator.scopeIds).sort((left, right) => left.localeCompare(right)),
  }
}

function compareProducts(left: MemoryCatalogProduct, right: MemoryCatalogProduct): number {
  const freshnessCompare = compareFreshness(right.freshness, left.freshness)
  if (freshnessCompare !== 0) {
    return freshnessCompare
  }

  const sourceCoverageCompare = right.sourceCoverage - left.sourceCoverage
  if (sourceCoverageCompare !== 0) {
    return sourceCoverageCompare
  }

  return left.productKey.localeCompare(right.productKey)
}

function compareFreshness(left: string | null, right: string | null): number {
  if (left === right) return 0
  if (!left) return -1
  if (!right) return 1
  return left.localeCompare(right)
}

function toMemoryWorkspaceObservation(
  scope: MemoryScope,
  scopeId: string,
  record: ObservationRecord,
  context: WorkspaceContext,
): MemoryWorkspaceObservation {
  const observation = record.observation
  return {
    id: observation.id,
    title: observation.title,
    content: observation.content,
    trust: observation.trust,
    created: observation.created,
    last_confirmed: observation.last_confirmed,
    confirmed_count: observation.confirmed_count,
    contradicted_count: observation.contradicted_count,
    source_test: observation.source_test,
    scope,
    scopeId,
    updated: record.updated,
    scopeRef: resolveScopeReference(scope, scopeId, context),
    sourceTestRef: resolveReference('source_test', context.testMetadataById.get(observation.source_test)),
  }
}

function compareMemoryWorkspaceObservations(left: MemoryWorkspaceObservation, right: MemoryWorkspaceObservation): number {
  const scopeCompare = MEMORY_SCOPE_ORDER[left.scope] - MEMORY_SCOPE_ORDER[right.scope]
  if (scopeCompare !== 0) {
    return scopeCompare
  }

  const lastConfirmedCompare = right.last_confirmed.localeCompare(left.last_confirmed)
  if (lastConfirmedCompare !== 0) {
    return lastConfirmedCompare
  }

  const createdCompare = right.created.localeCompare(left.created)
  if (createdCompare !== 0) {
    return createdCompare
  }

  return left.id.localeCompare(right.id)
}

function compareInvalidFiles(left: MemoryInvalidFile, right: MemoryInvalidFile): number {
  return (
    MEMORY_SCOPE_ORDER[left.scope] - MEMORY_SCOPE_ORDER[right.scope] ||
    left.scopeId.localeCompare(right.scopeId) ||
    left.filename.localeCompare(right.filename)
  )
}

function pickFreshest(current: string | null, candidate: string): string {
  if (!current) return candidate
  return candidate.localeCompare(current) > 0 ? candidate : current
}

async function readObservationDirectory(
  scope: MemoryScope,
  scopeId: string,
  dir: string,
): Promise<{ observations: ObservationRecord[]; invalidFiles: MemoryInvalidFile[] }> {
  const filenames = await listObservations(dir)
  const observations: ObservationRecord[] = []
  const invalidFiles: MemoryInvalidFile[] = []

  for (const filename of filenames) {
    const filePath = join(dir, filename)
    const raw = await readFile(filePath, 'utf-8').catch(() => null)
    if (!raw) continue

    const parsed = parseObservation(raw, filename)
    if (!parsed.data || parsed.error) {
      invalidFiles.push({
        scope,
        scopeId,
        filename,
        code: 'parse_error',
        message: parsed.error ?? 'Observation file could not be parsed',
      })
      continue
    }

    const scanned = scanObservationPayload(parsed.data.title, parsed.data.content)
    if (!scanned.safe) {
      invalidFiles.push({
        scope,
        scopeId,
        filename,
        code: 'security_scan_failed',
        message: `Security scan blocked: ${scanned.matchedPattern}`,
      })
      continue
    }

    const fileInfo = await stat(filePath).catch(() => null)
    if (!fileInfo) continue

    observations.push({
      observation: parsed.data,
      updated: fileInfo.mtime.toISOString(),
    })
  }

  return {
    observations: observations.sort((left, right) => right.observation.last_confirmed.localeCompare(left.observation.last_confirmed)),
    invalidFiles: invalidFiles.sort(compareInvalidFiles),
  }
}

function scanObservationPayload(title: string, content: string) {
  return scanContent([title, content].filter(Boolean).join('\n'))
}

function getTargetToProductMap(config: Record<string, unknown>): Map<string, string> {
  const registry = (config.registry ?? {}) as {
    targets?: Record<string, { product?: unknown }>
  }
  const map = new Map<string, string>()

  for (const [targetName, targetConfig] of Object.entries(registry.targets ?? {})) {
    const productValue = typeof targetConfig?.product === 'string' && targetConfig.product.trim().length > 0
      ? targetConfig.product.trim()
      : targetName
    if (isValidMemoryScopeId(productValue)) {
      map.set(targetName, productValue)
    }
  }

  return map
}

function getProductToTargetsMap(targetToProduct: Map<string, string>): Map<string, string[]> {
  const map = new Map<string, string[]>()

  for (const [targetName, productKey] of targetToProduct.entries()) {
    const targets = map.get(productKey) ?? []
    targets.push(targetName)
    map.set(productKey, targets)
  }

  for (const targets of map.values()) {
    targets.sort((left, right) => left.localeCompare(right))
  }

  return map
}

function extractSuiteFileMetadata(content: string): { suiteId: string | null; name: string | null; targetName: string | null } {
  let parsed: Record<string, unknown> | null = null

  try {
    const yamlValue = parseYaml(content)
    if (yamlValue && typeof yamlValue === 'object' && !Array.isArray(yamlValue)) {
      parsed = yamlValue as Record<string, unknown>
    }
  } catch {
    // Fall back to regex extraction for partially-authored files.
  }

  const name = typeof parsed?.name === 'string' && parsed.name.trim().length > 0
    ? parsed.name.trim()
    : content.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["'](.*)["']$/, '$1') ?? null

  const suiteId = typeof parsed?.['suite-id'] === 'string' && parsed['suite-id'].trim().length > 0
    ? parsed['suite-id'].trim()
    : content.match(/^suite-id:\s*(.+)$/m)?.[1]?.trim().replace(/^["'](.*)["']$/, '$1') ?? null

  const targetName = typeof parsed?.target === 'string' && parsed.target.trim().length > 0
    ? parsed.target.trim()
    : content.match(/^target:\s*(.+)$/m)?.[1]?.trim().replace(/^["'](.*)["']$/, '$1') ?? null

  return { suiteId, name, targetName }
}

function resolveScopeReference(
  scope: MemoryScope,
  scopeId: string,
  context: WorkspaceContext,
): MemoryObservationReference | null {
  switch (scope) {
    case 'product':
      return null
    case 'suite':
      return resolveReference('suite', context.suiteMetadataById.get(scopeId))
    case 'test':
      return resolveReference('test', context.testMetadataById.get(scopeId))
  }
}

function resolveReference(
  kind: MemoryObservationReference['kind'],
  metadata: WorkspaceEntityMetadata | undefined,
): MemoryObservationReference | null {
  if (!metadata) {
    return null
  }

  return {
    kind,
    id: metadata.id,
    label: metadata.label,
    targetName: metadata.targetName,
    href: metadata.href,
  }
}

export function isValidMemoryScopeId(value: string): boolean {
  return value.trim().length > 0 && !/\.\./.test(value) && !/[/\\]/.test(value) && !/\0/.test(value)
}
