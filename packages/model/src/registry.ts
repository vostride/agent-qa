import {
  addToolInputExamplesMiddleware,
  createProviderRegistry,
  customProvider,
  extractJsonMiddleware,
  wrapProvider,
} from 'ai'

import type { LanguageModelMiddleware } from 'ai'
import type { LanguageModelV3, LanguageModelV3StreamPart, ProviderV3 } from '@ai-sdk/provider'
import type { MaskFn, ModelProfile } from '@vostride/agent-qa-schema'
import { createMaskingMiddleware } from '@vostride/agent-qa-safety'

import { deriveTransport } from './auth.js'
import type { ResolvedModelAuth } from './auth.js'
import { resolveCapabilities } from './capability/resolve.js'
import { capabilityUpdateMiddleware } from './middleware/capability-update.js'
import { debugLoggingMiddleware } from './middleware/debug-logging.js'
import { dropEmptyMessagesMiddleware } from './middleware/drop-empty-messages.js'
import { deriveExamplesMiddleware } from './middleware/examples.js'
import { extractJsonStrategy } from './middleware/extract-json.js'
import { repairMiddleware } from './middleware/repair.js'
import { retryMiddleware } from './middleware/retry.js'
import { stripUnsupportedParamsMiddleware } from './middleware/strip-unsupported-params.js'
import { toolSchemaMiddleware } from './middleware.js'
import { getProvider, listProviders } from './providers/registry.js'
import { validateProfile } from './validate.js'
import { openaiCompatible, openaiSubscription } from './adapters/openai.js'
import { anthropicCompatible, anthropicSubscription } from './adapters/anthropic.js'
import { gemini } from './adapters/gemini.js'
import { providerCallReport } from './provider-call-report.js'
import type { ModelCallEvent, ModelCallObservation, ModelCallReportOrigin } from './provider-call-report.js'
export type { ModelCallObservation } from './provider-call-report.js'

// The per-call array createModel builds ends with the declared-secret mask after this array,
// so it is the last transform before the wire (the safety package tests check it).
const MIDDLEWARE: LanguageModelMiddleware[] = [
  retryMiddleware(),
  repairMiddleware(),
  extractJsonMiddleware({ transform: extractJsonStrategy }),
  toolSchemaMiddleware,
  deriveExamplesMiddleware(),
  addToolInputExamplesMiddleware(),
  // RUNX-04: flag-gated debug logging (AGENT_QA_DEBUG_LLM); catches the raw APICallError first.
  debugLoggingMiddleware(),
  // RUNX-01: strip empty-content messages just before the wire.
  dropEmptyMessagesMiddleware(),
]

export interface ModelProviderOverrides {
  languageModels?: Record<string, LanguageModelV3>
  /** Trusted custom/override adapter assertion; omitted means no cache/model authority. */
  providerReportOrigin?: ModelCallReportOrigin
}

export function createModel(
  profile: ModelProfile,
  auth: ResolvedModelAuth,
  mask: MaskFn,
  overrides: ModelProviderOverrides = {},
  observation: ModelCallObservation = {},
): LanguageModelV3 {
  validateProfile(profile)

  profile.capabilities ??= resolveCapabilities(profile)

  const transport = deriveTransport(profile, auth)
  const descriptor = getProvider(profile.provider as string)
  if (!descriptor) {
    throw new Error(
      `Unknown provider "${profile.provider}". Supported: ${listProviders().map(provider => provider.id).join(', ')}.`,
    )
  }

  const baseProvider = toProviderV3((modelId) => descriptor.adapter(transport, modelId))
  const provider: ProviderV3 = customProvider({
    languageModels: overrides.languageModels ?? {},
    fallbackProvider: baseProvider,
  })
  // Wrap BOTH explicit overrides and adapter fallbacks before the central middleware stack.
  // A retry reaches this boundary again; a safety refusal never does. The SDK calls the raw
  // model's methods with their receiver intact and leaves streaming results untouched.
  const onProviderCall = observation.onProviderCall
  const onCall = observation.onCall
  const origin = overrides.providerReportOrigin ?? (
    overrides.languageModels?.[profile.model] ? undefined
      : descriptor.adapter === openaiCompatible ? 'openai-chat'
      : descriptor.adapter === openaiSubscription ? 'openai-responses'
      : descriptor.adapter === anthropicCompatible || descriptor.adapter === anthropicSubscription
        ? 'anthropic-messages'
      : descriptor.adapter === gemini ? 'gemini' : undefined
  )
  const observe = (event: ModelCallEvent) => {
    try {
      Promise.resolve(onCall?.(event)).catch(() => {})
    } catch {
      // Observation cannot prevent a call or replace its original result/error.
    }
  }
  const start = () => {
    try {
      Promise.resolve(onProviderCall?.()).catch(() => {})
    } catch {
      // Legacy observation is isolated independently.
    }
    observe({ kind: 'start' })
  }
  const observedProvider = onProviderCall === undefined && onCall === undefined ? provider : wrapProvider({
    provider,
    languageModelMiddleware: {
      specificationVersion: 'v3',
      wrapGenerate: async ({ doGenerate }) => {
        start()
        try {
          const result = await doGenerate()
          // Reporting, including the mask, cannot replace a provider outcome.
          try {
            observe({ kind: 'success', report: providerCallReport(result, origin, mask) })
          } catch {
            observe({ kind: 'success', report: {} })
          }
          return result
        } catch (error) {
          observe({ kind: 'failure' })
          throw error
        }
      },
      wrapStream: async ({ doStream }) => {
        start()
        try {
          const result = await doStream()
          if (onCall === undefined) return result
          const reader = result.stream.getReader()
          let terminal = false
          let modelId: string | undefined
          const failure = () => {
            if (!terminal) {
              terminal = true
              observe({ kind: 'failure' })
            }
          }
          return {
            ...result,
            stream: new ReadableStream<LanguageModelV3StreamPart>({
              async pull(controller) {
                try {
                  const next = await reader.read()
                  if (next.done) {
                    failure()
                    controller.close()
                    return
                  }
                  const part = next.value
                  if (part.type === 'response-metadata') modelId = part.modelId
                  if (part.type === 'error') failure()
                  if (part.type === 'finish' && !terminal) {
                    terminal = true
                    try {
                      observe({ kind: 'success', report: providerCallReport({
                        usage: part.usage, response: { modelId },
                      }, origin, mask) })
                    } catch {
                      observe({ kind: 'success', report: {} })
                    }
                  }
                  controller.enqueue(part)
                } catch (error) {
                  failure()
                  controller.error(error)
                }
              },
              async cancel(reason) {
                failure()
                await reader.cancel(reason)
              },
            }, { highWaterMark: 0 }),
          }
        } catch (error) {
          observe({ kind: 'failure' })
          throw error
        }
      },
    },
  })
  // The masking middleware must stay last (the safety package tests check it).
  const middleware = [
    capabilityUpdateMiddleware(profile),
    ...(descriptor.unsupportedParams?.length
      ? [stripUnsupportedParamsMiddleware(descriptor.unsupportedParams)]
      : []),
    ...MIDDLEWARE,
    createMaskingMiddleware(mask),
  ]
  const registry = createProviderRegistry(
    { [profile.provider]: observedProvider },
    { languageModelMiddleware: middleware },
  )

  return registry.languageModel(`${profile.provider}:${profile.model}`)
}

function toProviderV3(build: (modelId: string) => LanguageModelV3): ProviderV3 {
  return {
    specificationVersion: 'v3',
    languageModel: build,
    embeddingModel(modelId) {
      throw new Error(`No embedding model for provider model "${modelId}"`)
    },
    imageModel(modelId) {
      throw new Error(`No image model for provider model "${modelId}"`)
    },
  }
}
