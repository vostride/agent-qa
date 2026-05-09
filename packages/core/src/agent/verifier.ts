import { generateText, Output } from 'ai'
import type { LanguageModel } from 'ai'
import { z } from 'zod'
import type { ScreenState, Action } from '../types/platform.js'
import type { Verifier, VerifyResult } from './types.js'
import type { ProviderOptions } from './provider.js'
import { buildVerificationPrompt } from './prompts.js'

// Three-outcome verification strategy (multi-action replanning):
// The planner self-reports goal completion via stepComplete. The verifier
// is only called on stepComplete: true or execution failure.
//   - success: true  + stepComplete: true  → goal met, step done
//   - success: true  + stepComplete: false → action worked but goal not met, continue
//   - success: false                       → action failed, inject error and replan
export const VerificationResultSchema = z.object({
  success: z.boolean().describe('Whether the step goal was accomplished'),
  reasoning: z.string().describe('Explanation of why the step succeeded or failed'),
  isAppError: z.boolean().describe(
    'Whether the page shows an application error (HTTP error, error toast, crash) vs the agent simply not accomplishing the goal',
  ),
})

export class LLMVerifier implements Verifier {
  private model: LanguageModel
  private providerOptions: ProviderOptions

  constructor(model: LanguageModel, providerOptions?: ProviderOptions) {
    this.model = model
    this.providerOptions = providerOptions
  }

  async verify(
    step: string,
    before: ScreenState,
    after: ScreenState,
    action: Action,
    screenshot?: Buffer,
    abortSignal?: AbortSignal,
  ): Promise<VerifyResult> {
    try {
      const promptText = buildVerificationPrompt(step, before, after, action, !!screenshot)

      const outputConfig = Output.object({
        schema: VerificationResultSchema,
        name: 'verification_result',
        description: 'Verification of whether the test step succeeded',
      })

      const result = screenshot
        ? await generateText({
            model: this.model,
            maxRetries: 0,
            output: outputConfig,
            providerOptions: this.providerOptions,
            abortSignal,
            messages: [{
              role: 'user' as const,
              content: [
                { type: 'text' as const, text: promptText },
                { type: 'image' as const, image: screenshot },
              ],
            }],
          })
        : await generateText({
            model: this.model,
            maxRetries: 0,
            output: outputConfig,
            providerOptions: this.providerOptions,
            abortSignal,
            prompt: promptText,
          })

      if (!result.output) {
        throw new Error('LLM returned empty response — no verification result')
      }

      const inputTokens = result.usage?.inputTokens ?? 0
      const outputTokens = result.usage?.outputTokens ?? 0
      return {
        verification: result.output,
        tokenUsage: result.usage ? {
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          totalTokens: inputTokens + outputTokens,
        } : undefined,
      }
    } catch (error: unknown) {
      if (abortSignal?.aborted) throw error
      return {
        verification: {
          success: false,
          reasoning: `Verification failed: ${error instanceof Error ? error.message : String(error)}`,
          isAppError: false,
        },
      }
    }
  }
}
