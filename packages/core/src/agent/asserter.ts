import { generateText, Output } from 'ai'
import type { LanguageModel } from 'ai'
import { z } from 'zod'
import type { ScreenState } from '../types/platform.js'
import type { AssertionInput, AssertionResult, Asserter } from './types.js'
import { truncateScreenState } from './observation.js'
import { buildAssertionPrompt } from './prompts.js'

export const AssertionResultSchema = z.object({
  passed: z.boolean(),
  reasoning: z.string(),
  evidence: z.string(),
})

export class AssertionEvaluator implements Asserter {
  async evaluate(assertion: AssertionInput, screenState: ScreenState): Promise<AssertionResult> {
    switch (assertion.type) {
      case 'text-presence':
        return this.evaluateTextPresence(assertion, screenState)
      case 'element-visibility':
        return this.evaluateElementVisibility(assertion, screenState)
      case 'url-match':
        return this.evaluateUrlMatch(assertion, screenState)
      case 'element-count':
        return this.evaluateElementCount(assertion, screenState)
      default:
        return {
          passed: false,
          assertionType: assertion.type,
          expected: assertion.value,
          actual: '',
          reasoning: `Unsupported assertion type: ${assertion.type}`,
        }
    }
  }

  private evaluateTextPresence(assertion: AssertionInput, screenState: ScreenState): AssertionResult {
    const searchText = assertion.value.toLowerCase()
    const treeText = screenState.tree.toLowerCase()
    const found = treeText.includes(searchText)

    return {
      passed: found,
      assertionType: 'text-presence',
      expected: assertion.value,
      actual: found ? assertion.value : `Text "${assertion.value}" not found in screen`,
      reasoning: found
        ? `Text "${assertion.value}" found in screen state`
        : `Text "${assertion.value}" not found in screen state tree`,
    }
  }

  private evaluateElementVisibility(assertion: AssertionInput, screenState: ScreenState): AssertionResult {
    const match = screenState.elements.find(
      el => el.name.toLowerCase().includes(assertion.value.toLowerCase())
        || el.role.toLowerCase().includes(assertion.value.toLowerCase())
        || el.ref === assertion.value,
    )

    return {
      passed: !!match,
      assertionType: 'element-visibility',
      expected: assertion.value,
      actual: match ? `${match.role}: "${match.name}"` : 'not found',
      reasoning: match
        ? `Element matching "${assertion.value}" found: ${match.role} "${match.name}"`
        : `Element matching "${assertion.value}" not found in ${screenState.elements.length} visible elements`,
    }
  }

  private evaluateUrlMatch(assertion: AssertionInput, screenState: ScreenState): AssertionResult {
    const currentUrl = screenState.url ?? ''
    const pattern = assertion.value

    let matched: boolean
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1)
      matched = currentUrl.startsWith(prefix)
    } else {
      matched = currentUrl === pattern
    }

    return {
      passed: matched,
      assertionType: 'url-match',
      expected: pattern,
      actual: currentUrl,
      reasoning: matched
        ? `URL "${currentUrl}" matches pattern "${pattern}"`
        : `URL "${currentUrl}" does not match expected "${pattern}"`,
    }
  }

  private evaluateElementCount(assertion: AssertionInput, screenState: ScreenState): AssertionResult {
    const searchValue = assertion.value.toLowerCase()
    const matchingElements = screenState.elements.filter(
      el => el.role.toLowerCase().includes(searchValue)
        || el.name.toLowerCase().includes(searchValue),
    )
    const count = matchingElements.length
    const expectedCount = parseInt(assertion.expected ?? '0', 10)
    const passed = count === expectedCount

    return {
      passed,
      assertionType: 'element-count',
      expected: String(expectedCount),
      actual: String(count),
      reasoning: passed
        ? `Found ${count} elements matching "${assertion.value}" (expected ${expectedCount})`
        : `Found ${count} elements matching "${assertion.value}", expected ${expectedCount}`,
    }
  }
}

export class LLMAssertionEvaluator implements Asserter {
  private model: LanguageModel

  constructor(model: LanguageModel) {
    this.model = model
  }

  async evaluate(assertion: AssertionInput, screenState: ScreenState): Promise<AssertionResult> {
    try {
      const prompt = buildAssertionPrompt(assertion, screenState)

      const result = await generateText({
        model: this.model,
        maxRetries: 0,
        output: Output.object({
          schema: AssertionResultSchema,
          name: 'assertion_result',
          description: 'Evaluation of whether the test assertion holds true',
        }),
        prompt,
      })

      if (!result.output) {
        throw new Error('LLM returned empty response — no assertion result')
      }

      const output = result.output as z.infer<typeof AssertionResultSchema>

      return {
        passed: output.passed,
        assertionType: 'ai',
        expected: assertion.value,
        actual: output.evidence,
        reasoning: output.reasoning,
      }
    } catch (error: unknown) {
      return {
        passed: false,
        assertionType: 'ai',
        expected: assertion.value,
        actual: '',
        reasoning: `LLM assertion failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }
}

export function createAsserter(model?: LanguageModel): Asserter {
  const explicitEvaluator = new AssertionEvaluator()
  const llmEvaluator = model ? new LLMAssertionEvaluator(model) : undefined

  return {
    async evaluate(assertion: AssertionInput, screenState: ScreenState): Promise<AssertionResult> {
      if (assertion.type === 'ai') {
        if (!llmEvaluator) {
          throw new Error('AI assertion requires a LanguageModel — pass a model to createAsserter()')
        }
        return llmEvaluator.evaluate(assertion, screenState)
      }
      return explicitEvaluator.evaluate(assertion, screenState)
    },
  }
}
