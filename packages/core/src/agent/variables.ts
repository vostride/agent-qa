import { generateText, Output } from 'ai'
import type { LanguageModel } from 'ai'
import { z } from 'zod'
import type { ScreenState } from '../types/platform.js'
import type { ExtractorInput, CaptureResult, VariableExtractor } from './types.js'
import { buildExtractionPrompt } from './prompts.js'

export const ExtractionResultSchema = z.object({
  value: z.string(),
  reasoning: z.string(),
})

export type VariableSource = 'env' | 'inline' | 'suite' | 'cli' | 'capture' | 'hook' | 'step'

interface TrackedVariable {
  value: string
  source: VariableSource
}

export class VariableStore {
  private storage = new Map<string, TrackedVariable>()

  set(name: string, value: string, source: VariableSource = 'capture'): void {
    const existing = this.storage.get(name)
    if (source === 'capture' && existing && existing.source !== 'capture') {
      console.warn(`Warning: capture step overwrites variable "${name}" (was set by ${existing.source})`)
    }
    this.storage.set(name, { value, source })
  }

  get(name: string): string | undefined {
    return this.storage.get(name)?.value
  }

  has(name: string): boolean {
    return this.storage.has(name)
  }

  getSource(name: string): VariableSource | undefined {
    return this.storage.get(name)?.source
  }

  getAll(): Map<string, string> {
    const result = new Map<string, string>()
    for (const [key, tracked] of this.storage) {
      result.set(key, tracked.value)
    }
    return result
  }

  setAll(vars: Record<string, string>, source: VariableSource = 'capture'): void {
    for (const [key, value] of Object.entries(vars)) {
      this.set(key, value, source)
    }
  }

  snapshot(): Record<string, { value: string; source: VariableSource }> {
    const result: Record<string, { value: string; source: VariableSource }> = {}
    for (const [key, tracked] of this.storage) {
      result[key] = { value: tracked.value, source: tracked.source }
    }
    return result
  }
}

export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eqIndex = line.indexOf('=')
    if (eqIndex === -1) continue
    const key = line.slice(0, eqIndex).trim()
    let value = line.slice(eqIndex + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}

export function serializeEnvFile(vars: Record<string, string>): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(vars)) {
    if (value.includes(' ') || value.includes('"') || value.includes("'") || value === '') {
      lines.push(`${key}="${value.replace(/"/g, '\\"')}"`)
    } else {
      lines.push(`${key}=${value}`)
    }
  }
  return lines.length > 0 ? lines.join('\n') + '\n' : ''
}

export function interpolateVariables(template: string, store: VariableStore): string {
  return template.replace(/\{\{env:(\w+)\}\}/g, (_match, varName) => {
    const value = store.get(varName)
    if (value !== undefined) return value
    return _match
  })
}

interface UnresolvedTemplate {
  pattern: string
  message: string
}

export function findUnresolvedTemplates(text: string): UnresolvedTemplate[] {
  const results: UnresolvedTemplate[] = []
  const re = /\{\{[^}]*\}\}/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const pattern = match[0]
    const inner = pattern.slice(2, -2)
    let message: string
    if (/^env:\w+$/.test(inner)) {
      const varName = inner.slice(4)
      message = `variable '${varName}' not set. Set it in .env, via --var, or setVariable action.`
    } else if (/^secret:\w+$/.test(inner)) {
      continue
    } else if (/^capture:\w+$/.test(inner)) {
      const varName = inner.slice(8)
      message = `'capture:' syntax is not supported. Use {{env:${varName}}} instead.`
    } else if (/^hook:\w+$/.test(inner)) {
      message = `unknown syntax. Did you mean {{runHook:"h_hook-id"}}?`
    } else if (/^runJS:/.test(inner)) {
      message = `runJS failed to resolve. Check browser page availability.`
    } else {
      message = `unknown template syntax.`
    }
    results.push({ pattern, message })
  }
  return results
}

const BARE_VARIABLE_RE = /\{\{(\w+)\}\}/g

export function findBareVariables(text: string): string[] {
  const bare: string[] = []
  let m: RegExpExecArray | null
  BARE_VARIABLE_RE.lastIndex = 0
  while ((m = BARE_VARIABLE_RE.exec(text)) !== null) {
    bare.push(m[1])
  }
  return bare
}

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

export class LLMVariableExtractor implements VariableExtractor {
  private model: LanguageModel

  constructor(model: LanguageModel) {
    this.model = model
  }

  async extract(input: ExtractorInput, screenState: ScreenState): Promise<CaptureResult> {
    try {
      const prompt = buildExtractionPrompt(input, screenState)

      const result = await generateText({
        model: this.model,
        maxRetries: 0,
        output: Output.object({
          schema: ExtractionResultSchema,
          name: 'extraction_result',
          description: 'Extracted variable value from screen state',
        }),
        prompt,
      })

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

export function createExtractor(model?: LanguageModel, method?: string): VariableExtractor {
  if (method === 'ai') {
    if (!model) {
      throw new Error('AI extraction requires a LanguageModel — pass a model to createExtractor()')
    }
    return new LLMVariableExtractor(model)
  }
  return new ExplicitExtractor()
}
