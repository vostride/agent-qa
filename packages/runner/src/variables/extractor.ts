// Runner-owned capture extractors. The pure ExplicitExtractor moves
// 1:1 from core/src/agent/variables.ts; the createExtractor factory routes 'ai' to the
// LLMVariableExtractor (loop/llm-variable-extractor.ts — the injected-model idiom).
import type { LanguageModel } from 'ai'
import type { ScreenState } from '@vostride/agent-qa-schema'
import type { ExtractorInput, CaptureResult, VariableExtractor } from '../loop/types.js'
import { LLMVariableExtractor } from '../loop/llm-variable-extractor.js'

export class ExplicitExtractor implements VariableExtractor {
  async extract(input: ExtractorInput, screenState: ScreenState): Promise<CaptureResult> {
    if (input.method === 'regex') {
      return this.extractByRegex(input, screenState)
    }
    return this.extractBySelector(input, screenState)
  }

  private extractByRegex(input: ExtractorInput, screenState: ScreenState): CaptureResult {
    const regex = new RegExp(input.pattern!)
    const match = regex.exec(screenState.tree)

    if (match && match[1]) {
      return {
        success: true,
        variableName: input.variableName,
        value: match[1],
        reasoning: `Regex "${input.pattern}" matched, captured group: "${match[1]}"`,
      }
    }

    return {
      success: false,
      variableName: input.variableName,
      reasoning: `Regex "${input.pattern}" did not match any content in screen state`,
    }
  }

  private extractBySelector(input: ExtractorInput, screenState: ScreenState): CaptureResult {
    const selectorLower = input.selector!.toLowerCase()
    const match = screenState.elements.find(
      el => el.role.toLowerCase().includes(selectorLower)
        || el.name.toLowerCase().includes(selectorLower)
        || el.ref === input.selector,
    )

    if (match) {
      const value = match.value ?? match.name
      return {
        success: true,
        variableName: input.variableName,
        value,
        reasoning: `Found element matching "${input.selector}": ${match.role} "${match.name}"`,
      }
    }

    return {
      success: false,
      variableName: input.variableName,
      reasoning: `No element matching "${input.selector}" found in ${screenState.elements.length} elements`,
    }
  }
}

export function createExtractor(model?: LanguageModel, method?: string): VariableExtractor {
  if (method === 'ai') {
    if (!model) {
      throw new Error('AI extraction requires a LanguageModel — pass a model to createExtractor()')
    }
    return new LLMVariableExtractor(model)
  }
  return new ExplicitExtractor()
}
