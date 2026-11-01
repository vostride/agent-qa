import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'
import type { ModelProfile } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import type { ResolvedModelAuth } from '../auth.js'
import { createModel } from '../registry.js'
import { stubGenerateResult, stubModel } from './stub-model.js'

const noneAuth: ResolvedModelAuth = { kind: 'none' }

const modelProfile: ModelProfile = {
  provider: 'openai-compatible',
  model: 'override-model',
  baseURL: 'http://localhost:11434/v1',
  auth: { mode: 'none' },
}

describe('safety egress middleware', () => {
  it('routes generate params through the safety seam without changing them', async () => {
    let captured: LanguageModelV4CallOptions | undefined
    const request: LanguageModelV4CallOptions = {
      prompt: [],
      providerOptions: {
        openai: {
          reasoningEffort: 'low',
        },
      },
    }
    const model = createModel(modelProfile, noneAuth, (text) => text, {
      languageModels: {
        'override-model': stubModel({
          async doGenerate(params) {
            captured = params
            return stubGenerateResult()
          },
        }),
      },
    })

    await model.doGenerate(request)

    expect(captured).toEqual(request)
  })
})
