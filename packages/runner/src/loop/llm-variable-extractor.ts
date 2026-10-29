// Runner-owned AI capture extractor. Moved 1:1 beside the asserter
// (loop/asserter.ts LLMAssertionEvaluator) — the injected verifier-lane LanguageModel
// + direct `generateText` with `maxRetries: 0` and Output.object is the runner's ONLY
// sanctioned AI-call idiom. No provider construction, no second provider path: egress
// masking rides the 362 provider-request hook inside runSafetyScope for free.
import { generateText, Output } from 'ai'
import { withStepModelCall } from '../run/step-model-observations.js'
import type { LanguageModel } from 'ai'
import { z } from 'zod'
import type { ScreenState } from '@vostride/agent-qa-schema'
import type { ExtractorInput, CaptureResult, VariableExtractor } from './types.js'
import { buildExtractionPrompt } from './prompts.js'

export const ExtractionResultSchema = z.object({
  value: z.string(),
  reasoning: z.string(),
})

export class LLMVariableExtractor implements VariableExtractor {
  private model: LanguageModel

  constructor(model: LanguageModel) {
    this.model = model
  }

  async extract(input: ExtractorInput, screenState: ScreenState): Promise<CaptureResult> {
    try {
      const prompt = buildExtractionPrompt(input, screenState)

      const { result } = await withStepModelCall(this.model, model => generateText({
        model,
        maxRetries: 0,
        output: Output.object({
          schema: ExtractionResultSchema,
          name: 'extraction_result',
          description: 'Extracted variable value from screen state',
        }),
        prompt,
      }))

      if (!result.output) {
        throw new Error('LLM returned empty response — no extraction result')
      }

      const output = result.output as z.infer<typeof ExtractionResultSchema>

      return {
        success: true,
        variableName: input.variableName,
        value: output.value,
        reasoning: output.reasoning,
      }
    } catch (error: unknown) {
      return {
        success: false,
        variableName: input.variableName,
        reasoning: `LLM extraction failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }
}
