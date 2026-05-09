import { generateText, Output } from 'ai'
import type { LanguageModel } from 'ai'
import { z } from 'zod'
import { join } from 'node:path'
import { access, readFile, readdir } from 'node:fs/promises'
import type { TestResult } from '../types/result.js'
import type { MemoryProvider } from './provider.js'
import type { BaseObservation, SuiteObservation } from './schema.js'
import { parseObservation, writeObservation as writeObservationFile, listObservations } from './observation-io.js'
import { generateObservationId } from './observation-id.js'
import { scanObservationText } from './security-scanner.js'
import type { ProviderOptions } from '../agent/provider.js'

export interface MemoryLog {
  added: number
  confirmed: number
  deprecated: number
  deleted: number
  deltas: MemoryDelta[]
  errors: string[]
  curatorDuration: number
  tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number }
}

export type MemoryDeltaAction = 'add' | 'confirm' | 'deprecate' | 'delete'

export interface MemoryObservationSnapshot {
  id: string
  title: string
  content: string
  trust: number
  created: string
  last_confirmed: string
  confirmed_count: number
  contradicted_count: number
  source_test: string
  position?: number
  suite_snapshot?: Array<{ test: string; id: string }>
}

export interface MemoryDelta {
  action: MemoryDeltaAction
  tier: 'products' | 'suites' | 'tests'
  scope: string
  observationId: string
  reasoning: string
  before: MemoryObservationSnapshot | null
  after: MemoryObservationSnapshot | null
  error?: string
}

export interface CuratorContext {
  testResult: TestResult
  provider: MemoryProvider
  model: LanguageModel
  providerOptions?: ProviderOptions
  memoryRoot: string
  product: string
  testId: string
  suiteId?: string
  suiteContext?: { tests: Array<{ test: string; id: string }>; position: number }
  injectedObservationIds: Map<number, string[]>
  trustConfirmDelta?: number
  trustContradictDelta?: number
}

const CuratorActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('add'),
    title: z.string().min(1),
    content: z.string().min(1),
    scope: z.enum(['product', 'suite', 'test']).describe('Use "suite" only if a suite context was provided'),
    reasoning: z.string(),
  }),
  z.object({
    action: z.literal('update'),
    observationId: z.string(),
    reasoning: z.string(),
  }),
  z.object({
    action: z.literal('deprecate'),
    observationId: z.string(),
    reasoning: z.string(),
  }),
  z.object({
    action: z.literal('noop'),
    reasoning: z.string(),
  }),
])

export const CuratorResponseSchema = z.object({
  decisions: z.array(CuratorActionSchema),
})

type CuratorResponse = z.infer<typeof CuratorResponseSchema>

function emptyLog(): MemoryLog {
  return { added: 0, confirmed: 0, deprecated: 0, deleted: 0, deltas: [], errors: [], curatorDuration: 0 }
}

function snapshotObservation(data: BaseObservation | SuiteObservation): MemoryObservationSnapshot {
  const snapshot: MemoryObservationSnapshot = {
    id: data.id,
    title: data.title,
    content: data.content,
    trust: data.trust,
    created: data.created,
    last_confirmed: data.last_confirmed,
    confirmed_count: data.confirmed_count,
    contradicted_count: data.contradicted_count,
    source_test: data.source_test,
  }
  if ('position' in data && typeof data.position === 'number') snapshot.position = data.position
  if ('suite_snapshot' in data && Array.isArray(data.suite_snapshot)) snapshot.suite_snapshot = data.suite_snapshot
  return snapshot
}

function buildSystemPrompt(): string {
  return `You are a memory curator for a test automation system. After each successful test run, you evaluate whether any behavioral observations are worth remembering.

Your decisions use the A.U.D.N. framework:
- ADD: Record a new behavioral observation about the application under test.
- UPDATE: Confirm an existing observation that was relevant and correct during this run.
- DEPRECATE: Mark an observation as contradicted by what happened in this run.
- NOOP: No action needed — the run did not reveal anything worth remembering.

Rules:
- Observations MUST be behavioral facts about the application ("The modal appears after a 2-second delay"), NOT testing strategies ("Wait 3 seconds then click the button").
- Every ADD decision MUST include both a 'title' and a 'content' body.
- Titles must read like context-first fact headlines that help retrieval later, for example "Security page: recovery links live below the fold".
- Keep the title out of the body. The body should start with the explanation, not a repeated heading.
- For update (confirm): only confirm observations that were actually relevant and correct during this run.
- For deprecate: only deprecate observations that are clearly contradicted by what happened in this run.
- If existing observations cover the same behavior, prefer "update" over "add" to avoid duplicates.
- Do NOT fabricate observation IDs. Only reference IDs that appear in the provided context.

Scope-specific selectivity:
- PRODUCT scope: Moderately selective. Capture structural and navigational facts about the application — page layout, menu structure, available sections, navigation paths, form fields present. These observations help ALL future test runs navigate the application.
  PRODUCT scope writing style:
  - Title: context-first fact headline with strong page or workflow keywords.
  - Body: a compact explanatory paragraph first.
  - Markdown: allowed, but only when it genuinely improves clarity (short bullets, tiny tables, brief code/config snippets).
  DO capture:
  - "The settings page has Account, Security, and Notifications sections"
  - "The sidebar navigation contains Dashboard, Reports, and Admin links"
  - "The checkout flow has Shipping, Payment, and Review steps"
  DO NOT capture:
  - "There is a Save button" (too granular, trivially discoverable)
  - "The header shows the company logo" (not useful for test navigation)
  - "The page has a blue background" (styling detail, not structural)

- TEST scope: Highly selective. Only add test-scoped observations when the step shows evidence of agent exploration or difficulty. Look at the sub-action count reported for each step:
  TEST scope writing style:
  - Title: scenario-specific fact headline.
  - Body: keep it short, usually one concise paragraph.
  - Steps with 3+ sub-actions: agent had to explore or retry — worth considering
  - Steps that required self-healing: non-trivial interaction
  - Steps with 0-1 sub-actions: trivial execution — do NOT create test observations for these unless the observation reveals genuinely surprising application behavior (e.g., unexpected delays, dynamic content loading)

- SUITE scope: Same selectivity as test scope. Only use "suite" scope if suite context is provided below.
  SUITE scope writing style:
  - Title: short cross-flow fact headline.
  - Body: keep it short and focused on shared sequencing, setup, or cross-test patterns.

When deciding scope: use "product" for behaviors that apply across the whole product, "suite" for behaviors specific to a test suite (only if suite context is provided), and "test" for behaviors specific to a single test. If no suite context is present, do NOT use "suite" scope.`
}

function buildUserMessage(
  ctx: CuratorContext,
  dedupMatches: Array<{ id: string; title: string; content: string; trust: number }>,
): string {
  const lines: string[] = []
  lines.push(`Test: ${ctx.testResult.name}`)
  lines.push(`File: ${ctx.testResult.filePath}`)
  lines.push(`Status: ${ctx.testResult.status}`)
  lines.push(`Product: ${ctx.product}`)
  lines.push(`Suite context: ${ctx.suiteId ? `yes (${ctx.suiteId})` : 'none — do not use suite scope'}`)
  lines.push('')
  lines.push('## Steps')

  for (let i = 0; i < ctx.testResult.steps.length; i++) {
    const step = ctx.testResult.steps[i]
    const subActionCount = step.trace?.subActions?.length ?? 0
    const healingCount = step.healingAttempts?.length ?? 0
    let stepHeader = `### Step ${i + 1}: ${step.name} [${step.status}] (${subActionCount} sub-actions`
    if (healingCount > 0) stepHeader += `, healed: ${healingCount} attempts`
    stepHeader += ')'
    lines.push(stepHeader)
    if (step.observation) lines.push(`Observation: ${step.observation}`)
    if (step.error) lines.push(`Error: ${step.error}`)
    if (step.trace?.reasoning) lines.push(`Reasoning: ${step.trace.reasoning}`)

    const injectedIds = ctx.injectedObservationIds.get(i)
    if (injectedIds && injectedIds.length > 0) {
      lines.push(`Injected observations: ${injectedIds.join(', ')}`)
    }
    lines.push('')
  }

  if (dedupMatches.length > 0) {
    lines.push('## ALL existing observations for this product')
    for (const match of dedupMatches) {
      lines.push(`- [${match.id}] ${match.title} (trust: ${match.trust.toFixed(2)}): ${match.content}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

function collectKnownObservationIds(
  injectedObservationIds: Map<number, string[]>,
  dedupMatches: Array<{ id: string; title: string; content: string; trust: number }>,
): Set<string> {
  const known = new Set<string>()
  for (const ids of injectedObservationIds.values()) {
    for (const id of ids) known.add(id)
  }
  for (const match of dedupMatches) known.add(match.id)
  return known
}

async function findObservationFile(
  memoryRoot: string,
  id: string,
): Promise<{ tier: 'products' | 'suites' | 'tests'; scope: string; filePath: string } | null> {
  const tiers = ['products', 'suites', 'tests'] as const
  for (const tier of tiers) {
    const tierDir = join(memoryRoot, tier)
    let scopes: string[]
    try {
      scopes = await readdir(tierDir)
    } catch {
      continue
    }
    for (const scope of scopes) {
      const filePath = join(tierDir, scope, `${id}.md`)
      try {
        await access(filePath)
        return { tier, scope, filePath }
      } catch {
        continue
      }
    }
  }
  return null
}

async function readAndParseObservation(
  filePath: string,
  id: string,
): Promise<{ data: BaseObservation | SuiteObservation; raw: string } | null> {
  try {
    const raw = await readFile(filePath, 'utf-8')
    const { data, error } = parseObservation(raw, `${id}.md`)
    if (!data || error) return null
    return { data, raw }
  } catch {
    return null
  }
}

export async function runCurator(ctx: CuratorContext): Promise<MemoryLog> {
  const start = Date.now()
  const log = emptyLog()

  try {
    if (ctx.testResult.status !== 'passed') {
      const failLog = await deprecateOnFailure({
        testResult: ctx.testResult,
        provider: ctx.provider,
        memoryRoot: ctx.memoryRoot,
        injectedObservationIds: ctx.injectedObservationIds,
        trustContradictDelta: ctx.trustContradictDelta,
      })
      failLog.curatorDuration = Date.now() - start
      return failLog
    }

    // Load ALL existing observations so the LLM has full dedup visibility
    let dedupMatches: Array<{ id: string; title: string; content: string; trust: number }> = []
    try {
      dedupMatches = ctx.provider.getAllObservations()
    } catch (err) {
      log.errors.push(`Load all observations failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    const systemPrompt = buildSystemPrompt()
    const userMessage = buildUserMessage(ctx, dedupMatches)
    const fullPrompt = `${systemPrompt}\n\n---\n\n${userMessage}`

    // LLM call
    let response: CuratorResponse
    try {
      const outputConfig = Output.object({
        schema: CuratorResponseSchema,
        name: 'curator_decisions',
        description: 'A.U.D.N. decisions for observation management',
      })
      const result = await generateText({
        model: ctx.model,
        maxRetries: 0,
        output: outputConfig,
        providerOptions: ctx.providerOptions,
        prompt: fullPrompt,
      })

      if (!result.output) {
        log.errors.push('LLM returned empty response')
        log.curatorDuration = Date.now() - start
        return log
      }

      response = result.output

      if (result.usage) {
        const promptTokens = result.usage.inputTokens ?? 0
        const completionTokens = result.usage.outputTokens ?? 0
        log.tokenUsage = {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        }
      }
    } catch (err) {
      log.errors.push(`LLM call failed: ${err instanceof Error ? err.message : String(err)}`)
      log.curatorDuration = Date.now() - start
      return log
    }

    const knownIds = collectKnownObservationIds(ctx.injectedObservationIds, dedupMatches)
    const confirmDelta = ctx.trustConfirmDelta ?? 0.02
    const contradictDelta = ctx.trustContradictDelta ?? 0.05
    const now = new Date().toISOString()

    // Process decisions under lock
    await ctx.provider.acquireLock()
    try {
      for (const decision of response.decisions) {
        try {
          if (decision.action === 'add') {
            if (decision.scope === 'suite' && !ctx.suiteId) {
              decision.scope = 'product'
            }
            const scan = scanObservationText(decision.title, decision.content)
            if (!scan.safe) {
              log.errors.push(`Security scan blocked add: ${scan.matchedPattern}`)
              continue
            }

            const id = generateObservationId()
            const tierMap = { product: 'products', suite: 'suites', test: 'tests' } as const
            const tier = tierMap[decision.scope]
            const scopeValue = decision.scope === 'product' ? ctx.product
              : decision.scope === 'suite' ? (ctx.suiteId ?? ctx.product)
              : ctx.testId

            const baseData: BaseObservation = {
              id,
              title: decision.title,
              content: decision.content,
              trust: 0.5,
              created: now,
              last_confirmed: now,
              confirmed_count: 0,
              contradicted_count: 0,
              source_test: ctx.testId,
            }

            if (decision.scope === 'suite' && ctx.suiteContext) {
              const suiteData: SuiteObservation = {
                ...baseData,
                position: ctx.suiteContext.position,
                suite_snapshot: ctx.suiteContext.tests,
              }
              await ctx.provider.writeObservation(tier, scopeValue, suiteData)
              log.deltas.push({
                action: 'add',
                tier,
                scope: scopeValue,
                observationId: id,
                reasoning: decision.reasoning,
                before: null,
                after: snapshotObservation(suiteData),
              })
            } else {
              await ctx.provider.writeObservation(tier, scopeValue, baseData)
              log.deltas.push({
                action: 'add',
                tier,
                scope: scopeValue,
                observationId: id,
                reasoning: decision.reasoning,
                before: null,
                after: snapshotObservation(baseData),
              })
            }
            log.added++

          } else if (decision.action === 'update') {
            if (!knownIds.has(decision.observationId)) {
              log.errors.push(`Unknown observation ID for update: ${decision.observationId}`)
              continue
            }

            const found = await findObservationFile(ctx.memoryRoot, decision.observationId)
            if (!found) {
              log.errors.push(`Observation file not found for update: ${decision.observationId}`)
              continue
            }

            const parsed = await readAndParseObservation(found.filePath, decision.observationId)
            if (!parsed) {
              log.errors.push(`Failed to parse observation for update: ${decision.observationId}`)
              continue
            }

            const updated = {
              ...parsed.data,
              trust: Math.round(Math.min(1.0, parsed.data.trust + confirmDelta) * 1000) / 1000,
              last_confirmed: now,
              confirmed_count: parsed.data.confirmed_count + 1,
            }
            await ctx.provider.writeObservation(found.tier, found.scope, updated as BaseObservation | SuiteObservation)
            log.deltas.push({
              action: 'confirm',
              tier: found.tier,
              scope: found.scope,
              observationId: decision.observationId,
              reasoning: decision.reasoning,
              before: snapshotObservation(parsed.data),
              after: snapshotObservation(updated as BaseObservation | SuiteObservation),
            })
            log.confirmed++

          } else if (decision.action === 'deprecate') {
            if (!knownIds.has(decision.observationId)) {
              log.errors.push(`Unknown observation ID for deprecate: ${decision.observationId}`)
              continue
            }

            const found = await findObservationFile(ctx.memoryRoot, decision.observationId)
            if (!found) {
              log.errors.push(`Observation file not found for deprecate: ${decision.observationId}`)
              continue
            }

            const parsed = await readAndParseObservation(found.filePath, decision.observationId)
            if (!parsed) {
              log.errors.push(`Failed to parse observation for deprecate: ${decision.observationId}`)
              continue
            }

            const newTrust = Math.round(Math.max(0.0, parsed.data.trust - contradictDelta) * 1000) / 1000
            if (newTrust < 1e-9) {
              await ctx.provider.deleteObservation(found.tier, found.scope, decision.observationId)
              log.deltas.push({
                action: 'delete',
                tier: found.tier,
                scope: found.scope,
                observationId: decision.observationId,
                reasoning: decision.reasoning,
                before: snapshotObservation(parsed.data),
                after: null,
              })
              log.deleted++
            } else {
              const updated = {
                ...parsed.data,
                trust: newTrust,
                contradicted_count: parsed.data.contradicted_count + 1,
              }
              await ctx.provider.writeObservation(found.tier, found.scope, updated as BaseObservation | SuiteObservation)
              log.deltas.push({
                action: 'deprecate',
                tier: found.tier,
                scope: found.scope,
                observationId: decision.observationId,
                reasoning: decision.reasoning,
                before: snapshotObservation(parsed.data),
                after: snapshotObservation(updated as BaseObservation | SuiteObservation),
              })
            }
            log.deprecated++
          }
          // noop: nothing to do
        } catch (err) {
          log.errors.push(`Decision processing error (${decision.action}): ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      // Suite stale cleanup (CUR-07)
      if (ctx.suiteId && ctx.suiteContext) {
        try {
          const suiteDir = join(ctx.memoryRoot, 'suites', ctx.suiteId)
          const files = await listObservations(suiteDir)
          for (const file of files) {
            try {
              const filePath = join(suiteDir, file)
              const raw = await readFile(filePath, 'utf-8')
              const { data } = parseObservation(raw, file)
              if (!data || !('suite_snapshot' in data)) continue
              const suiteObs = data as SuiteObservation
              const currentSnapshot = JSON.stringify(ctx.suiteContext.tests)
              const obsSnapshot = JSON.stringify(suiteObs.suite_snapshot)
              if (currentSnapshot !== obsSnapshot) {
                const obsId = file.replace(/\.md$/, '')
                await ctx.provider.deleteObservation('suites', ctx.suiteId!, obsId)
                log.deltas.push({
                  action: 'delete',
                  tier: 'suites',
                  scope: ctx.suiteId!,
                  observationId: obsId,
                  reasoning: `Suite snapshot changed for suite ${ctx.suiteId}`,
                  before: snapshotObservation(suiteObs),
                  after: null,
                })
                log.deleted++
              }
            } catch (err) {
              log.errors.push(`Suite stale cleanup error: ${err instanceof Error ? err.message : String(err)}`)
            }
          }
        } catch (err) {
          log.errors.push(`Suite stale scan error: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    } finally {
      await ctx.provider.releaseLock()
    }

    log.curatorDuration = Date.now() - start
    return log
  } catch (err) {
    log.errors.push(`Curator error: ${err instanceof Error ? err.message : String(err)}`)
    log.curatorDuration = Date.now() - start
    return log
  }
}

export async function deprecateOnFailure(
  ctx: Pick<CuratorContext, 'testResult' | 'provider' | 'memoryRoot' | 'injectedObservationIds' | 'trustContradictDelta'>,
): Promise<MemoryLog> {
  const log = emptyLog()

  try {
    const failedStepIndex = ctx.testResult.steps.findIndex(s => s.status === 'failed')
    if (failedStepIndex === -1) return log

    const injectedIds = ctx.injectedObservationIds.get(failedStepIndex) ?? []
    if (injectedIds.length === 0) return log

    const contradictDelta = ctx.trustContradictDelta ?? 0.05

    await ctx.provider.acquireLock()
    try {
      for (const id of injectedIds) {
        try {
          const found = await findObservationFile(ctx.memoryRoot, id)
          if (!found) {
            log.errors.push(`Observation file not found for deprecation: ${id}`)
            continue
          }

          const parsed = await readAndParseObservation(found.filePath, id)
          if (!parsed) {
            log.errors.push(`Failed to parse observation for deprecation: ${id}`)
            continue
          }

          const newTrust = Math.round(Math.max(0.0, parsed.data.trust - contradictDelta) * 1000) / 1000
          const reasoning = `Failure contradicted injected observation ${id}`
          if (newTrust < 1e-9) {
            await ctx.provider.deleteObservation(found.tier, found.scope, id)
            log.deltas.push({
              action: 'delete',
              tier: found.tier,
              scope: found.scope,
              observationId: id,
              reasoning,
              before: snapshotObservation(parsed.data),
              after: null,
            })
            log.deleted++
          } else {
            const updated = {
              ...parsed.data,
              trust: newTrust,
              contradicted_count: parsed.data.contradicted_count + 1,
            }
            await ctx.provider.writeObservation(found.tier, found.scope, updated as BaseObservation | SuiteObservation)
            log.deltas.push({
              action: 'deprecate',
              tier: found.tier,
              scope: found.scope,
              observationId: id,
              reasoning,
              before: snapshotObservation(parsed.data),
              after: snapshotObservation(updated as BaseObservation | SuiteObservation),
            })
          }
          log.deprecated++
        } catch (err) {
          log.errors.push(`Deprecation error for ${id}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    } finally {
      await ctx.provider.releaseLock()
    }

    return log
  } catch (err) {
    log.errors.push(`deprecateOnFailure error: ${err instanceof Error ? err.message : String(err)}`)
    return log
  }
}
