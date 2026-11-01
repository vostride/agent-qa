import type {
  LanguageModelV4,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamResult,
} from '@ai-sdk/provider'

export type StubModelOverrides = Partial<LanguageModelV4> & {
  generate?: () => Promise<LanguageModelV4GenerateResult>
  content?: LanguageModelV4GenerateResult['content']
}

export function stubGenerateResult(
  content: LanguageModelV4GenerateResult['content'] = [],
): LanguageModelV4GenerateResult {
  return {
    content,
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0, text: 0, reasoning: 0 },
    },
    warnings: [],
  }
}

export function stubStreamResult(): LanguageModelV4StreamResult {
  return { stream: new ReadableStream() }
}

export function stubModel(over: StubModelOverrides = {}): LanguageModelV4 {
  const { generate, content, ...modelOverrides } = over

  return {
    specificationVersion: 'v4',
    provider: 'stub',
    modelId: 'stub',
    supportedUrls: {},
    async doGenerate() {
      if (generate) return generate()
      return stubGenerateResult(content)
    },
    async doStream() {
      return stubStreamResult()
    },
    ...modelOverrides,
  }
}
